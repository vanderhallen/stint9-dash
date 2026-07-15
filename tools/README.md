# stint9-dash tools

Helper scripts that support the static dashboard (they are **not** shipped to the
page — run them locally).

## `gen_db.py`
Regenerates the embedded `const DB = {…}` (in `index.html` and `data.js`) from an
official VLN/NLS sector-times CSV. See [../data-source.md](../data-source.md).

## `make_clips.py` — racenote overtake clips
Cuts short video clips of car **#665**'s on-track overtakes from the full race
video, using the timestamps recorded by the racenote panel (left sidebar in
`index.html`, which replaces the starting grid once formation lap L0 is done).

Pipeline:

1. In the dashboard, let the race play so #665's overtake notes accumulate (they
   auto-save to Supabase `public.stint9_racenotes`). See
   [../racenotes-supabase.sql](../racenotes-supabase.sql).
2. In the racenote panel's **race video** section: paste the Dropbox link, enter
   the **video start time-of-day** (`hh:mm:ss` — anchors video t=0 to a race clock
   time), set **± sec** (default 20), and click **Analyse**. Download `jobs.json`.
3. Cut the clips:

   ```bash
   # from the exported jobs.json (offline)
   python3 tools/make_clips.py --jobs clips_665_20260620.json --video full_race.mp4

   # or straight from Supabase (supply the video-start + pad yourself)
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
