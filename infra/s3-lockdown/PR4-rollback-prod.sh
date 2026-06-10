#!/usr/bin/env bash
# ============================================================================
# PR4 — ROLLBACK SCRIPT
#
# Run if PR4-flip-prod.sh produces user-visible breakage and you need to
# restore public-read access in one shot.
#
# What this restores:
#   - Removes the PublicAccessBlock (so the public policy can take effect)
#   - Re-applies the original PublicRead bucket policy
#   - Restores the original CORS (with localhost + Vercel preview origins)
#
# What this does NOT undo (intentional — these are net-positive even if
# the rest gets rolled back):
#   - Versioning stays enabled (harmless; only adds storage cost)
#   - Access logging stays enabled (harmless; only adds storage cost)
#   - Logs bucket stays created (delete manually later if undesired)
# ============================================================================

set -euo pipefail

BUCKET="guard-media-prod"
HERE="$(cd "$(dirname "$0")" && pwd)"

log()  { printf "\n\033[1;33m== %s ==\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
fail() { printf "\033[1;31m  FAIL\033[0m  %s\n" "$*"; exit 1; }

# Sanity
log "Sanity"
aws s3api head-bucket --bucket "$BUCKET" || fail "$BUCKET not reachable"
ok "$BUCKET reachable"

# 1. Remove PAB so the policy can grant public read again
log "1. Remove PublicAccessBlock"
aws s3api delete-public-access-block --bucket "$BUCKET"
ok "PAB removed"

# 2. Re-apply the original PublicRead policy
log "2. Re-apply original PublicRead policy"
aws s3api put-bucket-policy --bucket "$BUCKET" \
  --policy file://"$HERE/prod-original-policy.json"
ok "policy restored"

# 3. Restore original CORS
log "3. Restore original CORS"
# Note: prod-original-cors.json is the full get-bucket-cors response shape;
# put-bucket-cors wants just the {CORSRules: [...]} root. Extract via jq.
TMP=$(mktemp)
jq '{CORSRules: .CORSRules}' "$HERE/prod-original-cors.json" > "$TMP"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://"$TMP"
rm -f "$TMP"
ok "CORS restored"

# Smoke
log "Smoke — anonymous GET must work again"
PROBE_KEY="${PROBE_KEY:-clock_in/16acb562-2c1b-42bb-935b-67dcc684beee/2026-05-15/4630c454-2060-474a-b648-9dfcfc2cd9bd.jpg}"
ANON_URL="https://${BUCKET}.s3.us-east-1.amazonaws.com/${PROBE_KEY}"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ANON_URL")
[ "$CODE" = "200" ] || fail "anonymous GET still $CODE — rollback incomplete"
ok "anonymous GET → 200"

log "Rollback complete — bucket is public-read again"
