#!/bin/bash
# test-proxy-merge.sh — tests for proxy-merge.sh that cannot merge anything.
#
#   scripts/ops/test-proxy-merge.sh            # offline: refusals, timed(), fake-tool runs
#   scripts/ops/test-proxy-merge.sh --network  # + one real read-only preflight (PR that does not exist)
#
# 1. Refusals run a COPY of the script whose PATH line is prefixed with TRIPWIRE
#    gh / railway / sntp (they log the call and exit 99). Every case must exit 2
#    with NO MERGE PERFORMED, and the suite asserts the tripwires were never
#    called: each refusal fires before any external command.
# 2. timed(): bounds a command that ignores SIGALRM and one whose grandchild
#    holds the pipe, passes exit codes through, and forwards INT/TERM/HUP.
# 3. End to end against FAKE gh / railway / sntp, via a copy with the fake-tool
#    directory prefixed to its PATH line and its 25-min window limit widened to
#    60 min (so no case waits for the wall clock; the limit itself is a refusal
#    in part 1). The fakes check the PR number, repo, deployment id, service,
#    environment and --since they are called with, and the fake gh records
#    every `gh pr merge`, so the live path runs without a real merge.
# The real script has no test hook; the suite asserts each copy differs from it
# in exactly the lines named above. Every script run keeps its state under this
# suite's temp dir (TMPDIR), and the suite checks none is left behind.
#
# macOS + bash 3.2 (like the script). Exits non-zero if any check fails.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
S=$HERE/proxy-merge.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/test-proxy-merge.XXXXXX")
T=$(cd "$T" && pwd -P)
TAG=$RANDOM$RANDOM   # digits only: it becomes part of sleep intervals
trap 'pkill -f "\.$TAG" 2>/dev/null; rm -rf "$T"' EXIT
export TMPDIR="$T"
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "  ok    $*"; }
no() { fail=$((fail + 1)); echo "  FAIL  $*"; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
changed_lines() { diff "$1" "$2" | grep -c '^[<>]'; }

PR=999999
HEAD=0123456789abcdef0123456789abcdef01234567
OTHER=1123456789abcdef0123456789abcdef01234567
MAIN=fedcba9876543210fedcba9876543210fedcba98
DEP=1a2b3c4d-2222-4bcd-8ef0-5e5e5e5e5e5e   # has hex letters, so the uppercase case changes it
UA_A='NetraOps/48 CFNetwork/1.0 Darwin/1.0'
UA_B='NetraOps/48 CFNetwork/2.0 Darwin/2.0'
PATH_LINE='PATH=/opt/homebrew/bin:/usr/bin:/bin'
[ "$(grep -c "^$PATH_LINE\$" "$S")" = 1 ] || { echo "FAIL: $S has no single '$PATH_LINE' line"; exit 1; }

# ── 1. refusals (tripwire copy) ──────────────────────────────────────────────
echo "== refusals (abort before any external command)"
TW=$T/tripwire; mkdir -p "$TW"
for t in gh railway sntp; do
  printf '#!/bin/bash\necho "%s $*" >> "%s/tripwire.log"\nexit 99\n' "$t" "$T" > "$TW/$t"; chmod +x "$TW/$t"
done
R=$T/refusal-copy.sh
sed "s|^$PATH_LINE\$|PATH=$TW:/opt/homebrew/bin:/usr/bin:/bin|" "$S" > "$R"
[ "$(changed_lines "$S" "$R")" = 2 ] && ok 'refusal copy differs from the script only in its PATH line' || no 'refusal copy: unexpected diff'
now=$(date -u +%s); nb=$(( (now / 1800 + 1) * 1800 )); NB=$(iso $nb); ND=$(iso $((nb + 1500)))
printf 'LBL_A\t%s\n' "$UA_A" > "$T/ua.tsv"
printf 'LBL_A\t%s\nLBL_A\t%s\n' "$UA_A" "$UA_B" > "$T/dup-label.tsv"
printf 'LBL_A\t%s\nLBL_B\t%s\n' "$UA_A" "$UA_A" > "$T/dup-ua.tsv"
printf 'A+B\t%s\n' "$UA_A" > "$T/plus.tsv"
printf 'LBL_A %s\n' "$UA_A" > "$T/space.tsv"
printf 'LBL_A\t%s\nbroken\n' "$UA_A" > "$T/broken.tsv"
printf 'LBL_A\t%s\textra\n' "$UA_A" > "$T/three.tsv"
: > "$T/empty.tsv"
refuse() {  # refuse <label> <expected text> <args...>
  local label=$1 want=$2; shift 2
  local out rc
  out=$(env -u MAX_AGE RAILWAY_DIR="$T" bash "$R" "$@" 2>&1); rc=$?
  if [ "$rc" = 2 ] && [[ $out == *"$want"* ]] && [[ $out == *"NO MERGE PERFORMED"* ]] && [[ $out != *"preflight:"* ]]; then
    ok "$label"
  else
    no "$label: rc=$rc $(echo "$out" | grep -E 'ABORT|preflight' | head -1)"
  fi
}
A=("$PR" "$HEAD" "$MAIN" "$DEP")
refuse '7 args'                      'got 7 args'                  "${A[@]}" "$NB" "$ND" "$T/ua.tsv"
refuse '9 args'                      'got 9 args'                  "${A[@]}" "$NB" "$ND" "$T/ua.tsv" --dry-run extra
refuse 'mode --dryrun'               '8th arg must be'             "${A[@]}" "$NB" "$ND" "$T/ua.tsv" --dryrun
refuse 'mode en-dash'                '8th arg must be'             "${A[@]}" "$NB" "$ND" "$T/ua.tsv" $'\xe2\x80\x93-dry-run'
refuse 'mode empty'                  '8th arg must be'             "${A[@]}" "$NB" "$ND" "$T/ua.tsv" ''
for p in 0 012 abc 1234567 -5 '' ' 85' $'85\n'; do
  refuse "pr $(printf '%q' "$p")"   'pr must be a PR number'      "$p" "$HEAD" "$MAIN" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
done
refuse 'head short'                  'head must be'                "$PR" "${HEAD:0:7}" "$MAIN" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'head uppercase'              'head must be'                "$PR" "$(echo $HEAD | tr a-f A-F)" "$MAIN" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'head 41 chars'               'head must be'                "$PR" "${HEAD}0" "$MAIN" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'main not hex'                'main must be'                "$PR" "$HEAD" "${MAIN:0:39}g" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'head = main'                 'same commit'                 "$PR" "$HEAD" "$HEAD" "$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'deploy 8-char prefix'        'full UUID'                   "$PR" "$HEAD" "$MAIN" "${DEP:0:8}" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'deploy non-hex letter'       'full UUID'                   "$PR" "$HEAD" "$MAIN" "${DEP:0:35}g" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'deploy uppercase'            'full UUID'                   "$PR" "$HEAD" "$MAIN" "$(echo $DEP | tr a-f A-F)" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'deploy + trailing newline'   'full UUID'                   "$PR" "$HEAD" "$MAIN" "$DEP"$'\n' "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'deploy + second line'        'full UUID'                   "$PR" "$HEAD" "$MAIN" $'junk\n'"$DEP" "$NB" "$ND" "$T/ua.tsv" --dry-run
refuse 'boundary junk suffix'        'boundary is not a canonical' "${A[@]}" "${NB}junk" "$ND" "$T/ua.tsv" --dry-run
refuse 'boundary rolls (09-31)'      'boundary is not a canonical' "${A[@]}" 2026-09-31T02:00:00Z "$ND" "$T/ua.tsv" --dry-run
refuse 'boundary lowercase z'        'boundary is not a canonical' "${A[@]}" "${NB%Z}z" "$ND" "$T/ua.tsv" --dry-run
refuse 'deadline junk suffix'        'deadline is not a canonical' "${A[@]}" "$NB" "${ND}junk" "$T/ua.tsv" --dry-run
refuse 'deadline rolls (09-31)'      'deadline is not a canonical' "${A[@]}" "$NB" 2026-09-31T02:20:00Z "$T/ua.tsv" --dry-run
refuse 'boundary not :00/:30'        ':00 or :30'                  "${A[@]}" "$(iso $((nb + 600)))" "$ND" "$T/ua.tsv" --dry-run
refuse 'deadline > 25 min'           'more than 25 min'            "${A[@]}" "$NB" "$(iso $((nb + 1560)))" "$T/ua.tsv" --dry-run
refuse 'deadline before boundary'    'not before the deadline'     "${A[@]}" "$NB" "$(iso $((nb - 60)))" "$T/ua.tsv" --dry-run
refuse 'deadline > 3 h away'         'more than 3 h away'          "${A[@]}" "$(iso $((nb + 12600)))" "$(iso $((nb + 13200)))" "$T/ua.tsv" --dry-run
refuse 'ua duplicate label'          'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/dup-label.tsv" --dry-run
refuse 'ua duplicate UA'             'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/dup-ua.tsv" --dry-run
refuse "ua '+' label"                'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/plus.tsv" --dry-run
refuse 'ua space, not tab'           'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/space.tsv" --dry-run
refuse 'ua broken line'              'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/broken.tsv" --dry-run
refuse 'ua three fields'             'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/three.tsv" --dry-run
refuse 'ua empty'                    'distinct LABEL'              "${A[@]}" "$NB" "$ND" "$T/empty.tsv" --dry-run
refuse 'ua missing'                  'cannot read ua_file'         "${A[@]}" "$NB" "$ND" "$T/nope.tsv" --dry-run
out=$(MAX_AGE=100 RAILWAY_DIR="$T" bash "$R" "${A[@]}" "$NB" "$ND" "$T/ua.tsv" --live 2>&1); rc=$?
[ "$rc" = 2 ] && [[ $out == *'dry runs only'* ]] && ok 'MAX_AGE 100 with --live' || no "MAX_AGE 100 with --live: rc=$rc"
out=$(MAX_AGE=7x RAILWAY_DIR="$T" bash "$R" "${A[@]}" "$NB" "$ND" "$T/ua.tsv" --dry-run 2>&1); rc=$?
[ "$rc" = 2 ] && [[ $out == *'whole number'* ]] && ok 'MAX_AGE not a number' || no "MAX_AGE not a number: rc=$rc"
out=$(env -u MAX_AGE RAILWAY_DIR="$T/nowhere" bash "$R" "${A[@]}" "$NB" "$ND" "$T/ua.tsv" --dry-run 2>&1); rc=$?
[ "$rc" = 2 ] && [[ $out == *'RAILWAY_DIR is not a directory'* ]] && ok 'RAILWAY_DIR missing' || no "RAILWAY_DIR missing: rc=$rc"
[ ! -e "$T/tripwire.log" ] && ok 'no refusal reached gh, railway or sntp' || no "tripwire calls: $(tr '\n' ';' < "$T/tripwire.log")"

# ── 2. timed() ───────────────────────────────────────────────────────────────
echo "== timed()"
eval "$(sed -n '/^timed() {/,/^}/p' "$S")"
t0=$(date +%s); timed 2 perl -e '$SIG{ALRM}="IGNORE"; sleep 30'; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" = 137 ] && [ "$dt" -le 4 ] && ok "ignores SIGALRM -> killed at ${dt}s, rc 137" || no "SIGALRM-ignoring command: rc=$rc after ${dt}s"
t0=$(date +%s); n=$(timed 1 sh -c "sleep 33.$TAG | cat" | wc -c | tr -d ' '); dt=$(( $(date +%s) - t0 ))
sleep 1; left=$(pgrep -f "sleep 33.$TAG" | wc -l | tr -d ' ')
[ "$dt" -ge 1 ] && [ "$dt" -le 3 ] && [ "$left" = 0 ] && ok "grandchild holding the pipe -> released at ${dt}s, 0 left" || no "pipe-holding grandchild: ${dt}s, $left left"
timed 5 /nonexistent/command 2>/dev/null; rc=$?; [ "$rc" = 127 ] && ok 'missing command -> 127' || no "missing command: rc=$rc"
timed 5 sh -c 'exit 3'; rc=$?; [ "$rc" = 3 ] && ok 'exit code passes through' || no "exit code: rc=$rc"
timed 5 sh -c 'kill -TERM $$'; rc=$?; [ "$rc" = 143 ] && ok 'death by signal -> 128+n' || no "death by signal: rc=$rc"
i=0
for sig in INT TERM HUP; do
  i=$((i + 1)); mark="sleep 41.$TAG$i"
  ( timed 30 $mark ) & sub=$!
  sleep 1
  pp=$(pgrep -P "$sub" perl | head -1)
  kill -"$sig" "$pp" 2>/dev/null
  wait "$sub"; rc=$?
  sleep 0.5; left=$(pgrep -f "$mark" | wc -l | tr -d ' ')
  [ "$rc" = 130 ] && [ "$left" = 0 ] && ok "$sig to timed -> rc 130, child group gone" || no "$sig to timed: rc=$rc, $left left"
  pkill -f "$mark" 2>/dev/null
done

# ── 3. end to end against fake tools ─────────────────────────────────────────
echo "== end to end (fake gh / railway / sntp)"
FB=$T/fakebin; FS=$T/fs; mkdir -p "$FB"
cat > "$FB/gh" <<'GH'
#!/bin/bash
F=${FAKE_STATE:?}
bad() { echo "gh: $*" >> "$F/bad_args"; exit 99; }
next() {  # next <key>: the call-counted line of $F/<key>; the last line repeats
  local n; n=$(cat "$F/n_$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$F/n_$1"
  local l; l=$(sed -n "${n}p" "$F/$1"); [ -n "$l" ] || l=$(tail -1 "$F/$1"); echo "$l"
}
all=" $* "
case "$1 $2" in
  "pr view")
    [ "$3" = "$FAKE_PR" ] || bad "pr view of PR '$3'"
    [[ $all == *" -R vvishnu1998-lab/guard "* ]] || bad "pr view without -R: $*"
    json=; prev=; for a in "$@"; do [ "$prev" = --json ] && json=$a; prev=$a; done
    case "$json" in
      headRefOid,mergeStateStatus,state,baseRefName) k=pre ;;
      headRefOid,mergeStateStatus,baseRefName)       k=chk ;;
      state,mergedAt,mergeCommit)                    k=post ;;
      *) bad "unexpected --json $json" ;;
    esac
    [ -f "$F/hang_$k" ] && sleep "40.$FAKE_TAG"
    [ -f "$F/hang1_$k" ] && [ ! -f "$F/hung1_$k" ] && { touch "$F/hung1_$k"; sleep "40.$FAKE_TAG"; }
    next "$k" ;;
  "api repos/vvishnu1998-lab/guard/commits/main") next main ;;
  "pr merge")
    [ "$3" = "$FAKE_PR" ] || bad "pr merge of PR '$3'"
    echo "$*" >> "$F/merge_calls"
    [ -f "$F/hang_merge" ] && sleep "30.$FAKE_TAG"
    exit "$(cat "$F/merge_rc" 2>/dev/null || echo 0)" ;;
  *) bad "unexpected: $*" ;;
esac
GH
cat > "$FB/railway" <<'RW'
#!/bin/bash
F=${FAKE_STATE:?}
bad() { echo "railway: $*" >> "$F/bad_args"; exit 99; }
next() {
  local n; n=$(cat "$F/n_$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$F/n_$1"
  local l; l=$(sed -n "${n}p" "$F/$1"); [ -n "$l" ] || l=$(tail -1 "$F/$1"); echo "$l"
}
case "$1" in
  deployment)
    [ "$*" = "deployment list --service guard --environment production --json" ] || bad "$*"
    next deployments ;;
  logs)
    want="logs $FAKE_DEP --service guard --environment production --http --json --method POST --path /api/locations/ping --since $FAKE_BI --until "
    [[ "$*" == "$want"* ]] && [[ "$*" == *" -n 100" ]] || bad "$*"
    /opt/homebrew/bin/python3 - "$F/rows" "$FAKE_B" <<'PY'
import sys, json, datetime
now = datetime.datetime.now(datetime.timezone.utc)
b = datetime.datetime.fromtimestamp(int(sys.argv[2]), datetime.timezone.utc)
for line in open(sys.argv[1]):
    line = line.rstrip('\n')
    if not line: continue
    if line.startswith('RAW '):
        print(line[4:]); continue
    off, status, ua, rid = line.split('\t')
    t = (b + datetime.timedelta(seconds=float(off[1:]))) if off.startswith('B') else (now + datetime.timedelta(seconds=float(off)))
    ts = t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond:06d}123Z'
    print(json.dumps({'timestamp': ts, 'method': 'POST', 'path': '/api/locations/ping',
                      'httpStatus': int(status), 'clientUa': ua, 'requestId': rid, 'srcIp': '192.0.2.77'}))
PY
  ;;
  *) bad "unexpected: $*" ;;
esac
RW
cat > "$FB/sntp" <<'NT'
#!/bin/bash
echo "${FAKE_SNTP:-+0.010} +/- 0.020 time.apple.com 192.0.2.1"
NT
chmod +x "$FB/gh" "$FB/railway" "$FB/sntp"
C=$T/e2e-copy.sh
WINDOW_LINE='[ $((D - B)) -le 1500 ] ||'
[ "$(grep -cF "$WINDOW_LINE" "$S")" = 1 ] || { no "script has no single '$WINDOW_LINE' line"; echo "$pass passed, $fail failed"; exit 1; }
sed -e "s|^$PATH_LINE\$|PATH=$FB:/opt/homebrew/bin:/usr/bin:/bin|" -e 's/\[ \$((D - B)) -le 1500 \] ||/[ $((D - B)) -le 3600 ] ||/' "$S" > "$C"
[ "$(changed_lines "$S" "$C")" = 4 ] && ok 'e2e copy differs only in its PATH line and the window limit' || no "e2e copy: $(changed_lines "$S" "$C") changed lines"

# A boundary at least 130 s in the past (the stale-ping case needs 120).
now=$(date -u +%s); B=$(( now - now % 1800 )); [ $(( now - B )) -ge 130 ] || B=$(( B - 1800 )); BI=$(iso "$B")
soon() { iso $(( $(date -u +%s) + ${1:-12} )); }
MERGE_ARGS="pr merge $PR -R vvishnu1998-lab/guard --merge --match-head-commit $HEAD"
DEPS_OK=$(printf '[{"id":"%s","status":"SUCCESS","meta":{"commitHash":"%s"}},{"id":"99999999-2222-4333-8444-555555555555","status":"REMOVED","meta":{"commitHash":"%s"}}]' "$DEP" "$MAIN" "$OTHER")

setup() {  # fresh fake state with the happy-path answers
  rm -rf "$FS"; mkdir -p "$FS"
  echo "$HEAD CLEAN OPEN main" > "$FS/pre"
  echo "$HEAD CLEAN main" > "$FS/chk"
  echo "MERGED 2026-01-01T00:00:00Z abcdef0123456789abcdef0123456789abcdef01" > "$FS/post"
  echo "$MAIN" > "$FS/main"
  echo "$DEPS_OK" > "$FS/deployments"
  printf -- '-2\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"
  printf 'LBL_A\t%s\n' "$UA_A" > "$FS/ua.tsv"
  SNTP=+0.010
}
fakeenv() { echo FAKE_STATE="$FS" FAKE_B="$B" FAKE_BI="$BI" FAKE_PR="$PR" FAKE_DEP="$DEP" FAKE_TAG="$TAG" FAKE_SNTP="$SNTP" RAILWAY_DIR="$T"; }
run() {  # run <mode> <deadline>: runs the e2e copy; sets $out $rc $merges $dt
  local t0; t0=$(date +%s)
  out=$(env -u MAX_AGE $(fakeenv) bash "$C" "$PR" "$HEAD" "$MAIN" "$DEP" "$BI" "$2" "$FS/ua.tsv" "$1" 2>&1); rc=$?
  dt=$(( $(date +%s) - t0 ))
  merges=$(cat "$FS/merge_calls" 2>/dev/null | wc -l | tr -d ' ')
}
expect() {  # expect <label> <rc> <merges> <text> [<text>]
  local good=1
  [ "$rc" = "$2" ] || good=0; [ "$merges" = "$3" ] || good=0
  [[ $out == *"$4"* ]] || good=0
  [ -z "${5:-}" ] || [[ $out == *"$5"* ]] || good=0
  [[ $out != *192.0.2.77* ]] || good=0            # no source address is ever printed
  [ ! -s "$FS/bad_args" ] || good=0               # the fakes were called as expected
  if [ "$good" = 1 ]; then ok "$1"; else
    no "$1: rc=$rc merges=$merges ${dt}s $(cat "$FS/bad_args" 2>/dev/null | head -1) $(echo "$out" | grep -E 'ABORT|DRY RUN|MERGING|returned' | head -2 | tr '\n' ' ')"
  fi
}
P() { soon 40; }   # deadline for cases that should finish at once

setup; run --dry-run "$(P)"; expect 'dry run, fresh gating ping -> would merge, no merge call' 0 0 'DRY RUN: WOULD MERGE' 'pre-merge newest deployment (try 1)'
setup; run --live "$(P)";    expect 'live, fresh gating ping -> exactly one merge, result read back' 0 1 'result: MERGED'
[ "$(cat "$FS/merge_calls" 2>/dev/null)" = "$MERGE_ARGS" ] && ok 'live: merge call is pinned (--match-head-commit), no branch deletion' || no "live: merge args were: $(cat "$FS/merge_calls" 2>/dev/null)"
setup; echo "$OTHER CLEAN OPEN main" > "$FS/pre"; run --live "$(P)";   expect 'preflight: PR head differs -> abort' 4 0 'preflight PR mismatch'
setup; echo "$HEAD CLEAN OPEN develop" > "$FS/pre"; run --live "$(P)"; expect 'preflight: base is not main -> abort' 4 0 'preflight PR mismatch'
setup; echo "$HEAD BEHIND OPEN main" > "$FS/pre"; run --live "$(P)";   expect 'preflight: PR BEHIND -> abort' 4 0 'preflight PR mismatch'
setup; echo "$HEAD CLEAN MERGED main" > "$FS/pre"; run --live "$(P)";  expect 'preflight: PR already merged -> abort' 4 0 'preflight PR mismatch'
setup; echo "$OTHER" > "$FS/main"; run --live "$(P)";                  expect 'preflight: main moved -> abort' 4 0 'preflight main moved'
setup; printf '[{"id":"77777777-2222-4333-8444-555555555555","status":"BUILDING","meta":{"commitHash":"%s"}},%s\n' "$OTHER" "${DEPS_OK#[}" > "$FS/deployments"; run --live "$(P)"
                                                        expect 'preflight: a newer deploy is BUILDING -> abort' 4 0 'newest deployment is not'
setup; printf '[{"id":"77777777-2222-4333-8444-555555555555","status":"SUCCESS","meta":{"commitHash":"%s"}}]\n' "$MAIN" > "$FS/deployments"; run --live "$(P)"
                                                        expect 'preflight: a different deployment is live -> abort' 4 0 'newest deployment is not'
setup; printf '[{"id":"%s","status":"SUCCESS","meta":{"commitHash":"%s"}}]\n' "$DEP" "$OTHER" > "$FS/deployments"; run --live "$(P)"
                                                        expect 'preflight: live deployment not built from main (a rollback) -> abort' 4 0 'built from main'
setup; SNTP=+3.5; run --live "$(P)";                    expect 'preflight: clock 3.5 s ahead -> abort' 4 0 'clock check failed'
setup; SNTP=-3.5; run --live "$(P)";                    expect 'preflight: clock 3.5 s behind -> abort' 4 0 'clock check failed'
setup; SNTP=garbage; run --live "$(P)";                 expect 'preflight: sntp answer unreadable -> abort' 4 0 'clock check failed'
setup; touch "$FS/hang_pre"; run --live "$(P)"
[ "$dt" -le 20 ] && expect "preflight: gh hangs -> bounded (${dt}s) and abort" 4 0 'preflight PR mismatch' || no "preflight: gh hang took ${dt}s"
setup; printf -- '-2\t201\t%s\treqB0001\n' "$UA_B" > "$FS/rows"; run --live "$(soon 12)"
                                                        expect 'only an UNATTRIBUTED 201 -> logged as such, no merge' 5 0 'UNATTRIBUTED req=reqB0001' 'deadline reached'
setup; printf 'B-60\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; run --live "$(soon 12)"
                                                        expect 'gating ping from before the boundary is ignored' 5 0 'LBL_A=none' 'deadline reached'
setup; printf -- '-2\t200\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; run --live "$(soon 12)"
                                                        expect 'HTTP 200 (duplicate window) does not count' 5 0 'LBL_A=none' 'deadline reached'
setup; printf -- '-120\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; run --live "$(P)"
                                                        expect 'stale gating ping (120 s) -> abort' 6 0 'outside the window'
setup; printf -- '+30\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; run --live "$(P)"
                                                        expect 'gating ping 30 s in the future -> abort' 6 0 'outside the window'
setup; printf 'RAW {"timestamp": "2026-\nRAW not json at all\n-2\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; run --dry-run "$(P)"
                                                        expect 'malformed log lines are counted, not fatal' 0 0 'bad=1'
setup; echo "$HEAD BLOCKED main" > "$FS/chk"; run --live "$(P)"
                                                        expect 'pre-merge: BLOCKED on both tries -> abort' 7 0 'pre-merge mismatch'
setup; printf '%s\n%s\n' "$HEAD UNKNOWN main" "$HEAD CLEAN main" > "$FS/chk"; run --live "$(P)"
                                                        expect 'pre-merge: UNKNOWN then CLEAN -> retried, one merge' 0 1 'pre-merge check (try 2)'
setup; echo "$OTHER CLEAN main" > "$FS/chk"; run --live "$(P)"
                                                        expect 'pre-merge: PR head changed after preflight -> abort' 7 0 'pre-merge mismatch'
setup; echo "$HEAD CLEAN develop" > "$FS/chk"; run --live "$(P)"
                                                        expect 'pre-merge: base changed after preflight -> abort' 7 0 'pre-merge mismatch'
setup; printf '%s\n%s\n' "$MAIN" "$OTHER" > "$FS/main"; run --live "$(P)"
                                                        expect 'pre-merge: main moved on both tries -> abort' 7 0 'main moved since approval'
setup; printf '%s\n[{"id":"77777777-2222-4333-8444-555555555555","status":"BUILDING","meta":{"commitHash":"%s"}},%s\n' "$DEPS_OK" "$MAIN" "${DEPS_OK#[}" > "$FS/deployments"; run --live "$(P)"
                                                        expect 'pre-merge: a newer deploy started after preflight -> abort' 7 0 'newest deployment changed'
setup; printf '%s\nnot json\n%s\n' "$DEPS_OK" "$DEPS_OK" > "$FS/deployments"; run --live "$(P)"
                                                        expect 'pre-merge: deployment read fails once -> retried, one merge' 0 1 'pre-merge newest deployment (try 2)'
setup; printf -- '-70\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; touch "$FS/hang1_chk"; run --live "$(P)"
                                                        expect 'pre-merge: ping ages past 85 s during the checks -> abort' 6 0 'aged past the window'
setup; touch "$FS/hang1_chk"; run --live "$(soon 12)"
                                                        expect 'pre-merge: deadline passes during the checks -> abort' 5 0 'deadline passed before the merge'
setup; printf -- '-60\t201\t%s\treqA0001\n' "$UA_A" > "$FS/rows"; touch "$FS/hang_merge"; run --live "$(P)"
[ "$dt" -le 35 ] && expect "merge call hangs -> killed at its limit (${dt}s)" 137 1 'merge call limit 2' 'merge command returned rc=137' || no "merge call hang took ${dt}s"
setup; echo 1 > "$FS/merge_rc"; run --live "$(P)"
if [ "$rc" = 1 ] && [ "$merges" = 1 ] && [[ $out == *'merge command returned rc=1'* ]] && [[ $out == *'result: '* ]] && [[ $out != *'OUTCOME UNKNOWN'* ]]; then
  ok 'merge call fails -> its rc, one attempt, result read back'; else no "merge call fails: rc=$rc merges=$merges"; fi
setup; printf 'LBL_A\t%s\nLBL_B\t%s\n' "$UA_A" "$UA_B" > "$FS/ua.tsv"; run --live "$(soon 12)"
                                                        expect 'two gating labels, one pinged -> no merge' 5 0 'LBL_B=none' 'deadline reached'
setup; printf 'LBL_A\t%s\nLBL_B\t%s\n' "$UA_A" "$UA_B" > "$FS/ua.tsv"; printf -- '-3\t201\t%s\treqA0001\n-2\t201\t%s\treqB0001\n' "$UA_A" "$UA_B" > "$FS/rows"; run --dry-run "$(P)"
                                                        expect 'two gating labels, both pinged -> would merge' 0 0 'DRY RUN: WOULD MERGE'

bg() {  # bg <deadline>: start the e2e copy in the background, --live; sets $sub
  env -u MAX_AGE $(fakeenv) bash "$C" "$PR" "$HEAD" "$MAIN" "$DEP" "$BI" "$1" "$FS/ua.tsv" --live > "$T/bg.out" 2>&1 &
  sub=$!
}
setup; : > "$FS/rows"; t0=$(date +%s); bg "$(P)"; sleep 3
if ps -o args= -p "$sub" | grep -qF "$C"; then
  kill -TERM "$sub"; wait "$sub"; rc=$?; dt=$(( $(date +%s) - t0 )); out=$(cat "$T/bg.out")
  [ "$rc" = 143 ] && [ "$dt" -le 10 ] && [[ $out == *'NO MERGE PERFORMED (exit)'* ]] && [[ $out != *'ABORT deadline'* ]] && [ ! -s "$FS/merge_calls" ] \
    && ok 'SIGTERM while polling -> exits 143 at once, no merge, says so' || no "SIGTERM while polling: rc=$rc ${dt}s; $(tail -1 "$T/bg.out")"
else no "SIGTERM while polling: pid $sub is not the script"; kill "$sub" 2>/dev/null; fi
setup; touch "$FS/hang_merge"; bg "$(P)"
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do grep -q 'MERGING' "$T/bg.out" && break; sleep 1; done
kill -TERM "$sub" 2>/dev/null; wait "$sub" 2>/dev/null; out=$(cat "$T/bg.out"); pkill -f "30.$TAG" 2>/dev/null
[[ $out == *"MERGE WAS ATTEMPTED, OUTCOME UNKNOWN: gh pr view $PR -R vvishnu1998-lab/guard"* ]] && [ "$(wc -l < "$FS/merge_calls" | tr -d ' ')" = 1 ] \
  && ok 'SIGTERM during the merge call -> says the outcome is unknown and how to read it' || no "SIGTERM during merge: $(tail -2 "$T/bg.out" | tr '\n' ' ')"
sleep 1
left=0; for d in "$T"/proxy-merge.??????; do [ -d "$d" ] && left=$((left + 1)); done
[ "$left" = 0 ] && ok 'every run removed its state dir' || no "$left state dirs left behind"

# ── 4. optional: one real read-only preflight ────────────────────────────────
if [ "${1:-}" = --network ]; then
  echo "== network (real gh / railway / sntp, read-only; PR $PR does not exist)"
  now=$(date -u +%s); nb=$(( (now / 1800 + 1) * 1800 ))
  out=$(env -u MAX_AGE bash "$S" "$PR" "$HEAD" "$MAIN" "$DEP" "$(iso $nb)" "$(iso $((nb + 1500)))" "$T/ua.tsv" --dry-run 2>&1); rc=$?
  [ "$rc" = 4 ] && [[ $out == *'preflight PR mismatch'* ]] && ok 'real preflight on a PR that does not exist -> abort' || no "real preflight: rc=$rc $(echo "$out" | tail -2 | tr '\n' ' ')"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
