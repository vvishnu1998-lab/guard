#!/usr/bin/env bash
#
# NetraOps triage runner. Invoked by .github/workflows/ops-triage.yml daily,
# targeting the 08:00 PT hour, and by manual dispatch. Read-only throughout.
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
COST_FILE="${TRIAGE_COST_FILE:-cost.json}"

# Raised from 15 on 2026-09-20. Both failures that week ended
# `error_max_turns` at num_turns 16; the last green run before them used 12 of
# 15, so the ceiling had roughly one collector failure of headroom and the
# 09-19 schema-applied failure consumed it. ONE VARIABLE, read by the flag and
# by the log line: they disagreed before, with 15 hardcoded in each, so a
# change to one would have left the log claiming a limit that was not in force.
MAX_TURNS="${TRIAGE_MAX_TURNS:-25}"

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

# A 503 is a RESULT -- the API answered and it is unhealthy, which is a finding
# the collector succeeded in collecting. Only a transport failure (curl non-zero,
# or http 000 = never connected) is a failure to collect. Before this, neither
# was: curl's status was never read and the function's exit status was the
# trailing printf's, so a dead host produced "HTTP 000" inside a section the
# harness recorded as a success.
c_health() {
  local body code rc
  body="$(curl -s --max-time 20 "$API/health")" && rc=0 || rc=$?
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/health")"
  printf 'HTTP %s\n%s\n' "$code" "$body"
  if [ "$rc" -ne 0 ] || [ "$code" = "000" ]; then
    printf 'curl could not reach %s/health (rc=%s, http=%s)\n' "$API" "$rc" "$code"
    return 1
  fi
  return 0
}

c_health_crons() {
  local body code rc
  # NOTE first: this function must end on something that can fail.
  printf 'NOTE: 503 with a stale list is the dead-cron alarm. 200 with stale:[] is healthy.\n'
  body="$(curl -s --max-time 20 "$API/health/crons")" && rc=0 || rc=$?
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/health/crons")"
  printf 'HTTP %s\n%s\n' "$code" "$body"
  if [ "$rc" -ne 0 ] || [ "$code" = "000" ]; then
    printf 'curl could not reach %s/health/crons (rc=%s, http=%s)\n' "$API" "$rc" "$code"
    return 1
  fi
  return 0
}

c_heartbeats() {
  printf 'job_name|last_result|age_seconds\n'
  psql_at "SELECT job_name, last_result, EXTRACT(EPOCH FROM (NOW()-last_tick_at))::int
             FROM cron_heartbeats ORDER BY 3 DESC"
}

c_starnet_sessions() {
  # NOTES FIRST, deliberately. This function has to END on psql so that its exit
  # status is the query's and not a printf's -- the trailing-NOTE form meant a
  # failed query was recorded as a successful collection.
  printf 'NOTE: if open_starnet_sessions is 0, the control list below proves the join works.\n'
  printf 'An empty result from a broken join is indistinguishable from a true zero.\n\n'
  printf 'open_starnet_sessions: '
  psql_at "SELECT COUNT(*) FROM shift_sessions ss
             JOIN guards g ON g.id = ss.guard_id
            WHERE ss.clocked_out_at IS NULL AND g.company_id = '$STARNET'" || return 1
  printf '\ncontrol -- open sessions per company_id (all tenants):\n'
  printf 'company_id|open_sessions\n'
  psql_at "SELECT g.company_id, COUNT(*) FROM shift_sessions ss
             JOIN guards g ON g.id = ss.guard_id
            WHERE ss.clocked_out_at IS NULL GROUP BY g.company_id ORDER BY 2 DESC"
}

c_customer_signal() {
  # NOTE first, so the function ends on psql. See c_starnet_sessions.
  printf 'NOTE: counts only, no identities. A sustained drop is the customer leaving.\n\n'
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
  out="$(railway logs --service guard --environment production --lines 100 2>&1)" && rc=0 || rc=$?
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
SENTRY_ISSUE_CAP=10

c_sentry() {
  local project="$1"
  local cutoff
  # 24h, matching the daily cadence. Was 6h when the runner ran every 6 hours;
  # a daily run filtering to 6h would silently drop 18 hours of issues.
  cutoff="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
            || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"

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

  printf 'issues_24h: %s   issues_with_events_24h: %s\n' "$total" "$shown"
  if [ "$shown" -gt "$SENTRY_ISSUE_CAP" ]; then
    printf 'NOTE: %s issues with events in the last 24h; showing the %s most recent.\n' \
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

c_git_log() { git log -10 --oneline; }

# ── Phase 4.5 brief collectors ──────────────────────────────────────────────

# ── schema-applied ──────────────────────────────────────────────────────────
#
# Reads the tip of the `files` array in migrate.ts, then asks the PRODUCTION
# CATALOG whether that migration's contract is actually there.
#
# WHY THIS EXISTS. Run 34881357451 posted
#   BROKE P2 -- N45 guard-overlap constraint (schema_v77) shipped in code but
#   migration not confirmed applied ... gap open ~15.5h since f027f72
# The constraint had been applied by hand the previous evening. No collector
# was wrong, because NO COLLECTOR EXISTED: the claim was inferred from
# STATE.md and OPEN-ITEMS.md, which the shell embeds as ground truth and which
# were nine versions and one day stale respectively. The runner had a working
# psql session against production throughout that run -- eight other collectors
# used it -- and nobody had ever pointed it at a catalog. The "~15.5h" was the
# age of a commit message, not of any measured state.
#
# CATALOG ONLY. pg_constraint / pg_extension / pg_class / pg_attribute /
# pg_indexes. No table is read, so the data rule in docs/OPS/POLICY.md is not
# in play and no column grant matters (see N10).
#
# THE THREE OUTCOMES ARE NOT THE SAME THING, and conflating them is the bug
# this file keeps re-shipping:
#   APPLIED  -- asked, and every mapped object is there.
#   MISSING  -- asked, and something is not there. The collector SUCCEEDED;
#               returns 0. A real finding, not a failure to collect.
#   COLLECTOR FAILED -- could not ask. psql error, unreadable migrate.ts, or
#               an UNMAPPED tip. Returns 1, so fix 6 fails the run.
#
# UNMAPPED is deliberately NOT "UNVERIFIED" and NOT "APPLIED". It means the
# database was reachable and nothing was asked of it, because nobody wrote down
# what to look for. That is a repo defect with a one-line fix, and it must never
# be mistakable for a pass or for an unreachable database.
c_schema_applied() {
  local map file tip v kind name sql out rc
  local n_checked=0 n_present=0 missing=''
  local tip_entries=0 tip_probeable=0 best='' probe_v='' dataonly_note=''

  # <version>|<kind>|<object>
  #   kind = constraint|index|table|column|extension|dataonly
  #
  # ADD A LINE WHEN YOU ADD A MIGRATION. A file name does not say what it
  # created, so each tip needs one object that is present if and only if that
  # migration ran. More than one line per version is fine; all must pass.
  #
  # `dataonly` IS FOR A MIGRATION THAT CREATES NOTHING TO PROBE. schema_v79 is
  # the first: twelve statements, every one an UPDATE recomputing expires_at,
  # zero DDL. There is no catalog object that is present if and only if it ran,
  # so demanding one would mean either an UNMAPPED tip forever or a fabricated
  # probe that passes without asking anything -- and a probe that cannot fail
  # is the exact class this collector was written to remove.
  #
  # A dataonly line COUNTS AS MAPPED, so the tip is not UNMAPPED. It is never
  # itself a verdict: when the tip is dataonly the collector probes the nearest
  # EARLIER version that does carry an object and says so in the label, so the
  # APPLIED still rests on a real question put to the database.
  #
  # What that verdict does and does not mean: it proves the chain was replayed
  # at least as far as the probed version. It cannot prove the data-only tip's
  # UPDATEs ran. Nothing in this repository can -- migrate.ts keeps no ledger
  # (no migrations table exists in production, checked 2026-09-20), it simply
  # replays every file in array order on each invocation, so reaching vM
  # implies running vN only because the loop has no way to skip one.
  map="$(cat <<'MAP'
v80|index|idx_clock_in_verifications_verified_at
v79|dataonly|recomputes expires_at onto the locked tiers; creates no catalog object
v78|column|checkpoint_scans.legal_hold_at
v77|constraint|shifts_no_guard_overlap
v77|extension|btree_gist
v76|column|shifts.unstaffed_warning_sent_at
v75|index|idx_prt_token
v74|constraint|chk_shift_reassignments_direction
v73|index|idx_shifts_scheduled_start
v72|index|idx_shifts_guard_scheduled
v71|constraint|chk_shifts_source
v70|table|site_config_audit
v69|constraint|chk_shift_sessions_ping_interval_minutes
MAP
)"

  # The tip is the LAST entry in array order, which is not the same as the
  # highest number -- order is what migrate.ts replays.
  file="$(grep -o "'schema_v[0-9]*\.sql'" apps/api/src/db/migrate.ts | tail -1 | tr -d "'")"
  if [ -z "$file" ]; then
    printf 'cannot read the files array tip from apps/api/src/db/migrate.ts\n'
    return 1
  fi
  tip="v${file#schema_v}"; tip="${tip%.sql}"
  printf 'migrate_ts_tip: %s (%s)\n' "$tip" "$file"

  # ── PASS 1: what does the map know about the tip? ─────────────────────────
  #
  # Two questions, and they are separate: does the tip appear at all (if not,
  # UNMAPPED), and does any of its entries carry something probeable (if not,
  # the tip is data-only and the probe has to fall back to an earlier version).
  # `best` collects the highest version strictly below the tip that is not
  # itself data-only -- the nearest thing to the tip that can actually be asked.
  #
  # Fed by heredoc, NOT by a pipe: a pipe would put the loop in a subshell and
  # `return 1` below would exit only that subshell, leaving the function at 0.
  # That is precisely the masked-failure class this collector exists to remove.
  while IFS='|' read -r v kind name; do
    [ -n "$v" ] || continue
    if [ "$v" = "$tip" ]; then
      tip_entries=$((tip_entries + 1))
      [ "$kind" = 'dataonly' ] || tip_probeable=$((tip_probeable + 1))
      continue
    fi
    [ "$kind" = 'dataonly' ] && continue
    # Numeric compare, guarded: a malformed version must not crash the probe.
    case "${v#v}${tip#v}" in
      *[!0-9]*) continue ;;
    esac
    if [ "${v#v}" -lt "${tip#v}" ] && { [ -z "$best" ] || [ "${v#v}" -gt "${best#v}" ]; }; then
      best="$v"
    fi
  done <<MAPEOF0
$map
MAPEOF0

  if [ "$tip_entries" -eq 0 ]; then
    printf 'UNMAPPED -- tip %s has no object in the mapping table. Add one line to\n' "$tip"
    printf 'c_schema_applied. UNMAPPED is not APPLIED and not UNVERIFIED: the database\n'
    printf 'was reachable and nothing was asked of it.\n'
    return 1
  fi

  probe_v="$tip"
  if [ "$tip_probeable" -eq 0 ]; then
    # The tip is data-only. Probe the nearest earlier version that is not, and
    # SAY SO in the verdict -- an APPLIED that silently described a different
    # version than the one named would be worse than UNMAPPED.
    if [ -z "$best" ]; then
      printf 'UNMAPPED -- tip %s is data-only and no earlier version in the mapping\n' "$tip"
      printf 'table carries a probeable object. Add one for an earlier migration.\n'
      return 1
    fi
    probe_v="$best"
    dataonly_note=" (tip ${tip} data-only; probed ${probe_v})"
  fi

  # ── PASS 2: ask the database about probe_v's objects ──────────────────────
  while IFS='|' read -r v kind name; do
    [ "$v" = "$probe_v" ] || continue
    [ "$kind" = 'dataonly' ] && continue
    case "$kind" in
      constraint) sql="SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '$name'" ;;
      index)      sql="SELECT indexdef FROM pg_indexes WHERE indexname = '$name'" ;;
      extension)  sql="SELECT 'btree_gist-style extension present, version ' || extversion FROM pg_extension WHERE extname = '$name'" ;;
      table)      sql="SELECT 'table ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relname = '$name' AND c.relkind = 'r' AND n.nspname = 'public'" ;;
      column)     sql="SELECT 'column ' || format_type(atttypid, atttypmod) FROM pg_attribute
                        WHERE attrelid = '${name%%.*}'::regclass AND attname = '${name#*.}' AND NOT attisdropped" ;;
      *)          printf 'UNMAPPED -- unknown kind "%s" for %s in the mapping table\n' "$kind" "$name"
                  return 1 ;;
    esac

    out="$(psql_at "$sql")" && rc=0 || rc=$?
    if [ "$rc" -ne 0 ]; then
      printf 'psql failed probing %s %s: %s\n' \
        "$kind" "$name" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
      return 1
    fi

    n_checked=$((n_checked + 1))
    if [ -n "$out" ]; then
      n_present=$((n_present + 1))
      printf '  %s %s: PRESENT\n' "$kind" "$name"
      printf '    %s\n' "$out"
    else
      missing="${missing}${missing:+, }${kind} ${name}"
      printf '  %s %s: ABSENT\n' "$kind" "$name"
    fi
  done <<MAPEOF
$map
MAPEOF

  if [ "$n_checked" -eq 0 ]; then
    printf 'UNMAPPED -- tip %s has no object in the mapping table. Add one line to\n' "$tip"
    printf 'c_schema_applied. UNMAPPED is not APPLIED and not UNVERIFIED: the database\n'
    printf 'was reachable and nothing was asked of it.\n'
    return 1
  fi

  if [ -n "$missing" ]; then
    printf 'schema_applied: MISSING%s -- %s\n' "$dataonly_note" "$missing"
  else
    printf 'schema_applied: APPLIED%s -- %s/%s mapped objects present\n' \
      "$dataonly_note" "$n_present" "$n_checked"
  fi

  # Explicit, not incidental. Every failure path above returns 1 before it can
  # reach here, so this 0 is a claim that the probe ran -- not the exit status
  # of whichever printf happened to come last.
  return 0
}

# The comment that used to sit here claimed "the Railway CLI does not print a
# commit sha on `deployment list` (checked again 2026-09-06, CLI 4.36.1 /
# 5.49.2). There is no read-only way to get it from the CLI." That is false,
# and it is why nobody retried for eight days: `deployment list` takes --json,
# on 4.36.1 as well as 5.x, and the payload carries meta.commitHash alongside
# meta.branch, meta.repo and meta.commitMessage. Whoever checked read the human
# table, which genuinely has only id | STATUS | timestamp.
#
# The old line under it was not a result, it was a string constant:
#   printf 'deploy_matches_main: UNVERIFIED (railway CLI prints no commit sha)'
# one possible value for the life of the file, printed whether or not anything
# had been asked. That is the check-window-anchor failure class -- a probe that
# exits 0 without doing its job -- with the verdict hardcoded rather than merely
# skipped.
#
# MISMATCH returns 0: the collector did its job and the news is bad, which is a
# finding, not a collection failure. An absent meta.commitHash returns 1, and
# that distinction is the whole point of this commit: if a project-scoped
# RAILWAY_TOKEN is not served `meta`, this must fail loudly and get fixed, not
# settle into a permanent well-worded UNVERIFIED. /health also carries the
# commit as of this branch, which is the fallback if that turns out to be so.
c_deploy_vs_main() {
  local raw rc node dep_id status sha main_sha
  raw="$(railway deployment list --service guard --environment production --limit 5 --json 2>&1)" \
    && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$raw" ]; then
    printf 'railway deployment list --json failed (rc=%s): %s\n' \
      "$rc" "$(printf '%s' "$raw" | tr '\n' ' ' | cut -c1-200)"
    return 1
  fi
  if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    printf 'railway --json did not return an array: %s\n' \
      "$(printf '%s' "$raw" | tr '\n' ' ' | cut -c1-200)"
    return 1
  fi

  node="$(printf '%s' "$raw" | jq -c '[ .[] | select(.status == "SUCCESS") ][0] // empty')"
  if [ -z "$node" ]; then
    printf 'no SUCCESS deployment among the 5 most recent rows\n'
    return 1
  fi

  dep_id="$(printf '%s' "$node" | jq -r '.id // "unknown"')"
  status="$(printf '%s' "$node" | jq -r '.status // "unknown"')"
  sha="$(printf '%s' "$node" | jq -r '.meta.commitHash // empty')"
  main_sha="$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)"

  printf 'deployment_id: %s\n' "$dep_id"
  printf 'status: %s\n' "$status"
  printf 'origin_main: %s\n' "$main_sha"
  printf 'deployed_commit: %s\n' "${sha:-<absent from meta>}"

  if [ -z "$sha" ]; then
    printf 'deploy_matches_main: UNVERIFIED (deployment JSON parsed but carries no meta.commitHash -- check RAILWAY_TOKEN scope, then GET /health commit)\n'
    return 1
  fi
  if [ "$sha" = "$main_sha" ]; then
    printf 'deploy_matches_main: MATCH (%s == %s)\n' "$sha" "$main_sha"
  else
    printf 'deploy_matches_main: MISMATCH (deployed %s ≠ main %s)\n' "$sha" "$main_sha"
  fi

  # Explicit, for the same reason as c_schema_applied: this 0 is a claim that
  # the probe ran, not the exit status of the last printf.
  return 0
}

c_failures_24h() {
  local cutoff
  cutoff="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
            || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"

  printf 'cron_heartbeats_error: '
  psql_at "SELECT COUNT(*) FROM cron_heartbeats WHERE last_result = 'error'"
  printf 'cron_heartbeat_error_jobs: '
  psql_at "SELECT COALESCE(string_agg(job_name, ','), 'none')
             FROM cron_heartbeats WHERE last_result = 'error'"

  # Push failures, from the log text the jobs actually emit. Patterns verified
  # against source: breakExpiryCron:220,324 / clockOutReminder:179 ("push
  # failed"), pingReminder:114 ("FCM <type> failed").
  # One log fetch, two greps. `grep -c` EXITS 1 on a zero count, so a naive
  # `grep -c ... || printf 0` prints "0" twice -- caught in the 2026-09-06 dry
  # run. `|| true` on the count itself is the fix.
  local logs
  logs="$(railway logs --service guard --environment production --lines 100 2>/dev/null || true)"
  printf 'push_failures_in_log_window: %s\n' \
    "$(printf '%s' "$logs" | grep -ciE 'push failed|FCM .* failed' || true)"
  printf 'enhancement_failed_in_log_window: %s\n' \
    "$(printf '%s' "$logs" | grep -c 'ai.enhance.failed' || true)"
  printf 'log_lines_searched: %s\n' "$(printf '%s' "$logs" | wc -l | tr -d ' ')"

  # ── email liveness ────────────────────────────────────────────────────────
  # Incident: docs/OPS/INCIDENTS/2026-09-01-unauthorized-burst.md. A declining
  # card made SendGrid 401 every send for 6d 18h and NOTHING reported it:
  # /health runs SELECT 1, /health/crons proves the job RAN, and
  # cron_heartbeats said last_result='ok' throughout -- because missedShiftAlert
  # WAS working. It found the shifts, called SendGrid, caught the error and
  # reported it. Every component was green while the product sent no mail.
  #
  # The oracle needs no new table. Both columns are stamped only AFTER a send
  # succeeds (email.ts, and shifts.daily_report_email_sent_at at the end of
  # sendDailyShiftReport), so their age is the age of the last delivered email.
  #
  # Two columns, not one, because they have different cadences:
  #   missed_alert_sent_at      -- sparse; only stamps when a shift is a no-show
  #   daily_report_email_sent_at -- daily; stamps per shift with an active client
  # The alarm uses GREATEST of the two: any successful email resets the clock.
  # Using missed_alert alone would false-fire on any week without a no-show.
  #
  # THRESHOLD CAVEAT -- read before trusting a green here. 26h was NOT
  # validated clean against history. Gaps over 26h in the combined signal since
  # 2026-07-01: 72.0h (07-13 -> 07-16) and 51.2h (07-19 -> 07-21), both OUTSIDE
  # the known outage, and both with shifts whose client reports were due (9 and
  # 2). Either those were undetected email outages, or the daily-report column
  # does not stamp for every eligible shift. That is unresolved, so the
  # shifts-due context below is emitted alongside the age: a long age with zero
  # shifts due is a quiet period, a long age with shifts due is a finding.
  printf '\nemail liveness (successful-send oracle):\n'
  printf '  hours_since_last_successful_email: '
  psql_at "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW() - GREATEST(
             MAX(missed_alert_sent_at), MAX(daily_report_email_sent_at))))/3600.0, 1)::text,
             'UNVERIFIED (no successful send ever recorded)') FROM shifts"
  printf '  hours_since_last_missed_shift_alert: '
  psql_at "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(missed_alert_sent_at)))/3600.0, 1)::text, 'none ever')
             FROM shifts"
  printf '  hours_since_last_daily_client_report: '
  psql_at "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(daily_report_email_sent_at)))/3600.0, 1)::text, 'none ever')
             FROM shifts"
  printf '  shifts_ended_last_26h: '
  psql_at "SELECT COUNT(*) FROM shifts WHERE scheduled_end > NOW() - INTERVAL '26 hours' AND scheduled_end <= NOW()"
  printf '  of_those_with_active_client (report was due): '
  psql_at "SELECT COUNT(*) FROM shifts sh
             JOIN sites si ON si.id = sh.site_id
             JOIN clients c ON c.site_id = si.id AND c.is_active = true
            WHERE sh.scheduled_end > NOW() - INTERVAL '26 hours' AND sh.scheduled_end <= NOW()"
  printf '  ALARM: '
  psql_at "SELECT CASE
             WHEN GREATEST(MAX(missed_alert_sent_at), MAX(daily_report_email_sent_at)) IS NULL
               THEN 'UNVERIFIED -- no successful send has ever been recorded'
             WHEN NOW() - GREATEST(MAX(missed_alert_sent_at), MAX(daily_report_email_sent_at)) > INTERVAL '26 hours'
               THEN 'P1 -- no successful email in ' ||
                    ROUND(EXTRACT(EPOCH FROM (NOW() - GREATEST(MAX(missed_alert_sent_at),
                          MAX(daily_report_email_sent_at))))/3600.0, 1)::text || ' h'
             ELSE 'none -- last successful email ' ||
                  ROUND(EXTRACT(EPOCH FROM (NOW() - GREATEST(MAX(missed_alert_sent_at),
                        MAX(daily_report_email_sent_at))))/3600.0, 1)::text || ' h ago'
           END FROM shifts"

  printf '\nprevious_runner_conclusions (newest first): '
  gh run list --workflow ops-triage.yml --limit 2 --json conclusion \
    --jq '[.[].conclusion] | join(",")' 2>/dev/null || printf 'UNVERIFIED (gh unavailable)\n'

  printf '\nsentry issues with events since %s:\n' "$cutoff"
  local t
  for pr in netraops-api netraops-mobile; do
    t="$(curl -s --max-time 30 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
         "https://sentry.io/api/0/projects/netraopscom/$pr/issues/?statsPeriod=24h" \
       | jq -r --arg c "$cutoff" '
           if type=="array" then
             [ .[] | select(.lastSeen >= $c) ] as $r
             | "  '"$pr"': \($r|length) issue(s); levels=\([$r[].level]|unique|join(","))"
           else "  '"$pr"': SENTRY API ERROR" end' 2>/dev/null)"
    printf '%s\n' "${t:-  $pr: UNVERIFIED}"
  done

  # ── sentry-dropped ────────────────────────────────────────────────────────
  # Events Sentry REFUSED, per project, split by reason.
  #
  # Why this exists: nothing else in the loop reads ingestion OUTCOMES. Both
  # `c_sentry` collectors and the issue counts above read what ARRIVED, and
  # during a quota blackout that is indistinguishable from a quiet day. It is
  # how 2026-09-01 12:00Z -> 2026-09-05 10:00Z passed unremarked for 94 hours
  # while the org accepted ZERO error events on all three projects and every
  # health signal stayed green. See
  # docs/OPS/INCIDENTS/2026-09-06-sentry-rate-limited.md.
  #
  # Explicit start/end, never statsPeriod. statsPeriod is evaluated at call
  # time, so two calls minutes apart cover different windows -- that drift made
  # two tables in the N27 investigation disagree by 14 events. The window the
  # API actually RETURNED is printed next to the one requested, because Sentry
  # snaps to hour boundaries and the two are not the same thing.
  #
  # One call, three groupBys. Verified 2026-09-06 that stats_v2 accepts
  # groupBy=project&groupBy=outcome&groupBy=reason together (14 groups over
  # 30d), so this does not need one request per project.
  #
  # What counts as a drop. `ratelimit_backoff` is counted as a PLATFORM drop
  # even though Sentry files it under client_discard: it is the SDK honouring a
  # 429 that Sentry sent. It was zero on every day outside the incident window
  # and 1,755 inside it -- three times the 582 the server refused outright, and
  # invisible in the headline number. `event_processor` and `network_error` are
  # NOT platform drops: the first is our own beforeSend / ignoreErrors /
  # denyUrls working as designed (apps/web/sentry.shared.ts:124-130 and the
  # scrubbers in apps/api and apps/mobile), the second is device connectivity.
  # Both occur on ordinary days -- 12 of them on 2026-08-17 alone -- so alarming
  # on them would fire a false P2 most days and train the reader to ignore the
  # line. They are reported for context and excluded from the alarm.
  local w_start w_end pmap stats
  w_end="$(date -u +%Y-%m-%dT%H:00:00Z)"
  w_start="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:00:00Z 2>/dev/null \
             || date -u -v-24H +%Y-%m-%dT%H:00:00Z)"

  # id -> slug, so the pack names projects rather than printing bare numeric
  # ids. Falls back to the id if the projects endpoint is unreadable; a bare id
  # is still actionable, an aborted collector is not.
  pmap="$(curl -s --max-time 30 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          "https://sentry.io/api/0/organizations/netraopscom/projects/" \
        | jq -c 'if type=="array" then (map({key:(.id|tostring), value:.slug})|from_entries) else {} end' \
          2>/dev/null || printf '{}')"
  # `|| printf '{}'` above does NOT cover an empty curl body: jq exits 0 on
  # empty input and prints nothing, so pmap ends up "" and --argjson dies with
  # "invalid JSON text", taking the whole section to UNVERIFIED. Validate it
  # explicitly. (The first version used "${pmap:-{\}}" as the guard; inside a
  # default-value expansion bash does not strip that backslash, so it produced
  # the literal {\} -- invalid JSON, and the guard was the bug. Caught
  # 2026-09-06 by testing the failure path, not the happy one.)
  printf '%s' "$pmap" | jq -e . >/dev/null 2>&1 || pmap='{}'

  stats="$(curl -s --max-time 30 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
           "https://sentry.io/api/0/organizations/netraopscom/stats_v2/?field=sum(quantity)&start=${w_start}&end=${w_end}&groupBy=project&groupBy=outcome&groupBy=reason&category=error")"

  printf '\nsentry-dropped requested window: %s -> %s\n' "$w_start" "$w_end"
  printf '%s' "$stats" | jq -r --argjson m "$pmap" '
    if (.groups | type) != "array" then
      "  SENTRY API ERROR: " + (.|tostring|.[0:160])
    else
      "  window returned by API: \(.start) -> \(.end)",
      ( [ .groups[]
          | select(.by.outcome=="rate_limited" or .by.outcome=="client_discard")
          | { p: ($m[(.by.project|tostring)] // (.by.project|tostring)),
              o: .by.outcome, r: (.by.reason // "none"),
              n: .totals["sum(quantity)"] }
          | select(.n > 0) ] ) as $rows
      | ( [ $rows[] | select(.o=="rate_limited" or .r=="ratelimit_backoff") | .n ] | add // 0 ) as $refused
      | ( [ $rows[] | select(.o=="client_discard" and .r!="ratelimit_backoff") | .n ] | add // 0 ) as $local
      | "  platform_refused_24h: \($refused)",
        "  client_local_discard_24h: \($local)   (beforeSend/ignoreErrors/network -- NOT a platform drop, excluded from the alarm)",
        ( if ($rows|length)==0 then "  rows: none"
          else ( $rows | sort_by(-.n)[] | "  \(.p) | \(.o) | \(.r) | \(.n)" ) end ),
        ( if $refused > 0 then
            "  ALARM: platform refused \($refused) event(s) in 24h -- reasons: " +
            ([ $rows[] | select(.o=="rate_limited" or .r=="ratelimit_backoff") | .r ] | unique | join(","))
          else "  ALARM: none -- 0 events refused by the platform in 24h" end )
    end' 2>/dev/null || printf '  UNVERIFIED (stats_v2 unreadable or jq failed)\n'
}

c_customer_pulse() {
  printf 'starnet_sessions_yesterday: '
  psql_at "SELECT COUNT(*) FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id
            WHERE g.company_id = '$STARNET'
              AND ss.clocked_in_at >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date - 1
              AND ss.clocked_in_at <  (NOW() AT TIME ZONE 'America/Los_Angeles')::date"

  printf 'starnet_active_guards_7d|prior_7d: '
  psql_at "SELECT
      (SELECT COUNT(DISTINCT ss.guard_id) FROM shift_sessions ss JOIN guards g ON g.id=ss.guard_id
        WHERE g.company_id='$STARNET' AND ss.clocked_in_at >= NOW() - INTERVAL '7 days')
      || '|' ||
      (SELECT COUNT(DISTINCT ss.guard_id) FROM shift_sessions ss JOIN guards g ON g.id=ss.guard_id
        WHERE g.company_id='$STARNET' AND ss.clocked_in_at >= NOW() - INTERVAL '14 days'
          AND ss.clocked_in_at < NOW() - INTERVAL '7 days')"

  # Human-maintained line in STATE.md. If it is missing or still the seeded
  # placeholder, say so -- a stale contact date read as fresh is worse than none.
  printf 'nataniel_last_contact: '
  grep -m1 '^Nataniel last contact:' docs/OPS/STATE.md \
    | sed 's/^Nataniel last contact: *//' || printf 'UNVERIFIED (line absent from STATE.md)\n'
}

c_ahead() {
  printf 'expiries with a date within 30 days:\n'
  # `|| return 1`: the EXPIRIES parser used to catch Exception and sys.exit(0),
  # so a malformed table printed one line and the section was banked as good.
  python3 - <<'PYEOF' || return 1
import re, datetime, sys
# Read the DATE COLUMN ONLY. A naive "first date anywhere in the row" match
# reported E4/E9/E10/E11 as expiring 2026-09-05 in the 2026-09-06 dry run --
# those are "verified present on" dates sitting in the Notes column, not expiry
# dates. Four false expiries in a founder brief is worse than none.
# Columns: | id | item | where | expires | owner | notes |
today = datetime.date.today()
dated, undated = [], []
try:
    for line in open('docs/OPS/EXPIRIES.md'):
        if not line.startswith('| E'):
            continue
        cols = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cols) < 4:
            continue
        ident = re.sub(r'[*`]', '', cols[0]).strip()
        label = re.sub(r'[*`]', '', cols[1]).strip()
        d = re.search(r'(\d{4})-(\d{2})-(\d{2})', cols[3])
        if not d:
            undated.append(ident)
            continue
        due = datetime.date(int(d.group(1)), int(d.group(2)), int(d.group(3)))
        days = (due - today).days
        if days <= 30:
            dated.append(f'  {ident}: {label} -- {due} ({days} days)')
except Exception as e:
    print('  EXPIRIES parse failed:', e); sys.exit(1)
print('\n'.join(dated) if dated else '  none dated within 30 days')
print(f'  {len(undated)} row(s) carry no date in the expires column: {", ".join(undated) or "none"}')
print('  UNDATED ROWS ARE NOT "FINE" -- they are unchecked.')
PYEOF

  printf '\nsentry errors last 30d (accepted / rate_limited / filtered):\n'
  curl -s --max-time 30 -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/organizations/netraopscom/stats_v2/?field=sum(quantity)&groupBy=outcome&statsPeriod=30d&category=error" \
  | jq -r 'if .groups then (.groups[] | "  \(.by.outcome): \(.totals["sum(quantity)"])")
           else "  UNVERIFIED: " + (.|tostring|.[0:120]) end' 2>/dev/null \
    || printf '  UNVERIFIED (stats endpoint unreadable)\n'
  printf '  NOTE: quota denominator is the plan tier, not returned here.\n'

  printf '\nanthropic spend: '
  if [ -f "$COST_FILE" ]; then
    jq -r '"last run $" + (.total_cost_usd|tostring)' "$COST_FILE" 2>/dev/null \
      || printf 'UNVERIFIED (cost.json unparseable)\n'
  else
    printf 'UNVERIFIED — no cost.json from a previous run yet\n'
  fi
  printf '  MTD total: UNVERIFIED — summing across run artifacts is not implemented (N26).\n'
}

c_waiting() {
  printf 'open PRs:\n'
  gh pr list --state open --json number,title,createdAt \
    --jq '.[] | "  #\(.number) \(.title) (opened \(.createdAt[0:10]))"' 2>/dev/null \
    || printf '  UNVERIFIED (gh unavailable)\n'

  printf '\n[VISHNU] items in OPEN-ITEMS.md:\n'
  # Anchor on the ITEM HEADING form (**N<n>. [VISHNU] ...), not a bare grep for
  # the tag -- the convention paragraph and the merge-order note both contain
  # the literal string and were being reported as items in the 2026-09-06 dry
  # run. Emit the number and the first few words so the line is actionable.
  local tagged
  tagged="$(grep -oE '^\*\*(N[0-9]+)\. \[VISHNU\][^*]*' docs/OPS/OPEN-ITEMS.md \
            | sed -E 's/^\*\*(N[0-9]+)\. \[VISHNU\] */  \1 /' | cut -c1-90 || true)"
  if [ -n "$tagged" ]; then printf '%s\n' "$tagged"; else printf '  none tagged\n'; fi
}


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
  collect 'schema-applied'              c_schema_applied
  collect 'deploy-vs-main'              c_deploy_vs_main
  collect 'failures-24h'                c_failures_24h
  collect 'customer-pulse'              c_customer_pulse
  collect 'ahead'                       c_ahead
  collect 'waiting'                     c_waiting

  printf '\n---\n\n# REPO MEMORY\n'

  # Embedded in full: all small, and all load-bearing for grading a finding.
  for f in docs/OPS/STATE.md docs/OPS/FREEZES.md \
           docs/OPS/DECISIONS.md docs/OPS/POLICY.md docs/OPS/REPORT-TEMPLATE.md; do
    printf -- '\n---\n\n# FILE: %s\n\n' "$f"
    cat "$f"
    printf '\n'
  done

  # OPEN-ITEMS.md is TRIMMED, not embedded whole. It is the largest and
  # fastest-growing repo-memory file and most of it is history: the "Carried
  # items" section is a backlog inherited from Phase 1, and several entries are
  # marked CLOSED. The model needs the open items so it does not re-report a
  # known issue as new; it does not need the archive.
  #
  # THE PREVIOUS RULE DROPPED HALF THE FILE. It was
  #     /^## Carried items/ { carried = NR; exit }
  # -- `exit`, not "skip this section". "## Carried items" sits at line 1359 of
  # 2727, so lines 1359-2727 never reached the pack: the Carried-items archive
  # (92 lines, which was the intent) AND the twelve "## New from ..." sections
  # after it (1277 lines, which was not). New items are appended to the END of
  # this file, so the rule made the NEWEST findings the least visible.
  #
  # That is the other half of the 2026-09-14 false P2. Run 34881357451 was given
  # the stale N45 block (line 860, before the cut) and was NOT given N90 (line
  # 2554+, after it), which records that schema_v77's constraint had been proven
  # against a live database. Verified against that run's uploaded pack: zero
  # occurrences of N90 or N91, one occurrence of the stale N45.
  #
  # The skip now ENDS at the next "## " heading, whatever its text. Checked
  # 2026-09-14: "## Carried items" contains no sub-heading at any level, and the
  # file's only "### " heading (line 363) is inside a different section, so
  # nothing inside the archive can close the skip early.
  #
  # What is dropped is stated in the pack rather than silently omitted -- a
  # trimmed file that does not say it was trimmed is how a reader concludes an
  # item does not exist. The notice now prints the LINE COUNT actually dropped,
  # so a rule that starts over-trimming again says so in its own output.
  OI_TXT=/tmp/triage-openitems.txt
  OI_STATE=/tmp/triage-openitems.state
  printf -- '\n---\n\n# FILE: docs/OPS/OPEN-ITEMS.md (TRIMMED -- see the note at the end)\n\n'
  awk -v state="$OI_STATE" '
    /^## Carried items/ { skip = 1; found = 1; dropped++; next }
    skip && /^## /      { skip = 0 }
    skip                { dropped++; next }
                        { print }
    END                 { printf "%d %d\n", found + 0, dropped + 0 > state }
  ' docs/OPS/OPEN-ITEMS.md > "$OI_TXT"

  if [ -s "$OI_TXT" ]; then
    # Drop item blocks whose heading line says CLOSED. Blocks start at a bold
    # item marker such as **N4. or **C6. UNCHANGED -- this rule is how a fixed
    # item leaves the pack, and relabelling a heading is what triggers it.
    awk '
      /^\*\*[NC][0-9]+\./ { skip = ($0 ~ /CLOSED/) ? 1 : 0 }
      !skip { print }
    ' "$OI_TXT"

    OI_FOUND=0; OI_DROPPED=0
    read -r OI_FOUND OI_DROPPED < "$OI_STATE" || true
    printf '\n> TRIMMED. Exactly two things are omitted and nothing else:\n'
    if [ "$OI_FOUND" = "1" ]; then
      printf '>   1. the "## Carried items" section ONLY -- %s lines, from that heading\n' "$OI_DROPPED"
      printf '>      to the next "## " heading. Every section AFTER it is included,\n'
      printf '>      including the newest ones at the end of the file.\n'
    else
      printf '>   1. nothing -- no "## Carried items" heading exists in the file.\n'
    fi
    printf '>   2. every item block whose heading line contains the word CLOSED.\n'
    printf '> Everything else in the file is above. Read docs/OPS/OPEN-ITEMS.md in the\n'
    printf '> repo for the full list -- you have the Read tool.\n'
    rm -f "$OI_TXT" "$OI_STATE"
  else
    # Reaching here now means the file is empty or unreadable, not that a
    # heading is missing -- the skip above cannot consume the whole file.
    printf '> NOTE: trimming docs/OPS/OPEN-ITEMS.md produced NO output. The file is\n'
    printf '> empty or unreadable. This is a collector defect -- fix it, and do not\n'
    printf '> read the absence of items as "no open items".\n\n'
    head -80 docs/OPS/OPEN-ITEMS.md
  fi
  printf '\n'
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
# grep and wc were added 2026-09-20. On 09-19 the model spent two of its
# fifteen turns being denied `grep -n "^# FILE: ..." ${CONTEXT}` and
# `wc -l ${CONTEXT} <repo>/docs/OPS/OPEN-ITEMS.md`, then hit the ceiling.
#
# THIS WIDENS NOTHING. Read, Grep and Glob are already on this list with no
# path restriction, so the model can already read any file on the runner; the
# denials cost turns without protecting anything. Both commands are read-only:
# neither grep nor wc has a mode that writes.
#
# ON SCOPING, HONESTLY: the brief asked for these to be pinned to ${CONTEXT}
# and the repo, and the permission syntax cannot express that. A rule matches a
# command PREFIX -- `:*` is recognised only at the end of a pattern -- and in
# both `grep <pattern> <path>` and `wc -l <paths>` the path is the LAST
# argument, so no prefix can constrain it. `Bash(grep ${CONTEXT}:*)` would
# match only a grep whose first argument is the pack, which is not a form
# anyone types. The scoping that does exist is the same as for the git rules
# above and rests on the same two facts: the runner is ephemeral, and every
# credential in this job is read-only.
# Bash(cat ${CONTEXT}) was removed 2026-09-20 when the pack moved to stdin.
# It existed because `Read` truncates: measured on run 35528838218's pack,
# Read returned line 993 of 4,204 -- the model could write a brief from 24% of
# the evidence and nothing said so. `cat` was the lossless escape hatch (tested
# both ends and the middle of a 226,023 B pack; all three survived), so the two
# paths differed by 4.6x and the model chose between them nondeterministically.
#
# Stdin removes the choice rather than arbitrating it. The pack is in context
# before the first turn, so neither tool is needed to obtain it, and leaving
# `cat` on the list would only invite a second 109k-token copy of something
# already there.
#
# Read/Grep/Glob and grep/wc stay for TARGETED lookups -- one N item out of
# OPEN-ITEMS.md, a git range -- which is what they were added for.
ALLOWED_TOOLS="Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(grep:*),Bash(wc:*)"

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

The context pack has ALREADY BEEN DELIVERED TO YOU ON STDIN, in full and
untruncated. It is in your context now; there is no file to open and no tool
call to make. Do not attempt to gather anything yourself."

# Model is pinned so a runner default change cannot silently alter cost or
# quality. Run 33964954767 passed no --model at all and its log names no model,
# so what actually served that report is UNVERIFIABLE after the fact.
#
# Scheduled runs are routine and get the cheaper model. A manual run carries a
# `focus`, which means a human is chasing something -- that is an alarm, and it
# gets the stronger model. MODEL is set by the workflow; this default keeps a
# local run working.
MODEL="${MODEL:-claude-sonnet-5}"

printf 'starting claude -p (model=%s, max-turns %s)\n' "$MODEL" "$MAX_TURNS"

# --output-format json so the run's own cost is recoverable. The payload
# carries `result` (the report text) and `total_cost_usd`; text format carries
# neither, which is why every cost figure so far has been UNVERIFIED (N21).
RAW="${TRIAGE_RAW:-/tmp/triage-raw.json}"

set +e
# THE PACK GOES IN ON STDIN, NOT AS A PATH.
#
# `--input-format` defaults to "text" and `-p` reads stdin (the CLI even warns
# "no stdin data received in 3s" when nothing is piped), so the pack arrives as
# part of the first user message: complete, untruncated, and before the model
# takes its first turn. Verified 2026-09-20 by piping a 226,023 B / 4,205-line
# pack with a unique sentinel on its LAST line and asking for that line back --
# returned verbatim.
#
# This replaces a choice the model was making badly. See the allowlist note.
claude -p "$PROMPT_BODY" \
  --output-format json \
  --max-turns "$MAX_TURNS" \
  --model "$MODEL" \
  --permission-mode dontAsk \
  --allowedTools "$ALLOWED_TOOLS" \
  < "$CONTEXT" \
  > "$RAW"
CLAUDE_EXIT=$?
set -e

# Unwrap to the shape the rest of this script expects.
#
# THREE SHAPES, NOT TWO. This gated on `.result` until 2026-09-20, which
# quietly treated an ERROR result as though claude had emitted garbage. An
# `error_max_turns` payload is `{"type":"result","subtype":"error_max_turns",
# ...}` with no `.result` key -- documented JSON, carrying num_turns, the
# errors array and total_cost_usd -- so the old test sent it down the "not the
# documented JSON" path and threw the cost away with it. Both failures that
# week uploaded no cost artifact while the figure sat in the payload.
#
# So the envelope test is `.type == "result"`, and the report-body test is
# `has("result")`, because they are different questions. is_error drives the
# exit status independently: a result that says it failed is a failure even
# when a body is present.
RESULT_SUBTYPE=''
PACK_DELIVERY='ok'
if jq -e '.type == "result"' "$RAW" >/dev/null 2>&1; then
  RESULT_SUBTYPE="$(jq -r '.subtype // "unknown"' "$RAW" 2>/dev/null || printf 'unknown')"

  # Cost is written for EVERY result envelope. subtype and is_error go in too:
  # a cost figure with no verdict beside it invites reading a failed run's
  # spend as a successful one's.
  jq '{total_cost_usd, session_id, num_turns, subtype, is_error,
       model: (.modelUsage // null)}' "$RAW" > "$COST_FILE" 2>/dev/null || true
  printf 'cost: %s (subtype=%s)\n' \
    "$(jq -r '.total_cost_usd // "unknown"' "$RAW" 2>/dev/null)" "$RESULT_SUBTYPE"

  # ── DID THE PACK ACTUALLY ARRIVE? ────────────────────────────────────
  #
  # Free. Read from the usage this run already reports; no second model call
  # and no sentinel round trip.
  #
  # The floor is PACK_BYTES/4, the conventional English bytes-per-token ratio,
  # and it is deliberately loose. This pack measures 2.07 B/token (226,023 B
  # -> 109,176 cache_creation tokens, 2026-09-20) because it is dense with
  # tables, UUIDs and SQL, so a DELIVERED pack clears bytes/4 by about 2x. A
  # pack that never arrived leaves only the prompt and the system preamble --
  # on the order of 15-20k tokens -- which is far under the floor. The check
  # discriminates because of the gap between those two, not because the floor
  # is precise.
  #
  # input_tokens + cache_creation ONLY. cache_read is excluded on purpose: it
  # accumulates across turns, so a 22-turn run reports ~2M whatever happened
  # and would clear any floor. Creation is the prefix being built, which is
  # where a cold-cache pack lands -- and at daily cadence the cache is always
  # cold. If the cadence ever changes, this check weakens and should be
  # revisited rather than trusted.
  #
  # WHAT IT PROVES AND DOES NOT. It proves something pack-sized reached the
  # model. It does not prove it was THIS pack, and it cannot: that would need
  # a sentinel and a second call, which the brief for this change ruled out.
  PACK_BYTES="$(wc -c < "$CONTEXT" | tr -d ' ')"
  MIN_INPUT_TOKENS=$(( PACK_BYTES / 4 ))
  GOT_INPUT="$(jq -r '((.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0))' \
                 "$RAW" 2>/dev/null || printf '0')"
  case "$GOT_INPUT" in *[!0-9]*) GOT_INPUT=0 ;; esac
  if [ "$GOT_INPUT" -lt "$MIN_INPUT_TOKENS" ]; then
    PACK_DELIVERY='suspect'
    printf 'PACK DELIVERY SUSPECT: %s input tokens reported, floor %s for a %s-byte pack.\n' \
      "$GOT_INPUT" "$MIN_INPUT_TOKENS" "$PACK_BYTES" >&2
    printf 'The report below was written WITHOUT the evidence. Treat it as a runner failure.\n' >&2
    CLAUDE_EXIT=$(( CLAUDE_EXIT == 0 ? 1 : CLAUDE_EXIT ))
  else
    printf 'pack delivery: OK (%s input tokens >= %s floor, %s-byte pack)\n' \
      "$GOT_INPUT" "$MIN_INPUT_TOKENS" "$PACK_BYTES"
  fi

  if jq -e 'has("result")' "$RAW" >/dev/null 2>&1; then
    jq -r '.result' "$RAW" > "$OUT"
  else
    # An error result has no body. Keep the envelope so the banner below can
    # quote the evidence rather than reporting an empty file.
    cp "$RAW" "$OUT"
  fi

  if jq -e '.is_error == true' "$RAW" >/dev/null 2>&1; then
    CLAUDE_EXIT=$(( CLAUDE_EXIT == 0 ? 1 : CLAUDE_EXIT ))
  fi
else
  cp "$RAW" "$OUT"
  printf 'WARNING: claude output was not the documented JSON; passing it through verbatim.\n' >&2
  CLAUDE_EXIT=$(( CLAUDE_EXIT == 0 ? 1 : CLAUDE_EXIT ))
fi

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

# Slack gets the five-line brief ONLY. The full report is the artifact.
# Nothing goes to Slack that has no decision attached (DECISIONS.md D14).
#
# Extract everything after the '## Slack brief' heading. If the model did not
# emit that section the format has regressed, and that is itself worth seeing --
# so fall back to the old first-3500-chars post with a loud prefix rather than
# posting nothing or pretending the brief was empty.
BODY="$(awk '/^## Slack brief[[:space:]]*$/{flag=1; next} flag' "$OUT" | sed '/^[[:space:]]*$/d')"

if [ -z "$BODY" ]; then
  printf 'WARNING: no "## Slack brief" section in the report\n' >&2

  # NAME THE CAUSE. Until 2026-09-20 every briefless report was posted as
  # "runner format regression", including two max-turns failures -- so the
  # header blamed the runner's output format for a budget the model exhausted,
  # and whoever read it in Slack was pointed at the wrong thing twice.
  #
  # "runner format regression" now means only what it says: the output was not
  # a result envelope at all, or it was a SUCCESS that somehow lacked the
  # brief section. Any error subtype is named as itself.
  _lim=''
  # Checked before the subtype: a run whose pack never arrived reports
  # subtype=success, so without this branch the label would blame the output
  # format for missing evidence -- the same wrong-component mistake PR #72
  # removed for max-turns.
  if [ "$PACK_DELIVERY" = 'suspect' ]; then
    BRIEF_LABEL='BRIEF MISSING — context pack did not reach the model'
  else
  case "$RESULT_SUBTYPE" in
    error_max_turns)
      # The ceiling THAT run hit, read from the payload's own sentence
      # ("Reached maximum number of turns (15)") rather than from MAX_TURNS --
      # replaying or re-reading an old result must report the limit that was
      # actually in force, not today's value.
      _lim="$(jq -r '(.errors // [])[]' "$RAW" 2>/dev/null \
              | sed -n 's/.*maximum number of turns (\([0-9][0-9]*\)).*/\1/p' \
              | head -1 || true)"
      [ -n "$_lim" ] || _lim="$MAX_TURNS"
      BRIEF_LABEL="BRIEF MISSING — max turns (${_lim})" ;;
    ''|success)
      BRIEF_LABEL='BRIEF MISSING — runner format regression' ;;
    unknown)
      BRIEF_LABEL='BRIEF MISSING — result envelope with no subtype' ;;
    *)
      BRIEF_LABEL="BRIEF MISSING — ${RESULT_SUBTYPE}" ;;
  esac
  fi

  BODY="$BRIEF_LABEL

$(head -c 3500 "$OUT")"
fi

# ── THE TWO LINKS ──────────────────────────────────────────────────────────
#
# The brief used to end with the SAME url twice, written by two authors that
# did not know about each other: `Full evidence: <run url>` from the last line
# of triage-prompt.md's template, and `Full report: <run url>` appended here.
# Three artifacts were uploaded on every run and NEITHER link pointed at any of
# them -- the context pack, the one thing that lets a reader check a finding in
# ten seconds, had a direct url that appeared nowhere.
#
# The template line is gone; this is now the only place links are added.
#
# The pack's artifact url does not exist until upload-artifact has run, which is
# necessarily AFTER this script finishes building the pack. So in CI the
# workflow defers the post: it sets TRIAGE_SLACK_DEFER=1, this script writes the
# finished brief text and stops, the uploads run, and a final workflow step
# appends both links and posts. Outside CI there is no artifact, and the brief
# says so rather than printing a url that 404s.
BRIEF_FILE="${TRIAGE_BRIEF_FILE:-slack-brief.txt}"

if [ "$COLLECTOR_FAILURES" != "0" ]; then
  BODY="$BODY

:warning: $COLLECTOR_FAILURES collector(s) failed -- some signals are UNVERIFIED."
fi

printf '%s' "$BODY" > "$BRIEF_FILE"
printf 'brief: %s (%s bytes)\n' "$BRIEF_FILE" "$(wc -c < "$BRIEF_FILE" | tr -d ' ')"

if [ "${TRIAGE_SLACK_DEFER:-0}" = "1" ]; then
  printf 'slack: DEFERRED -- workflow posts after upload so the pack url can be included\n'
else
  # Not deferred: local run, or a hand-run outside CI. No artifact exists, so
  # only the run page is linked and the pack is named as a local path.
  PAYLOAD="$(BODY="$BODY" RUN_URL="$RUN_URL" CONTEXT="$CONTEXT" python3 -c '
import json, os
body = os.environ["BODY"]
print(json.dumps({"text": body
                  + "\n\nFull report: " + os.environ["RUN_URL"]
                  + "\nContext pack: " + os.environ["CONTEXT"] + " (local file -- not uploaded)"}))
')"
  if [ "$LOCAL" = "1" ]; then
    printf '%s' "$PAYLOAD" > "${SLACK_SINK:-/tmp/slack.json}"
    printf 'local mode: slack payload written to %s\n' "${SLACK_SINK:-/tmp/slack.json}"
  else
    curl -s -X POST -H 'Content-type: application/json' \
      --data "$PAYLOAD" "$SLACK_WEBHOOK_URL" > /dev/null
    printf 'slack: posted\n'
  fi
fi

# ---------------------------------------------------------------------------
# The run's own verdict.
#
# This was `exit 0`, unconditional. COLLECTOR_FAILURES was counted, printed, and
# used for a Slack :warning: prefix -- and never tested. The workflow went green
# whether one collector failed or all sixteen did, which is the permanently-green
# check the repo already named once: apps/api/scripts/check-window-anchor.ts,
# "a required check that skips is green forever and verifies nothing".
#
# AFTER the Slack post on purpose. A degraded brief is more useful than none, so
# the message ships first and the run goes red second. Every later workflow step
# is `if: always()`, so the uploads and the post still run when this exits 1.
# ---------------------------------------------------------------------------
if [ "$COLLECTOR_FAILURES" -gt 0 ]; then
  printf 'FAILING THE RUN: %s collector(s) failed. Signals are missing, not green.\n' \
    "$COLLECTOR_FAILURES" >&2
  exit 1
fi
exit 0
