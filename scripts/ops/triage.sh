#!/usr/bin/env bash
#
# NetraOps triage runner. Invoked by .github/workflows/ops-triage.yml on a
# 6-hour schedule and by manual dispatch. Runs read-only: it collects context,
# hands it to Claude with a restricted tool allowlist, and writes report.md.
#
# It changes nothing. Every credential it touches is read-only, and the tool
# allowlist below is the enforcement — not a suggestion to the model.
#
# Local dry run:
#   TRIAGE_LOCAL=1 SLACK_SINK=/tmp/slack.json zsh scripts/ops/triage.sh
# In local mode the Slack POST is written to SLACK_SINK instead of being sent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

OUT="${TRIAGE_OUT:-report.md}"
CONTEXT="${TRIAGE_CONTEXT:-/tmp/triage-context.md}"
LOCAL="${TRIAGE_LOCAL:-0}"

# ---------------------------------------------------------------------------
# Secrets. Fail fast and by NAME -- a run that starts with a missing secret and
# discovers it thirty turns in wastes a full API budget and reports nothing.
# Values are never printed, only presence.
# ---------------------------------------------------------------------------
require_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    printf 'FATAL: required secret %s is unset or empty\n' "$name" >&2
    return 1
  fi
  printf 'secret %s: present (%s chars)\n' "$name" "${#value}"
}

MISSING=0

if [ "$LOCAL" = "1" ]; then
  # Local dry run. Only the database URL has no ambient equivalent on a
  # workstation: claude uses the interactive login, railway uses ~/.railway,
  # sentry uses ~/.sentryclirc, and Slack is redirected to a file sink. Faking
  # the other four just to satisfy a presence check would prove nothing and
  # would hand claude an invalid API key.
  require_secret DATABASE_READONLY_URL || MISSING=1
  printf 'local mode: using ambient claude/railway/sentry auth, slack sink=%s\n' \
    "${SLACK_SINK:-/tmp/slack.json}"
else
  for s in ANTHROPIC_API_KEY SENTRY_AUTH_TOKEN RAILWAY_TOKEN DATABASE_READONLY_URL SLACK_WEBHOOK_URL; do
    require_secret "$s" || MISSING=1
  done
fi

if [ "$MISSING" -ne 0 ]; then
  printf 'FATAL: one or more required secrets are missing. Refusing to run.\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Context pack. Assembled here rather than left to the model so every run reads
# the same source of truth and a run is reproducible from the report alone.
# ---------------------------------------------------------------------------
{
  printf '# Triage context\n\n'
  printf 'Collected: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Pacific:   %s\n' "$(TZ=America/Los_Angeles date +'%Y-%m-%d %H:%M %Z')"
  printf 'Weekday:   %s\n' "$(TZ=America/Los_Angeles date +%A)"
  printf 'Run id:    %s\n' "${GITHUB_RUN_ID:-local}"
  printf 'Trigger:   %s\n' "${GITHUB_EVENT_NAME:-manual}"
  printf 'Focus:     %s\n\n' "${TRIAGE_FOCUS:-none}"

  printf '## git log -20 --oneline\n\n```\n'
  git log -20 --oneline
  printf '```\n\n'

  printf '## HEAD\n\n```\n'
  git rev-parse HEAD
  printf '```\n\n'

  for f in docs/OPS/STATE.md docs/OPS/OPEN-ITEMS.md docs/OPS/FREEZES.md \
           docs/OPS/DECISIONS.md docs/OPS/POLICY.md; do
    printf -- '---\n\n# FILE: %s\n\n' "$f"
    cat "$f"
    printf '\n'
  done
} > "$CONTEXT"

printf 'context pack: %s (%s lines)\n' "$CONTEXT" "$(wc -l < "$CONTEXT" | tr -d ' ')"

# ---------------------------------------------------------------------------
# The run.
#
# --allowedTools is the security boundary. Every entry is read-only:
#   psql        bound to DATABASE_READONLY_URL, which cannot read credential
#               columns and holds SELECT only
#   railway     logs and status only -- never up, redeploy, or variable
#   curl        Sentry API and the public health endpoints only
#   git         log and diff only
# There is no Write, no Edit, and no unrestricted Bash. Adding one turns this
# from a triage pass into an agent with production write access.
# ---------------------------------------------------------------------------
ALLOWED_TOOLS="Read,Grep,Glob"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(psql \"$DATABASE_READONLY_URL\"*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(railway logs*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(railway status*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(curl -s https://sentry.io/api/*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(curl -s https://api.netraops.com/health*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(git log*)"
ALLOWED_TOOLS="$ALLOWED_TOOLS,Bash(git diff*)"

PROMPT_BODY="$(cat .github/ops/triage-prompt.md)"
if [ -n "${TRIAGE_FOCUS:-}" ]; then
  PROMPT_BODY="$PROMPT_BODY

## Focus for this run

The operator asked you to pay particular attention to the following. It does
NOT replace the standard collection above; do both.

${TRIAGE_FOCUS}"
fi

PROMPT_BODY="$PROMPT_BODY

## Context pack

Already collected for you at ${CONTEXT}. Read it first with the Read tool
before running any command."

printf 'starting claude -p (max-turns 40)\n'

set +e
claude -p "$PROMPT_BODY" \
  --output-format text \
  --max-turns 40 \
  --allowedTools "$ALLOWED_TOOLS" \
  > "$OUT"
CLAUDE_EXIT=$?
set -e

# A non-zero exit is a failure EVEN IF the file is non-empty. claude writes
# some fatal errors to stdout, so a failed run leaves a one-line file like
# "Failed to authenticate: OAuth session expired" -- which is non-empty, passes
# a naive -s check, and gets posted to Slack looking like a report. Caught in
# the 2026-09-05 local dry run. Banner first, original output kept below it.
if [ "$CLAUDE_EXIT" -ne 0 ] || [ ! -s "$OUT" ]; then
  printf 'claude exited %s\n' "$CLAUDE_EXIT" >&2
  ORIGINAL="$(cat "$OUT" 2>/dev/null || true)"
  {
    printf '# Triage FAILED\n\n'
    printf 'claude exited %s and produced %s bytes.\n\n' "$CLAUDE_EXIT" "${#ORIGINAL}"
    printf 'This is a RUNNER FAILURE, not an all-green result. Nothing was collected.\n'
    printf 'Do not read the absence of findings below as the absence of problems.\n\n'
    if [ -n "$ORIGINAL" ]; then
      printf '## Output captured before failure\n\n```\n%s\n```\n' "$ORIGINAL"
    fi
  } > "$OUT"
fi

printf 'report: %s (%s lines)\n' "$OUT" "$(wc -l < "$OUT" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Slack. 3500 chars is well inside Slack's 40k block limit and keeps the post
# skimmable; the artifact holds the full report.
# ---------------------------------------------------------------------------
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-vvishnu1998-lab/guard}/actions/runs/${GITHUB_RUN_ID:-0}"
BODY="$(head -c 3500 "$OUT")"

PAYLOAD="$(BODY="$BODY" RUN_URL="$RUN_URL" python3 -c '
import json, os
body = os.environ["BODY"]
url = os.environ["RUN_URL"]
print(json.dumps({"text": body + "\n\nFull report: " + url}))
')"

if [ "$LOCAL" = "1" ]; then
  printf '%s' "$PAYLOAD" > "${SLACK_SINK:-/tmp/slack.json}"
  printf 'local mode: slack payload written to %s\n' "${SLACK_SINK:-/tmp/slack.json}"
else
  curl -s -X POST -H 'Content-type: application/json' \
    --data "$PAYLOAD" "$SLACK_WEBHOOK_URL" > /dev/null
  printf 'slack: posted\n'
fi

exit 0
