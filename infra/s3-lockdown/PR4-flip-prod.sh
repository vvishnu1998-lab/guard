#!/usr/bin/env bash
# ============================================================================
# PR4 — S3 BUCKET LOCKDOWN — PRODUCTION FLIP
# Pre-launch security punchlist #1.
#
# DO NOT RUN UNATTENDED. Intended for execution Sunday 2026-06-14 02:00 PDT
# under live operator supervision.
#
# Sequence (each step independently re-runnable; aborts on first non-zero):
#   0. Sanity: confirm caller identity + region
#   1. Create the access-logs bucket (private) + apply its bucket policy
#   2. Enable versioning on guard-media-prod
#   3. Enable server access logging on guard-media-prod
#   4. Apply restricted CORS (drop localhost + stale Vercel origins)
#   5. PublicAccessBlock = all-true (must precede policy delete; with PAB
#      flipped on first, any later mistake that re-grants public is suppressed)
#   6. Delete the PublicRead bucket policy
#   7. Smoke-test:
#        a) anonymous GET on a known key → expect 403
#        b) presigned GET on the same key → expect 200
#        c) (optional, manual) presigned-POST upload still works
#
# Rollback: see PR4-rollback-prod.sh in the same directory.
# ============================================================================

set -euo pipefail

BUCKET="guard-media-prod"
LOGS_BUCKET="guard-media-prod-logs"
REGION="us-east-1"
EXPECTED_ACCOUNT="458869662780"
HERE="$(cd "$(dirname "$0")" && pwd)"

log()  { printf "\n\033[1;33m== %s ==\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
fail() { printf "\033[1;31m  FAIL\033[0m  %s\n" "$*"; exit 1; }

# ── 0. Sanity ────────────────────────────────────────────────────────────────
log "0. Sanity check — caller + bucket"
ACTUAL_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACTUAL_ACCOUNT" = "$EXPECTED_ACCOUNT" ] || fail "wrong account $ACTUAL_ACCOUNT (expected $EXPECTED_ACCOUNT)"
ok "account = $ACTUAL_ACCOUNT"
aws s3api head-bucket --bucket "$BUCKET" || fail "$BUCKET not reachable"
ok "$BUCKET reachable"

# ── 1. Logs bucket ───────────────────────────────────────────────────────────
log "1. Create + lock down $LOGS_BUCKET"
if aws s3api head-bucket --bucket "$LOGS_BUCKET" 2>/dev/null; then
  ok "$LOGS_BUCKET already exists — skipping create"
else
  aws s3api create-bucket --bucket "$LOGS_BUCKET" --region "$REGION"
  ok "created $LOGS_BUCKET"
fi
# Private from day 1
aws s3api put-public-access-block --bucket "$LOGS_BUCKET" \
  --public-access-block-configuration file://"$HERE/new-pab.json"
ok "$LOGS_BUCKET PAB = all-true"
# The bucket policy granting logging.s3.amazonaws.com PutObject
aws s3api put-bucket-policy --bucket "$LOGS_BUCKET" \
  --policy file://"$HERE/new-logs-bucket-policy.json"
ok "$LOGS_BUCKET policy applied"

# ── 2. Versioning on guard-media-prod ────────────────────────────────────────
log "2. Enable versioning on $BUCKET"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration file://"$HERE/new-versioning.json"
STATUS=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)
[ "$STATUS" = "Enabled" ] || fail "versioning status = $STATUS"
ok "versioning = Enabled"

# ── 3. Access logging ────────────────────────────────────────────────────────
log "3. Enable access logging → $LOGS_BUCKET"
aws s3api put-bucket-logging --bucket "$BUCKET" \
  --bucket-logging-status file://"$HERE/new-logging.json"
TGT=$(aws s3api get-bucket-logging --bucket "$BUCKET" --query LoggingEnabled.TargetBucket --output text)
[ "$TGT" = "$LOGS_BUCKET" ] || fail "logging target = $TGT"
ok "logging target = $TGT"

# ── 4. CORS ──────────────────────────────────────────────────────────────────
log "4. Apply restricted CORS"
aws s3api put-bucket-cors --bucket "$BUCKET" \
  --cors-configuration file://"$HERE/new-cors.json"
ok "CORS applied"

# ── 5. PublicAccessBlock — MUST precede policy delete ────────────────────────
log "5. Public access block (block-all)"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration file://"$HERE/new-pab.json"
ok "PAB applied"

# ── 6. Delete the PublicRead bucket policy ───────────────────────────────────
log "6. Delete bucket policy (removes the PublicRead grant)"
aws s3api delete-bucket-policy --bucket "$BUCKET"
ok "bucket policy deleted"

# ── 7. Smoke tests ───────────────────────────────────────────────────────────
log "7. Smoke tests"
# Pick a known existing key from prod (caller can override)
PROBE_KEY="${PROBE_KEY:-clock_in/16acb562-2c1b-42bb-935b-67dcc684beee/2026-05-15/4630c454-2060-474a-b648-9dfcfc2cd9bd.jpg}"

# 7a — anonymous GET should be 403
ANON_URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/${PROBE_KEY}"
ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ANON_URL")
[ "$ANON_CODE" = "403" ] || fail "anonymous GET expected 403, got $ANON_CODE"
ok "anonymous GET → 403 (denied as expected)"

# 7b — presigned GET should be 200
SIGNED_URL=$(aws s3 presign "s3://${BUCKET}/${PROBE_KEY}" --expires-in 60)
SIGNED_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SIGNED_URL")
[ "$SIGNED_CODE" = "200" ] || fail "presigned GET expected 200, got $SIGNED_CODE"
ok "presigned GET → 200 (works as expected)"

log "DONE (steps 0-7) — bucket is private, presigned reads + uploads still flow"
echo ""

# ── 8. Railway 15-min 403 watch ──────────────────────────────────────────────
# Tails the Railway API service for 15 minutes filtering for any line that
# mentions a 403 against an upload-presign or photo-serving route. If any
# fire during the window the script PROMPTS before printing the final
# "flip confirmed" line — so the operator can decide to roll back instead.
#
# Railway CLI does not have a flag for "tail for N minutes then stop" so
# we wrap `railway logs --tail` in a background process + sleep + kill.

log "8. Watching Railway logs for 403s on upload + photo routes (15 min)"

WATCH_LOG=$(mktemp)
WATCH_DURATION=900  # 15 minutes
PATTERNS='403|/api/uploads/presign|photo_url|storage_url|selfie_url|site_photo_url|instructions_pdf_url|/api/admin/violations|/api/activity-log|/api/reports|/api/client/reports|/api/billing/hours-export'

if command -v railway >/dev/null 2>&1; then
  echo "  → tailing 'railway logs' for ${WATCH_DURATION}s into $WATCH_LOG"
  railway logs > "$WATCH_LOG" 2>&1 &
  WATCH_PID=$!
  # Sleep but allow ctrl-C cleanup
  trap 'kill $WATCH_PID 2>/dev/null; rm -f "$WATCH_LOG"; exit 130' INT
  sleep "$WATCH_DURATION"
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
  trap - INT

  HITS=$(grep -E "$PATTERNS" "$WATCH_LOG" | grep -E '403|forbidden|access denied|accessdenied' -i || true)
  if [ -n "$HITS" ]; then
    echo ""
    printf "\033[1;31m== STEP 8 — 403s OBSERVED IN 15-MIN WATCH ==\033[0m\n"
    echo "$HITS" | head -30
    echo ""
    echo "Full capture: $WATCH_LOG (saved for review)"
    echo ""
    read -p "Confirm flip succeeded anyway? [y/N] " ack
    [ "$ack" = "y" ] || [ "$ack" = "Y" ] || fail "operator declined — investigate or run PR4-rollback-prod.sh"
    ok "operator confirmed despite 403s"
  else
    ok "no 403s observed during 15-min window"
    rm -f "$WATCH_LOG"
  fi
else
  # 8a — manual fallback: print the command for the operator to run
  printf "\033[1;33m== STEP 8a — MANUAL: run this in a second terminal ==\033[0m\n"
  cat <<MANUAL
  railway logs | grep -E '403|forbidden|access denied' \\
    | grep -E '/api/uploads/presign|photo_url|storage_url|selfie_url|site_photo_url|instructions_pdf_url|/api/admin/violations|/api/activity-log|/api/reports|/api/client/reports|/api/billing/hours-export'

  Watch for ~15 minutes. If anything matches, run PR4-rollback-prod.sh.
MANUAL
  read -p "Press [Enter] after 15 minutes of clean logs to confirm the flip…"
fi

log "FLIP CONFIRMED — bucket is private, 15-min watch complete, no rollback triggered"
