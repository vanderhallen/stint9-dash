#!/usr/bin/env python3
"""One-off/repeatable cleanup: merge REPLAY clips already uploaded to Supabase
Storage that sit close together in time -- the same fix detection_loop() in
replay_server.py now applies live (MERGE_GAP_S), applied retroactively to
whatever was captured before that fix existed.

Groups clips (per video) where the gap between one clip ending and the next
starting is <= --gap seconds, downloads and concatenates each group with
ffmpeg, uploads the merged clip + a poster frame, and prints the original
object names to delete.

NOTE: the anon/publishable key this project uses client-side has an INSERT +
SELECT policy on the replay-clips bucket but deliberately no DELETE policy
(public delete on a key that's visible in this public repo would let anyone
wipe the bucket) -- so this script uploads the merged replacements but
cannot remove the originals itself. It prints the exact `storage.objects`
names to delete; run that delete with DB-level access (e.g. via the
Supabase SQL editor / service role), not through this script.

Usage:
    source ~/Documents/Terminal/venv/bin/activate
    python3 tools/merge_nearby_clips.py --video=vvTv_nIhDxg
    python3 tools/merge_nearby_clips.py --video=vvTv_nIhDxg --gap=8 --dry-run
"""
import argparse
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests

SB = 'https://esvvzgxqnfszhttdkuzc.supabase.co'
KEY = 'sb_publishable_svmP7ATfuf9eK-jJGXjlYQ_qC8nONLU'
BUCKET = 'replay-clips'
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}

NAME_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(\d+)s\.(mp4|webm)$')


def parse_dashed_iso(s):
    m = re.match(r'^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$', s)
    dt = datetime.strptime(f'{m[1]}T{m[2]}:{m[3]}:{m[4]}.{m[5]}000', '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)
    return dt.timestamp()


def to_dashed_iso(ts):
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime('%Y-%m-%dT%H-%M-%S-') + f'{dt.microsecond // 1000:03d}Z'


def list_clips(video_id):
    r = requests.post(
        f'{SB}/storage/v1/object/list/{BUCKET}', headers={**H, 'Content-Type': 'application/json'},
        json={'prefix': f'{video_id}/', 'limit': 500, 'sortBy': {'column': 'name', 'order': 'asc'}}, timeout=30,
    )
    r.raise_for_status()
    clips = []
    for obj in r.json():
        m = NAME_RE.match(obj['name'])
        if not m:
            continue
        start = parse_dashed_iso(m[1])
        clips.append({'name': obj['name'], 'start': start, 'dur': int(m[2]), 'ext': m[3]})
    clips.sort(key=lambda c: c['start'])
    return clips


def group_clips(clips, gap_s):
    groups, cur = [], []
    for c in clips:
        if cur and c['start'] - (cur[-1]['start'] + cur[-1]['dur']) > gap_s:
            groups.append(cur)
            cur = []
        cur.append(c)
    if cur:
        groups.append(cur)
    return groups


def download(video_id, name, dest):
    r = requests.get(f'{SB}/storage/v1/object/public/{BUCKET}/{video_id}/{name}', timeout=60)
    r.raise_for_status()
    dest.write_bytes(r.content)


def upload(path, object_path, content_type):
    with open(path, 'rb') as f:
        r = requests.post(
            f'{SB}/storage/v1/object/{BUCKET}/{object_path}',
            headers={**H, 'Content-Type': content_type, 'x-upsert': 'true'},
            data=f.read(), timeout=120,
        )
    r.raise_for_status()


def merge_group(video_id, group, dry_run):
    start = group[0]['start']
    end = max(c['start'] + c['dur'] for c in group)
    merged_dur = round(end - start)
    new_name = f'{to_dashed_iso(start)}_{merged_dur}s.mp4'
    print(f'  merging {len(group)} clips -> {new_name} ({merged_dur}s)')
    for c in group:
        print(f'    - {c["name"]} (start {datetime.fromtimestamp(c["start"], tz=timezone.utc).strftime("%H:%M:%S")}, {c["dur"]}s)')
    if dry_run:
        return None
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        parts = []
        for i, c in enumerate(group):
            p = td / f'part_{i}.{c["ext"]}'
            download(video_id, c['name'], p)
            parts.append(p)
        concat_list = td / 'concat.txt'
        concat_list.write_text(''.join(f"file '{p}'\n" for p in parts))
        out = td / 'merged.mp4'
        r = subprocess.run(
            ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat_list), '-c', 'copy', str(out)],
            capture_output=True,
        )
        if not out.exists() or out.stat().st_size == 0:
            # fall back to a re-encode concat if the segments don't share codec params for stream copy
            r = subprocess.run(
                ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat_list),
                 '-c:v', 'libx264', '-preset', 'veryfast', '-an', str(out)],
                capture_output=True,
            )
        if not out.exists() or out.stat().st_size == 0:
            print(f'    ffmpeg failed: {r.stderr.decode(errors="replace")[-500:]}', file=sys.stderr)
            return None
        upload(out, f'{video_id}/{new_name}', 'video/mp4')
        still = td / 'still.jpg'
        subprocess.run(['ffmpeg', '-y', '-ss', '0.4', '-i', str(out), '-frames:v', '1', '-q:v', '3', str(still)], capture_output=True)
        if still.exists() and still.stat().st_size > 0:
            upload(still, f'{video_id}/{new_name[:-4]}.jpg', 'image/jpeg')
    return new_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True, help='YouTube video id (the Storage folder name)')
    ap.add_argument('--gap', type=float, default=8.0, help='merge clips within this many seconds of each other (default 8, matches MERGE_GAP_S)')
    ap.add_argument('--dry-run', action='store_true', help="show groups without downloading/uploading/merging")
    args = ap.parse_args()

    clips = list_clips(args.video)
    print(f'{len(clips)} clip(s) found for {args.video}')
    groups = group_clips(clips, args.gap)
    to_delete = []
    for g in groups:
        if len(g) == 1:
            continue
        merge_group(args.video, g, args.dry_run)
        to_delete += [c['name'] for c in g] + [c['name'][:-4] + '.jpg' for c in g]

    if not to_delete:
        print('nothing to merge -- no clips are within the gap threshold of each other.')
        return
    if args.dry_run:
        print('\n(dry run -- nothing uploaded or deleted)')
        return
    print(f'\n{len(to_delete)} original object(s) to delete now that their merged replacements are uploaded'
          f' (the anon key has no delete policy on this bucket -- run this with DB access):\n')
    names = ", ".join("'" + n.replace("'", "''") + "'" for n in to_delete)
    print(f"delete from storage.objects where bucket_id='{BUCKET}' and name in ({names});")


if __name__ == '__main__':
    main()
