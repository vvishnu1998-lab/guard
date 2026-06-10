#!/usr/bin/env bash
# Dress rehearsal — applies the full PR4 sequence against the throwaway
# test bucket guard-media-prod-flip-test and verifies the four behaviors
# we care about:
#   (a) anonymous GET → 403
#   (b) presigned GET → 200
#   (c) CORS preflight from https://app.netraops.com → 200 + Allow-Origin
#   (d) CORS preflight from http://localhost:3000 → no Allow-Origin
#
# (The mobile presigned-POST upload check is run separately via Node — see
#  test-presigned-post.mjs.)

set -euo pipefail
BUCKET="guard-media-prod-flip-test"
REGION="us-east-1"
HERE="$(cd "$(dirname "$0")" && pwd)"

log()  { printf "\n\033[1;33m== %s ==\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
fail() { printf "\033[1;31m  FAIL\033[0m  %s\n" "$*"; exit 1; }

aws s3api head-bucket --bucket "$BUCKET" || fail "$BUCKET not reachable"
ok "$BUCKET reachable"

# Same sequence as PR4-flip-prod.sh, minus logging (separate concern)
log "Apply CORS"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://"$HERE/new-cors.json"
ok "CORS applied"

log "Versioning"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration file://"$HERE/new-versioning.json"
ok "versioning enabled"

log "PublicAccessBlock"
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration file://"$HERE/new-pab.json"
ok "PAB applied"

log "Delete bucket policy (none was attached; safe to skip if 404)"
aws s3api delete-bucket-policy --bucket "$BUCKET" 2>&1 | head -1 || true
ok "policy cleared"

# Probe key (one of the 10 copied from prod)
PROBE_KEY="clock_in/16acb562-2c1b-42bb-935b-67dcc684beee/2026-05-15/4630c454-2060-474a-b648-9dfcfc2cd9bd.jpg"

log "(a) anonymous GET"
ANON_URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/${PROBE_KEY}"
ANON_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ANON_URL")
[ "$ANON_CODE" = "403" ] || fail "expected 403, got $ANON_CODE"
ok "anonymous → 403"

log "(b) presigned GET"
SIGNED_URL=$(aws s3 presign "s3://${BUCKET}/${PROBE_KEY}" --expires-in 60)
SIGNED_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SIGNED_URL")
[ "$SIGNED_CODE" = "200" ] || fail "expected 200, got $SIGNED_CODE"
ok "presigned → 200"

log "(c) CORS preflight from https://app.netraops.com"
ALLOWED_ORIGIN=$(curl -s -o /dev/null -w "%{http_code}\n%header{access-control-allow-origin}" \
  -X OPTIONS \
  -H "Origin: https://app.netraops.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  "https://${BUCKET}.s3.${REGION}.amazonaws.com/")
echo "  raw: $ALLOWED_ORIGIN"
echo "$ALLOWED_ORIGIN" | head -1 | grep -q "200" || fail "preflight code != 200"
echo "$ALLOWED_ORIGIN" | tail -1 | grep -q "app.netraops.com" || fail "Allow-Origin missing"
ok "preflight: 200 + Allow-Origin: https://app.netraops.com"

log "(d) CORS preflight from http://localhost:3000 (should NOT be allowed)"
# Dump all response headers to a tmpfile and check both (a) HTTP code is 403,
# and (b) no access-control-allow-origin header is present.
LH_HEADERS=$(mktemp)
LH_CODE=$(curl -s -o /dev/null -D "$LH_HEADERS" -w "%{http_code}" \
  -X OPTIONS \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  "https://${BUCKET}.s3.${REGION}.amazonaws.com/")
echo "  http code: $LH_CODE"
if grep -i '^access-control-allow-origin:' "$LH_HEADERS" >/dev/null 2>&1; then
  HV=$(grep -i '^access-control-allow-origin:' "$LH_HEADERS" | head -1)
  rm -f "$LH_HEADERS"
  fail "localhost preflight got header: $HV (expected none)"
fi
rm -f "$LH_HEADERS"
[ "$LH_CODE" = "403" ] || fail "localhost preflight expected 403, got $LH_CODE"
ok "localhost preflight: 403 + no Allow-Origin (correctly denied)"

echo ""
log "DRESS REHEARSAL PASSED"
