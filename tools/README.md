# stint9-dash tools

Helper scripts that support the static dashboard (they are **not** shipped to the
page — run them locally).

## `gen_db.py`
Regenerates the embedded `const DB = {…}` (in `index.html` and `data.js`) from an
official VLN/NLS sector-times CSV. See [../data-source.md](../data-source.md).

## Overtake clips — primary flow is in-browser

Clips of the **selected car**'s on-track overtakes are now cut **in the browser**
from a locally-selected video, in the dashboard's **VIDEO** reel (4th panel of the
right-side weather/agenda reel in `index.html`):

1. Let the race play so overtake notes accumulate for the selected car (LIVE saves
   them to Supabase `public.stint9_racenotes`; SIM keeps them in memory).
2. Open the **VIDEO** reel (▲▼ next to the timetable) and choose the **race video
   file** from this computer. The **race clock** is read automatically from the
   video's burned-in top-left timestamp (OCR); the video is a continuous real-time
   recording, so that anchors video t=0 to race time-of-day. Set **± sec**
   (default 20).
3. Click **ANALYSE & CLIP**. ffmpeg.wasm cuts each overtake ±N s and names it
   `YYYYMMDD_car_Llap_Ssector_Px_Py.mp4` (e.g. `20260620_665_L2_S3_P4_P3.mp4`).
   Each clip appears as a **download link in the reel — click to save it locally**,
   then commit the files into `clips/` yourself (e.g. via VS Code). **Sector 1 is
   excluded** (pit/out zone).

## `make_clips.py` — offline / batch fallback

Still available for cutting from a full local video without the browser (e.g. a
huge recording, or no token). It reads specs straight from Supabase (or a
`jobs.json`) and cuts with local `ffmpeg`:

   ```bash
   python3 tools/make_clips.py --event 2026-06-20 --video full_race.mp4 \
           --video-start 12:05:00 --pad 20
   ```

Requires `ffmpeg` on PATH. Output goes to `./clips/`, named
`YYYYMMDD_car_Llap_Ssector_Px_Py.mp4` (e.g. `20260620_665_L2_S3_P4_P3.mp4`).

Notes:
- **Sector 1 is excluded** — it holds the pit lane / out-zone, so passes there are
  usually a consequence of pit stops, not on-track overtakes.
- Where in the sector the pass happened is estimated from the gap at the sector
  entry vs. exit (`f = |g0| / (|g0| + |g1|)`), then ±pad seconds around that point
  gives the clip window. Sector lengths are the time-based estimates in
  [../nls-sector-layout.md](../nls-sector-layout.md).
- Default is stream-copy (`-c copy`, instant but cuts on keyframes); pass
  `--reencode` for frame-accurate clips.
