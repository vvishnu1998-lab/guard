#!/bin/bash
# proxy-merge.sh — merge one PR to main by the deploy gate's PROXY route
# (docs/OPS/POLICY.md). A merge to main restarts the Railway API, so it goes
# out within 90 s after a STARNET guard's new ping lands: the quiet time between
# ping windows. The single write is `gh pr merge` (the PR's branch is left in
# place); everything else is a read.
#
#   scripts/ops/proxy-merge.sh <pr> <head sha> <main sha> <deployment id> \
#       <boundary utc> <deadline utc> <ua file> --dry-run|--live
#
# <pr> is the PR number; <head sha> its approved head and <main sha> main's
# approved tip, both full 40-hex; <deployment id> the live Railway deployment's
# full UUID. The merge happens only if the PR is open, CLEAN, based on main and
# at <head sha>; main is at <main sha>; and the NEWEST deployment of Railway
# service guard (environment production) is <deployment id>, SUCCESS, built from
# <main sha>. All three are checked at preflight and again right before the
# merge, which is pinned with --match-head-commit.
# Times are canonical UTC, YYYY-MM-DDTHH:MM:SSZ. There is no default mode.
#
# History: rebuilt byte-for-byte from the script that merged PR #85 on
# 2026-09-29 19:00:51 PT (sha256 604423dc…), itself hardened from PR #83's after
# two adversarial reviews; generalized here (the four values above as validated
# arguments; the deployment's commit and the Railway service/environment pinned;
# the deployment re-checked before the merge; no branch deletion; a fresh mktemp
# state dir, removed on exit; RAILWAY_DIR). Refusal and fake-tool tests:
# scripts/ops/test-proxy-merge.sh.
#
# Environment: RAILWAY_DIR (default $HOME/guard) is a directory linked to the
# Railway project (adorable-courage); the railway CLI runs there, read-only,
# always with --service guard --environment production. MAX_AGE (default 75) may
# be raised for --dry-run only. macOS + bash 3.2; needs gh, railway, sntp, perl
# and /opt/homebrew/bin/python3.
#
# GATE: every gating (pinging) STARNET session, identified by its device's
# exact clientUa, has a NEW ping at or after BOUNDARY, and the merge follows the
# latest of them within 90 s (MAX_AGE 75 s leaves margin), never after DEADLINE.
# BOUNDARY must be a :00/:30 ping-window open and DEADLINE at most 25 min after
# it, so one arm never spans two windows. Re-arm per window.
#
# "NEW" = HTTP 201. The ping route answers 201 {status:'recorded'} for a new
# row and 200 {status:'already_recorded'} for a resend of an answered window
# (routes/locations.ts), so the status code alone excludes duplicates. A late
# backfill of a past window is also a 201; it still proves the app is live.
#
# Attribution: Railway HTTP logs carry no guard or session id; the UA file maps
# LABEL<TAB>exact clientUa, calibrated before arming from requests that session
# made (joined to DB ping rows) and checked unique among the day's ping UAs. A
# 201 with any other UA is UNATTRIBUTED and never counts. The file is refused
# unless every line parses, labels and UAs are all distinct, and no label joins
# two sessions ("+").
#
# NOT checked in here (no DB access from a shell; postgres-readonly is an MCP
# tool): the arming check that the open sessions are exactly the expected
# STARNET set and that no non-STARNET session is open. Run it right before
# arming.
#
# Fail closed everywhere. Every external call is bounded by timed(), which
# kills the whole process group (gh ignores SIGALRM; railway's node wrapper
# leaves its Rust child running) and passes Ctrl-C / TERM / HUP on to it. The
# deadline, the ping's age, the PR head/state/base, main and the newest
# deployment are re-checked immediately before the merge, which is pinned with
# --match-head-commit. Single write action: gh pr merge, never retried (the
# three reads before it get one retry each). Every exit that did not attempt the merge prints NO MERGE
# PERFORMED; one that did prints the result, or how to read it.
set -u
PATH=/opt/homebrew/bin:/usr/bin:/bin
export RAILWAY_NO_TELEMETRY=1
ATTEMPTED=0; SAID=0; DONE=0
ts() { python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"))'; }
log() { echo "$(ts) $*"; }
nomerge() { log "$1"; echo "NO MERGE PERFORMED"; SAID=1; exit "$2"; }
trap 'if [ "$ATTEMPTED" = 1 ]; then [ "$DONE" = 1 ] || echo "MERGE WAS ATTEMPTED, OUTCOME UNKNOWN: gh pr view $PR -R $REPO --json state,mergedAt,mergeCommit"; else [ "$SAID" = 1 ] || echo "NO MERGE PERFORMED (exit)"; fi; case "${STATE:-}" in /*/proxy-merge.??????) rm -rf "$STATE";; esac' EXIT

[ $# -eq 8 ] || nomerge "ABORT usage: proxy-merge.sh <pr> <head sha> <main sha> <deployment id> <boundary_utc> <deadline_utc> <ua_file> --dry-run|--live (got $# args)" 2
PR=$1; HEAD_WANT=$2; MAIN_WANT=$3; DEPLOY=$4; BOUNDARY=$5; DEADLINE=$6; UA_FILE=$7; MODE=$8
case "$MODE" in --dry-run|--live) ;; *) nomerge "ABORT 8th arg must be exactly --dry-run or --live (got '$MODE')" 2;; esac
REPO=vvishnu1998-lab/guard
case "$PR" in ''|0*|*[!0123456789]*) nomerge "ABORT pr must be a PR number (got '$PR')" 2;; esac
[ ${#PR} -le 6 ] || nomerge "ABORT pr must be a PR number (got '$PR')" 2
# Explicit character lists rather than ranges: range matching can follow the
# locale's collation on some systems, and these values must be exact.
hex40() { case "$1" in *[!0123456789abcdef]*) return 1;; esac; [ ${#1} -eq 40 ]; }
hex40 "$HEAD_WANT" || nomerge "ABORT head must be the PR head's full 40-char lowercase sha (got '$HEAD_WANT')" 2
hex40 "$MAIN_WANT" || nomerge "ABORT main must be main's full 40-char lowercase sha (got '$MAIN_WANT')" 2
[ "$HEAD_WANT" != "$MAIN_WANT" ] || nomerge "ABORT head and main are the same commit" 2
X='[0123456789abcdef]'
[ ${#DEPLOY} -eq 36 ] && printf '%s' "$DEPLOY" | LC_ALL=C grep -Eq "^$X{8}-$X{4}-$X{4}-$X{4}-$X{12}\$" \
  || nomerge "ABORT deployment id must be the live deployment's full UUID (got '$DEPLOY')" 2
RAILWAY_DIR_IN=${RAILWAY_DIR:-$HOME/guard}
RAILWAY_DIR=$(cd "$RAILWAY_DIR_IN" 2>/dev/null && pwd -P) && [ -n "$RAILWAY_DIR" ] \
  || nomerge "ABORT RAILWAY_DIR is not a directory: $RAILWAY_DIR_IN" 2
MAX_AGE=${MAX_AGE:-75}
case "$MAX_AGE" in ''|*[!0123456789]*) nomerge "ABORT MAX_AGE must be a whole number of seconds" 2;; esac
[ "$MODE" = --dry-run ] || [ "$MAX_AGE" -le 75 ] || nomerge "ABORT MAX_AGE over 75 s is for dry runs only" 2
STATE=$(mktemp -d "${TMPDIR:-/tmp}/proxy-merge.XXXXXX") && STATE=$(cd "$STATE" && pwd -P) && [ -d "$STATE" ] \
  || nomerge "ABORT cannot create a state dir" 3
# Hold off idle sleep for as long as this script runs (the lid must stay open).
/usr/bin/caffeinate -i -w $$ >/dev/null 2>&1 &

# timed <secs> cmd... : run cmd in its own process group; SIGKILL the group on
# timeout (exit 137) or when this perl gets INT/TERM/HUP (exit 130); 127 if
# the command cannot be run.
timed() {
  perl -e '
    my $t = shift;
    my $p = fork; defined $p or exit 125;
    if (!$p) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127 }
    my $kill = sub { kill "KILL", -$p; waitpid($p, 0); exit 130 };
    $SIG{INT} = $SIG{TERM} = $SIG{HUP} = $kill;
    $SIG{ALRM} = sub { kill "KILL", -$p; waitpid($p, 0); exit 137 };
    alarm $t; waitpid($p, 0); alarm 0;
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$@"
}
canon() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
pt() { TZ=America/Los_Angeles date -r "$1" '+%a %H:%M:%S %Z'; }
age_of() {                                          # whole seconds since an ISO-8601 Z time, or empty
  python3 -c "import datetime,re,sys
try:
  s=re.sub(r'(\.\d{6})\d+', r'\1', sys.argv[1])
  if not s.endswith('Z'): raise ValueError
  t=datetime.datetime.fromisoformat(s[:-1]+'+00:00')
  print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()))
except Exception: pass" "$1"; }
isint() { case "$1" in ''|-|*[!0123456789-]*|?*-*) return 1;; *) return 0;; esac; }
fresh() { isint "$1" && [ "$1" -ge -5 ] && [ "$1" -le "$2" ]; }   # fresh <age> <max>

# ── arguments ────────────────────────────────────────────────────────────────
B=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$BOUNDARY" +%s 2>/dev/null) && [ "$(canon "$B")" = "$BOUNDARY" ] \
  || nomerge "ABORT boundary is not a canonical UTC time (got '$BOUNDARY')" 2
D=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$DEADLINE" +%s 2>/dev/null) && [ "$(canon "$D")" = "$DEADLINE" ] \
  || nomerge "ABORT deadline is not a canonical UTC time (got '$DEADLINE')" 2
[ $((B % 1800)) -eq 0 ] || nomerge "ABORT boundary must be a :00 or :30 ping-window open" 2
[ "$B" -lt "$D" ] || nomerge "ABORT boundary is not before the deadline" 2
[ $((D - B)) -le 1500 ] || nomerge "ABORT deadline more than 25 min after the boundary (one arm per window)" 2
NOW=$(date -u +%s)
[ $((D - NOW)) -le 10800 ] || nomerge "ABORT deadline more than 3 h away" 2
cp "$UA_FILE" "$STATE/ua.tsv" 2>/dev/null || nomerge "ABORT cannot read ua_file" 2
NUA=$(python3 -c "import sys
lines=[l.rstrip('\n') for l in open(sys.argv[1])]
rows=[]
for l in lines:
    if not l.strip(): continue
    p=l.split('\t')
    if len(p)!=2 or not p[0].strip() or not p[1].strip() or '+' in p[0]: print(0); sys.exit()
    rows.append((p[0].strip(), p[1].strip()))
labs=[r[0] for r in rows]; uas=[r[1] for r in rows]
print(len(rows) if rows and len(set(labs))==len(labs) and len(set(uas))==len(uas) else 0)" "$STATE/ua.tsv" 2>/dev/null)
isint "$NUA" && [ "$NUA" -ge 1 ] || nomerge "ABORT ua_file must hold distinct LABEL<TAB>UA lines (no duplicate label or UA, no '+')" 2
cd /private/tmp || nomerge "ABORT cd" 3
if git rev-parse --git-dir >/dev/null 2>&1; then nomerge "ABORT cwd is inside a git checkout" 3; fi
log "armed pr=$PR mode=$MODE boundary=$BOUNDARY ($(pt "$B")) deadline=$DEADLINE ($(pt "$D")) max_age=${MAX_AGE}s deploy=${DEPLOY:0:8} head=${HEAD_WANT:0:8} main=${MAIN_WANT:0:8} state=$STATE gating_sessions=$NUA ($(cut -f1 "$STATE/ua.tsv" | tr '\n' ' '))"

# ── preflight ────────────────────────────────────────────────────────────────
off=$(timed 10 sntp -t 3 time.apple.com 2>/dev/null | awk 'NR==1{print $1}')
python3 -c "import sys; sys.exit(0 if abs(float(sys.argv[1]))<=2 else 1)" "$off" 2>/dev/null \
  || nomerge "ABORT clock check failed (sntp offset '$off', must be within 2 s)" 4
pre=$(timed 15 gh pr view $PR -R $REPO --json headRefOid,mergeStateStatus,state,baseRefName --jq '.headRefOid+" "+.mergeStateStatus+" "+.state+" "+.baseRefName' 2>&1)
main=$(timed 15 gh api repos/$REPO/commits/main --jq .sha 2>&1)
# The NEWEST deployment in any status must be the live one, built from main: a
# queued or building deploy would switch over during the arm, and a rollback
# would make the merge ship main commits the API is not running.
newest_deployment() {  # newest_deployment <secs> -> "<id> <status> <commit>", or empty
  ( cd "$RAILWAY_DIR" && timed "$1" railway deployment list --service guard --environment production --json 2>/dev/null ) \
    | python3 -c "import sys,json
d=json.load(sys.stdin)
x=d[0] if d else None
print(' '.join([x.get('id') or '-', x.get('status') or '-', (x.get('meta') or {}).get('commitHash') or '-']) if x else '')" 2>/dev/null
}
live=$(newest_deployment 30)
log "preflight: clock_offset=${off}s pr=$pre main=$main newest_deployment=$live"
[ "$pre" = "$HEAD_WANT CLEAN OPEN main" ] || nomerge "ABORT preflight PR mismatch" 4
[ "$main" = "$MAIN_WANT" ] || nomerge "ABORT preflight main moved" 4
[ "$live" = "$DEPLOY SUCCESS $MAIN_WANT" ] || nomerge "ABORT preflight: the newest deployment is not $DEPLOY, SUCCESS, built from main" 4
while [ "$(date -u +%s)" -lt "$B" ]; do
  [ "$(date -u +%s)" -ge "$D" ] && nomerge "ABORT deadline reached before the boundary" 5
  sleep 1
done
log "boundary reached; polling HTTP logs every ~2 s for 201 pings"

# One line per NEW 201 ping at or after BOUNDARY (by requestId), then:
# STATUS <all|partial> <latest_counted_iso|-> <label=first_iso,...> bad=<n>
# No source address is read or printed.
cat > "$STATE/classify.py" <<'PY'
import sys, json, os, datetime, re
state, boundary = sys.argv[1], sys.argv[2]
def when(s):
    s = re.sub(r'(\.\d{6})\d+', r'\1', s)
    return datetime.datetime.fromisoformat(s[:-1] + '+00:00') if s.endswith('Z') else None
b = when(boundary)
uas = [l.rstrip('\n').split('\t') for l in open(os.path.join(state, 'ua.tsv')) if l.strip()]
uas = [(p[0].strip(), p[1].strip()) for p in uas]
seen_path = os.path.join(state, 'seen.json')
seen = json.load(open(seen_path)) if os.path.exists(seen_path) else {}
bad, rows = 0, []
for l in sys.stdin:
    if not l.strip().startswith('{'): continue
    try:
        r = json.loads(l)
        t = when(r['timestamp'])
        if r.get('path') != '/api/locations/ping' or int(r.get('httpStatus', 0)) != 201: continue
        if t is None or t < b: continue
        rows.append((t, r))
    except Exception:
        bad += 1
for t, r in sorted(rows, key=lambda x: x[0]):
    rid = r.get('requestId')
    if not rid or rid in seen: continue
    label = next((lab for lab, ua in uas if r.get('clientUa') == ua), 'UNATTRIBUTED')
    seen[rid] = {'t': r['timestamp'], 'label': label}
    print(f"NEWPING {r['timestamp']} {r['httpStatus']} {label} req={rid[:8]}")
json.dump(seen, open(seen_path, 'w'))
first, last = {}, {}
for rid, v in seen.items():
    if v['label'] == 'UNATTRIBUTED': continue
    first[v['label']] = min(first.get(v['label'], v['t']), v['t'])
    last[v['label']] = max(last.get(v['label'], v['t']), v['t'])
labels = [lab for lab, _ in uas]
ok = bool(labels) and all(lab in first for lab in labels)
latest = max(last.values()) if last else '-'
print('STATUS', 'all' if ok else 'partial', latest,
      ','.join(f"{lab}={first.get(lab, 'none')}" for lab in labels), f"bad={bad}")
PY
classify() { python3 "$STATE/classify.py" "$STATE" "$BOUNDARY"; }

beat=0
while :; do
  now=$(date -u +%s)
  [ "$now" -ge "$D" ] && nomerge "ABORT deadline reached: not every gating session has a new ping" 5
  UNTIL=$(date -u -r $((now + 5)) +%Y-%m-%dT%H:%M:%SZ)
  # --until is required (without it railway logs streams forever); railway must
  # run in the linked project dir. Rows go straight to classify, never to disk.
  out=$( { cd "$RAILWAY_DIR" && timed 20 railway logs $DEPLOY --service guard --environment production --http --json --method POST --path /api/locations/ping --since "$BOUNDARY" --until "$UNTIL" -n 100 2>"$STATE/rwerr"; echo $? > "$STATE/rwrc"; } 2>/dev/null | classify)
  rwrc=$(cat "$STATE/rwrc" 2>/dev/null)
  [ "$rwrc" = 0 ] || log "WARN railway logs exited rc=${rwrc:-?}: $(head -c 200 "$STATE/rwerr" 2>/dev/null | tr '\n' ' ')"
  echo "$out" | grep '^NEWPING' | while IFS= read -r l; do log "$l"; done
  st=$(echo "$out" | grep '^STATUS')
  [ -n "$st" ] || log "WARN classify printed no STATUS"
  if [ "$((now - beat))" -ge 60 ]; then log "heartbeat: ${st:-no status}"; beat=$now; fi
  if [ "${st#STATUS all }" != "$st" ]; then
    latest=$(echo "$st" | cut -d' ' -f3)
    log "all gating sessions have a new 201 ping: $st"
    age=$(age_of "$latest")
    isint "$age" || nomerge "ABORT age of the latest ping not computable ($latest)" 6
    log "latest counted ping $latest age=${age}s"
    fresh "$age" "$MAX_AGE" || nomerge "ABORT latest ping outside the window (age ${age}s; must be -5..${MAX_AGE})" 6
    # Two tries each: a transient gh error (or a momentary UNKNOWN merge state)
    # must not throw the window away. The age and deadline re-checks below
    # still bound the whole thing.
    for try in 1 2; do
      chk=$(timed 15 gh pr view $PR -R $REPO --json headRefOid,mergeStateStatus,baseRefName --jq '.headRefOid+" "+.mergeStateStatus+" "+.baseRefName' 2>&1)
      log "pre-merge check (try $try): $chk"
      [ "$chk" = "$HEAD_WANT CLEAN main" ] && break
      [ "$try" = 2 ] || sleep 2
    done
    [ "$chk" = "$HEAD_WANT CLEAN main" ] || nomerge "ABORT pre-merge mismatch (or gh timed out)" 7
    for try in 1 2; do
      main2=$(timed 15 gh api repos/$REPO/commits/main --jq .sha 2>&1)
      log "pre-merge main (try $try): $main2"
      [ "$main2" = "$MAIN_WANT" ] && break
      [ "$try" = 2 ] || sleep 2
    done
    [ "$main2" = "$MAIN_WANT" ] || nomerge "ABORT pre-merge: main moved since approval (or gh timed out)" 7
    for try in 1 2; do
      live2=$(newest_deployment 10)
      log "pre-merge newest deployment (try $try): $live2"
      [ "$live2" = "$DEPLOY SUCCESS $MAIN_WANT" ] && break
      [ "$try" = 2 ] || sleep 2
    done
    [ "$live2" = "$DEPLOY SUCCESS $MAIN_WANT" ] || nomerge "ABORT pre-merge: the newest deployment changed (or railway timed out)" 7
    # Re-check both limits immediately before the one write, and give the merge
    # call only the time that is left (88 s from the ping, and the deadline).
    [ "$(date -u +%s)" -lt "$D" ] || nomerge "ABORT deadline passed before the merge" 5
    age=$(age_of "$latest"); fresh "$age" 85 || nomerge "ABORT ping aged past the window before the merge (age=${age})" 6
    left=$((88 - age)); dl=$((D - $(date -u +%s))); [ "$dl" -lt "$left" ] && left=$dl
    [ "$left" -ge 3 ] || nomerge "ABORT only ${left}s left for the merge call" 6
    if [ "$MODE" = --dry-run ]; then log "DRY RUN: WOULD MERGE NOW (ping age ${age}s, merge call limit ${left}s)"; echo "NO MERGE PERFORMED (dry run)"; SAID=1; exit 0; fi
    log "MERGING (ping age ${age}s, merge call limit ${left}s)"
    ATTEMPTED=1
    mo=$(timed "$left" gh pr merge $PR -R $REPO --merge --match-head-commit "$HEAD_WANT" 2>&1); mrc=$?
    echo "$mo" | while IFS= read -r l; do log "gh: $l"; done
    log "merge command returned rc=$mrc"
    timed 15 gh pr view $PR -R $REPO --json state,mergedAt,mergeCommit --jq '.state+" "+.mergedAt+" "+.mergeCommit.oid' 2>&1 | while IFS= read -r l; do log "result: $l"; done
    DONE=1
    exit "$mrc"
  fi
  sleep 4
done
