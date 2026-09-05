#!/usr/bin/env bash
#
# PreToolUse hook for Bash. Second line of defence behind the deny list in
# .claude/settings.json.
#
# The deny list matches command PREFIXES, so it is defeated by anything that
# moves the dangerous token off the front -- an env var assignment, a cd, a
# pipeline, a subshell:
#
#     DATABASE_URL=... psql -c 'DROP ...'      prefix is DATABASE_URL=, not psql
#     cd /tmp && git push origin main          prefix is cd
#     bash -c 'railway up'                     prefix is bash
#
# This hook reads the whole command string and matches ANYWHERE in it, so those
# shapes are caught. It is intentionally blunt: false positives are cheap
# (rephrase the command), a false negative writes to production.
#
# Contract: tool input JSON on stdin. Exit 2 blocks the call and shows the
# reason. Exit 0 allows. Any other exit is treated as non-blocking by the
# harness, so every failure path here must exit 0 or 2 deliberately.

set -uo pipefail

INPUT="$(cat)"

# Pull .tool_input.command out of the payload. python3 is used rather than jq
# because jq is not guaranteed present. A payload we cannot parse is NOT a
# reason to block -- it is a different tool shape, so fall through to allow.
COMMAND="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
ti = d.get("tool_input") or {}
print(ti.get("command", "") if isinstance(ti, dict) else "")
' 2>/dev/null)"

if [ -z "$COMMAND" ]; then
  exit 0
fi

block() {
  printf 'BLOCKED by .claude/hooks/guard.sh: command contains %s -- production write path, run it yourself if you mean it.\n' "$1" >&2
  exit 2
}

case "$COMMAND" in
  *"DATABASE_URL="*)                block "DATABASE_URL=" ;;
  *"postgres.railway.internal"*)    block "postgres.railway.internal" ;;
  *"git push"*)                     block "git push" ;;
  *"railway up"*)                   block "railway up" ;;
  *"eas "*)                         block "eas " ;;
  *"vercel "*)                      block "vercel " ;;
  *"--set"*)                        block "--set" ;;
esac

exit 0
