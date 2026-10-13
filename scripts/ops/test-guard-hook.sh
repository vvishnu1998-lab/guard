#!/bin/bash
# test-guard-hook.sh — the PreToolUse guard (.claude/hooks/guard.sh) against
# the commands it must block, the pushes it must hand to Vishnu, and the ones
# it must let through (N183).
#
#   scripts/ops/test-guard-hook.sh [path/to/guard.sh]     # default: the repo's hook
#
# Each case is fed to the hook as the JSON payload Claude Code sends for a
# Bash call. Exit 2 is a block. Exit 0 with a valid JSON PreToolUse decision of
# "ask" on stdout is an ask (Vishnu approves or refuses it in the app); exit 0
# with nothing on stdout is a pass. Anything else is a failure of its own (the
# hook contract allows only those). Point it at an older copy of the hook to
# see which cases that copy misses. Nothing here runs the commands.
#
# macOS + bash 3.2. Exits non-zero if any check fails.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
HOOK=${1:-$HERE/../../.claude/hooks/guard.sh}
[ -x "$HOOK" ] || { echo "no executable hook at $HOOK"; exit 2; }

pass=0; fail=0
verdict() {   # verdict <exit code> <stdout> → block | ask | allow | "exit N" | "bad stdout"
  local rc=$1 out=$2
  if [ "$rc" = 2 ]; then echo block; return; fi
  if [ "$rc" != 0 ]; then echo "exit $rc"; return; fi
  if [ -z "$out" ]; then echo allow; return; fi
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)["hookSpecificOutput"]
except Exception:
    print("bad stdout"); sys.exit()
ok = d.get("hookEventName") == "PreToolUse" and d.get("permissionDecision") == "ask" and d.get("permissionDecisionReason")
print("ask" if ok else "bad stdout")'
}
run() {   # run <want: block|ask|allow> <command>
  local want=$1 cmd=$2 payload out rc got
  payload=$(python3 -c 'import json, sys; print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))' "$cmd")
  out=$(printf '%s' "$payload" | "$HOOK" 2>/dev/null)
  rc=$?
  got=$(verdict "$rc" "$out")
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf '  ok    %-5s  %s\n' "$want" "$cmd"
  else fail=$((fail + 1)); printf '  FAIL  want %s, got %s:  %s\n' "$want" "$got" "$cmd"; fi
}

echo "hook: $HOOK"
echo "-- a git push, in any shape, asks Vishnu (N183)"
run ask 'git push origin main'
run ask 'cd /tmp && git push origin main'
run ask 'git -C /Users/x/guard-wt/b5 push -u origin feat/x'
run ask 'git -c core.sshCommand=ssh push origin main'
run ask 'git --git-dir=/x/.git push'
run ask 'git --git-dir /x/.git push'
run ask 'git --no-pager -C /x push --force'
run ask '/usr/bin/git -C /x push'
run ask 'cd /x && git -C /y push'
run ask 'cd /x&&git -C /y push'
run ask 'bash -c "git -C /x push origin main"'
run ask 'env GIT_DIR=/x/.git git push'
run ask 'git  push origin main'
run ask 'git -C "/path with space" push'
echo "-- hard blocks stay blocks, even next to a push"
run block 'git push origin main && railway up'
run block 'git -C /x push && vercel deploy --prod'
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
run allow 'git -C /x pull --ff-only'
run allow 'git status --short'
run allow 'gh pr create --title "Close the push guard gap"'
run allow 'echo pushed'
echo "-- payloads that are not a Bash command"
out=$(printf '%s' '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' | "$HOOK" 2>/dev/null); rc=$?
if [ "$(verdict "$rc" "$out")" = allow ]; then pass=$((pass + 1)); echo "  ok    allow  (a Read payload)"; else fail=$((fail + 1)); echo "  FAIL  a Read payload: $(verdict "$rc" "$out")"; fi
out=$(printf '%s' 'not json' | "$HOOK" 2>/dev/null); rc=$?
if [ "$(verdict "$rc" "$out")" = allow ]; then pass=$((pass + 1)); echo "  ok    allow  (unparseable payload)"; else fail=$((fail + 1)); echo "  FAIL  unparseable payload: $(verdict "$rc" "$out")"; fi

echo
echo "$pass passed, $fail failed"
[ $fail = 0 ]
