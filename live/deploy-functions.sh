#!/usr/bin/env bash
# Deploy the LIVE-pipeline edge functions to Supabase.
#
# The functions live under live/<name>/ (not the supabase/functions/<name>/ layout
# the CLI expects — they were originally deployed via the Supabase MCP), so this
# stages them into a temp dir with the right structure and deploys from there.
#
#   SUPABASE_ACCESS_TOKEN=<token> ./live/deploy-functions.sh
#
# Token: create one at https://supabase.com/dashboard/account/tokens
# --no-verify-jwt keeps them callable with the publishable key (the ⟳ Update
# button) and the service key (pg_cron) — matching how they're deployed today.
set -euo pipefail

REF="${SUPABASE_PROJECT_REF:-esvvzgxqnfszhttdkuzc}"
: "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN — create one at https://supabase.com/dashboard/account/tokens}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNCS=(wige-scrape nls-schedule-scrape)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/supabase/functions"
for fn in "${FUNCS[@]}"; do
  cp -r "$ROOT/live/$fn" "$STAGE/supabase/functions/$fn"
done

cd "$STAGE"
for fn in "${FUNCS[@]}"; do
  echo "== deploying $fn to $REF =="
  npx -y supabase@latest functions deploy "$fn" --project-ref "$REF" --no-verify-jwt
done
echo "== all functions deployed =="
