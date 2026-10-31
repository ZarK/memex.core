#!/usr/bin/env bash
# The proof run of the client launchers and the outbox: a TypeScript app (proof-app.mjs on @tjalve/memex-user-client) and a C# app
# (user-outbox-proof on Memex.User.Client, memex.node) against the real Memex.User service, started by the client
# launchers from a scratch services folder. The services folder has its own Node.js runtime and service.json; the code
# that it runs is the built memex.user folder. The run ends with exit code 1 when any step did not have its result.
#
# Usage (Git Bash, after pnpm build here, pnpm build in memex.user, and dotnet build of tools/UserOutboxProof):
#   bash proof/proof.sh <empty scratch folder> <memex.user folder> <user-outbox-proof program>
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
P=$(cygpath -m "$1" 2>/dev/null || echo "$1")
USER_REPO=$(cygpath -m "$(cd "$2" && pwd)" 2>/dev/null || (cd "$2" && pwd))
CS=$3
mkdir -p "$P"
# Every Memex folder in the scratch folder, so the run leaves nothing in the real ones.
export MEMEX_HOME=$P/home MEMEX_APPS_DIR=$P/apps MEMEX_SERVICES_DIR=$P/services LOCALAPPDATA=$P/localappdata XDG_STATE_HOME=$P/state
unset MEMEX_USER_HOME
# User stops by itself after 8 s without a call, so the run sees it stop and start again.
export MEMEX_USER_IDLE_EXIT=8
FAILED=0
step() { echo; echo "=== $*"; }
fail() { echo "  FAILED: $*"; FAILED=$((FAILED+1)); }
# Each app call fails the run when it exits non-zero, for example when a report does not have its --expect values.
ts() { node "$HERE/proof/proof-app.mjs" --db "$P/ts-app.db" --app proofts "$@" || fail "proof-app $* (exit code $?)"; }
cs() { "$CS" --db "$P/cs-app.db" --app proofcs "$@" || fail "user-outbox-proof $* (exit code $?)"; }
user() { node "$USER_REPO/dist/bin.js" "$@"; }
running() { node -e "const fs=require('fs');if(!fs.existsSync(process.argv[1])){console.log('User has no app record yet');process.exit(0)}const r=require(process.argv[1]);console.log(r.running?'User runs: process '+r.running.pid+' at '+r.running.url:'User does not run (running is null)')" "$MEMEX_APPS_DIR/user.json"; }
wait_stop() {
  echo "waiting for User to stop by itself (8 s without a call) ..."
  for _ in $(seq 1 60); do
    node -e "process.exit(require(process.argv[1]).running?1:0)" "$MEMEX_APPS_DIR/user.json" && break
    sleep 0.5
  done
  running
}
# The id in the first JSON object of a show line (the C# app adds " protected: [...]" after it).
id_of() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s.trim().replace(/ protected: \[[^\]]*\]$/,'')).id))"; }
local_id() { sed -n 's/.* local id \(local_[0-9a-f]*\).*/\1/p'; }

V=$(node -e "console.log(require(process.argv[1]).version)" "$USER_REPO/package.json")
step "0. Memex User $V in the services folder: its own Node.js runtime and service.json (memex.service/1), which runs the built memex.user folder"
mkdir -p "$P/services/user/$V"
cp "$(command -v node)" "$P/services/user/$V/node.exe"
node -e "
const fs=require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({format:'memex.service/1',app:'user',version:process.argv[2],command:'node.exe',args:[process.argv[3],'serve']},null,2)+'\n');
" "$P/services/user/$V/service.json" "$V" "$(cygpath -w "$USER_REPO/dist/bin.js" 2>/dev/null || echo "$USER_REPO/dist/bin.js")"
cat "$P/services/user/$V/service.json"
sha256sum "$P/services/user/$V/node.exe" "$(command -v node)"

step "1. Photos claims (made-up trips, from memex.user scripts/proof) written with the real CLI while User does not run"
user claims write "$USER_REPO/scripts/proof/photos-trips-1.json" | head -3
user trips --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const t of JSON.parse(s).items)console.log('  '+t.id+' '+t.fields.title)})"
TRIP_A=$(user trips --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items.find(t=>t.fields.title==='Lisbon').id))")
TRIP_B=$(user trips --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items.find(t=>t.fields.title==='Bergen').id))")
echo "trip A (Lisbon) $TRIP_A, trip B (Bergen) $TRIP_B"
running

step "2. The TypeScript app reads the feed: ensureUser starts User detached from the services folder"
ts --expect applied=2,waiting=0 pull
running
ts list

step "3. The C# app reads the feed: EnsureUserAsync finds the running User"
cs --expect applied=2,waiting=0 pull
cs list

step "4. The TypeScript app saves an edit; User runs, so it is delivered at once"
ts --expect delivered=1,waiting=0 set "$TRIP_A" title '"Lisbon and Sintra"'

step "5. Stop User"
wait_stop

step "6. Both apps save more edits while User is stopped (and may not start): each edit is saved and waits"
ts --no-start --expect delivered=0,waiting=1 set "$TRIP_A" countries '["PT","ES"]'
ts --no-start --expect delivered=0,waiting=2 set "$TRIP_B" title '"Bergen, by the TypeScript app"'
cs --no-start --expect delivered=0,waiting=1 set "$TRIP_A" title '"Lisbon, Sintra and Cascais"'
cs --no-start --expect delivered=0,waiting=2 set "$TRIP_B" countries '["NO","SE"]'
echo "-- the local copies show the edits as saved:"
ts show "$TRIP_A"; ts show "$TRIP_B"
cs show "$TRIP_A"; cs show "$TRIP_B"
echo "-- the outboxes after both processes exited:"
ts outbox; cs outbox

step "7. The C# app restarts and syncs: EnsureUserAsync starts User again, and its two edits arrive"
cs --expect delivered=2,refused=0,waiting=0 sync
running

step "8. The C# app saves a later edit of trip B's title, delivered at once"
cs --expect delivered=1,waiting=0 set "$TRIP_B" title '"Bergen and Voss, by the C# app"'

step "9. The TypeScript app reads the feed without sending: the C# changes arrive, its own unsent edits stay"
ts --expect waiting=2 pull
ts show "$TRIP_A"; ts show "$TRIP_B"
ts outbox

step "10. The TypeScript app sends, and the answer is lost (the process stops before the outbox records it)"
node "$HERE/proof/proof-app.mjs" --db "$P/ts-app.db" --app proofts sync --lose-answer; CODE=$?
echo "exit code $CODE"; [ "$CODE" = 3 ] || fail "the lost-answer run ended with exit code $CODE, not 3"
ts outbox

step "11. Stop User again"
wait_stop

step "12. The TypeScript app restarts and syncs: ensureUser starts User, the two corrections go again, and User stores each once. Trip B's title edit of the TypeScript app is the earlier act, so it loses to the C# edit, and the app reads the record back once"
ts --expect delivered=2,repeats=2,readBack=1,waiting=0 sync
running
ts show "$TRIP_A"; ts show "$TRIP_B"
ts outbox

step "13. The C# app reads the feed"
cs --expect waiting=0 sync
cs show "$TRIP_A"; cs show "$TRIP_B"

step "14. Each trip field has the value of the edit that the person made last (by createdAt), whatever order the edits arrived in"
ts edits > "$P/ts-edits-1.json"
cs edits > "$P/cs-edits-1.json"
user trips --json > "$P/user-trips.json"
node -e "
const fs=require('fs');
const [tsF,csF,tF]=process.argv.slice(1);
const edits=[...JSON.parse(fs.readFileSync(tsF,'utf8')),...JSON.parse(fs.readFileSync(csF,'utf8'))].filter(e=>e.op==='set'&&e.record.startsWith('trip_'));
const trips=new Map(JSON.parse(fs.readFileSync(tF,'utf8')).items.map(t=>[t.id,t]));
const last=new Map();
for (const e of edits) { const k=e.record+' '+e.field; const p=last.get(k); if(!p||Date.parse(e.createdAt)>Date.parse(p.createdAt)) last.set(k,e); }
let wrong=0;
for (const [k,e] of last) {
  const [record,field]=k.split(' ');
  const has=JSON.stringify(trips.get(record).fields[field]);
  const ok=has===JSON.stringify(JSON.parse(e.value));
  if(!ok) wrong++;
  console.log('  '+record.slice(0,13)+'... '+field+': User has '+has+'; the last of '+edits.filter(x=>x.record+' '+x.field===k).length+' edit(s), at '+e.createdAt+', set '+e.value+(ok?'':'  WRONG'));
}
console.log(last.size+' fields checked, '+wrong+' wrong');
process.exit(wrong?1:0);
" "$P/ts-edits-1.json" "$P/cs-edits-1.json" "$P/user-trips.json" || fail "a trip field does not have the value of the last edit"
user show "$TRIP_B" | head -12

step "15. Stop User again"
wait_stop

step "16. While User is stopped: the TypeScript app creates a home and edits it by its local id, saves a set that User will refuse (a field that a trip does not have), and clears the home's type, which User will hold; the C# app creates a home, edits it by its local id, and merges trip B into trip A"
OUT=$(node "$HERE/proof/proof-app.mjs" --db "$P/ts-app.db" --app proofts --no-start --expect delivered=0,waiting=1 save '{"op":"create","kind":"home","fields":{"type":"home","label":"Proof flat","town":"Bergen","country":"NO","from":"2019"},"sources":[{"app":"proofts","kind":"home","id":"proof-home-1"}]}') || fail "the TypeScript create"
echo "$OUT"
L_TS=$(echo "$OUT" | local_id)
ts --no-start --expect delivered=0,waiting=2 save "{\"op\":\"set\",\"record\":\"$L_TS\",\"fields\":{\"label\":\"The flat by the harbour\"}}"
ts --no-start --expect delivered=0,waiting=3 save "{\"op\":\"set\",\"record\":\"$TRIP_A\",\"fields\":{\"nonsense\":1}}"
ts --no-start --expect delivered=0,waiting=4 save "{\"op\":\"clear\",\"record\":\"$L_TS\",\"names\":[\"type\"]}"
OUT=$("$CS" --db "$P/cs-app.db" --app proofcs --no-start --expect delivered=0,waiting=1 save '{"op":"create","kind":"home","fields":{"type":"cabin","label":"Proof cabin","town":"Voss","country":"NO","from":"2021"},"sources":[{"app":"proofcs","kind":"home","id":"proof-home-2"}]}') || fail "the C# create"
echo "$OUT"
L_CS=$(echo "$OUT" | local_id)
cs --no-start --expect delivered=0,waiting=2 save "{\"op\":\"set\",\"record\":\"$L_CS\",\"fields\":{\"label\":\"The cabin at Voss\"}}"
cs --no-start --expect delivered=0,waiting=3 save "{\"op\":\"merge\",\"records\":[\"$TRIP_A\",\"$TRIP_B\"]}"
echo "-- the local copies show the new homes under their local ids:"
ts show "$L_TS"; cs show "$L_CS"
ts outbox; cs outbox

step "17. The TypeScript app syncs: ensureUser starts User; the create goes first and the edit of its local id goes with the record id; User refuses the call with the bad set, so the corrections go one at a time: the bad one keeps its mark and waits, and the clear is held"
ts --expect delivered=3,refused=1,held=1,waiting=1 sync
running
echo "-- the local copy has the home under User's record id, and the held type is protected:"
ts show "$L_TS"
ts outbox
ts held
HOME_TS=$(ts show "$L_TS" | id_of)
echo "TypeScript home: $L_TS is now $HOME_TS"
case "$HOME_TS" in home_*) ;; *) fail "the TypeScript home has no record id";; esac

step "18. The C# app syncs: its create, the edit of its local id, and the merge arrive"
cs --expect delivered=3,refused=0,held=0,waiting=0 sync
cs show "$L_CS"
HOME_CS=$(cs show "$L_CS" | id_of)
echo "C# home: $L_CS is now $HOME_CS"
case "$HOME_CS" in home_*) ;; *) fail "the C# home has no record id";; esac

step "19. The TypeScript app reads the feed: trip B comes as removed and merged into trip A, and the C# home arrives"
ts --expect waiting=1 pull
ts show "$TRIP_B"
ts show "$HOME_CS"
MERGED=$(ts show "$TRIP_B" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.removed===true&&r.mergedInto===process.argv[1]?'yes':'no')})" "$TRIP_A")
[ "$MERGED" = yes ] || fail "trip B is not removed and merged into trip A in the TypeScript app's local copy"
user homes
user show "$HOME_TS" | head -8

step "20. Every edit arrived exactly once, except the one that User refused, which waits in the outbox with its mark"
ts edits > "$P/ts-edits.json"
cs edits > "$P/cs-edits.json"
user corrections --json > "$P/user-corrections.json"
node -e "
const fs=require('fs');
const [tsF,csF,uF]=process.argv.slice(1);
const edits=[...JSON.parse(fs.readFileSync(tsF,'utf8')).map(e=>({...e,app:'proofts'})),...JSON.parse(fs.readFileSync(csF,'utf8')).map(e=>({...e,app:'proofcs'}))];
const stored=JSON.parse(fs.readFileSync(uF,'utf8')).items;
const refused=edits.filter(e=>e.refused);
const ops=[...new Set(edits.map(e=>e.op))].map(op=>edits.filter(e=>e.op===op).length+' '+op).join(', ');
console.log('edits saved by the two apps: '+edits.length+' ('+ops+'); refused and waiting: '+refused.length+'; corrections stored in User: '+stored.length);
for (const c of stored) console.log('  '+c.createdAt+' '+c.app+' '+c.id+' '+c.op+' '+(c.record??(c.records??[]).join('+')).slice(0,40)+' '+JSON.stringify(c.fields??c.names??''));
const byId=new Map(); for (const c of stored) byId.set(c.id,(byId.get(c.id)||0)+1);
const missing=edits.filter(e=>!e.refused&&!byId.has(e.id)).map(e=>e.id);
const twice=[...byId].filter(([,n])=>n>1).map(([id])=>id);
const extra=stored.filter(c=>!edits.some(e=>e.id===c.id)).map(c=>c.id);
const refusedStored=refused.filter(e=>byId.has(e.id)).map(e=>e.id);
console.log('missing: '+missing.length+', stored twice: '+twice.length+', not made by the apps: '+extra.length+', refused but stored: '+refusedStored.length);
process.exit(missing.length||twice.length||extra.length||refusedStored.length?1:0);
" "$P/ts-edits.json" "$P/cs-edits.json" "$P/user-corrections.json" || fail "the exactly-once check"

step "21. The C# client round-trips every user and contacts fixture of memex.core"
"$CS" fixtures "$(cygpath -m "$HERE/../../contracts/fixtures" 2>/dev/null || echo "$HERE/../../contracts/fixtures")" > "$P/fixtures.log" || fail "the fixture round trip"
grep -c '^  ok ' "$P/fixtures.log" | sed 's/$/ fixtures ok/'
grep -v '^  ok ' "$P/fixtures.log"

echo
if [ "$FAILED" = 0 ]; then echo "=== The proof run passed: every step had its expected result."; exit 0; fi
echo "=== The proof run FAILED: $FAILED step(s) did not have the expected result."
exit 1
