#!/usr/bin/env python3
"""Local server for the STINT9 replay-clip catcher (replay.html).

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
import signal
import subprocess
import threading
import time
from pathlib import Path

import cv2
import pytesseract
import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

PORT = 5057
REPO_ROOT = Path(__file__).resolve().parent.parent
SESSIONS_DIR = Path(os.path.expanduser('~/Documents/Terminal/replay-sessions'))
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
COOKIES_PATH = Path(os.path.expanduser('~/Documents/Terminal/youtube-cookies.txt'))

# same project + publishable key the rest of stint9-dash already uses client-side
SB = 'https://esvvzgxqnfszhttdkuzc.supabase.co'
KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU'
BUCKET = 'replay-clips'

SAMPLE_STEP = 1.0   # video-seconds between OCR samples
DEBOUNCE_N = 2      # consecutive same-state samples required before flipping badge state
MIN_VIDEO_BYTES = 400_000

app = Flask(__name__, static_folder=None)
CORS(app, allow_private_network=True)

lock = threading.Lock()
session = None   # single active session; this is a one-user local tool, not multi-tenant


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
    clip_path = sess['dir'] / f'clip_{idx}.mp4'
    subprocess.run(
        ['ffmpeg', '-y', '-ss', str(start_t), '-i', str(src),
         '-t', str(dur), '-c', 'copy', '-avoid_negative_ts', 'make_zero', str(clip_path)],
        capture_output=True,
    )
    if not clip_path.exists() or clip_path.stat().st_size == 0:
        subprocess.run(
            ['ffmpeg', '-y', '-ss', str(start_t), '-i', str(src),
             '-t', str(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-an', str(clip_path)],
            capture_output=True,
        )
    if not clip_path.exists() or clip_path.stat().st_size == 0:
        return
    broadcast_start = sess.get('broadcast_start')
    real_ms = int((broadcast_start + start_t) * 1000) if broadcast_start else int(time.time() * 1000)
    iso = time.strftime('%Y-%m-%dT%H-%M-%S', time.gmtime(real_ms / 1000)) + f'-{real_ms % 1000:03d}Z'
    obj_path = f"{sess['video_id']}/{iso}_{round(dur)}s.mp4"
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
    except Exception as e:
        with lock:
            sess['error'] = f'upload failed: {e}'
        return
    with lock:
        sess['clips_found'] = sess.get('clips_found', 0) + 1
    clip_path.unlink(missing_ok=True)


def detection_loop(sess):
    next_t = 0.0
    badge_on = False
    pending, pending_n = None, 0
    clip_start_t = None
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
                        clip_start_t = next_t
                        save_hit_frame(sess, frame, calib, next_t)
                    elif clip_start_t is not None:
                        clip_idx += 1
                        threading.Thread(
                            target=cut_and_upload,
                            args=(sess, clip_start_t, next_t, clip_idx),
                            daemon=True,
                        ).start()
                        clip_start_t = None

            next_t += SAMPLE_STEP
    finally:
        close_cap()
        if badge_on and clip_start_t is not None:
            clip_idx += 1
            threading.Thread(
                target=cut_and_upload,
                args=(sess, clip_start_t, next_t, clip_idx),
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
    global session
    data = request.get_json(force=True) or {}
    url = data.get('url', '')
    vid = yt_id(url)
    if not vid:
        return jsonify(status='error', message='not a YouTube link'), 400
    with lock:
        if session and not session.get('stopped'):
            if session.get('video_id') == vid:
                return jsonify(status='running')
            return jsonify(status='error', message='already monitoring a different video — stop first'), 409
        sess_dir = SESSIONS_DIR / f'{vid}-{int(time.time())}'
        sess_dir.mkdir(parents=True, exist_ok=True)
        session = {
            'video_id': vid, 'dir': sess_dir, 'downloading': True,
            'scan_mode': 'catchup', 'badge_on': False, 'clips_found': 0,
            'calib': None, 'preview_ready': False, 'scanned_t': 0.0,
            'stopped': False, 'broadcast_start': None, 'error': None,
            'last_dl_line': '', 'video_path': None, 'hits': [],
        }
        sess = session
    start_download(sess, url)
    threading.Thread(target=fill_broadcast_start, args=(sess, url), daemon=True).start()
    threading.Thread(target=detection_loop, args=(sess,), daemon=True).start()
    return jsonify(status='started')


@app.route('/api/monitor/status')
def monitor_status():
    with lock:
        if not session:
            return jsonify(active=False)
        s = session
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
        if not session or not session.get('preview_ready'):
            return jsonify(status='error'), 404
        d = session['dir']
    return send_from_directory(d, 'preview.jpg')


@app.route('/api/monitor/hit/<int:idx>.jpg')
def monitor_hit(idx):
    with lock:
        if not session:
            return jsonify(status='error'), 404
        d = session['dir']
    resp = send_from_directory(d, f'hit_{idx}.jpg')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/api/monitor/calibrate', methods=['POST'])
def monitor_calibrate():
    data = request.get_json(force=True) or {}
    with lock:
        if not session:
            return jsonify(status='error'), 400
        try:
            session['calib'] = {k: float(data[k]) for k in ('x', 'y', 'w', 'h')}
        except (KeyError, TypeError, ValueError):
            return jsonify(status='error', message='bad crop region'), 400
    return jsonify(status='ok')


@app.route('/api/monitor/stop', methods=['POST'])
def monitor_stop():
    global session
    proc = None
    with lock:
        if session:
            session['stopped'] = True
            proc = session.get('proc')
        session = None
    kill_proc(proc)
    return jsonify(status='ok')


@app.route('/replay.html')
def serve_replay():
    return send_from_directory(REPO_ROOT, 'replay.html')


@app.route('/')
def index():
    return send_from_directory(REPO_ROOT, 'replay.html')


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
    print(f'STINT9 replay server starting on http://localhost:{PORT}')
    if local_host:
        # stable across network changes (unlike the DHCP-assigned IP below) --
        # this is the address replay.html itself falls back to when opened
        # from the deployed site, so keep it in sync with CAPTURE_HOST there
        # if this Mac's name (System Settings > Sharing) ever changes.
        print(f'  fixed link for other laptops on this network: http://{local_host}.local:{PORT}/replay.html')
    if ip:
        print(f'  (raw LAN IP right now, will change: http://{ip}:{PORT}/replay.html)')
    # 0.0.0.0: other machines on the same LAN/hotspot can open the dashboard too
    # (they only view/control this Mac's single capture session, same as this tab).
    # macOS may prompt to allow incoming connections for Python the first time.
    app.run(debug=False, host='0.0.0.0', port=PORT)
