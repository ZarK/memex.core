#!/usr/bin/env bash
# Builds the Memex CI tools from this memex.core checkout: memex-licenses (the license check), memex-surfaces (the
# contract check of an app) and memex-desktop (its fetch-electron gives the license check Electron's Chromium
# credits). The reusable workflows check out memex.core at the commit the calling workflow pins and run this script.
set -euo pipefail
core=$(cd "$(dirname "$0")/../.." && pwd)
cd "$core"
pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
if ! command -v pnpm > /dev/null; then
  npm install --global --ignore-scripts "pnpm@$pnpm_version"
fi
# The lockfile is frozen and install scripts stay off (pnpm-workspace.yaml says so too).
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter "@tjalve/memex-licenses..." --filter "@tjalve/memex-surfaces..." --filter "@tjalve/memex-desktop..." build
for tool in licenses surfaces desktop; do
  test -f "packages/$tool/dist/bin.js"
done
echo "Memex CI tools built from memex.core $(git rev-parse HEAD 2>/dev/null || echo '(no git)')"
