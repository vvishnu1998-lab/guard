#!/bin/zsh
# ota-export-and-gate.sh — export one mobile OTA from a clean tree, gate the
# bundles, write a sha256 manifest, and PRINT (never run) the publish command.
# The rule it enforces is DECISIONS.md D21; the procedure is release-ops §3b.
#
#   scripts/ops/ota-export-and-gate.sh <worktree> <commit sha, >= 7 chars> <app.json version> \
#                                      <channel> <absolute out dir> <dsn file>
#
# <channel> is production, preview or smoke; it selects the API URL the bundle
# must carry (eas.json build.<channel>.env.EXPO_PUBLIC_API_URL) and goes into
# the printed publish command. EXPO_PUBLIC_SENTRY_ENV is 'production' for every
# channel (decided 2026-09-29; the channel is read from contexts.ota_updates in
# Sentry, not from environment).
#
# <dsn file> holds exactly one line, EXPO_PUBLIC_SENTRY_DSN=<dsn>, mode 0600,
# outside every git worktree — made with:
#   umask 077 && printf 'EXPO_PUBLIC_SENTRY_DSN=%s\n' "$(pbpaste)" > <file>
# The DSN value is never printed; only counts and sha256 prefixes are.
#
# Refuses: a tree not at the commit, dirty (or whose git status fails), on
# another version, holding any apps/mobile/.env* (@expo/env would fill unset
# vars from it), or whose installed node_modules differ from its
# package-lock.json; a runtimeVersion policy other than appVersion; an out dir
# or DSN file spelled with a . or .. component; a relative out dir, one inside
# ANY git worktree, one that is the tree or contains it, or an existing one
# that is not a previous export (only _expo, assets and a metadata.json with
# ios + android bundles). The checks, the delete and --output-dir all use the
# symlink-resolved path. Exits non-zero if any gate fails, and then prints no
# publish command.
#
# macOS + zsh only (stat -f, shasum). Needs the tree's node_modules installed
# with npm ci at that commit.
set -u
if (( $# != 6 )); then
  print -u2 "usage: $0 <worktree> <sha> <version> <production|preview|smoke> <absolute out dir> <dsn file>"
  exit 2
fi
TREE=${1:P}; WANT_SHA=$2; WANT_VER=$3; CHANNEL=$4; OUT_ARG=$5; DSNFILE_ARG=$6
# Resolved once; every check, the delete and --output-dir use these.
OUT=${OUT_ARG:P}; DSNFILE=${DSNFILE_ARG:P}
DSN_RE='https://[0-9a-f]{32}@o[0-9]+\.ingest\.(us\.)?sentry\.io/[0-9]+'
fail=0
ok()  { print -r -- "  PASS  $*"; }
bad() { print -r -- "  FAIL  $*"; fail=1; }
stop() { print -r -- "RESULT: FAIL ($1)"; exit 1; }
# A . or .. component can resolve one way as text and another through a
# symlink, so the spelling itself is refused.
dotted() { [[ /$1/ == */./* || /$1/ == */../* ]]; }
# True when $1, or its nearest existing ancestor, is inside a git worktree.
in_worktree() {
  local d=$1
  while [[ ! -e $d && $d != / ]]; do d=${d:h}; done
  [[ -d $d ]] || d=${d:h}
  git -C "$d" rev-parse --show-toplevel >/dev/null 2>&1
}
# True when directory $1 holds nothing, or only a previous export: _expo,
# assets and a metadata.json listing ios + android bundles.
previous_export() {
  python3 -c '
import json, os, sys
d = sys.argv[1]
e = set(os.listdir(d))
if not e:
    sys.exit(0)
if "metadata.json" not in e or not e <= {"_expo", "assets", "metadata.json"}:
    sys.exit(1)
try:
    fm = json.load(open(os.path.join(d, "metadata.json"))).get("fileMetadata", {})
except Exception:
    sys.exit(1)
sys.exit(0 if all(p in fm and fm[p].get("bundle") for p in ("ios", "android")) else 1)
' "$1"
}

print "## arguments"
[[ $CHANNEL == (production|preview|smoke) ]] && ok "channel $CHANNEL" || bad "channel must be production, preview or smoke (got $CHANNEL)"
(( ${#WANT_SHA} >= 7 )) && ok "sha given (${#WANT_SHA} chars)" || bad "give at least 7 characters of the commit sha"
[[ $OUT_ARG == /* ]] && ok "out dir is absolute" || bad "out dir must be absolute (got $OUT_ARG)"
dotted "$OUT_ARG" && bad "out dir has a . or .. component (got $OUT_ARG)" || ok "out dir has no . or .. component"
dotted "$DSNFILE_ARG" && bad "DSN file path has a . or .. component" || ok "DSN file path has no . or .. component"
[[ $OUT != / && $OUT != $TREE && $OUT != $TREE/* ]] && ok "out dir is not the tree or inside it" || bad "out dir is the tree or inside it"
in_worktree "$OUT" && bad "out dir is inside a git worktree ($OUT)" || ok "out dir is outside every git worktree"
if [[ -e $OUT ]]; then
  # -ef compares device and inode, so another spelling of an ancestor is caught.
  contains=0; d=$TREE
  while :; do [[ $d -ef $OUT ]] && contains=1; [[ $d == / ]] && break; d=${d:h}; done
  (( contains )) && bad "out dir contains the tree ($OUT)" || ok "out dir does not contain the tree"
  if [[ -d $OUT ]] && previous_export "$OUT"; then ok "out dir is empty or a previous export"
  else bad "out dir exists and is not a previous export: $OUT"; fi
fi
(( fail )) && stop "arguments"

cd "$TREE/apps/mobile" 2>/dev/null || stop "no apps/mobile in $TREE"
print "## tree $TREE"
head=$(git rev-parse HEAD)
[[ $head == ${WANT_SHA}* ]] && ok "HEAD ${head:0:12}" || bad "HEAD ${head:0:12}, want $WANT_SHA"
st=$(git status --porcelain --untracked-files=all) || { bad "git status failed"; st=failed; }
[[ -z $st ]] && ok "worktree clean" || bad "worktree dirty"
# node_modules is ignored, so the clean-tree check cannot see it: compare what
# npm installed (node_modules/.package-lock.json) with the commit's lockfile.
python3 - "$TREE" <<'PY' && ok "node_modules matches package-lock.json" || bad "node_modules differs from package-lock.json (run npm ci in $TREE)"
import json, sys
root = sys.argv[1]
try:
    lock = json.load(open(root + '/package-lock.json'))['packages']
    got = json.load(open(root + '/node_modules/.package-lock.json'))['packages']
except Exception as e:
    print(f'  info  cannot read a lockfile: {e}'); sys.exit(1)
wrong = [k for k in got if k in lock and got[k].get('version') != lock[k].get('version')]
extra = [k for k in got if k not in lock]
missing = [k for k, v in lock.items() if 'node_modules/' in k and k not in got and not v.get('optional')]
for label, keys in (('wrong version', wrong), ('not in the lockfile', extra), ('not installed', missing)):
    if keys:
        print(f'  info  {len(keys)} {label}, e.g. {", ".join(keys[:3])}')
sys.exit(1 if wrong or extra or missing else 0)
PY
read -r ver policy api_url <<<"$(python3 - "$CHANNEL" <<'PY'
import json,sys
a=json.load(open('app.json'))['expo']; e=json.load(open('eas.json'))
rv=a.get('runtimeVersion'); pol=rv.get('policy') if isinstance(rv,dict) else rv
url=(((e.get('build') or {}).get(sys.argv[1]) or {}).get('env') or {}).get('EXPO_PUBLIC_API_URL','')
print(a.get('version'), pol, url or '-')
PY
)"
[[ $ver == $WANT_VER ]] && ok "app.json version $ver (the runtime)" || bad "app.json version $ver, want $WANT_VER"
[[ $policy == appVersion ]] && ok "runtimeVersion policy appVersion" || bad "runtimeVersion policy is $policy, not appVersion"
[[ $api_url == https://* ]] && ok "API URL from eas.json build.$CHANNEL.env: $api_url" || bad "no EXPO_PUBLIC_API_URL for build.$CHANNEL in eas.json"
envs=$(ls -a | grep '^\.env' | tr '\n' ' ')
[[ -z $envs ]] && ok "no apps/mobile/.env* files" || bad "env files present: $envs"

print "## DSN file"
[[ -f $DSNFILE ]] || stop "missing $DSNFILE"
in_worktree "$DSNFILE" && bad "the DSN file is inside a git worktree" || ok "outside every git worktree"
mode=$(stat -f '%Lp' "$DSNFILE")
[[ $mode == 600 ]] && ok "mode 600" || bad "mode $mode, want 600"
lines=$(grep -c . "$DSNFILE")
DSN=$(sed -n 's/^EXPO_PUBLIC_SENTRY_DSN=//p' "$DSNFILE")
[[ $lines == 1 && -n $DSN ]] && ok "one EXPO_PUBLIC_SENTRY_DSN line" || bad "the file must hold exactly one EXPO_PUBLIC_SENTRY_DSN=<dsn> line"
print -rn -- "$DSN" | grep -qE "^${DSN_RE}\$" && ok "value has the DSN shape" || bad "value is not a DSN"
key_hash=$(print -rn -- "${DSN%%@*}@" | shasum -a 256 | cut -c1-12)
print "  info  key sha256 $key_hash…"
(( fail )) && stop "pre-export"

print "## export"
rm -rf "$OUT"
env -u EXPO_PUBLIC_API_URL -u EXPO_PUBLIC_SENTRY_ENV -u EXPO_PUBLIC_SENTRY_DSN \
  EXPO_PUBLIC_API_URL="$api_url" EXPO_PUBLIC_SENTRY_ENV=production EXPO_PUBLIC_SENTRY_DSN="$DSN" \
  ../../node_modules/.bin/expo export --platform ios --platform android --output-dir "$OUT" --clear > "$OUT.log" 2>&1
rc=$?
(( rc == 0 )) && ok "expo export rc=0 ($(grep -c Bundled "$OUT.log") platforms bundled)" || { bad "expo export rc=$rc (see $OUT.log)"; stop "export"; }
grep -qF -- "$DSN" "$OUT.log" && bad "the DSN appears in the export log" || ok "the DSN is not in the export log"

print "## bundle gates"
for p in ios android; do
  f=( $OUT/_expo/static/js/$p/*.hbc(N) )
  if (( ${#f} != 1 )); then bad "$p: expected one .hbc, found ${#f}"; continue; fi
  f=$f[1]
  api=$(grep -a -c -F -- "$api_url" "$f")
  lh=$(grep -a -c 'localhost:3001' "$f")
  und=$(grep -a -c 'undefined/api' "$f")
  exact=$(grep -a -c -F -- "$DSN" "$f")
  # Hermes packs strings with no separators, so a whole-DSN regex runs on into
  # the next string: gate on the self-delimiting public key instead.
  keys_n=$(grep -a -o -E 'https://[0-9a-f]{32}@' "$f" | sort -u | wc -l | tr -d ' ')
  keys_h=$(grep -a -o -E 'https://[0-9a-f]{32}@' "$f" | sort -u | head -1 | tr -d '\n' | shasum -a 256 | cut -c1-12)
  (( api >= 1 ))     && ok "$p: API URL present" || bad "$p: API URL missing"
  (( lh == 0 ))      && ok "$p: no localhost:3001" || bad "$p: localhost:3001 present"
  (( und == 0 ))     && ok "$p: no 'undefined/api'" || bad "$p: 'undefined/api' present"
  (( exact >= 1 ))   && ok "$p: the exact DSN is in the bundle" || bad "$p: the exact DSN is NOT in the bundle"
  [[ $keys_n == 1 ]] && ok "$p: exactly one Sentry public key" || bad "$p: $keys_n distinct Sentry keys"
  [[ $keys_h == $key_hash ]] && ok "$p: bundle key = file key ($keys_h…)" || bad "$p: bundle key $keys_h… != file $key_hash…"
done
unset DSN
python3 - "$OUT/metadata.json" <<'PY' && ok "metadata.json lists ios + android bundles" || bad "metadata.json incomplete"
import json,sys
m=json.load(open(sys.argv[1])); fm=m.get("fileMetadata",{})
sys.exit(0 if all(p in fm and fm[p].get("bundle") for p in ("ios","android")) else 1)
PY
(( fail )) && stop "bundle gates"

(cd "$OUT" && find . -type f | LC_ALL=C sort | xargs shasum -a 256) > "$OUT.sha256"
print "  info  manifest $OUT.sha256 ($(wc -l < "$OUT.sha256" | tr -d ' ') files, sha256 $(shasum -a 256 "$OUT.sha256" | cut -c1-16)…)"
print "RESULT: PASS  $OUT"
print ""
print "Publish (Vishnu runs both). First the manifest check, which must print 'manifest OK':"
print "  cd $OUT && n=\$(wc -l < $OUT.sha256 | tr -d ' ') && k=\$(shasum -a 256 -c $OUT.sha256 | grep -c ': OK\$'); [ \"\$n\" -gt 0 ] && [ \"\$k\" = \"\$n\" ] && echo \"manifest OK (\$n files)\" || echo 'manifest FAILED'"
print "Then:"
print "  cd $TREE/apps/mobile && eas update --branch $CHANNEL -m \"<message>\" --skip-bundler --input-dir $OUT --non-interactive"
exit 0
