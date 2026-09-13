#!/usr/bin/env python3
"""Local server for the STINT9 replay-clip catcher (server.html).

Runs entirely on your own Mac, independent of any browser tab: downloads a
YouTube livestream from its actual start (yt-dlp --live-from-start) to a
growing local file, scans it for the on-screen REPLAY badge with OpenCV +
Tesseract OCR, and cuts+uploads each clip to the project's Supabase Storage
bucket the moment it's found. Detection races through whatever's already on
disk as fast as decode allows, and naturally settles to a real-time pace once
it catches up to the live edge.

The download is HLS/MPEG-TS with --no-part so the file is readable *while*
yt-dlp is still writing. `bestvideo+bestaudio` + a post-download merge would
leave us with nothing to scan until the stream ended — that's why we don't.

One-time setup:
    brew install tesseract
    source ~/Documents/Terminal/venv/bin/activate
    pip install pytesseract requests flask flask_cors opencv-python

Run:
    source ~/Documents/Terminal/venv/bin/activate
    python3 tools/replay_server.py
"""
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import pytesseract
import requests
from flask import Flask, jsonify, request, send_from_directory, session
from flask_cors import CORS

PORT = 5057
REPO_ROOT = Path(__file__).resolve().parent.parent
SESSIONS_DIR = Path(os.path.expanduser('~/Documents/Terminal/replay-sessions'))
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
COOKIES_PATH = Path(os.path.expanduser('~/Documents/Terminal/youtube-cookies.txt'))

# Only used when this server is reached through a Cloudflare Tunnel (an internet-
# facing *.trycloudflare.com URL) -- LAN/.local/localhost access stays exactly as
# open as it always was. Lives outside the repo (this is public on GitHub) and is
# generated once, so it survives restarts without ever touching version control.
AUTH_PATH = Path(os.path.expanduser('~/Documents/Terminal/replay-auth.json'))
TUNNEL_HOST_SUFFIX = '.trycloudflare.com'


def load_auth():
    try:
        return json.loads(AUTH_PATH.read_text())
    except Exception:
        auth = {'password': secrets.token_urlsafe(9), 'secret_key': secrets.token_hex(32)}
        AUTH_PATH.write_text(json.dumps(auth))
        return auth


AUTH = load_auth()

# same project + publishable key the rest of stint9-dash already uses client-side
SB = 'https://esvvzgxqnfszhttdkuzc.supabase.co'
KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU'
BUCKET = 'replay-clips'

SAMPLE_STEP = 1.0   # video-seconds between OCR samples
DEBOUNCE_N = 2      # consecutive same-state samples required before flipping badge state
MIN_VIDEO_BYTES = 400_000
MERGE_GAP_S = 8.0   # badge re-appearing within this many video-seconds of going off
                    # extends the same clip instead of starting a new one -- back-to-back
                    # replays (a new angle, a slow-mo replay of the same incident) often
                    # have the badge blink off for a couple seconds between segments

app = Flask(__name__, static_folder=None)
app.secret_key = AUTH['secret_key']
CORS(app, allow_private_network=True)

lock = threading.Lock()
capture_session = None   # single active capture session; this is a one-user local tool, not multi-tenant
                          # (named apart from Flask's `session` import, used below for the tunnel auth gate)


def yt_id(url):
    m = re.search(
        r'(?:youtu\.be/|youtube(?:-nocookie)?\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/))([A-Za-z0-9_-]{11})',
        url or '',
    )
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', (url or '').strip()):
        return url.strip()
    return None


def fetch_broadcast_start(url):
    """release_timestamp (falling back to timestamp) is when the stream actually
    went live — used to back-date old footage to when it really aired, instead of
    to whenever the catch-up scan happens to pass over it."""
    try:
        cmd = ['yt-dlp', '-J', '--no-warnings', '--no-playlist', url]
        if COOKIES_PATH.exists():
            cmd[1:1] = ['--cookies', str(COOKIES_PATH)]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        info = json.loads(out.stdout)
        return info.get('release_timestamp') or info.get('timestamp')
    except Exception:
        return None


def fill_broadcast_start(sess, url):
    ts = fetch_broadcast_start(url)
    with lock:
        sess['broadcast_start'] = ts


def start_download(sess, url):
    # MPEG-TS + --no-part: yt-dlp writes the final filename as it goes, so
    # OpenCV can read frames out of a still-growing live recording. HLS is
    # preferred over DASH because DASH video+audio is only merged at the end.
    video_path = sess['dir'] / 'session.ts'
    cmd = ['yt-dlp']
    if COOKIES_PATH.exists():
        cmd += ['--cookies', str(COOKIES_PATH)]
    cmd += [
        '--live-from-start',
        '--hls-use-mpegts',
        '--no-part',
        '--newline',
        '--no-playlist',
        '--no-warnings',
        # HLS video+audio first (live writes a growing MPEG-TS). Combined `best`
        # often doesn't exist on YouTube — only separate DASH/HLS tracks — so
        # `b` is a last resort, not the primary selector.
        '-f', 'bv*[protocol^=m3u8]+ba[protocol^=m3u8]/b[protocol^=m3u8]/bv*+ba/b',
        '-o', str(video_path),
        url,
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, start_new_session=True,
    )
    sess['proc'] = proc
    sess['video_path'] = video_path

    def tail():
        try:
            for line in proc.stdout:
                line = line.rstrip()
                with lock:
                    sess['last_dl_line'] = line
                    if 'ERROR:' in line and not sess.get('stopped'):
                        sess['error'] = line
        finally:
            rc = proc.wait()
            with lock:
                sess['downloading'] = False
                if rc not in (0, None) and not sess.get('stopped') and not sess.get('error'):
                    sess['error'] = f'yt-dlp exited {rc}'

    threading.Thread(target=tail, daemon=True).start()


def resolve_video_path(sess):
    """Pick the largest readable media file in the session dir.

    Live HLS lands on session.ts immediately (--no-part). A VOD fallback or a
    leftover .part from an older yt-dlp still has to be discoverable too.
    """
    d = sess['dir']
    named = sess.get('video_path')
    candidates = []
    if named:
        candidates.append(named)
    for name in ('session.ts', 'session.mkv', 'session.mp4', 'session.webm'):
        candidates.append(d / name)
    try:
        others = [p for p in d.iterdir() if p.is_file()]
        others.sort(key=lambda p: p.stat().st_size, reverse=True)
        candidates.extend(others)
    except FileNotFoundError:
        return None
    seen = set()
    for p in candidates:
        if p in seen or not p.is_file():
            continue
        seen.add(p)
        if p.name.startswith(('clip_', 'preview', '_frame')):
            continue
        suf = p.suffix.lower()
        if suf in {'.ts', '.mkv', '.mp4', '.webm', '.part'} or '.part' in p.name:
            try:
                if p.stat().st_size >= MIN_VIDEO_BYTES:
                    return p
            except OSError:
                continue
    return None


def media_kinds(path):
    """Return (has_video, has_audio) for a media file."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type',
             '-of', 'csv=p=0', str(path)],
            capture_output=True, text=True, timeout=20,
        )
        kinds = {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}
        return ('video' in kinds, 'audio' in kinds)
    except Exception:
        return (False, False)


def resolve_audio_path(sess, video_path):
    """Companion audio file for a video-only HLS/DASH download.

    yt-dlp writes `session.ts.f299.mp4` (video) and `session.ts.f140.mp4`
    (audio) separately until the live download ends and it merges them.
    Cutting from the video file alone is why the uploaded clips were silent.
    """
    if video_path is None:
        return None
    _, has_a = media_kinds(video_path)
    if has_a:
        return video_path
    d = sess['dir']
    try:
        files = [p for p in d.iterdir() if p.is_file()]
    except FileNotFoundError:
        return None
    audio_only = []
    combined = []
    for p in files:
        if p == video_path or p.name.startswith(('clip_', 'preview', '_frame', 'hit_')):
            continue
        suf = p.suffix.lower()
        if suf not in {'.ts', '.mkv', '.mp4', '.webm', '.m4a', '.part'} and '.part' not in p.name:
            continue
        hv, ha = media_kinds(p)
        if ha and hv:
            combined.append(p)
        elif ha:
            audio_only.append(p)
    if combined:
        combined.sort(key=lambda p: p.stat().st_size, reverse=True)
        return combined[0]
    if audio_only:
        audio_only.sort(key=lambda p: p.stat().st_size, reverse=True)
        return audio_only[0]
    return None


def ffmpeg_cut(video_path, audio_path, start_t, dur, dest):
    """Cut [start_t, start_t+dur) keeping audio whenever we have it."""
    dest = Path(dest)
    start_t = max(0.0, float(start_t))
    dur = max(0.5, float(dur))
    common_tail = ['-t', str(dur), '-avoid_negative_ts', 'make_zero',
                   '-movflags', '+faststart', str(dest)]

    def run(cmd):
        return subprocess.run(cmd, capture_output=True, timeout=180)

    same = audio_path is None or Path(audio_path) == Path(video_path)
    if same:
        r = run(['ffmpeg', '-y', '-ss', str(start_t), '-i', str(video_path),
                 '-c', 'copy', *common_tail])
        if dest.exists() and dest.stat().st_size > 0 and media_kinds(dest)[1]:
            return True
        # copy kept video but no audio — try encode that still copies audio if present
        r = run(['ffmpeg', '-y', '-ss', str(start_t), '-i', str(video_path),
                 '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k',
                 *common_tail])
        if dest.exists() and dest.stat().st_size > 0:
            return True
        run(['ffmpeg', '-y', '-ss', str(start_t), '-i', str(video_path),
             '-c:v', 'libx264', '-preset', 'veryfast', '-an', *common_tail])
        return dest.exists() and dest.stat().st_size > 0

    r = run(['ffmpeg', '-y',
             '-ss', str(start_t), '-i', str(video_path),
             '-ss', str(start_t), '-i', str(audio_path),
             '-map', '0:v:0', '-map', '1:a:0?',
             '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest',
             *common_tail])
    if dest.exists() and dest.stat().st_size > 0 and media_kinds(dest)[1]:
        return True
    r = run(['ffmpeg', '-y',
             '-ss', str(start_t), '-i', str(video_path),
             '-ss', str(start_t), '-i', str(audio_path),
             '-map', '0:v:0', '-map', '1:a:0?',
             '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k',
             '-shortest', *common_tail])
    return dest.exists() and dest.stat().st_size > 0


def crop_frame(frame, calib):
    h, w = frame.shape[:2]
    x, y = int(calib['x'] * w), int(calib['y'] * h)
    cw, ch = max(1, int(calib['w'] * w)), max(1, int(calib['h'] * h))
    x = max(0, min(x, w - 1))
    y = max(0, min(y, h - 1))
    return frame[y:y + min(ch, h - y), x:x + min(cw, w - x)]


def _letters(txt):
    return ''.join(c for c in (txt or '').upper() if c.isalpha())


def _looks_like_replay(txt):
    t = _letters(txt)
    return 'REPLAY' in t or 'REPLAV' in t


def ocr_has_replay(crop):
    if crop is None or crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    big = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    boosted = cv2.convertScaleAbs(big, alpha=2.4, beta=-90 * 2.4)
    _, otsu = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cfg = '--psm 7 -c tessedit_char_whitelist=REPLAYreplay'
    for img in (big, otsu, boosted):
        if _looks_like_replay(pytesseract.image_to_string(img, config=cfg)):
            return True
    return False


def _ocr_start_no(crop):
    """Read '#12' / '#48' / '#665' etc. from a green-box crop. Requires the hash
    so '911' in 'Porsche 911' is not treated as a start number."""
    if crop is None or crop.size == 0:
        return None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    big = cv2.resize(gray, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
    cfg = '--psm 7 -c tessedit_char_whitelist=#0123456789'
    texts = [pytesseract.image_to_string(big, config=cfg)]
    for t in (160, 180, 200):
        _, th = cv2.threshold(big, t, 255, cv2.THRESH_BINARY)
        texts.append(pytesseract.image_to_string(th, config=cfg))
        texts.append(pytesseract.image_to_string(255 - th, config=cfg))
    blob = ' '.join(texts)
    found = re.findall(r'#\s*(\d{1,3})', blob)
    return found[0] if found else None


def detect_start_number(frame):
    """Find the NLS lower-third green parallelogram and OCR the start number
    inside it (any 1–3 digit value). Returns a digit string or None."""
    if frame is None or getattr(frame, 'size', 0) == 0:
        return None
    h, w = frame.shape[:2]
    band = frame[int(h * 0.70):, :]
    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array((40, 80, 60)), np.array((90, 255, 255)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 11), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    scale = h / 1080.0
    votes = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        if ch < 16 * scale or cw < 30 * scale:
            continue
        if ch > 90 * scale or cw > 220 * scale:
            continue
        if cw / max(ch, 1) < 1.4 or cw / max(ch, 1) > 4.5:
            continue
        if area < 600 * scale * scale:
            continue
        pad = int(6 * scale)
        crop = band[max(0, y - pad):y + ch + pad, max(0, x - pad):x + cw + pad]
        num = _ocr_start_no(crop)
        if num:
            votes.append(num)
    if not votes:
        return None
    return Counter(votes).most_common(1)[0][0]


def detect_start_number_from_clip(clip_path, duration=None):
    """Sample a few frames of the clip itself (not the full broadcast) and vote."""
    votes = []
    times = [0.4, 1.0, 2.0]
    if duration:
        times += [max(0.4, float(duration) * 0.5), max(0.4, float(duration) - 0.5)]
    seen = set()
    for t in times:
        t = round(float(t), 2)
        if t in seen or t < 0:
            continue
        seen.add(t)
        n = detect_start_number(grab_frame(Path(clip_path), t))
        if n:
            votes.append(n)
    if not votes:
        return None
    return Counter(votes).most_common(1)[0][0]


def upsert_car_meta(video_id, filename, car):
    if not car or not filename:
        return
    pub = f'{SB}/storage/v1/object/public/{BUCKET}/{video_id}/meta.json'
    url = f'{SB}/storage/v1/object/{BUCKET}/{video_id}/meta.json'
    meta = {}
    try:
        r = requests.get(pub, timeout=10)
        if r.ok:
            meta = r.json() or {}
    except Exception:
        pass
    meta[filename] = str(car)
    try:
        requests.post(
            url,
            headers={
                'apikey': KEY,
                'Authorization': f'Bearer {KEY}',
                'Content-Type': 'application/json',
                'x-upsert': 'true',
            },
            data=json.dumps(meta),
            timeout=20,
        )
    except Exception:
        pass


def grab_frame(path, t):
    cap = cv2.VideoCapture(str(path))
    if t > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    cap.release()
    if ok and frame is not None:
        return frame
    tmp = path.parent / f'_frame_{int(t * 1000)}.jpg'
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-ss', str(max(0, t)), '-i', str(path),
             '-frames:v', '1', '-q:v', '2', str(tmp)],
            capture_output=True, timeout=20,
        )
        if tmp.exists() and tmp.stat().st_size > 0:
            frame = cv2.imread(str(tmp))
            return frame
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)
    return None


def save_hit_frame(sess, frame, calib, t):
    """Write a still of the detection frame (red box on the calibrated crop)
    so the page can show it the moment REPLAY is found."""
    vis = frame.copy()
    h, w = vis.shape[:2]
    x, y = int(calib['x'] * w), int(calib['y'] * h)
    cw, ch = max(1, int(calib['w'] * w)), max(1, int(calib['h'] * h))
    cv2.rectangle(vis, (x, y), (x + cw, y + ch), (0, 0, 255), 4)
    with lock:
        idx = len(sess.get('hits') or []) + 1
        dest_dir = sess['dir']
    fname = f'hit_{idx}.jpg'
    cv2.imwrite(str(dest_dir / fname), vis, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    crop = crop_frame(frame, calib)
    if crop is not None and crop.size:
        cv2.imwrite(str(dest_dir / f'hit_{idx}_crop.jpg'), crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    rec = {'id': idx, 't': round(float(t), 2), 'file': fname}
    with lock:
        sess.setdefault('hits', []).append(rec)
    return rec


def cut_and_upload(sess, start_t, end_t, idx):
    time.sleep(2.0)   # give yt-dlp time to flush this range to disk before cutting
    dur = max(0.5, end_t - start_t)
    src = resolve_video_path(sess) or sess.get('video_path')
    if src is None or not Path(src).exists():
        return
    audio = resolve_audio_path(sess, src)
    # Prefer a already-merged A+V file (yt-dlp writes it after the live
    # download ends) so timestamps stay in lockstep.
    if audio is not None and Path(audio) != Path(src):
        hv, ha = media_kinds(audio)
        if hv and ha:
            src = audio
    clip_path = sess['dir'] / f'clip_{idx}.mp4'
    if not ffmpeg_cut(src, audio, start_t, dur, clip_path):
        return
    car = detect_start_number_from_clip(clip_path, dur)
    car_suffix = f'_n{car}' if car else ''
    broadcast_start = sess.get('broadcast_start')
    real_ms = int((broadcast_start + start_t) * 1000) if broadcast_start else int(time.time() * 1000)
    iso = time.strftime('%Y-%m-%dT%H-%M-%S', time.gmtime(real_ms / 1000)) + f'-{real_ms % 1000:03d}Z'
    fname = f'{iso}_{round(dur)}s{car_suffix}.mp4'
    obj_path = f"{sess['video_id']}/{fname}"
    try:
        with open(clip_path, 'rb') as f:
            r = requests.post(
                f'{SB}/storage/v1/object/{BUCKET}/{obj_path}',
                headers={
                    'apikey': KEY,
                    'Authorization': f'Bearer {KEY}',
                    'Content-Type': 'video/mp4',
                    'x-upsert': 'true',
                },
                data=f.read(), timeout=60,
            )
        if r.status_code >= 400:
            with lock:
                sess['error'] = f'upload failed {r.status_code}: {r.text[:180]}'
            return
        still = clip_path.with_suffix('.jpg')
        subprocess.run(
            ['ffmpeg', '-y', '-ss', '0.4', '-i', str(clip_path),
             '-frames:v', '1', '-q:v', '3', str(still)],
            capture_output=True,
        )
        if still.exists() and still.stat().st_size > 0:
            with open(still, 'rb') as f:
                requests.post(
                    f'{SB}/storage/v1/object/{BUCKET}/{obj_path[:-4]}.jpg',
                    headers={
                        'apikey': KEY,
                        'Authorization': f'Bearer {KEY}',
                        'Content-Type': 'image/jpeg',
                        'x-upsert': 'true',
                    },
                    data=f.read(), timeout=30,
                )
            still.unlink(missing_ok=True)
        upsert_car_meta(sess['video_id'], fname, car)
    except Exception as e:
        with lock:
            sess['error'] = f'upload failed: {e}'
        return
    with lock:
        sess['clips_found'] = sess.get('clips_found', 0) + 1
        if car:
            sess['last_car'] = car
    clip_path.unlink(missing_ok=True)


def detection_loop(sess):
    next_t = 0.0
    badge_on = False
    pending, pending_n = None, 0
    clip_start_t = None
    pending_off_t = None   # video-time the badge last went off; clip isn't cut until MERGE_GAP_S passes with no comeback
    clip_idx = 0
    cap = None
    cap_path = None

    def close_cap():
        nonlocal cap, cap_path
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
            cap = None
            cap_path = None

    try:
        while True:
            with lock:
                if sess.get('stopped'):
                    break
                calib = sess.get('calib')
                need_preview = not sess.get('preview_ready')
                do_reset = sess.pop('reset_scan', False)

            if do_reset:
                close_cap()
                next_t = 0.0
                badge_on = False
                pending, pending_n = None, 0
                clip_start_t = None
                pending_off_t = None
                with lock:
                    sess['badge_on'] = False
                    sess['scan_mode'] = 'catchup'
                    sess['scanned_t'] = 0.0

            path = resolve_video_path(sess)
            if path is None:
                close_cap()
                time.sleep(0.5)
                continue

            if need_preview:
                frame = grab_frame(path, 0)
                if frame is not None:
                    cv2.imwrite(str(sess['dir'] / 'preview.jpg'), frame)
                    with lock:
                        sess['preview_ready'] = True
                else:
                    time.sleep(0.5)
                continue

            if calib is None:
                time.sleep(0.3)
                continue

            if cap is None or cap_path != path:
                close_cap()
                cap = cv2.VideoCapture(str(path))
                cap_path = path
                if next_t > 0:
                    cap.set(cv2.CAP_PROP_POS_MSEC, next_t * 1000)

            ok, frame = cap.read()
            if not ok or frame is None:
                close_cap()
                with lock:
                    sess['scan_mode'] = 'live'
                time.sleep(0.4)
                continue

            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t + 0.05 < next_t:
                continue
            next_t = t if t > next_t else next_t

            with lock:
                if sess.get('scan_mode') != 'live':
                    sess['scan_mode'] = 'catchup'
                sess['scanned_t'] = next_t

            seen = ocr_has_replay(crop_frame(frame, calib))
            if seen == badge_on:
                pending, pending_n = None, 0
            else:
                if pending == seen:
                    pending_n += 1
                else:
                    pending, pending_n = seen, 1
                if pending_n >= DEBOUNCE_N:
                    pending, pending_n = None, 0
                    badge_on = seen
                    with lock:
                        sess['badge_on'] = badge_on
                    if badge_on:
                        if clip_start_t is None:
                            clip_start_t = next_t
                        pending_off_t = None   # badge came back -- cancel any pending cut, same clip continues
                        save_hit_frame(sess, frame, calib, next_t)
                    elif clip_start_t is not None:
                        pending_off_t = next_t   # don't cut yet -- wait out MERGE_GAP_S in case it comes back

            # flush a clip only once the badge has been off for the full merge
            # gap with no comeback -- checked every tick, not just on a flip,
            # since time keeps passing while we're waiting to see if it returns
            if pending_off_t is not None and next_t - pending_off_t >= MERGE_GAP_S:
                clip_idx += 1
                threading.Thread(
                    target=cut_and_upload,
                    args=(sess, clip_start_t, pending_off_t, clip_idx),
                    daemon=True,
                ).start()
                clip_start_t = None
                pending_off_t = None

            next_t += SAMPLE_STEP
    finally:
        close_cap()
        if clip_start_t is not None:
            end_t = pending_off_t if pending_off_t is not None else next_t
            clip_idx += 1
            threading.Thread(
                target=cut_and_upload,
                args=(sess, clip_start_t, end_t, clip_idx),
                daemon=True,
            ).start()


def kill_proc(proc):
    if not proc:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass


@app.route('/health')
def health():
    return jsonify(status='ok')


@app.route('/api/open-terminal')
def open_terminal():
    try:
        subprocess.Popen(['open', '-a', 'Terminal'])
        return jsonify(status='ok')
    except Exception as e:
        return jsonify(status='error', message=str(e)), 500


@app.route('/api/monitor/start', methods=['POST'])
def monitor_start():
    global capture_session
    data = request.get_json(force=True) or {}
    url = data.get('url', '')
    vid = yt_id(url)
    if not vid:
        return jsonify(status='error', message='not a YouTube link'), 400
    with lock:
        if capture_session and not capture_session.get('stopped'):
            if capture_session.get('video_id') == vid:
                return jsonify(status='running')
            return jsonify(status='error', message='already monitoring a different video — stop first'), 409
        sess_dir = SESSIONS_DIR / f'{vid}-{int(time.time())}'
        sess_dir.mkdir(parents=True, exist_ok=True)
        capture_session = {
            'video_id': vid, 'dir': sess_dir, 'downloading': True,
            'scan_mode': 'catchup', 'badge_on': False, 'clips_found': 0,
            'calib': None, 'preview_ready': False, 'scanned_t': 0.0,
            'stopped': False, 'broadcast_start': None, 'error': None,
            'last_dl_line': '', 'video_path': None, 'hits': [],
        }
        sess = capture_session
    start_download(sess, url)
    threading.Thread(target=fill_broadcast_start, args=(sess, url), daemon=True).start()
    threading.Thread(target=detection_loop, args=(sess,), daemon=True).start()
    return jsonify(status='started')


@app.route('/api/monitor/status')
def monitor_status():
    with lock:
        if not capture_session:
            return jsonify(active=False)
        s = capture_session
        return jsonify(
            active=True, videoId=s['video_id'], downloading=s['downloading'],
            scanMode=s['scan_mode'], badgeOn=s['badge_on'], clipsFound=s['clips_found'],
            previewReady=s['preview_ready'], scannedT=s['scanned_t'],
            calibrated=s['calib'] is not None, lastDlLine=s.get('last_dl_line', ''),
            error=s.get('error'), hits=list(s.get('hits') or []),
        )


@app.route('/api/monitor/preview.jpg')
def monitor_preview():
    with lock:
        if not capture_session or not capture_session.get('preview_ready'):
            return jsonify(status='error'), 404
        d = capture_session['dir']
    return send_from_directory(d, 'preview.jpg')


@app.route('/api/monitor/hit/<int:idx>.jpg')
def monitor_hit(idx):
    with lock:
        if not capture_session:
            return jsonify(status='error'), 404
        d = capture_session['dir']
    resp = send_from_directory(d, f'hit_{idx}.jpg')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/api/monitor/calibrate', methods=['POST'])
def monitor_calibrate():
    data = request.get_json(force=True) or {}
    with lock:
        if not capture_session:
            return jsonify(status='error'), 400
        had_calib = capture_session['calib'] is not None
        try:
            capture_session['calib'] = {k: float(data[k]) for k in ('x', 'y', 'w', 'h')}
        except (KeyError, TypeError, ValueError):
            return jsonify(status='error', message='bad crop region'), 400
        # a redo (not the first calibration) means whatever was already scanned
        # used the old, wrong crop region -- rescan the whole recording so far
        # from the start with the corrected one instead of picking up where the
        # old scan left off.
        if had_calib:
            capture_session['reset_scan'] = True
    return jsonify(status='ok')


@app.route('/api/monitor/stop', methods=['POST'])
def monitor_stop():
    global capture_session
    proc = None
    with lock:
        if capture_session:
            capture_session['stopped'] = True
            proc = capture_session.get('proc')
        capture_session = None
    kill_proc(proc)
    return jsonify(status='ok')


@app.route('/api/restart', methods=['POST'])
def restart_server():
    # so you can restart without a terminal: stop any active capture cleanly
    # (same as /api/monitor/stop), spawn a fresh copy of this script, then hard
    # -exit this process. (Tried os.execv-in-place first -- re-execing the same
    # PID should reuse the same fd table, but empirically the old listening
    # socket didn't free up in time and the new image's app.run() immediately
    # died with "address already in use", killing the server outright with no
    # process left standing. Spawning the replacement *before* exiting sidesteps
    # that: heavy imports (cv2 etc.) give the old process plenty of time to
    # fully exit and release the port before the new one's app.run() binds --
    # and that bind now retries for a few seconds regardless, just in case.)
    global capture_session
    proc = None
    with lock:
        if capture_session:
            capture_session['stopped'] = True
            proc = capture_session.get('proc')
        capture_session = None
    kill_proc(proc)

    def _relaunch():
        time.sleep(0.3)   # let this response reach the browser first
        subprocess.Popen([sys.executable, str(Path(__file__).resolve())], start_new_session=True)
        os._exit(0)
    threading.Thread(target=_relaunch, daemon=True).start()
    return jsonify(status='ok')


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(force=True) or {}
    if data.get('password') == AUTH['password']:
        session['authed'] = True
        session.permanent = True
        return jsonify(status='ok')
    return jsonify(status='error', message='wrong password'), 401


@app.before_request
def _guard_tunnel_auth():
    # LAN/.local/localhost access is unauthenticated exactly as before -- this
    # only gates requests that arrive through the internet-facing tunnel host.
    host = request.host.split(':')[0]
    if not host.endswith(TUNNEL_HOST_SUFFIX):
        return
    if request.path == '/api/login' or not request.path.startswith('/api/'):
        return
    if session.get('authed'):
        return
    return jsonify(status='error', message='auth required'), 401


@app.route('/replay.html')
def serve_replay():
    return send_from_directory(REPO_ROOT, 'replay.html')


@app.route('/server.html')
def serve_server_page():
    return send_from_directory(REPO_ROOT, 'server.html')


@app.route('/')
def index():
    return send_from_directory(REPO_ROOT, 'server.html')


def lan_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


if __name__ == '__main__':
    ip = lan_ip()
    local_host = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True).stdout.strip()
    print(f'STINT9 replay server starting on http://localhost:{PORT}/server.html')
    if local_host:
        # stable across network changes (unlike the DHCP-assigned IP below) --
        # this is the address replay.html's "Open control page" link points at,
        # so keep it in sync there if this Mac's name (System Settings > Sharing)
        # ever changes.
        print(f'  fixed link for other laptops on this network: http://{local_host}.local:{PORT}/server.html')
    if ip:
        print(f'  (raw LAN IP right now, will change: http://{ip}:{PORT}/server.html)')
    print(f'  if you run a Cloudflare Tunnel (cloudflared tunnel --url http://localhost:{PORT}) for internet access,'
          f' the *.trycloudflare.com link it prints will ask for this password: {AUTH["password"]}')
    # 0.0.0.0: other machines on the same LAN/hotspot can open the dashboard too
    # (they only view/control this Mac's single capture session, same as this tab).
    # macOS may prompt to allow incoming connections for Python the first time.
    # Retry the bind for a few seconds -- covers /api/restart's brief window
    # where the old process hasn't released the port yet, and a plain manual
    # relaunch racing a not-quite-dead previous instance.
    for attempt in range(10):
        try:
            app.run(debug=False, host='0.0.0.0', port=PORT)
            break
        except OSError as e:
            if attempt == 9:
                raise
            print(f'  port {PORT} still in use ({e}), retrying...')
            time.sleep(0.5)
