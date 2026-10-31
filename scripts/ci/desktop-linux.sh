#!/usr/bin/env bash
# The Linux installers of the Memex desktop shell, built and used for real: Memex Hello is packed as an
# AppImage and a deb, the deb is installed with apt, and each one is started under Xvfb with scratch folders. The app
# must show its page (the cookie read and the cookie write both answered), write a running app record, and pass
# memex-surfaces check through that record (HTTP API, MCP and CLI through the shim of the deb); after SIGTERM the
# record must say it stopped.
# Usage, from the memex.core root after pnpm install and pnpm build: bash scripts/ci/desktop-linux.sh <empty folder>
set -euo pipefail
core=$(pwd)
out=$1
mkdir -p "$out"
out=$(cd "$out" && pwd)
hello="$core/packages/desktop/examples/hello"
surfaces="$core/packages/surfaces/dist/bin.js"
step() { echo; echo "=== $*"; }

step "Electron for the example (checked against the checksums of the electron package), the notices, the installers"
cd "$hello"
node ../../dist/bin.js fetch-electron
node ../../../licenses/dist/bin.js check --repo ../../../.. --importer packages/desktop/examples/hello --electron-dist node_modules/electron/dist
node ../../../licenses/dist/bin.js notices --out build/notices --repo ../../../.. --importer packages/desktop/examples/hello --electron-dist node_modules/electron/dist --product "Memex Hello"
node ../../dist/bin.js pack
ls -l release
cat release/SHA256SUMS.txt
appimage=$(ls release/*-linux-x64.AppImage)
deb=$(ls release/*-linux-x64.deb)
(cd release && sha256sum -c SHA256SUMS.txt)

# run <label> <program> [surfaces check options]: starts the program, checks it, stops it.
run() {
  local label=$1 program=$2
  shift 2
  local root="$out/$label"
  local proof="$root/proof"
  mkdir -p "$root"
  step "$label: start $program"
  # A desktop session: its own D-Bus session bus and an X display. The runner has no GPU, so Chromium draws in
  # software (--disable-gpu); without it, capturing the window fails under Xvfb.
  MEMEX_HELLO_ROOT="$root" MEMEX_HELLO_PROOF="$proof" dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "$program" --disable-gpu > "$root/app.log" 2>&1 &
  local runner=$!
  for _ in $(seq 1 120); do
    [ -f "$proof/window-1.txt" ] && break
    if ! kill -0 "$runner" 2> /dev/null; then echo "The app stopped:"; cat "$root/app.log"; return 1; fi
    sleep 0.5
  done
  if [ ! -f "$proof/window-1.txt" ]; then echo "No window after 60 seconds:"; cat "$root/app.log"; cat "$proof/events.jsonl" 2> /dev/null; return 1; fi
  echo "--- the shell's events:"
  node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e = JSON.parse(l); console.log(e.type, e.url ?? e.announcement?.url ?? e.title ?? "") }' "$proof/events.jsonl"
  echo "--- the text of the window:"
  cat "$proof/window-1.txt"; echo
  if grep -q waiting "$proof/window-1.txt"; then echo "The page did not get both answers."; return 1; fi
  echo "--- the app record:"
  cat "$root/Apps/hello.json"; echo
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!r.running) process.exit(1)' "$root/Apps/hello.json"
  node "$surfaces" check hello --apps "$root/Apps" "$@"
  local main
  main=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n"); console.log(JSON.parse(l[0]).mainPid)' "$proof/events.jsonl")
  step "$label: quit (SIGTERM to the main process $main)"
  kill -TERM "$main"
  for _ in $(seq 1 40); do kill -0 "$main" 2> /dev/null || break; sleep 0.5; done
  if kill -0 "$main" 2> /dev/null; then echo "The app did not quit."; return 1; fi
  wait "$runner" || true
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("running after quit:", JSON.stringify(r.running)); if (r.running) process.exit(1)' "$root/Apps/hello.json"
}

step "The deb, installed with apt"
dpkg-deb --info "$deb" | sed -n '1,20p'
sudo apt-get install -y -q "$PWD/$deb"
desktop=$(dpkg -L "$(dpkg-deb -f "$deb" Package)" | grep '\.desktop$' | head -1)
cat "$desktop"
program=$(sed -n 's/^Exec=\("[^"]*"\|[^ ]*\).*/\1/p' "$desktop" | head -1 | tr -d '"')
echo "Program: $program"
ls -l "$(dirname "$program")/chrome-sandbox"
shim="$(dirname "$program")/resources/bin/memex-hello"
MEMEX_HELLO_ROOT="$out/shim" "$shim" about --json
run deb "$program"

step "The AppImage (it runs from its own mount; its record names the AppImage and has no MCP command)"
chmod +x "$appimage"
cp "$appimage" "$out/Memex.Hello.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 run appimage "$out/Memex.Hello.AppImage" --skip-commands

step "Done: the AppImage and the deb were built, started, checked and stopped"
