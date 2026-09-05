#!/usr/bin/env bash
#
# NetraOps triage runner. Invoked by .github/workflows/ops-triage.yml on a
# 6-hour schedule and by manual dispatch. Read-only throughout.
#
# WHY THE SHELL COLLECTS THE SIGNALS (Phase 4.2)
# ----------------------------------------------
# Run 33964038694 reported SUCCESS and posted a report that was authored from
# docs/OPS/STATE.md alone. Every Bash and WebFetch call the model attempted came
# back "requires approval", so it collected nothing live and said so only
# obliquely. Two causes, both now removed:
#
#   1. `claude -p` starts in Manual permission mode on every plan. With nobody
#      to answer, anything not matching an allow rule is denied outright.
#   2. The old --allowedTools rules were too specific to match what the model
#      actually typed -- e.g. Bash(psql "$DATABASE_READONLY_URL"*) interpolated
#      a URL, with quotes, into a prefix rule -- and WebFetch was never listed
#      at all.
#
# A triage pass that silently reports on nothing is worse than no triage pass,
# because the output looks identical to a clean run. So the shell now collects
# every live signal BEFORE claude is invoked, and the model's job is reduced to
# reading one file and writing the report. Its tool allowlist no longer includes
# psql, curl or railway, because it no longer needs them.
#
# Each collector is wrapped: a failure writes
#   COLLECTOR FAILED: <name>: <one-line error>
# into the pack and the run continues. A partial pack with named gaps is useful;
# an aborted run is not.
#
# DATA RULE: every query selects ID and count columns only. Never name, email,
# phone, lat or lng. See docs/OPS/POLICY.md.
#
# Local dry run:
#   TRIAGE_LOCAL=1 SLACK_SINK=/tmp/slack.json bash scripts/ops/triage.sh
# Collection only, no model call (also the workflow's dry_run input):
#   TRIAGE_DRY_RUN=1 TRIAGE_LOCAL=1 bash scripts/ops/triage.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

OUT="${TRIAGE_OUT:-report.md}"
CONTEXT="${TRIAGE_CONTEXT:-/tmp/triage-context.md}"
LOCAL="${TRIAGE_LOCAL:-0}"
DRY_RUN="${TRIAGE_DRY_RUN:-0}"

STARNET='27c4d404-8769-49ca-bfd6-93cb9b890067'
BETHEL='53c71c64-1973-4f82-be9c-98e4800beece'
API='https://api.netraops.com'

# ---------------------------------------------------------------------------
# Secrets. Fail fast and by NAME.
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
  require_secret DATABASE_READONLY_URL || MISSING=1
  printf 'local mode: using ambient claude/railway/sentry auth, slack sink=%s\n' \
    "${SLACK_SINK:-/tmp/slack.json}"
else
  for s in SENTRY_AUTH_TOKEN RAILWAY_TOKEN DATABASE_READONLY_URL; do
    require_secret "$s" || MISSING=1
  done
  if [ "$DRY_RUN" = "1" ]; then
    printf 'dry run: ANTHROPIC_API_KEY and SLACK_WEBHOOK_URL not required\n'
  else
    for s in ANTHROPIC_API_KEY SLACK_WEBHOOK_URL; do
      require_secret "$s" || MISSING=1
    done
  fi
fi

if [ "$MISSING" -ne 0 ]; then
  printf 'FATAL: one or more required secrets are missing. Refusing to run.\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Collector harness.
#
# collect <section name> <command...>
#
# Writes a "## <name>" header, then either a fenced block with the output and
# its line count, or a single COLLECTOR FAILED line. Never aborts the run --
# `set -e` is sidestepped by testing the exit status explicitly.
# ---------------------------------------------------------------------------
COLLECTOR_FAILURES=0

collect() {
  local name="$1"; shift
  local out rc
  out="$("$@" 2>&1)" && rc=0 || rc=$?

  printf '\n## %s\n\n' "$name"
  if [ "$rc" -ne 0 ]; then
    COLLECTOR_FAILURES=$((COLLECTOR_FAILURES + 1))
    printf 'COLLECTOR FAILED: %s: %s\n' \
      "$name" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  else
    printf 'lines: %s\n\n' "$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
    printf '```\n%s\n```\n' "$out"
  fi
}

psql_at() {
  psql "$DATABASE_READONLY_URL" -At -v ON_ERROR_STOP=1 -c "$1"
}

# ── individual collectors ───────────────────────────────────────────────────

c_health() {
  local body code
  body="$(curl -s --max-time 20 "$API/health")"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/health")"
  printf 'HTTP %s\n%s\n' "$code" "$body"
}

c_health_crons() {
  local body code
  body="$(curl -s --max-time 20 "$API/health/crons")"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/health/crons")"
  printf 'HTTP %s\n%s\n' "$code" "$body"
  printf '\nNOTE: 503 with a stale list is the dead-cron alarm. 200 with stale:[] is healthy.\n'
}

c_heartbeats() {
  printf 'job_name|last_result|age_seconds\n'
  psql_at "SELECT job_name, last_result, EXTRACT(EPOCH FROM (NOW()-last_tick_at))::int
             FROM cron_heartbeats ORDER BY 3 DESC"
}

c_starnet_sessions() {
  printf 'open_starnet_sessions: '
  psql_at "SELECT COUNT(*) FROM shift_sessions ss
             JOIN guards g ON g.id = ss.guard_id
            WHERE ss.clocked_out_at IS NULL AND g.company_id = '$STARNET'"
  printf '\ncontrol -- open sessions per company_id (all tenants):\n'
  printf 'company_id|open_sessions\n'
  psql_at "SELECT g.company_id, COUNT(*) FROM shift_sessions ss
             JOIN guards g ON g.id = ss.guard_id
            WHERE ss.clocked_out_at IS NULL GROUP BY g.company_id ORDER BY 2 DESC"
  printf '\nNOTE: if open_starnet_sessions is 0, the control list proves the join works.\n'
  printf 'An empty result from a broken join is indistinguishable from a true zero.\n'
}

c_customer_signal() {
  printf 'active_guards_last_7d|active_guards_prior_7d|sessions_last_7d\n'
  psql_at "SELECT
      (SELECT COUNT(DISTINCT ss.guard_id) FROM shift_sessions ss
         JOIN guards g ON g.id = ss.guard_id
        WHERE g.company_id = '$STARNET'
          AND ss.clocked_in_at >= NOW() - INTERVAL '7 days'),
      (SELECT COUNT(DISTINCT ss.guard_id) FROM shift_sessions ss
         JOIN guards g ON g.id = ss.guard_id
        WHERE g.company_id = '$STARNET'
          AND ss.clocked_in_at >= NOW() - INTERVAL '14 days'
          AND ss.clocked_in_at <  NOW() - INTERVAL '7 days'),
      (SELECT COUNT(*) FROM shift_sessions ss
         JOIN guards g ON g.id = ss.guard_id
        WHERE g.company_id = '$STARNET'
          AND ss.clocked_in_at >= NOW() - INTERVAL '7 days')"
  printf '\nNOTE: counts only, no identities. A sustained drop is the customer leaving.\n'
}

c_open_violations() {
  printf 'open_geofence_violations_over_6h (excluding Bethel AME %s): ' "$BETHEL"
  psql_at "SELECT COUNT(*) FROM geofence_violations
            WHERE resolved_at IS NULL
              AND occurred_at < NOW() - INTERVAL '6 hours'
              AND site_id <> '$BETHEL'"
}

c_stuck_sessions() {
  printf 'sessions_open_past_scheduled_end_plus_3h: '
  psql_at "SELECT COUNT(*) FROM shift_sessions ss
             JOIN shifts s ON s.id = ss.shift_id
            WHERE ss.clocked_out_at IS NULL
              AND NOW() > s.scheduled_end + INTERVAL '3 hours'"
}

c_railway_logs() {
  # --service and --environment are REQUIRED here. A GitHub runner has no
  # ~/.railway link, and RAILWAY_TOKEN alone does not imply a service, so a
  # bare `railway logs` returns:
  #     No service linked
  #     Run `railway service` to link a service
  # Verified from run 33964954767's uploaded context pack (railway 5.49.2).
  #
  # If CI still reports "No project linked" after this, the fix is one line --
  # add a repo VARIABLE (not a secret) RAILWAY_PROJECT_ID and run
  #   railway link --project "$RAILWAY_PROJECT_ID" --service guard --environment production
  # before this call. Not added now because the observed error names the
  # SERVICE, not the project, and an unused link step is a thing that rots.
  local out rc
  out="$(railway logs --service guard --environment production --lines 300 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
  # Railway EXITS 0 while printing a link error, so the wrapper's exit-status
  # check alone recorded that failure as a successful 3-line collection in run
  # 33964954767. That is the exact silent-failure class this loop exists to
  # remove, so match the error text explicitly and fail loudly.
  if printf '%s' "$out" | grep -qiE 'No (service|project|environment) linked|Run .railway (service|link|environment).'; then
    return 1
  fi
}

# Cap on per-issue stat lookups. Each recent issue costs one extra API call;
# this bounds a bad day rather than letting the collector run unbounded. If it
# binds, the collector says so rather than silently truncating.
SENTRY_ISSUE_CAP=15

c_sentry() {
  local project="$1"
  local cutoff
  cutoff="$(date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
            || date -u -v-6H +%Y-%m-%dT%H:%M:%SZ)"

  # TWO COUNTS, NAMED HONESTLY.
  #
  # `count` on the issues endpoint is the LIFETIME total since firstSeen; it is
  # NOT scoped by statsPeriod. Emitting it under a heading that said "issues
  # from the last 24h" is how the 2026-09-05 triage reported "count 303 in 24h"
  # for an issue whose real 24h volume was 54 and whose lifetime spanned six
  # weeks. See docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md.
  #
  # count_24h is summed from the PER-ISSUE endpoint's hourly buckets, one call
  # per recent issue. The listing's own embedded stats are NOT trustworthy:
  # measured 2026-09-05, the listing returned 24 buckets summing to 0 for issue
  # 7713575234 while /issues/7713575234/?statsPeriod=24h returned 25 buckets
  # summing to 4, with the events plainly inside the window. Same field name,
  # different answer -- so the accurate source is the one worth the extra call.
  #
  # statsPeriod accepts only '', 24h and 14d; 6h returns HTTP 400. Fetch 24h and
  # filter on lastSeen here, so the model never has to know that.
  local listing recent total shown
  listing="$(curl -s --max-time 30 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/projects/netraopscom/$project/issues/?statsPeriod=24h")"

  if ! printf '%s' "$listing" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf 'SENTRY API ERROR: %s\n' "$(printf '%s' "$listing" | head -c 200)"
    return 1
  fi

  total="$(printf '%s' "$listing" | jq 'length')"
  recent="$(printf '%s' "$listing" | jq -c --arg cutoff "$cutoff" \
    '[ .[] | select(.lastSeen >= $cutoff) ]')"
  shown="$(printf '%s' "$recent" | jq 'length')"

  printf 'issues_24h: %s   issues_last_6h: %s\n' "$total" "$shown"
  if [ "$shown" -gt "$SENTRY_ISSUE_CAP" ]; then
    printf 'NOTE: %s issues in the last 6h; showing the %s most recent.\n' \
      "$shown" "$SENTRY_ISSUE_CAP"
  fi
  printf '\n'
  printf 'id|shortId|level|count_24h|lifetime|firstSeen|lastSeen|title\n'

  printf '%s' "$recent" \
  | jq -r --argjson cap "$SENTRY_ISSUE_CAP" \
      '.[:$cap][] | "\(.id)\t\(.shortId)\t\(.level)\t\(.count)\t\(.firstSeen)\t\(.lastSeen)\t\(.title)"' \
  | while IFS=$'\t' read -r id shortid level lifetime firstseen lastseen title; do
      local c24
      c24="$(curl -s --max-time 20 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
              "https://sentry.io/api/0/issues/$id/?statsPeriod=24h" \
            | jq -r '(.stats["24h"] // []) | map(.[1]) | add // "?"' 2>/dev/null)"
      [ -z "$c24" ] && c24='?'
      printf '%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "$id" "$shortid" "$level" "$c24" "$lifetime" "$firstseen" "$lastseen" "$title"
    done
}

c_sentry_api()    { c_sentry netraops-api; }
c_sentry_mobile() { c_sentry netraops-mobile; }

c_git_log() { git log -20 --oneline; }

# ---------------------------------------------------------------------------
# Build the pack.
# ---------------------------------------------------------------------------
{
  printf '# Triage context pack\n\n'
  printf 'EVERY LIVE SIGNAL IS ALREADY BELOW. Report from this file.\n'
  printf 'Any section reading COLLECTOR FAILED means that signal is UNVERIFIED --\n'
  printf 'say so in the report and do NOT try to fetch it yourself.\n\n'
  printf 'Collected: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Pacific:   %s\n' "$(TZ=America/Los_Angeles date +'%Y-%m-%d %H:%M %Z')"
  printf 'Weekday:   %s\n' "$(TZ=America/Los_Angeles date +%A)"
  printf 'Run id:    %s\n' "${GITHUB_RUN_ID:-local}"
  printf 'Trigger:   %s\n' "${GITHUB_EVENT_NAME:-manual}"
  printf 'Focus:     %s\n' "${TRIAGE_FOCUS:-none}"
  printf 'HEAD:      %s\n' "$(git rev-parse --short HEAD)"

  printf '\n---\n\n# LIVE SIGNALS\n'

  collect 'health'                      c_health
  collect 'health-crons'                c_health_crons
  collect 'cron-heartbeats'             c_heartbeats
  collect 'starnet-open-sessions'       c_starnet_sessions
  collect 'customer-signal'             c_customer_signal
  collect 'open-geofence-violations'    c_open_violations
  collect 'stuck-sessions'              c_stuck_sessions
  collect 'railway-logs'                c_railway_logs
  collect 'sentry-netraops-api'         c_sentry_api
  collect 'sentry-netraops-mobile'      c_sentry_mobile
  collect 'git-log'                     c_git_log

  printf '\n---\n\n# REPO MEMORY\n'
  for f in docs/OPS/STATE.md docs/OPS/OPEN-ITEMS.md docs/OPS/FREEZES.md \
           docs/OPS/DECISIONS.md docs/OPS/POLICY.md docs/OPS/REPORT-TEMPLATE.md; do
    printf -- '\n---\n\n# FILE: %s\n\n' "$f"
    cat "$f"
    printf '\n'
  done
} > "$CONTEXT"

printf 'context pack: %s (%s lines, %s collector failure(s))\n' \
  "$CONTEXT" "$(wc -l < "$CONTEXT" | tr -d ' ')" "$COLLECTOR_FAILURES"

if [ "$DRY_RUN" = "1" ]; then
  printf 'dry run: collection only, not calling claude\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# The model run.
#
# The allowlist is now three read-only entries plus the file tools. The model
# reads the pack; it does not gather anything.
#
# Syntax verified against code.claude.com/docs/en/permissions 2026-09-05:
# "The `:*` suffix is an equivalent way to write a trailing wildcard, so
# Bash(ls:*) matches the same commands as Bash(ls *)", and it is recognised
# only at the end of a pattern. The space matters in the other form --
# Bash(git log*) would also match `git logfoo`.
#
# --permission-mode dontAsk: `claude -p` starts in Manual mode on every plan,
# and the docs name dontAsk as the mode for "locked-down CI runs" -- it denies
# anything outside the allow rules and the built-in read-only command set
# instead of waiting on a prompt nobody will answer. That is the flag the
# previous run needed. --permission-prompts none would also suit but requires
# v2.1.259+, and with no permission host in a plain -p run the docs say such
# requests are denied either way, so it buys nothing here and would break on
# older CLIs.
# ---------------------------------------------------------------------------
ALLOWED_TOOLS="Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(cat ${CONTEXT})"

PROMPT_BODY="$(cat .github/ops/triage-prompt.md)"
if [ -n "${TRIAGE_FOCUS:-}" ]; then
  PROMPT_BODY="$PROMPT_BODY

## Focus for this run

The operator asked you to pay particular attention to the following. It does
NOT replace the standard reporting above; do both.

${TRIAGE_FOCUS}"
fi

PROMPT_BODY="$PROMPT_BODY

## Context pack

Every live signal has already been collected for you at ${CONTEXT}.
Read that file first. Do not attempt to collect anything yourself."

# Model is pinned so a runner default change cannot silently alter cost or
# quality. Run 33964954767 passed no --model at all and its log names no model,
# so what actually served that report is UNVERIFIABLE after the fact.
#
# Scheduled runs are routine and get the cheaper model. A manual run carries a
# `focus`, which means a human is chasing something -- that is an alarm, and it
# gets the stronger model. MODEL is set by the workflow; this default keeps a
# local run working.
MODEL="${MODEL:-claude-sonnet-5}"

printf 'starting claude -p (model=%s, max-turns 40)\n' "$MODEL"

set +e
claude -p "$PROMPT_BODY" \
  --output-format text \
  --max-turns 40 \
  --model "$MODEL" \
  --permission-mode dontAsk \
  --allowedTools "$ALLOWED_TOOLS" \
  > "$OUT"
CLAUDE_EXIT=$?
set -e

# A rejected model id is a startup error, not a triage result. Surface it as
# itself rather than letting the generic banner call it a runner failure.
if [ "$CLAUDE_EXIT" -ne 0 ] && grep -qiE 'model|unknown|invalid' "$OUT" 2>/dev/null; then
  printf 'NOTE: claude exited %s; check whether --model %s was rejected.\n' \
    "$CLAUDE_EXIT" "$MODEL" >&2
fi

# A non-zero exit is a failure EVEN IF the file is non-empty. claude writes some
# fatal errors to stdout, so a failed run leaves a one-line file like "Failed to
# authenticate: OAuth session expired" -- non-empty, passes a naive -s check,
# and gets posted to Slack looking like a report. Caught in the 2026-09-05 dry
# run. Banner first, original output kept below it.
if [ "$CLAUDE_EXIT" -ne 0 ] || [ ! -s "$OUT" ]; then
  printf 'claude exited %s\n' "$CLAUDE_EXIT" >&2
  ORIGINAL="$(cat "$OUT" 2>/dev/null || true)"
  {
    printf '# Triage FAILED\n\n'
    printf 'claude exited %s and produced %s bytes.\n\n' "$CLAUDE_EXIT" "${#ORIGINAL}"
    printf 'This is a RUNNER FAILURE, not an all-green result. The report was not written.\n'
    printf 'The context pack was still collected -- see the uploaded artifact.\n\n'
    if [ -n "$ORIGINAL" ]; then
      printf '## Output captured before failure\n\n```\n%s\n```\n' "$ORIGINAL"
    fi
  } > "$OUT"
fi

printf 'report: %s (%s lines)\n' "$OUT" "$(wc -l < "$OUT" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Slack.
# ---------------------------------------------------------------------------
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-vvishnu1998-lab/guard}/actions/runs/${GITHUB_RUN_ID:-0}"
BODY="$(head -c 3500 "$OUT")"

PAYLOAD="$(BODY="$BODY" RUN_URL="$RUN_URL" FAILS="$COLLECTOR_FAILURES" python3 -c '
import json, os
body = os.environ["BODY"]
url = os.environ["RUN_URL"]
fails = os.environ.get("FAILS", "0")
suffix = "\n\nFull report: " + url
if fails != "0":
    suffix = "\n\n:warning: " + fails + " collector(s) failed -- some signals are UNVERIFIED." + suffix
print(json.dumps({"text": body + suffix}))
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
