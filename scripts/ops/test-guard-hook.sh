#!/bin/bash
# test-guard-hook.sh — the PreToolUse guard (.claude/hooks/guard.sh) against
# the commands it must block and the ones it must let through (N183).
#
#   scripts/ops/test-guard-hook.sh [path/to/guard.sh]     # default: the repo's hook
#
# Each case is fed to the hook as the JSON payload Claude Code sends for a
# Bash call; exit 2 is a block and exit 0 a pass, and any other exit code is a
# failure of its own (the hook contract allows only those two). Point it at an
# older copy of the hook to see which cases that copy misses: main before N183
# misses every `git <options> push` case. Nothing here runs the commands.
#
# macOS + bash 3.2. Exits non-zero if any check fails.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
HOOK=${1:-$HERE/../../.claude/hooks/guard.sh}
[ -x "$HOOK" ] || { echo "no executable hook at $HOOK"; exit 2; }

pass=0; fail=0
run() {   # run <want: block|allow> <command>
  local want=$1 cmd=$2 payload rc got
  payload=$(python3 -c 'import json, sys; print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))' "$cmd")
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  rc=$?
  case $rc in 2) got=block ;; 0) got=allow ;; *) got="exit $rc" ;; esac
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf '  ok    %-5s  %s\n' "$want" "$cmd"
  else fail=$((fail + 1)); printf '  FAIL  want %s, got %s:  %s\n' "$want" "$got" "$cmd"; fi
}

echo "hook: $HOOK"
echo "-- git with its options before push (N183)"
run block 'git -C /Users/x/guard-wt/b5 push -u origin feat/x'
run block 'git -c core.sshCommand=ssh push origin main'
run block 'git --git-dir=/x/.git push'
run block 'git --git-dir /x/.git push'
run block 'git --no-pager -C /x push --force'
run block '/usr/bin/git -C /x push'
run block 'cd /x && git -C /y push'
run block 'cd /x&&git -C /y push'
run block 'bash -c "git -C /x push origin main"'
run block 'env GIT_DIR=/x/.git git push'
run block 'git  push origin main'
run block 'git -C "/path with space" push'
echo "-- the plain shapes, as before"
run block 'git push origin main'
run block 'cd /tmp && git push origin main'
run block 'DATABASE_URL=postgres://x psql -c "select 1"'
run block 'psql -h postgres.railway.internal'
run block 'bash -c "railway up"'
run block 'eas build --platform ios'
run block 'vercel deploy --prod'
run block 'railway variables --set A=b'
echo "-- git that does not push, and pushes that are not git"
run allow 'git -C /x log --oneline -3'
run allow 'git -C /x ls-remote origin refs/heads/main'
run allow 'git -C /x rev-parse HEAD'
run allow 'git -C /x commit -m "push the fix"'
run allow 'git -C /x log --grep=push'
run allow 'git -C /x fetch origin main'
run allow 'git status --short'
run allow 'gh pr create --title "Close the push guard gap"'
run allow 'echo pushed'
echo "-- payloads that are not a Bash command"
printf '%s' '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' | "$HOOK" >/dev/null 2>&1
rc=$?; if [ $rc = 0 ]; then pass=$((pass + 1)); echo "  ok    allow  (a Read payload)"; else fail=$((fail + 1)); echo "  FAIL  a Read payload: exit $rc"; fi
printf '%s' 'not json' | "$HOOK" >/dev/null 2>&1
rc=$?; if [ $rc = 0 ]; then pass=$((pass + 1)); echo "  ok    allow  (unparseable payload)"; else fail=$((fail + 1)); echo "  FAIL  unparseable payload: exit $rc"; fi

echo
echo "$pass passed, $fail failed"
[ $fail = 0 ]
