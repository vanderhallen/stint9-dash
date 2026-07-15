#!/usr/bin/env python3
"""make_clips.py — cut the racenote overtake clips from the full race video.

Companion to the stint9-dash racenote panel (index.html, left sidebar). The
browser "Analyse" button computes every clip spec from the recorded #665
overtakes and exports a `clips_665_<YYYYMMDD>.json`. This tool does the actual
cutting with ffmpeg and applies the naming convention
`YYYYMMDD_car_Llap_Ssector_Px_Py.mp4` (e.g. 20260620_665_L2_S3_P4_P3.mp4).

Two ways to get the jobs:

  1. From the exported JSON (offline, no network):
       python3 tools/make_clips.py --jobs clips_665_20260620.json \\
               --video /path/to/full_race.mp4

  2. Straight from Supabase (pulls #665 overtake notes for an event and rebuilds
     the same specs — you still supply the video, the video-start time-of-day and
     the +/- pad, since those live in the browser, not the DB):
       python3 tools/make_clips.py --event 2026-06-20 \\
               --video /path/to/full_race.mp4 \\
               --video-start 12:05:00 --pad 20

The `dropbox_url` in the JSON is recorded for reference; downloading is left to
you (a multi-hour race video is many GB). Point --video at the local file. If you
must stream a Dropbox link directly, pass its direct-download form
(…?dl=1 / dl.dropboxusercontent.com) as --video — ffmpeg can read an http(s) URL,
but stream-copy seeking over the network is slow; a local file is strongly
preferred.

By default clips are stream-copied (`-c copy`, instant, no re-encode). Because
stream-copy can only cut on keyframes the real in-point may drift by up to the
GOP length; pass --reencode for frame-accurate cuts (slower).
"""
import argparse, json, os, subprocess, sys, urllib.request, urllib.parse

SB_URL = "https://esvvzgxqnfszhttdkuzc.supabase.co"
SB_KEY = "sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU"
SECKM  = [3.3, 3.3, 6.0, 9.4, 2.4]   # NLS 5-sector estimated lengths (nls-sector-layout.md)


def parse_tod(s):
    """'hh:mm:ss(.ms)' or plain seconds -> seconds of day (float)."""
    s = str(s).strip()
    if ":" in s:
        acc = 0.0
        for part in s.split(":"):
            acc = acc * 60 + float(part)
        return acc
    return float(s)


def jobs_from_supabase(event, video_url, video_start_tod, pad):
    """Rebuild clip specs from public.stint9_racenotes (#665 overtakes, S2-S5)."""
    q = ("/rest/v1/stint9_racenotes?select=lap,sector,kind,meta,tod"
         "&event_date=eq." + urllib.parse.quote(event) +
         "&car=eq.665&kind=eq.overtake&order=tod")
    req = urllib.request.Request(SB_URL + q,
                                 headers={"apikey": SB_KEY,
                                          "Authorization": "Bearer " + SB_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.load(r)
    ed = event.replace("-", "")
    jobs = []
    for n in rows:
        sec = n.get("sector")
        m = n.get("meta") or {}
        if not sec or sec == 1 or m.get("tcross") is None:
            continue  # S1 excluded (pit/out zone), need a crossover time
        g0, g1 = abs(m.get("g0", 0.0)), abs(m.get("g1", 0.0))
        f = g0 / ((g0 + g1) or 1)
        tcross = float(m["tcross"])
        start = max(0.0, tcross - pad - video_start_tod)
        end = tcross + pad - video_start_tod
        jobs.append({
            "filename": f"{ed}_665_L{n['lap']}_S{sec}_P{m.get('px')}_P{m.get('py')}",
            "dropbox_url": video_url or "",
            "start_s": round(start, 2), "end_s": round(end, 2),
            "sector": sec, "lap": n["lap"], "px": m.get("px"), "py": m.get("py"),
            "gain": m.get("gain") is not False, "tcross_tod": round(tcross, 2),
            "dist_into_sector_km": round(f * (SECKM[sec - 1] if 1 <= sec <= 5 else 0), 2),
        })
    return jobs


def cut(video, job, outdir, reencode):
    out = os.path.join(outdir, job["filename"] + ".mp4")
    start, end = float(job["start_s"]), float(job["end_s"])
    dur = max(0.0, end - start)
    # -ss before -i = fast seek; stream-copy by default, re-encode if requested.
    cmd = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", video, "-t", f"{dur:.3f}"]
    cmd += (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac"]
            if reencode else ["-c", "copy"])
    cmd += ["-avoid_negative_ts", "make_zero", out]
    print(f"  -> {job['filename']}.mp4  [{start:.1f}s .. {end:.1f}s]  S{job['sector']}"
          f"  ~{job.get('dist_into_sector_km','?')}km in")
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if res.returncode != 0:
        sys.stderr.write(res.stderr.decode(errors="replace")[-800:] + "\n")
        return False
    return True


def main():
    ap = argparse.ArgumentParser(description="Cut racenote overtake clips with ffmpeg.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--jobs", help="clips_665_<date>.json exported by the Analyse button")
    src.add_argument("--event", help="event date YYYY-MM-DD (pull specs from Supabase)")
    ap.add_argument("--video", required=True, help="path (or http/Dropbox direct URL) to the full race video")
    ap.add_argument("--video-start", help="video start time-of-day hh:mm:ss (required with --event)")
    ap.add_argument("--pad", type=float, default=20.0, help="+/- seconds around the overtake (default 20; --event only)")
    ap.add_argument("--outdir", default="clips", help="output directory (default ./clips)")
    ap.add_argument("--reencode", action="store_true", help="frame-accurate re-encode instead of stream-copy")
    a = ap.parse_args()

    if a.jobs:
        with open(a.jobs) as f:
            data = json.load(f)
        jobs = data.get("jobs", data if isinstance(data, list) else [])
    else:
        if not a.video_start:
            ap.error("--video-start is required with --event")
        jobs = jobs_from_supabase(a.event, a.video, parse_tod(a.video_start), a.pad)

    if not jobs:
        print("No on-track overtake clips (S2-S5) to cut.")
        return
    os.makedirs(a.outdir, exist_ok=True)
    print(f"Cutting {len(jobs)} clip(s) from {a.video} -> {a.outdir}/")
    ok = sum(cut(a.video, j, a.outdir, a.reencode) for j in jobs)
    print(f"Done: {ok}/{len(jobs)} clip(s) written.")
    if ok != len(jobs):
        sys.exit(1)


if __name__ == "__main__":
    main()
