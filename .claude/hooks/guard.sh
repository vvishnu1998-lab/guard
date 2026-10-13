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
#     git -C /some/dir push                    prefix is git -C (N183)
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

# git's own options before the subcommand (N183): `git -C <dir> push`,
# `git -c k=v push`, `git --git-dir=<d> push`, `/usr/bin/git push`, a doubled
# space. The case above matches only the literal "git push", and the deny
# list only commands that start with it; on 2026-10-13 `git -C <dir> push`
# passed both. This finds git anywhere in the command (lists, pipes and
# `bash -c "..."` strings included), steps over its options, and blocks when
# the subcommand is push. The program uses only double quotes, since it sits
# inside single quotes; a command it cannot tokenize falls back to a plain
# word check, so it fails closed.
if printf '%s' "$COMMAND" | python3 -c '
import re, shlex, sys
TAKES_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"}
def tokens(s):
    lex = shlex.shlex(s, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)
def pushes(s, depth=0):
    try:
        toks = tokens(s)
    except ValueError:
        return re.search(r"\bgit\b.*\bpush\b", s, re.S) is not None
    for i, t in enumerate(toks):
        if depth < 3 and any(c.isspace() for c in t) and pushes(t, depth + 1):
            return True
        if t == "git" or t.endswith("/git"):
            j = i + 1
            while j < len(toks) and toks[j].startswith("-"):
                j += 2 if toks[j] in TAKES_VALUE else 1
            if j < len(toks) and toks[j] == "push":
                return True
    return False
sys.exit(0 if pushes(sys.stdin.read()) else 1)
'; then
  block "git <options> push"
fi

exit 0
