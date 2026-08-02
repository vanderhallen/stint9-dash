#!/usr/bin/env bash
# raceday.sh — keep the VDS/WIGE live relay running all day, restart if it dies.
# ---------------------------------------------------------------------------
# Start this once before the session and leave it. It runs vds-relay.mjs --watch
# (auto-detects the live eventId, then upserts laps to Supabase) and respawns it
# with capped backoff if it ever exits. Ctrl-C stops cleanly.
#
#   ./live/raceday.sh                 # scan eventIds 1..80, auto-detect
#   ./live/raceday.sh --range 1-120   # wider scan window
#   ./live/raceday.sh 24              # known eventId (skips the scan)
#
# All extra args are passed straight to vds-relay.mjs. Console output is also
# tee'd to live/logs/relay-<date>.log.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$DIR/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/relay-$(date +%Y%m%d).log"

# If no eventId/scan args given, default to --watch (auto-detect).
ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ]; then ARGS=(--watch); fi

CHILD=""
cleanup() { echo "[raceday] stopping…" | tee -a "$LOG"; [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null; exit 0; }
trap cleanup INT TERM

echo "[raceday] $(date '+%F %T') supervisor up — args: ${ARGS[*]}  log: $LOG" | tee -a "$LOG"

backoff=2
while true; do
  echo "[raceday] $(date '+%F %T') launching relay…" | tee -a "$LOG"
  # run the relay; tee its output to the log. Capture PID for clean shutdown.
  node "$DIR/vds-relay.mjs" "${ARGS[@]}" 2>&1 | tee -a "$LOG" &
  CHILD=$!
  wait "$CHILD"
  code=$?
  # 130 = Ctrl-C forwarded to node; the trap handles real shutdown.
  echo "[raceday] $(date '+%F %T') relay exited (code $code) — restarting in ${backoff}s" | tee -a "$LOG"
  sleep "$backoff"
  backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
done
