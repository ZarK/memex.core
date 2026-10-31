#!/usr/bin/env bash
# Starts an app with scratch folders and checks it against contracts/surfaces.md with memex-surfaces check.
# Usage: surfaces-check.sh <app id> <start command> [<cli name>=<JavaScript entry>]
# The start command runs in the background from the repository root. It must start the app's server, which writes
# its app record to $MEMEX_APPS_DIR. The check runs when the record says the app runs; the app is stopped after it.
# With <cli name>=<entry>, the CLI is put on PATH as that name (node <entry>), as an install would, so the record's
# MCP command (for example memex-contacts mcp) runs.
# Exits with the check's code (0 passed, 1 failed, 2 usage), or 3 when the app did not start and write a running record.
set -euo pipefail
app=$1
start=$2
cli=${3:-}
core=$(cd "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/memex-surfaces-XXXXXX")
# Only scratch folders: never a real data folder, archive, apps folder, Photos library or pack store.
export MEMEX_HOME="$scratch/home" MEMEX_ARCHIVE_HOME="$scratch/archive" MEMEX_APPS_DIR="$scratch/apps"
export MEMEX_PHOTOS_LIBRARY="$scratch/photos" MEMEX_PACKS_DIR="$scratch/packs"
export XDG_CACHE_HOME="$scratch/xdg/cache" XDG_STATE_HOME="$scratch/xdg/state" XDG_DATA_HOME="$scratch/xdg/data" XDG_CONFIG_HOME="$scratch/xdg/config"
mkdir -p "$MEMEX_HOME" "$MEMEX_ARCHIVE_HOME" "$MEMEX_APPS_DIR"
if [ -n "$cli" ]; then
  mkdir -p "$scratch/bin"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$(pwd)/${cli#*=}" > "$scratch/bin/${cli%%=*}"
  chmod +x "$scratch/bin/${cli%%=*}"
  export PATH="$scratch/bin:$PATH"
  echo "${cli%%=*} runs node $(pwd)/${cli#*=}"
fi
record="$MEMEX_APPS_DIR/$app.json"
setsid bash -c "$start" > "$scratch/app.log" 2>&1 &
pid=$!
stop() {
  kill -TERM -- "-$pid" 2> /dev/null || true
  sleep 2
  kill -KILL -- "-$pid" 2> /dev/null || true
}
trap stop EXIT
running() {
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(r.running?0:1)' "$record" 2> /dev/null
}
for _ in $(seq 1 120); do
  running && break
  if ! kill -0 "$pid" 2> /dev/null; then
    echo "The app stopped before it wrote a running record:"; cat "$scratch/app.log"; exit 3
  fi
  sleep 0.5
done
if ! running; then
  echo "No running record for $app after 60 seconds:"; cat "$scratch/app.log"; exit 3
fi
echo "The app record of $app:"
cat "$record"
echo
status=0
node "$core/packages/surfaces/dist/bin.js" check "$app" --apps "$MEMEX_APPS_DIR" || status=$?
if [ "$status" -ne 0 ]; then
  echo "--- the app's output:"; cat "$scratch/app.log"
fi
exit "$status"
