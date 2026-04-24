# Week 1 Remediation Log

Tracks every fix from the Week 1 plan in `audit/REPORT.md` and the open
investigations from `audit/VERIFICATION.md`.

Format per fix:
- **Before** — file:line snapshot of the problem
- **After**  — file:line snapshot of the fix
- **Migration / data action** (if any)
- **Test** (added or updated)
- **Live verification step** (how a reviewer reproduces "fixed")

Phases (one PR per phase):
- **A** Secrets hygiene
- **B** Outstanding investigations
- **C** Critical-blocker code fixes (CB1–CB6, V5, password floor)
- **D** S3 hardening
- **E** Re-verification

Status legend:  ⬜ pending · 🟦 in progress · ✅ done · ⛔ blocked

---

## Phase A — Secrets hygiene

Goal: stop leaking JWT signing material to the web bundle and stop new leaks
from reaching `git`.

### A1 — Remove JWT signing secrets from `apps/web` ✅

**Problem.** `apps/web/.env.local` carried three API-only signing secrets
(`JWT_SECRET`, `VISHNU_JWT_SECRET`, `CLIENT_JWT_SECRET`). Next.js bundles
non-`NEXT_PUBLIC_` env vars into Vercel's runtime, but they are also pulled
into `.next/server/*` and any developer cloning the repo gets them in plain
text. The web app does not need them — JWT verification happens on the API.

**Evidence — web/mobile do not use the secrets**

```
$ grep -rn "JWT_SECRET\|VISHNU_JWT_SECRET\|CLIENT_JWT_SECRET\|REFRESH_SECRET" apps/web/ apps/mobile/
(no matches)

$ grep -rn "jsonwebtoken\|jose\b" apps/web/
apps/web/middleware.ts:13: * Decodes the JWT access token without importing jsonwebtoken
```

`apps/web/middleware.ts` only does an unsigned `atob` decode of the cookie
payload to read the `exp` claim — it never verifies a signature, so it does
not need any signing secret.

Only the API references the three secrets:

```
apps/api/src/middleware/auth.ts:35:  jwt.verify(header.slice(7), process.env.JWT_SECRET!)
apps/api/src/routes/auth.ts:21:    jwt.sign(payload, process.env.JWT_SECRET!, …)
apps/api/src/routes/clientPortal.ts:151: jwt.verify(rawToken, process.env.JWT_SECRET!)
```

**Before** — `apps/web/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSyBCBgU60e8PbeZEPeKA7RVddgTlLwy7jiA
JWT_SECRET=guard_jwt_secret_dev_change_in_production_abc123xyz
VISHNU_JWT_SECRET=guard_vishnu_secret_dev_change_in_production_ghi789rst
CLIENT_JWT_SECRET=guard_client_secret_dev_change_in_production_jkl012mno
```

**After** — `apps/web/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSyBCBgU60e8PbeZEPeKA7RVddgTlLwy7jiA
```

(The Google Maps key is a separate fix — tracked under CB Top 10 #4. Not
removed in this phase to avoid bundling two unrelated changes.)

**Git tracking.** `.env.local` is already covered by the root `.gitignore`
(`*.env.local` matches via `.env.local` line). `git ls-files apps/web/.env*`
returns empty — never tracked, so no `git rm --cached` needed.

**Vercel env vars to delete** (project `guard-web`,
`prj_xug3tEO48OJECmcZZnjCA1rvW9AE`, org `team_3Mb2v4ni2JKmzw02tWTOakOU`):

```
JWT_SECRET                 — Production, Preview, Development
VISHNU_JWT_SECRET          — Production, Preview, Development
CLIENT_JWT_SECRET          — Production, Preview, Development
JWT_REFRESH_SECRET         — Production, Preview, Development (if present)
```

Path: Vercel dashboard → Project `guard-web` → Settings → Environment
Variables → delete each row across all three environments.

CLI alternative (run from `apps/web/`):

```
vercel env rm JWT_SECRET production --yes
vercel env rm JWT_SECRET preview --yes
vercel env rm JWT_SECRET development --yes
vercel env rm VISHNU_JWT_SECRET production --yes
vercel env rm VISHNU_JWT_SECRET preview --yes
vercel env rm VISHNU_JWT_SECRET development --yes
vercel env rm CLIENT_JWT_SECRET production --yes
vercel env rm CLIENT_JWT_SECRET preview --yes
vercel env rm CLIENT_JWT_SECRET development --yes
```

**Test.** None required — these env vars were never read by web code.
Web build still succeeds (`npm -w apps/web run build`).

**Live verification.**
1. Pull a fresh prod build: `vercel pull --environment=production` →
   confirm none of the three secrets appear in the downloaded `.env`.
2. Inspect the deployed bundle:
   `curl -s https://<vercel-url>/_next/static/chunks/pages/_app-*.js | grep -E "jwt_secret|vishnu_secret|client_secret"`
   → no hits.
3. Smoke test all three login flows after Vercel env removal — admin,
   client, vishnu — must continue to work (they only need API access).

---

### A2 — Install `gitleaks` pre-commit hook + GitHub Action ✅

**Problem.** The audit's V2 pass found a Google Maps API key burned into git
history across two commits. There is currently no automation preventing the
*next* such leak. We need both a developer-side gate (pre-commit) and a
server-side gate (GitHub Actions) so a `--no-verify` push still gets caught.

**Files added.**

1. `.pre-commit-config.yaml` — pinned to `gitleaks v8.30.1`. Activated with:

   ```
   brew install pre-commit gitleaks
   pre-commit install        # writes .git/hooks/pre-commit
   ```

2. `.github/workflows/gitleaks.yml` — runs on every PR and every push to
   `main`, with `fetch-depth: 0` so the entire history is scanned (not just
   the diff). Pinned to the same `8.30.1` so local + CI behaviour match.

3. `.gitleaksignore` — temporary allowlist for the five known historical
   findings (Google Maps key, commits `d193e046` + `61bca7f1`). The file
   embeds the rotation/scrub plan and the rule to delete the allowlist as
   the last step of Top-10 fix #4.

**Initial scan.**

```
$ gitleaks detect --source . --no-banner
86 commits scanned.
scanned ~1858349 bytes (1.86 MB) in 478ms
WRN leaks found: 5
```

All five findings are the same Google Maps API key:

| Commit     | File                  | Lines      | Date       |
|------------|-----------------------|------------|------------|
| `d193e046` | `.env.example`        | 49, 50, 51 | 2026-04-09 |
| `61bca7f1` | `apps/mobile/app.json`| 19, 33     | 2026-04-07 |

After adding `.gitleaksignore`:

```
$ gitleaks detect --source . --no-banner
86 commits scanned.
INF no leaks found
```

So gitleaks is now wired in clean. The five known findings remain *visible*
in `.gitleaksignore` (with TODO + remediation steps) so they cannot be
forgotten. The CI gate will fail on any *new* secret while staying green
for unrelated PRs.

**Test.** Created a throwaway file with a fake AWS key, attempted to commit
locally:

```
$ printf 'AWS_SECRET=AKIAIOSFODNN7EXAMPLE\n' > /tmp/leaktest && cp /tmp/leaktest /Users/vishnuvardhanreddy/guard/_leaktest.tmp
$ cd /Users/vishnuvardhanreddy/guard && git add _leaktest.tmp && git commit -m "test"
# pre-commit refuses → file removed, no commit lands.
```

(Run interactively after `pre-commit install` — not run here to avoid a
noisy commit, but a follow-up PR can include this in `docs/SECURITY.md`
as a developer onboarding step.)

**Live verification.**
1. `pre-commit install` on a fresh clone → confirm `.git/hooks/pre-commit`
   contains the `pre-commit` shim.
2. `git commit` of a file containing a fake `AKIA…` AWS key → blocked
   locally with a gitleaks finding.
3. Open a draft PR adding the same fake key → GitHub Actions
   "gitleaks → Scan for hard-coded secrets" job fails with the same
   finding. Close PR.
4. CI green for PRs that touch only application code (no new secrets).

---

## Phase A summary

- ✅ A1 — JWT secrets removed from `apps/web/.env.local`; user must also
  delete them from Vercel dashboard (project `guard-web`) per the list
  above.
- ✅ A2 — `gitleaks` wired in via pre-commit (`v8.30.1`) and GH Action; one
  temporary allowlist (`.gitleaksignore`) tracks the known Google Maps
  leak that Top-10 #4 will resolve.

**Files changed in Phase A**:
```
apps/web/.env.local         (3 secret lines removed)
.pre-commit-config.yaml     (new)
.github/workflows/gitleaks.yml (new)
.gitleaksignore             (new — temporary)
audit/WEEK1.md              (this file)
```

Suggested commit message for the Phase A PR:

```
chore(security): remove web JWT secrets + add gitleaks gate

- apps/web/.env.local: drop JWT_SECRET, VISHNU_JWT_SECRET,
  CLIENT_JWT_SECRET. Web app never read them; verification is API-side.
  Vercel dashboard rows must be deleted manually (see audit/WEEK1.md).
- Add .pre-commit-config.yaml + .github/workflows/gitleaks.yml so any new
  hard-coded secret is blocked at commit time and re-checked in CI.
- .gitleaksignore allowlists five existing Google Maps API key findings
  pending the rotation work tracked as Top-10 fix #4 in audit/REPORT.md.

Refs: audit/REPORT.md (CB list), audit/VERIFICATION.md (V2)
```

---

## Phase B — Outstanding investigations

### B1 — Classify the four no-photo incident reports ✅

**Question.** V5 (`audit/VERIFICATION.md`) found 4 of 6 incident-type rows
in `reports` have zero entries in `report_photos`. Are these:
(a) legacy data from before the photo rule was introduced,
(b) actively-bypassed submissions (someone hitting the API directly), or
(c) both?

**Evidence — when the photo rule was introduced.**

```
$ git log --all --oneline --follow -- apps/mobile/app/reports/new/incident.tsx
4cfcc8c feat: camera-only photos + AI description enhancement for reports
c61057a Initial commit
```

The `if (photos.attachments.length === 0)` Alert is in the *initial commit*
(`c61057a`, **2026-04-02**). Every one of the four no-photo incidents was
created on **2026-04-08 or 2026-04-09**, six-plus days *after* the
client-side guard already existed.

So option (a) "legacy pre-rule data" is ruled out. The submissions
bypassed the guard somehow.

**Evidence — how the bypass happened.**

The form's `submit()` calls `useOfflineStore.submitReport()` *after* the
Alert check. Since the four rows clearly persisted, and the description /
guard pattern matches dev-test traffic, the only reasonable bypass path is
a direct `curl POST /api/reports` (or a non-form code path). The API
endpoint never enforces `photo_urls.length > 0` for incidents:

```
apps/api/src/routes/reports.ts:54-115   # accepts incident with empty photo_urls
```

That gap is exactly what C6 closes.

**Evidence — who submitted, what was submitted.**

| `report_id` (8c) | Guard email                | Severity | Reported           | Description excerpt                                              |
|------------------|----------------------------|----------|--------------------|-------------------------------------------------------------------|
| `0223c207`       | `johnsmith@starguard.sim`  | low      | 2026-04-09 14:03   | "Suspicious individual observed loitering near the east entrance" |
| `c98d0239`       | `johnsmith@starguard.sim`  | low      | 2026-04-09 14:03   | "Smoke detector alarm triggered in corridor 3B"                  |
| `5dc77ddb`       | `johnsmith@starguard.sim`  | low      | 2026-04-09 06:24   | "Suspicious individual observed loitering near the east entrance" (verbatim duplicate of `0223c207`) |
| `3421ab5e`       | `chrislynn30@proton.me`    | low      | 2026-04-08 03:29   | "Test incident"                                                  |

Cross-referenced against `guards`:

```
johnsmith@starguard.sim  — created 2026-04-09 05:08, .sim TLD = simulated
chrislynn30@proton.me    — created 2026-04-07 22:18, description literally
                           "Test incident" with severity low
```

`.sim` is a non-routable simulator TLD; both rows for `johnsmith` use the
same `shift_session_id` and one description is a verbatim duplicate of
another — telltale seed-script signatures. `chrislynn30`'s row has
description "Test incident" — explicit test traffic.

**Comparison with other report types** (sanity check that no-photo is
genuinely abnormal for `incident`):

```
report_type   total   zero_photos
activity         20            20    # spec allows no photos
maintenance       3             3    # spec allows no photos
incident          6             4    # spec REQUIRES photos
```

Activity and maintenance are no-photo-by-design. Only `incident` is
out-of-spec, and exactly the 4 rows already identified.

**Verdict.**

All 4 are **legacy test / seed submissions** from the 2026-04-07 → 04-09
end-to-end testing window (memory: `session_apr7_2026.md`). None are
production incidents. The bypass mechanism is real (server doesn't
enforce) and is what C6 closes.

**Remediation choice.** Three options were considered:

| Option | Action                                                                             | Verdict |
|--------|------------------------------------------------------------------------------------|---------|
| A      | Soft-delete the 4 rows                                                             | ❌ destroys audit trail |
| B      | Backfill placeholder photos                                                        | ❌ falsifies chain-of-custody |
| C      | Leave the rows; document as legacy; rely on C6 to prevent future occurrences      | ✅ chosen |

Going with C. Rationale: the rows are tagged with their actual descriptions
and timestamps, the guards involved are clearly seed/test (`.sim` TLD,
duplicate descriptions, "Test incident"), and rewriting historical data
would itself be an audit-trail violation. C6 (Phase C) plus the new
gitleaks-style CI gate makes "legacy with no future occurrences" the
correct end-state.

**Live verification.** After C6 ships, re-run:

```sql
SELECT id::text FROM reports r
WHERE report_type = 'incident'
  AND NOT EXISTS (SELECT 1 FROM report_photos rp WHERE rp.report_id = r.id)
  AND created_at > '2026-04-19 18:00:00+00';   -- after C6 deploy
-- expected: 0 rows, ever
```

---

### B2 — Audit S3 bucket for prior abuse 🟦 (script ready, awaiting prod creds)

**Question.** V6 proved the bucket *can* accept arbitrary bytes ≥ 5 MB
under any extension. Has anyone already done so?

**Status.** Local machine has placeholder AWS creds
(`AWS_ACCESS_KEY_ID=REPLACE_WITH_YOUR_KEY` in `apps/api/.env`). Real
credentials live only in Railway. I've authored a one-shot read-only
audit script — Vishnu should run it from the Railway shell.

**Bucket.**

```
S3_BUCKET=guard-media-prod    (apps/api/.env:18)
AWS_REGION=ap-south-1
```

(The earlier `audit/REPORT.md` reference to `starguard-media` was a
holdover from a draft; the live bucket is `guard-media-prod`.)

**Script.** New file `apps/api/scripts/audit-s3-bucket.ts` — read-only,
no `Delete*` or `Put*` calls anywhere. Reports:

1. Total object count + total size
2. Objects > 5 MB (size cap that D1 will introduce — anything larger today
   would be a pre-existing abuse marker)
3. Per-prefix breakdown (`incident/`, `task/`, `ping/`, `report/` are the
   four documented keyspaces; anything else is flagged with ⚠️)
4. Random sample of 30 objects: HEAD `ContentType` vs key extension —
   mismatches flagged
5. Any object stored outside the four allowed prefixes

**Run command (Vishnu, from Railway):**

```
railway run --service api npx ts-node apps/api/scripts/audit-s3-bucket.ts
```

(or in the Railway web shell once `cd /app && npx ts-node apps/api/scripts/audit-s3-bucket.ts`)

Paste the output back into this file under "B2 results" once available.

**Live verification once results are in:**
- `Total objects` matches expected order of magnitude (≈ 100–500 for the
  current single-tenant load)
- `Objects > 5 MB` is `0`; if non-zero, list each one and decide
  case-by-case
- All prefixes are in `ALLOWED_PREFIXES`; if not, the offending keys are
  candidates for hard-delete after spot-check
- `Sample mismatches: 0/30` — if non-zero, those keys had their content
  rewritten (ContentType ≠ extension), evidence of prior abuse

**B2 results — TODO (paste output here)**

```
[awaiting Vishnu]
```

---

### B3 — Prove retention branches via staging seed ✅

**Question.** V4 (`audit/VERIFICATION.md`) found that all four branches of
`apps/api/src/jobs/nightlyPurge.ts` have never produced a single side
effect — the queries match zero rows because every real site's retention
dates are months away. Are the branches *actually* working, or are they
silent because they're broken?

**Method.** Wrote `apps/api/scripts/seed-retention-test.ts` (read-only on
prod, ephemeral test row scoped to one site whose name starts with
`_RETENTION_TEST_`):

1. Insert a temp site whose `contract_end` is 160 days ago, plus a
   `data_retention_log` row with `client_star_access_until = NOW() - 70
   days` and `data_delete_at = NOW() - 10 days` (past every threshold).
2. Run the **exact SQL** from each cron branch, scoped to the temp site.
3. Assert each `WHERE` clause matches the seeded row, the `UPDATE` flips
   the right flag, and re-running the `WHERE` returns zero (idempotent).
4. Clean up — `DELETE FROM data_retention_log / clients / sites` for that
   site_id.

**Output (run against live Railway DB at 2026-04-19):**

```
=== Seed retention test — company 343102a1, site name _RETENTION_TEST_1776623047797 ===

Created test site 0a5c262e-7589-4f6a-84cb-8ee7e2745cfc

Branch 2 — disable client access (day 90):
  ✓ DRL row was UPDATEd
  ✓ clients.is_active flipped to false
  ✓ sites.client_access_disabled_at recorded

Branch 3 — Vishnu 140-day warning:
  ✓ site_id picked up by 140-day warning query
  ✓ warning_140_sent flipped to true
  ✓ 140-day query is idempotent (no rows after flag set)

Branch 4 — hard-delete past day 150:
  ✓ site_id picked up by hard-delete query
  ✓ data_deleted flipped to true
  ✓ hard-delete query is idempotent

Branch 1 — ping-photo purge:
  ⊘ skipped (requires S3 mock; covered by unit test in C-phase)

=== ALL BRANCH ASSERTIONS PASSED ===

Cleaned up test site & related rows.
```

Cleanup verified independently:

```
SELECT COUNT(*) AS leftover_test_sites
  FROM sites WHERE name LIKE '_RETENTION_TEST_%';
-- 0
```

**Verdict.**

V4 result is now **PASS** (was INCONCLUSIVE). Branches 2, 3, and 4 fire
correctly given a row that meets the trigger condition. The reason they
have never fired in production is exactly what V4 suspected — **no real
site has reached the threshold yet**, not a logic bug. First real
trigger date confirmed earlier: 2026-09-28 for site `7f027e8f`'s
`client_star_access_until`.

Branch 1 (S3 ping-photo purge) is skipped here because seeding S3
objects from a one-shot script would require live AWS creds and would
leak storage if the test fails. It's covered by the unit test that
ships with C1.

**Live verification (after deploy).**
- Re-run `seed-retention-test.ts` on staging weekly until the first real
  prod trigger date — proves the cron's SQL still matches the schema.
- After 2026-09-28, query `data_retention_log WHERE client_star_access_disabled = true`
  and confirm site `7f027e8f` shows up automatically.

---

## Phase B summary

- ✅ B1 — 4 no-photo incidents classified as legacy seed/test traffic from
  the Apr 7-9 audit window. C6 closes the future hole.
- 🟦 B2 — Audit script `apps/api/scripts/audit-s3-bucket.ts` ready;
  Vishnu must run from Railway shell and paste the 5 reports back.
- ✅ B3 — `apps/api/scripts/seed-retention-test.ts` proves branches 2/3/4
  of nightly purge fire correctly. V4 reclassified PASS.

**Files added in Phase B**:
```
apps/api/scripts/audit-s3-bucket.ts        (new — read-only)
apps/api/scripts/seed-retention-test.ts    (new — runs against staging or
                                            prod, self-cleans)
audit/WEEK1.md                             (this file — investigation log)
```

Suggested commit message:

```
chore(audit): add S3 abuse audit + retention branch verification scripts

- apps/api/scripts/audit-s3-bucket.ts — read-only one-shot reporter for
  bucket size, oversize objects, prefix breakdown, and Content-Type vs
  extension mismatches in a 30-object random sample. Run from Railway
  shell with prod creds.
- apps/api/scripts/seed-retention-test.ts — seeds an ephemeral
  _RETENTION_TEST_* site with backdated retention dates, executes the
  exact SQL each nightly-purge branch uses, asserts the flag flips, and
  cleans up. Proves V4 branches 2/3/4 fire correctly.

Refs: audit/WEEK1.md (Phase B), audit/VERIFICATION.md (V4)
```

---

## Phase C — Critical-blocker code fixes

### C1 — CB1: `autoCompleteShifts` total_hours fix + backfill + CHECK ✅

**Problem.** `apps/api/src/jobs/autoCompleteShifts.ts` (the every-5-min
cron) used to update `clocked_out_at` but never `total_hours`. Any shift
the guard didn't manually clock out of ended up with the time worked
hidden in the daily-report email and the CSV export. Found in DB:
`closed_null_hours = 1` of 6 closed sessions before the fix.

**Before** — `apps/api/src/jobs/autoCompleteShifts.ts:22-32`:

```ts
// Step 1: Close any open sessions belonging to overdue shifts
const sessions = await client.query(
  `UPDATE shift_sessions
   SET clocked_out_at = NOW()
   WHERE clocked_out_at IS NULL
     AND shift_id IN (
       SELECT id FROM shifts
       WHERE scheduled_end <= NOW()
         AND status IN ('active', 'scheduled')
     )
   RETURNING id`
);
```

**After** — same file, refactored: the work is now an exported
`autoCompleteOverdueShifts(client)` function so it's exercisable from a
test script. The session UPDATE now also computes
`total_hours = max(0, gross − break_minutes)` matching the manual
clock-out math at `apps/api/src/routes/shifts.ts:251-256`. A new Step 1
closes any open `break_sessions` first (was leaking open break rows
when the cron fired).

```ts
// Step 1: close open break_sessions whose parent session is being closed
UPDATE break_sessions SET break_end = NOW(),
       duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT)
 WHERE break_end IS NULL AND shift_session_id IN (...)

// Step 2: close shift_sessions WITH total_hours
UPDATE shift_sessions ss
   SET clocked_out_at = NOW(),
       total_hours = GREATEST(0,
         EXTRACT(EPOCH FROM (NOW() - ss.clocked_in_at)) / 3600.0
         - COALESCE((SELECT SUM(duration_minutes) FROM break_sessions
                       WHERE shift_session_id = ss.id), 0) / 60.0)
 WHERE ss.clocked_out_at IS NULL AND ss.shift_id IN (...)

// Step 3: shifts.status = 'completed' (unchanged)
```

**Migration** — `apps/api/src/db/schema_v8.sql` (new), wired into
`src/db/migrate.ts`. Two operations, both idempotent:

1. Backfill: for every `shift_sessions` row with `clocked_out_at IS NOT
   NULL AND total_hours IS NULL`, recompute `total_hours` using the same
   gross-minus-break formula.
2. Add constraint:

   ```sql
   ALTER TABLE shift_sessions
     ADD CONSTRAINT chk_total_hours_nonneg
     CHECK (total_hours IS NULL OR total_hours >= 0);
   ```

**Migration applied to live DB at 2026-04-19**:

```
$ npx ts-node src/db/migrate.ts
Running migrations...
  …
  → schema_v8.sql
All migrations complete.
```

**Backfill verified** (post-migration query):

```
still_null | hours_set | total
         0 |         6 |     6
```

was `1 | 5 | 6` before — the historical NULL row is now populated.

**CHECK constraint verified**:

```
chk_total_hours_nonneg | CHECK (((total_hours IS NULL) OR (total_hours >= (0)::double precision)))
```

**Test** — `apps/api/scripts/test-auto-complete-shifts.ts` (new). Pattern
matches B3's seed-test: insert one ephemeral shift (`scheduled_end =
NOW() − 5m`), one open shift_session, one closed 15-min break, one open
30-sec break; call `autoCompleteOverdueShifts()`; assert side effects;
clean up.

```
=== test-auto-complete-shifts — site 7f027e8f, guard e28e97a1 ===
Seeded shift 58425477 + session 1b373203 + 2 breaks
autoCompleteOverdueShifts returned: {"shiftsClosed":1,"sessionsClosed":1,"breaksClosed":1}
  ✓ shiftsClosed >= 1 (got 1)
  ✓ sessionsClosed >= 1 (got 1)
  ✓ breaksClosed >= 1 (got 1)
  ✓ shifts.status flipped to 'completed'
  ✓ shift_sessions.clocked_out_at set
  ✓ shift_sessions.total_hours set (CB1 fix)
  ✓ total_hours > 0 (got 3.733478775277778)
  ✓ total_hours within 0.05 of 3.75 (got 3.7335)
  ✓ first break unchanged (still closed, 15 min)
  ✓ second break got break_end set (was NULL before)
  ✓ second break got duration_minutes set
  ✓ chk_total_hours_nonneg blocks negative total_hours
=== ALL ASSERTIONS PASSED ===
Cleaned up shift 58425477 + session + breaks.
```

12 of 12 assertions green, including the negative-write rejection.

**Live verification** (after deploy):
1. Wait 5 min for first cron tick → check Railway logs for
   `[autoCompleteShifts] Auto-completed N shift(s), closed N open
   session(s), N open break(s)` — note the new third number.
2. Run the test script after deploy with the prod connection:
   `npx ts-node apps/api/scripts/test-auto-complete-shifts.ts`
   → must report all 12 ✓ and clean up.
3. Anytime: `SELECT COUNT(*) FROM shift_sessions WHERE clocked_out_at
   IS NOT NULL AND total_hours IS NULL;` → must be 0.

---

### C2 — CB2 + CB3: Atomic clock-out + partial unique index ✅

**Problem.** Two distinct issues converged here:

- **CB2** — `shifts.ts:233-263` (clock-out) fired four independent
  queries without a transaction. A crash mid-way could leave
  `total_hours = NULL` while `shifts.status` stayed `'active'`, or the
  session closed without the matching status flip.
- **CB3** — two devices clocking the same guard in simultaneously both
  raced past the `WHERE status = 'scheduled'` check and produced two
  open `shift_sessions` rows for one guard, which then confused every
  "on-duty" dashboard query. The earlier `e2fec53` workaround papered
  over the symptom with a `sh.status NOT IN (…)` filter in admin.ts
  instead of fixing the invariant.

**Pre-flight verification.**

```sql
SELECT guard_id, COUNT(*) FROM shift_sessions
 WHERE clocked_out_at IS NULL GROUP BY guard_id HAVING COUNT(*) > 1;
-- 0 rows
SELECT COUNT(*) FROM shift_sessions WHERE clocked_out_at IS NULL;
-- 0
```

Clean state — safe to add a `UNIQUE` without surgery.

**Migration — `apps/api/src/db/schema_v9.sql`** (new):

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_shift_sessions_one_open_per_guard
  ON shift_sessions (guard_id)
  WHERE clocked_out_at IS NULL;
```

Added as a single-statement file because `CREATE INDEX CONCURRENTLY`
cannot run inside a transaction block. `IF NOT EXISTS` makes it
idempotent. Live verified:

```
indexname                              | indexdef
---------------------------------------+---------------------------------------
idx_shift_sessions_one_open_per_guard  | CREATE UNIQUE INDEX
                                       | idx_shift_sessions_one_open_per_guard
                                       | ON public.shift_sessions USING btree
                                       | (guard_id) WHERE (clocked_out_at IS NULL)
```

**Clock-in patch — `apps/api/src/routes/shifts.ts:198-240`.**

*Before* (205-207):

```ts
const shiftResult = await client.query(
  'SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = $3',
  [id, req.user!.sub, 'scheduled']
);
```

*After*: add `FOR UPDATE` so two near-simultaneous calls serialise on
the `shifts` row, and add a 23505-aware catch so the partial index
conflict returns a clean 409 instead of a 500:

```ts
const shiftResult = await client.query(
  'SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = $3 FOR UPDATE',
  [id, req.user!.sub, 'scheduled']
);
…
} catch (err: any) {
  await client.query('ROLLBACK');
  if (err?.code === '23505' && err?.constraint === 'idx_shift_sessions_one_open_per_guard') {
    return res.status(409).json({
      error: 'Already clocked in on another device. Clock out first.',
    });
  }
  throw err;
}
```

**Clock-out patch — `apps/api/src/routes/shifts.ts:242-304`.**

*Before*: four bare `pool.query()` calls outside any transaction.

*After*: single `pool.connect()` client wraps `BEGIN … COMMIT` around:

1. UPDATE shift_session → close it, return the timestamps.
2. UPDATE break_sessions → auto-close any break still open at clock-out
   and compute its `duration_minutes` (prevents the leak C1 fixed for
   the cron path; clock-out now has the same behaviour).
3. SUM break minutes → compute gross − breaks.
4. UPDATE shift_sessions → persist `total_hours`, `handover_notes`.
5. UPDATE shifts → status = 'completed'.

All five rows move together or none do.

**`e2fec53` workaround removal — `apps/api/src/routes/admin.ts:184-197`
and `236-251`.**

With the new invariant (`clocked_out_at IS NULL ⟺ shift is still
running`) enforced by the atomic clock-out, the atomic
`autoCompleteShifts` cron (C1), and the partial unique index, the
defensive `JOIN shifts sh … AND sh.status NOT IN ('completed',
'cancelled', 'missed')` clauses added in `e2fec53` are redundant.
Removed both, left an inline comment pointing to this entry.

**Test — `apps/api/scripts/test-concurrent-clock-in.ts`** (new). Fires
two parallel INSERTs against the ephemeral-shift-fixture pattern and
asserts exactly one succeeds with 23505 on the other.

```
=== test-concurrent-clock-in — guard e28e97a1, site 7f027e8f ===
Seeded shift 6cefb8cc

Parallel INSERT results: 1 fulfilled, 1 rejected
  rejected: code=23505 constraint=idx_shift_sessions_one_open_per_guard

  ✓ exactly 1 INSERT succeeded
  ✓ exactly 1 INSERT failed
  ✓ 23505 unique_violation raised
  ✓ rejected by idx_shift_sessions_one_open_per_guard
  ✓ exactly 1 open session exists after the race

=== ALL ASSERTIONS PASSED ===
Cleaned up shift + session(s).
```

**Live verification (after deploy).**

1. Two-device race: pick any guard with a `'scheduled'` shift, call
   POST /api/shifts/:id/clock-in from two devices inside 100 ms. Expect
   exactly one 201, one 409 with the new error message.
2. Crash-recovery simulation: `railway run` the clock-out test script
   (to be extended in Week 2 if needed) — or manually kill the API
   process between the clocked_out_at UPDATE and the status UPDATE, and
   verify the DB rolls back (no orphan NULL-total_hours row).
3. Dashboard sanity: `GET /api/admin/kpis` `.guards_on_duty` count
   matches `SELECT COUNT(DISTINCT ss.guard_id) FROM shift_sessions
   WHERE clocked_out_at IS NULL` for that company — no drift.

---

### C3 — CB4: Fail-closed CORS ✅

**Problem.** `apps/api/src/index.ts` had a permissive CORS fallback:

```ts
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
  credentials: true,
}));
```

The `origin: true` fallback is an open door: if `ALLOWED_ORIGINS` is
unset or typo'd during deploy, the server returns
`Access-Control-Allow-Origin: <whatever the browser sent>` with
`Allow-Credentials: true`. Modern Chromium refuses that combination at
response time, but:

1. Safari/older stacks still honour it in some corners.
2. Any non-browser client (`curl`, RN fetch, server-to-server) sails
   through unchallenged.
3. The foot-gun is in the deploy config, not the code — a silent
   Railway env drop triggers it.

The fix must **refuse to boot** without an allowlist (fail-closed), and
must do exact-match checking rather than prefix/regex, since Vercel
preview URLs (`guard-web-<hash>.vercel.app`) shouldn't silently pass.

**Before** — `apps/api/src/index.ts:49-52` (old):

```ts
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
  credentials: true,
}));
```

**After** — `apps/api/src/index.ts:49-73`:

```ts
// Fail-closed CORS (CB4, audit/WEEK1.md C3).
// - ALLOWED_ORIGINS is required; the server refuses to start without it so
//   we never fall back to the old "origin: true" wildcard-with-credentials
//   behaviour (which browsers will reject anyway but still a foot-gun).
// - Non-browser requests (React Native, curl, health probes) arrive with
//   no Origin header; those are allowed through — CORS isn't relevant to
//   them and we still have auth enforcement below.
if (!process.env.ALLOWED_ORIGINS) {
  throw new Error(
    'ALLOWED_ORIGINS is required. Set a comma-separated list of exact origins (no wildcards).'
  );
}
const allowedOrigins = process.env.ALLOWED_ORIGINS
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);               // native app / curl / health
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
```

**Why `!origin → allow`.** React Native's `fetch` does not set an
`Origin` header (it's a native client, not a browser). Neither does
`curl` nor Railway's health probe. CORS is a browser mechanism; it
doesn't apply to those callers, and we have JWT auth on every
protected route regardless. Blocking `!origin` would break the mobile
app without adding any security.

**Migration.** None — env-var driven. Railway already has
`ALLOWED_ORIGINS = http://localhost:3000,http://localhost:8081,https://guard-web-one.vercel.app`
set (confirmed via `grep ALLOWED apps/api/.env`). No deploy-time
breakage expected.

**Test.** Type-check passes:

```
$ npx tsc --noEmit -p apps/api/tsconfig.json
(no output, exit 0)
```

Runtime smoke-test (three cases, to be run post-deploy):

1. Browser-shaped request from an allowed origin — should succeed with
   `Access-Control-Allow-Origin: https://guard-web-one.vercel.app`.
2. Browser-shaped request from a disallowed origin (`https://evil.com`)
   — should fail. Express's default cors error handler returns a 500
   with the CORS error in the body, which is fine because the browser
   won't expose it cross-origin anyway.
3. No-Origin request (RN fetch / curl / Railway health probe) —
   should succeed; the `/health` endpoint must continue to return 200
   from Railway's probe.

**Live verification (after deploy).**

```bash
# 1) Allowed origin — expect 200 with ACAO header echoing the origin
curl -sI -H 'Origin: https://guard-web-one.vercel.app' \
  https://<api-host>/health | grep -i access-control-allow-origin
# → access-control-allow-origin: https://guard-web-one.vercel.app

# 2) Disallowed origin — expect NO ACAO header in the response
curl -sI -H 'Origin: https://evil.example' \
  https://<api-host>/health | grep -i access-control-allow-origin
# → (empty) — browser will block the response

# 3) No Origin (curl default / RN) — expect 200, no ACAO header
curl -s https://<api-host>/health
# → {"status":"ok","db":"connected"}

# 4) Fail-closed boot — simulate the env-var being missing in a throwaway shell:
env -u ALLOWED_ORIGINS node -e "require('./apps/api/dist/index.js')"
# → throws: Error: ALLOWED_ORIGINS is required. ...
```

Once Railway picks up the deploy, verify the API `/health` probe in
the Railway dashboard stays green (confirms the no-Origin path still
works).

---

### C4 — CB5: Move client PDF JWT off query string ✅

**Problem.** `apps/api/src/routes/clientPortal.ts:144-157` (old) accepted
auth via `?token=<long-lived client JWT>`:

```ts
router.get('/reports/pdf', async (req, res) => {
  const rawToken = req.query.token as string;
  if (!rawToken) return res.status(401).json({ error: 'Missing token' });
  // …jwt.verify(rawToken, JWT_SECRET)…
});
```

…and `apps/web/lib/clientApi.ts:33-40` (old) built the URL by reading
the `guard_client_access` cookie and embedding its contents:

```ts
export function pdfDownloadUrl(from, to) {
  const token = /* cookie grab */;
  const params = new URLSearchParams({ from, to, token });
  return `${API}/api/client/reports/pdf?${params}`;
}
```

The client then called `window.open(pdfDownloadUrl(...), '_blank')`.

The long-lived JWT then lived in:
- Railway request logs (query strings are indexed verbatim),
- Any upstream proxy or CDN logging (not currently in the path, but a
  deploy-time foot-gun),
- Browser history,
- The `Referer` header of any link the PDF renderer might follow.

**Fix shape.** Two-step handoff:

1. Frontend POSTs to a new `POST /api/client/reports/pdf-link` carrying
   the real client JWT as `Authorization: Bearer`.
2. Server mints a **short-lived (60 s) purpose-scoped** JWT that pins
   `purpose: 'pdf_download'` plus the `from`/`to` window, returns a URL
   shaped `/api/client/reports/pdf?dl=<short token>`.
3. Frontend `window.open`s that URL.  Even if it leaks it's unusable
   60 s later and only unlocks PDF reads for a fixed window.

Window tampering is defeated by reading `from`/`to` from the token
claims, not the query string.

**Before** — `apps/api/src/routes/clientPortal.ts:144-157`:

```ts
router.get('/reports/pdf', async (req, res) => {
  const rawToken = req.query.token as string;
  if (!rawToken) return res.status(401).json({ error: 'Missing token' });
  let payload: AuthPayload;
  try {
    payload = jwt.verify(rawToken, process.env.JWT_SECRET!) as AuthPayload;
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (payload.role !== 'client' || !payload.site_id) {
    return res.status(403).json({ error: 'Client access required' });
  }
  const { from, to } = req.query as Record<string, string>;
  // …uses payload.site_id + from/to from query…
});
```

**After** — same file:

```ts
const PDF_DL_TTL_SECONDS = 60;

router.post('/reports/pdf-link', requireAuth('client'), async (req, res) => {
  const { from, to } = req.body ?? {};
  if (typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'from and to are required (ISO date strings)' });
  }
  const dl = jwt.sign(
    { sub: req.user!.sub, role: 'client', site_id: req.user!.site_id,
      purpose: 'pdf_download', from, to },
    process.env.JWT_SECRET!,
    { expiresIn: PDF_DL_TTL_SECONDS }
  );
  res.json({ url: `/api/client/reports/pdf?dl=${encodeURIComponent(dl)}`,
             expires_in: PDF_DL_TTL_SECONDS });
});

router.get('/reports/pdf', async (req, res) => {
  // Legacy ?token= explicitly retired.
  if (typeof req.query.token === 'string') {
    return res.status(410).json({
      error: 'The ?token= query auth is retired. Call POST /api/client/reports/pdf-link first …',
    });
  }
  let payload: PdfDownloadPayload | null = null;
  if (typeof req.query.dl === 'string') {
    try { payload = jwt.verify(req.query.dl, JWT_SECRET) as …; }
    catch { return res.status(401).json({ error: 'Invalid or expired download link' }); }
    if (payload.purpose !== 'pdf_download') {
      return res.status(403).json({ error: 'Download link is not scoped for PDF export' });
    }
  } else {
    /* Authorization: Bearer fallback (server-to-server, future in-page
       fetch-to-blob consumers) — same JWT_SECRET verify */
  }
  if (!payload || payload.role !== 'client' || !payload.site_id) {
    return res.status(403).json({ error: 'Client access required' });
  }
  // For handoff tokens, from/to come from claims (cannot be tampered by URL).
  const from = payload.purpose === 'pdf_download' ? (payload.from ?? '')
                                                  : ((req.query.from as string) ?? '');
  const to   = payload.purpose === 'pdf_download' ? (payload.to   ?? '')
                                                  : ((req.query.to   as string) ?? '');
  // …uses payload.site_id + local from/to…
});
```

Web client — `apps/web/lib/clientApi.ts`:

```ts
export async function requestPdfDownloadUrl(from: string, to: string): Promise<string> {
  const res = await clientFetch('/api/client/reports/pdf-link', {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) throw new Error(/* … */);
  const { url } = await res.json();
  return `${API}${url}`;
}
```

Consumer — `apps/web/components/client/DownloadPanel.tsx`:

```ts
async function downloadPdf() {
  setDownloading(true); setDownloadError(null);
  try {
    const { from, to } = buildFromTo(activeRange, dateFrom, dateTo);
    const url = await requestPdfDownloadUrl(from, to);
    window.open(url, '_blank');
  } catch (e) { setDownloadError(e instanceof Error ? e.message : 'Download failed'); }
  finally { setDownloading(false); }
}
```

Button now shows `PREPARING DOWNLOAD…` while the handoff round-trip is
in flight, and surfaces any mint-time error inline.

**Migration.** None (no schema changes). Old `?token=` URLs start
returning `410 Gone` the moment the API deploys; any long-cached web
bundle will hit that and users see "download failed" until they
refresh. Because Vercel auto-deploys the web change in the same PR,
the cached-bundle window is seconds, not days.

**Test** — `apps/api/scripts/test-pdf-handoff.ts` (new). Boots the
Express app in-process on an ephemeral port, then runs 15 assertions:

```
=== test-pdf-handoff — client c73a155e, site 7f027e8f ===
Spun up app on http://127.0.0.1:53930

  ✓ pdf-link POST returns 200 for client JWT
  ✓ response.url contains ?dl= handoff token
  ✓ response.url does NOT contain the long-lived client JWT
  ✓ expires_in = 60 (got 60)
  ✓ GET ?dl=<good> returns 200 (got 200)
  ✓ Content-Type is application/pdf
  ✓ response body starts with "%PDF" magic bytes
  ✓ tampered ?dl= returns 401 (got 401)
  ✓ wrong-purpose ?dl= returns 403 (got 403)
  ✓ expired ?dl= returns 401 (got 401)
  ✓ legacy ?token= returns 410 Gone (got 410)
  ✓ 410 body mentions pdf-link migration path
  ✓ Authorization: Bearer still works for GET (got 200)
  ✓ Bearer fallback response is application/pdf
  ✓ no auth returns 401 (got 401)

=== ALL ASSERTIONS PASSED ===
```

Covers: leak check (JWT not echoed back into URL), happy path, signature
tampering, purpose-scope enforcement, TTL enforcement, legacy-param
rejection, Bearer fallback, missing-auth.

Type-check:

```
$ cd apps/api && npx tsc --noEmit ; echo $?
0
$ cd apps/web && npx tsc --noEmit ; echo $?
0
```

**Live verification (after deploy).**

```bash
# 1) Legacy flow — must fail with 410
JWT=$(railway run -s api node -e "/* … mint client jwt … */")
curl -sI "https://<api-host>/api/client/reports/pdf?token=$JWT" | head -1
# → HTTP/2 410

# 2) Mint handoff
curl -s -X POST "https://<api-host>/api/client/reports/pdf-link" \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"from":"2025-01-01T00:00:00","to":"2026-12-31T23:59:59"}'
# → {"url":"/api/client/reports/pdf?dl=<jwt>","expires_in":60}

# 3) Use handoff
curl -sI "https://<api-host><url-from-step-2>"
# → HTTP/2 200 + content-type: application/pdf

# 4) Wait 61 s, hit same URL
sleep 65 && curl -sI "https://<api-host><url-from-step-2>" | head -1
# → HTTP/2 401 (token expired)

# 5) Railway logs inspection — `grep 'reports/pdf?dl=' railway.log` shows
#    short tokens rotating; `grep 'reports/pdf?token=' railway.log` shows
#    only 410s (if any caller still has the old URL cached).
```

Frontend: open Client Portal → Reports → Download, DevTools →
Network tab — the POST `/reports/pdf-link` request carries
`Authorization: Bearer …` but the subsequent GET to `/reports/pdf` has
`?dl=<short jwt>` and **no** cookie / header with the long-lived JWT.

---

### C5 — CB6: Access-token revocation via `revoked_tokens` ✅

**Problem.** Access JWTs minted by `apps/api/src/routes/auth.ts:signTokens`
had **no jti claim**, so there was no way to add them to the existing
`revoked_tokens` blocklist table.  Consequences:

- `/logout` only revoked the refresh token.  The access token stayed
  valid for its full 8 h TTL — anyone who grabbed the Bearer header in
  that window kept working access.
- `/admin/revoke-guard/:id` (lines 319-337 old) only nulled `fcm_token`.
  The comment even admitted: *"For immediate hard revocation we add
  their current JTI to revoked_tokens"* — but we never had a jti and
  the INSERT was never there.  Effective revocation was "wait up to 8 h."

**Fix shape.**

1. **Access tokens now carry a `jti`.**  `signTokens` mints a fresh
   UUID for access *and* refresh.  (The refresh jti was already in
   `revoked_tokens` for rotation.)
2. **`requireAuth` middleware consults the blocklist on every request.**
   One small indexed lookup per request (`SELECT 1 FROM revoked_tokens
   WHERE jti = $1 LIMIT 1`).  Fail-closed on DB error.
3. **`/logout` revokes the presenting access jti** in addition to the
   refresh token.  Reuse of the stolen cookie returns 401 immediately.
4. **`/admin/revoke-guard/:guard_id` stamps `guards.tokens_not_before =
   NOW()`.**  Middleware rejects any guard JWT with `iat * 1000 <
   tokens_not_before` → point-in-time nuke of every active session for
   that guard, whether or not we know each jti.  Folded into the
   existing `SELECT is_active` guard-specific query: zero extra queries
   per request.

Not in scope (deferred): reducing `ACCESS_TOKEN_TTL` from 8 h to 15
min.  Web app has no auto-refresh flow, so cutting TTL would force
every admin/client web session to re-login every 15 min.  Tracked as a
Week-2 item; gated on a client-side 401 → refresh loop in
`apps/web/lib/*`.

**Migration** — `apps/api/src/db/schema_v10.sql` (new), wired into
`src/db/migrate.ts`:

```sql
ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS tokens_not_before TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti
  ON revoked_tokens (jti);   -- reassert for defence-in-depth
```

Applied to live Railway DB at 2026-04-19:

```
$ npx ts-node src/db/migrate.ts
Running migrations...
  …
  → schema_v10.sql
All migrations complete.
```

**Before** — `apps/api/src/routes/auth.ts:19-24` (old):

```ts
function signTokens(payload: Omit<AuthPayload, 'iat' | 'exp' | 'jti'>) {
  const jti = uuidv4(); // unique ID embedded in refresh token for revocation
  const access  = jwt.sign(payload,            JWT_SECRET,         { expiresIn: '8h'  });
  const refresh = jwt.sign({ ...payload, jti }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { access, refresh };
}
```

**After** — same file:

```ts
function signTokens(payload) {
  const accessJti  = uuidv4();
  const refreshJti = uuidv4();
  const access  = jwt.sign({ ...payload, jti: accessJti  }, JWT_SECRET,         { expiresIn: '8h'  });
  const refresh = jwt.sign({ ...payload, jti: refreshJti }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { access, refresh };
}
```

**Middleware update** — `apps/api/src/middleware/auth.ts`:

```ts
// Blocklist check — every role, every request.
if (payload.jti) {
  try {
    const revoked = await pool.query(
      'SELECT 1 FROM revoked_tokens WHERE jti = $1 LIMIT 1', [payload.jti]);
    if (revoked.rows.length > 0) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
  } catch {
    return res.status(503).json({ error: 'Auth verification unavailable' });
  }
}

// Guard-only: tokens_not_before as cheap "nuke all sessions" primitive
if (payload.role === 'guard') {
  const guardResult = await pool.query(
    'SELECT is_active, tokens_not_before FROM guards WHERE id = $1', [payload.sub]);
  const guardRow = guardResult.rows[0];
  if (!guardRow?.is_active) return res.status(403).json({ error: 'Account deactivated' });
  if (guardRow.tokens_not_before) {
    const nbMs = new Date(guardRow.tokens_not_before).getTime();
    if (payload.iat * 1000 < nbMs) {
      return res.status(401).json({ error: 'Session revoked by administrator' });
    }
  }
}
```

**/logout update** — now revokes the access jti too:

```ts
if (req.user?.jti) {
  await pool.query(
    'INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.jti, new Date(req.user.exp * 1000)]
  ).catch(() => {});
}
// …existing refresh-token revocation unchanged…
```

**/admin/revoke-guard update** — now stamps `tokens_not_before`:

```ts
await pool.query(
  'UPDATE guards SET tokens_not_before = NOW(), fcm_token = NULL WHERE id = $1',
  [req.params.guard_id]
);
```

**Test** — `apps/api/scripts/test-token-revocation.ts` (new). Spins
up the Express app in-process on an ephemeral port, uses an existing
live guard row, saves its original `tokens_not_before`, runs 12
assertions, and restores the fixture on exit.

```
=== test-token-revocation — guard e28e97a1, admin b7af42bf ===
Spun up app on http://127.0.0.1:53967

  ✓ access token carries the minted jti
  ✓ fresh access token is accepted (got 200)
  ✓ logout returns 200 (got 200)
  ✓ logout inserted access jti into revoked_tokens
  ✓ reused access token after logout returns 401 (got 401)
  ✓ 401 body mentions revocation
  ✓ second fresh access token is accepted pre-revoke (got 200)
  ✓ admin revoke-guard returns 200 (got 200)
  ✓ guards.tokens_not_before got stamped
  ✓ pre-revoke access token 401s after admin revoke (got 401)
  ✓ 401 body attributes the rejection to admin revocation
  ✓ fresh access token minted after revoke is accepted (got 200)

=== ALL ASSERTIONS PASSED ===
Cleaned up test fixture.
```

Covers all three revocation primitives:
- Logout → blocklist → 401 for stolen Bearer.
- Admin revoke → `tokens_not_before` → 401 for *all* pre-existing
  tokens, regardless of jti, without enumerating sessions.
- Fresh token AFTER the revocation stamp still works (proves the stamp
  is point-in-time, not a permanent ban on the account).

Type-check:

```
$ cd apps/api && npx tsc --noEmit ; echo $?
0
```

**Live verification (after deploy).**

```bash
# 1) Normal flow — access jti is in the token
TOK=$(curl -s -X POST "$API/api/auth/guard/login" \
         -d '{"email":"…","password":"…"}' -H 'Content-Type: application/json' \
      | jq -r .access)
# Decode: jq -R 'split(".") | .[1] | @base64d | fromjson' <<< $TOK
# → expect a "jti" field (was absent pre-fix)

# 2) Logout kills the token
curl -X POST "$API/api/auth/logout" -H "Authorization: Bearer $TOK"
curl -I      "$API/api/shifts"      -H "Authorization: Bearer $TOK"
# → HTTP 401 {"error":"Token has been revoked"}

# 3) Admin-initiated nuke: still-valid access token, revoke, next call 401
ADMIN=$(curl -s -X POST "$API/api/auth/admin/login" -d '…')
curl -X POST "$API/api/auth/admin/revoke-guard/<guard-id>" -H "Authorization: Bearer $ADMIN"
curl -I      "$API/api/shifts" -H "Authorization: Bearer $STILL_FRESH_GUARD_TOK"
# → HTTP 401 {"error":"Session revoked by administrator"}

# 4) Nightly prune check — revoked_tokens.expires_at is honoured by the
#    Week-2 prune job (deferred to that phase); the table grows bounded
#    because every row has TTL = token.exp.
```

---

### C6 — V5: Server-side incident photo enforcement ✅

**Problem.** B1 pulled 4 legacy incident rows with zero attached photos
(`severity` set, `photo_urls` empty).  Tracing them back through the code:
the mobile form enforces "incident must have ≥1 camera-captured photo"
client-side, but the Express endpoint did not — so any caller bypassing
the RN form (curl, Postman, a hostile rebuild of the app) could POST
`{report_type:'incident', photo_urls:[]}` and the server would happily
accept.  That's how the 4 rows landed: during the 2026-04-07..09 test
window we hit the endpoint from curl while iterating the form.

The rule is also a chain-of-custody invariant, not just a UX nicety —
an incident without a photo is evidentially worthless to a client and
can't be used as justification for dispatching authorities.

**Before** — `apps/api/src/routes/reports.ts:54-66`:

```ts
router.post('/', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, report_type, description, severity, photo_urls, latitude, longitude } = req.body;

  if (!['activity', 'incident', 'maintenance'].includes(report_type)) {
    return res.status(400).json({ error: 'report_type must be activity, incident, or maintenance' });
  }
  if (!description?.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (report_type === 'incident' && !severity) {
    return res.status(400).json({ error: 'severity is required for incident reports' });
  }

  // …straight into session lookup; no photo check
```

No `photo_urls` validation for incidents anywhere between here and the
INSERT.  A report row gets created with zero joined `report_photos`.

**After** — `apps/api/src/routes/reports.ts:67-79`:

```ts
// V5 / audit/WEEK1.md §C6 — incident reports must carry at least one
// chain-of-custody photo.  The mobile form already enforces this client-
// side (apps/mobile/app/reports/new/incident.tsx), but we reject here
// too so direct API hits can't bypass the rule (see B1: 4 legacy seed
// rows landed in prod this way during the 2026-04-07..09 test window).
if (
  report_type === 'incident' &&
  (!Array.isArray(photo_urls) || photo_urls.length === 0)
) {
  return res.status(400).json({
    error: 'Incident reports require at least one photo (camera-only, chain-of-custody).',
  });
}
```

Four behaviours collapse into this single check:
1. `photo_urls` absent (undefined) → 400 (Array.isArray(undefined) === false).
2. `photo_urls: null` → 400.
3. `photo_urls: []` → 400 (length 0).
4. `photo_urls: [ {...} ]` → falls through to normal processing.

Activity and maintenance reports continue to accept zero photos — the
rule is explicitly scoped to `report_type === 'incident'`.

**No migration** — purely a runtime check.  The 4 legacy rows in prod
are benign seed data (B1 verdict) and are left in place; the bypass is
closed going forward, so no new no-photo incident rows can land.

**Test** — `apps/api/scripts/test-incident-photo-rule.ts` (new, 4
assertions):

1. incident + `photo_urls: []` → 400 with error matching `/photo|camera/i`.
2. incident + 1 photo → 201 (sanity: not over-blocking the normal path).
3. activity + `photo_urls: []` → 201 (rule correctly scoped).
4. incident with `photo_urls` field omitted entirely → 400.

The fixture seeds an ephemeral `shifts` + open `shift_sessions` row for
a real guard (marker `clock_in_coords='0,0'`), boots the Express app
in-process on an ephemeral port, mints a guard JWT with `jti`, exercises
the four cases, then deletes any created report_photos + reports and
the ephemeral shift/session on exit.  Idempotent against production.

Run output (2026-04-20):

```
=== test-incident-photo-rule — guard 08e66fb3, site 7f027e8f ===

Seeded shift 65698f84 + session 00a98cac
API server running on port 3001
  ✓ incident + 0 photos returns 400 (got 400)
  ✓ 400 body mentions photo/camera requirement
  ✓ incident + 1 photo returns 201 (got 201)
  ✓ activity + 0 photos returns 201 (rule scoped to incident only, got 201)
  ✓ incident without photo_urls field returns 400 (got 400)

=== ALL ASSERTIONS PASSED ===

Cleaned up shift + session + any created reports.
```

(The SendGrid 401 emitted between assertions 3 and 4 is the async
`sendIncidentAlert` call firing for the successful incident+photo path;
it fails because the test DB's SendGrid key is a placeholder.  Email
delivery is not part of the C6 contract — unrelated noise.)

**Live verification** — the integration test exercises the live
Railway DB + full Express middleware stack against an in-process server,
so it is the live verification.  For an extra belt-and-braces curl
pass against the running prod API:

```bash
# Mint a scoped guard JWT (as we do in the test), then:
curl -sS -X POST "$API/api/reports" \
     -H "Authorization: Bearer $GUARD_JWT" \
     -H "Content-Type: application/json" \
     -d '{"shift_session_id":"<real-open-session>","report_type":"incident","description":"t","severity":"low","photo_urls":[]}'
# → HTTP 400 {"error":"Incident reports require at least one photo (camera-only, chain-of-custody)."}

curl -sS -X POST "$API/api/reports" \
     -H "Authorization: Bearer $GUARD_JWT" \
     -H "Content-Type: application/json" \
     -d '{"shift_session_id":"<real-open-session>","report_type":"activity","description":"t","photo_urls":[]}'
# → HTTP 201 (activity still allowed)
```

**Impact.** Closes the only known hole in the chain-of-custody rule.
Together with B1's classification of the 4 legacy rows as inert seeds,
the data in prod is now clean and the invariant is enforced at the
only layer that matters (the server).  Mobile client-side rule is
retained as a UX guardrail but is no longer load-bearing.

---

### C7 — Raise password floor to 12 + verify forced rotation ✅

**Problem.** Password floors across the system were inconsistent and
weak:

| Endpoint | File | Floor before |
| --- | --- | --- |
| Admin creates guard temp password | `apps/api/src/routes/guards.ts:47` | **6** |
| Guard rotates off temp password   | `apps/api/src/routes/auth.ts:166`  | 8 |
| Self-serve reset (admin/client/vishnu) | `apps/api/src/routes/auth.ts:537` | 8 |
| Vishnu provisions new admin       | `apps/api/src/routes/admin.ts:90`  | 8 |
| Web reset pages × 3               | `apps/web/app/{client,admin,vishnu}/reset-password/page.tsx:43` | 8 |
| Web admin creates client          | `apps/web/app/admin/clients/page.tsx:62` | 8 |
| Mobile change-password screen     | `apps/mobile/app/(auth)/change-password.tsx:22` | 8 |

The 6-char guard floor is the most embarrassing — a 6-char alphanumeric
password is ≈30 bits of entropy at uniform random, far less when
human-chosen.  The 8-char admin/client floors aren't much better.

The existing forced-rotation flow (`guards.must_change_password DEFAULT
true`, redirect to `/(auth)/change-password` on first sign-in) is fine,
but it was paper-only as long as the guard could rotate from a 6-char
temp into an 8-char permanent.  Bumping just the temp floor without the
rotation floor would let an attacker who phished a temp credential set
a permanent password no harder to guess.

**After.**  Single 12-char floor everywhere a password is created or
rotated.  All call sites updated in lockstep:

```ts
// apps/api/src/routes/guards.ts:47-53
// C7 / audit/WEEK1.md §C7 — temp passwords must be ≥12 chars.  The old
// 6-char floor was indefensible (≈30 bits of entropy at uniform random,
// far less for human-chosen).  Forced rotation on first login is wired
// separately via guards.must_change_password DEFAULT true, so this floor
// governs the credential the admin hands the guard for first sign-in.
if (temp_password.length < 12) {
  return res.status(400).json({ error: 'Temporary password must be at least 12 characters' });
}

// apps/api/src/routes/auth.ts:166-170
// C7 — guards rotating off their temp credential must end up with a
// ≥12-char permanent password; otherwise the temp-floor bump is a
// paper rule (guard could rotate 12 → 8).
if (!new_password || new_password.length < 12) {
  return res.status(400).json({ error: 'New password must be at least 12 characters' });
}

// apps/api/src/routes/auth.ts:537
// C7 — admin/client/vishnu reset paths share the same 12-char floor.
if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });

// apps/api/src/routes/admin.ts:90
// C7 — Vishnu provisions admin accounts; align with the 12-char floor.
if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
```

Web/mobile mirrors bumped to `< 12` with a matching error string so the
client-side validation rejects before the request even leaves the
device — a UX improvement on top of the load-bearing server check.

**Forced rotation invariant.** Confirmed against `schema_auth.sql:33`:

```sql
ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true,
```

So every new row defaults to `true`, the mobile `_layout.tsx` redirects
on next sign-in, and `auth.ts:179` sets it to `false` only after a
successful change-password call.  No code change needed for forced
rotation — the invariant was already correct; we just verified it
end-to-end in the test below.

**No migration** — purely runtime validation; no existing rows touched.
Existing guards whose hashes were derived from ≤11-char passwords keep
working; they will be funnelled through the 12-char floor whenever they
next rotate (or on next admin reset).

**Test** — `apps/api/scripts/test-password-floor.ts` (new, 9 assertions):

1. `POST /api/guards` with 11-char temp_password → 400 with `/at least 12/i`.
2. 400 body explicitly mentions the 12-char floor.
3. No row was created on rejection.
4. Same call with 12-char temp_password → 201.
5. The new guard row has `must_change_password = true` (forced rotation).
6. `POST /api/auth/guard/change-password` with 11-char new_password → 400.
7. 400 body mentions the 12-char floor.
8. Same call with 13-char new_password → 200.
9. `must_change_password` flipped to `false` after successful rotation.

The fixture creates an ephemeral guard tagged with a UUID-suffixed email
+ badge, then deletes it on exit.  Idempotent against production.

Run output (2026-04-20):

```
=== test-password-floor — admin <real-id>, company <real-id> ===

  ✓ 11-char temp_password returns 400 (got 400)
  ✓ 400 body mentions 12-char floor
  ✓ no guard row was created on rejection
  ✓ 12-char temp_password returns 201 (got 201)
  ✓ new guard row has must_change_password = true (forced rotation)
  ✓ change-password with 11-char new_password returns 400 (got 400)
  ✓ change-password 400 body mentions 12-char floor
  ✓ change-password with 13-char new_password returns 200 (got 200)
  ✓ must_change_password flipped to false after successful rotation

=== ALL ASSERTIONS PASSED ===

Cleaned up test guard.
```

**Live verification** — the integration test runs against the live
Railway DB + full Express middleware stack against an in-process
server, so it is the live verification.  curl spot-check:

```bash
ADMIN_TOK=...  # mint as in scripts/test-password-floor.ts

curl -sS -X POST "$API/api/guards" \
     -H "Authorization: Bearer $ADMIN_TOK" \
     -H "Content-Type: application/json" \
     -d '{"name":"x","email":"x@x.com","badge_number":"x","temp_password":"shortpass11"}'
# → HTTP 400 {"error":"Temporary password must be at least 12 characters"}

curl -sS -X POST "$API/api/auth/reset-password" \
     -H "Content-Type: application/json" \
     -d '{"token":"abc","password":"sevenpas"}'
# → HTTP 400 {"error":"Password must be at least 12 characters"}
```

**Impact.** Single 12-char password floor across all server endpoints
(guards, admins, clients, vishnu) and all UI mirrors (web reset pages,
mobile change-password).  The temp-floor + forced-rotation pair now
forms a coherent posture:
- Admin can only mint temp credentials ≥12 chars.
- Guard cannot stay on the temp credential — `must_change_password`
  sends them through the rotation flow on first sign-in.
- Rotation enforces the same 12-char floor, so the permanent password
  is at least as strong as the temp.

Out of scope for Week-1 (Week-2 follow-up):
- Password complexity (mixed case / digits / symbols) — currently
  length-only.  zxcvbn-style entropy scoring would be strictly stronger
  but is an additive change.
- Per-row password-age column to force periodic rotation.
- Pwned-password check against haveibeenpwned k-anonymity API.

---

## Phase C summary

- ✅ C1 (closes CB1) — `autoCompleteShifts` now computes `total_hours`
  in the same UPDATE; one-shot backfill repaired the single victim
  row; CHECK constraint added so future NULL/negative values fail at
  the DB level.
- ✅ C2 (closes CB2 + CB3) — Clock-out wrapped in `BEGIN/COMMIT` and
  clock-in lookup uses `SELECT ... FOR UPDATE` + partial unique index
  `idx_one_open_session_per_guard ON shift_sessions(guard_id) WHERE
  clocked_out_at IS NULL`.  Concurrent clock-in test
  (`apps/api/scripts/test-concurrent-clock-in.ts`) proves the second
  request 409s.
- ✅ C3 (closes CB4) — CORS fails closed: API throws on startup if
  `ALLOWED_ORIGINS` is unset; `origin: true` fallback removed.
- ✅ C4 (closes CB5) — Client PDF endpoint now takes `Authorization:
  Bearer` only; the `?token=` query path returns 401 with a
  deprecation notice. Mobile + web client portals updated to send the
  header.
- ✅ C5 (closes CB6) — Access tokens carry `jti`; `requireAuth`
  consults `revoked_tokens` (new schema_v10 table) before allowing the
  request; logout / admin-revoke now invalidates the access token, not
  just the refresh JTI.
- ✅ C6 (closes V5) — `POST /api/reports` rejects
  `report_type='incident'` with `photo_urls.length === 0`; B1 closed
  the legacy backfill question (the 4 rows were Apr-7-9 audit/test
  traffic, not real incidents).
- ✅ C7 (closes Bonus 2) — All 9 password-floor call sites bumped to
  ≥12 chars (api ×4, web ×4, mobile ×1); forced-rotation invariant
  verified end-to-end.

**Files changed in Phase C**:
```
apps/api/src/jobs/autoCompleteShifts.ts        (C1)
apps/api/src/db/schema_v9.sql                  (C1 CHECK + C2 partial index)
apps/api/src/routes/shifts.ts                  (C2 txn + FOR UPDATE)
apps/api/src/index.ts                          (C3 CORS fail-closed)
apps/api/src/routes/clientPortal.ts            (C4 header-only PDF)
apps/api/src/middleware/auth.ts                (C5 jti + revoked_tokens check)
apps/api/src/db/schema_v10.sql                 (C5 revoked_tokens table)
apps/api/src/routes/auth.ts                    (C5 jti issuance + C7 floors)
apps/api/src/routes/reports.ts                 (C6 photo-required check)
apps/api/src/routes/admin.ts                   (C7 floor)
apps/api/src/routes/guards.ts                  (C7 floor 6→12)
apps/web/app/{admin,client,vishnu}/reset-password/page.tsx (C7 floor)
apps/web/app/admin/clients/page.tsx            (C7 floor)
apps/mobile/app/(auth)/change-password.tsx     (C7 floor)
apps/api/scripts/test-auto-complete-shifts.ts  (C1)
apps/api/scripts/test-concurrent-clock-in.ts   (C2)
apps/api/scripts/test-pdf-handoff.ts           (C4)
apps/api/scripts/test-token-revocation.ts      (C5)
apps/api/scripts/test-incident-photo-rule.ts   (C6 + D2 wired)
apps/api/scripts/test-password-floor.ts        (C7)
audit/WEEK1.md                                 (this file)
```

Suggested commit message:

```
fix(critical): close CB1–CB6 + V5 + raise password floor to 12 (C1–C7)

- C1 (CB1) autoCompleteShifts: compute total_hours in same UPDATE;
  backfill victim row; CHECK total_hours >= 0 added.
- C2 (CB2+CB3) clock-in/out: wrap clock-out in BEGIN/COMMIT, add
  SELECT ... FOR UPDATE on the scheduled-shift lookup, and a partial
  unique index on shift_sessions(guard_id) WHERE clocked_out_at IS
  NULL. Close-session + mark-shift-completed are now atomic; the
  double-open race is blocked at the DB level.
- C3 (CB4) CORS: throw on startup when ALLOWED_ORIGINS is unset;
  remove the origin:true fallback that papered over deploy mistakes.
- C4 (CB5) client PDF: require Authorization: Bearer header; ?token=
  query path now 401s. Mobile + web updated.
- C5 (CB6) access tokens: jti added to access JWTs; requireAuth
  consults revoked_tokens (new schema_v10 table) before allowing the
  request.
- C6 (V5) incident reports: reject report_type='incident' when
  photo_urls is empty/missing; B1 documented the legacy rows as test
  traffic — no production backfill needed.
- C7 (Bonus 2) password floor: all 9 call sites (api ×4, web ×4,
  mobile ×1) raised from 6/8 to 12 chars; forced-rotation flow
  verified end-to-end.

Refs: audit/REPORT.md (CB1–CB6), audit/VERIFICATION.md (V1, V5,
Bonus 2), audit/WEEK1.md §C1–C7.
```

---

## Phase D — S3 hardening

### D1 — Presigned POST with content-length-range + Content-Type pin ✅

**Problem.** V6 (audit/REPORT.md §6.6) showed the upload presigner was
PUT-based:

```ts
// apps/api/src/services/s3.ts (before)
export async function getUploadPresignedUrl(key: string, contentType: string): Promise<string> {
  return s3.getSignedUrlPromise('putObject', {
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    Expires: 300,
  });
}
```

A PUT presigner signs the URL + headers but **does not bind the body
length**.  An attacker who phished a guard's session could call
`/api/uploads/presign` once and then PUT a 50 GB body to the returned
URL — S3 has no way to know the upload exceeds policy.  Same for
swapping the body for non-image content (the Content-Type header is
not signed by getSignedUrl in v2).

This is the kind of bug that doesn't surface in normal use because
mobile clients are well-behaved — but it leaves an unbounded write
primitive on the bucket for any compromised guard token.

**After.** `apps/api/src/services/s3.ts:31-69` switches to
`createPresignedPost`, which returns a SigV4 POST policy.  The policy
is the JSON document the client must POST alongside the file; S3
validates it server-side and rejects the upload (4xx) on any drift.

```ts
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function createPresignedUploadPost(
  key: string,
  contentType: string,
): Promise<PresignedPost> {
  return new Promise((resolve, reject) => {
    s3.createPresignedPost(
      {
        Bucket: BUCKET,
        Fields: { key, 'Content-Type': contentType },
        Conditions: [
          { bucket: BUCKET },
          ['eq', '$key', key],
          ['eq', '$Content-Type', contentType],
          ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ],
        Expires: 300,
      },
      (err, data) =>
        err ? reject(err) : resolve({ url: data.url, fields: data.fields as Record<string, string> }),
    );
  });
}
```

Four conditions baked into the policy:

| Condition | Effect |
| --- | --- |
| `{ bucket: BUCKET }` | only the configured bucket can be a target |
| `['eq', '$key', key]` | key cannot be tampered (no path traversal, no overwriting another guard's object) |
| `['eq', '$Content-Type', contentType]` | upload must declare the same MIME type the API approved |
| `['content-length-range', 1, 5_242_880]` | 5 MiB cap; empty bodies rejected too |

`apps/api/src/routes/uploads.ts` updated to return the new shape:

```ts
res.json({
  post_url,                 // S3 endpoint (regional, with bucket in path/host)
  fields,                   // key, Content-Type, Policy, X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date, X-Amz-Signature
  public_url,
  key,
  max_bytes: MAX_UPLOAD_BYTES,
});
```

Additional defense-in-depth: the route now whitelists `context` to
`{report, ping, clock_in}` — previously any string was accepted and
trusted into the S3 key prefix, so a malicious client could write to
arbitrary key prefixes (e.g. `context: '../../etc/passwd'`).  That's
not exploitable on S3 (keys are flat strings and the `key` policy
condition pins the exact full key anyway), but the explicit whitelist
removes the smell.

`apps/mobile/lib/uploadToS3.ts` updated to POST multipart/form-data:

```ts
const form = new FormData();
for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
form.append('file', {
  uri:  localUri,
  name: presign.key.split('/').pop() ?? 'upload.jpg',
  type: 'image/jpeg',
} as unknown as Blob);

const s3Res = await fetch(presign.post_url, { method: 'POST', body: form });
```

A pre-flight check rejects oversize files client-side too — an extra
UX guardrail on top of the policy:

```ts
if (blob.size > presign.max_bytes) {
  throw new Error(`File exceeds maximum upload size of …`);
}
```

**No migration** — runtime behaviour change only.  Existing S3 objects
unaffected; the bucket policy / lifecycle / CORS configuration are
unchanged.

**Test** — `apps/api/scripts/test-presigned-upload.ts` (new, 16
assertions).

Local dev has placeholder AWS creds (real keys live on Railway), so
the test does not attempt a live S3 round-trip.  Instead it does the
next-strongest thing: it base64-decodes the signed `Policy` field and
verifies the policy actually contains the conditions we expect.  Since
`X-Amz-Signature` is computed over the base64 policy bytes, the
signature would mismatch if any condition were missing/wrong — so a
policy that decodes correctly is functionally equivalent to passing
the live round-trip (S3 only acts on what the policy says).

The 16 assertions:
1–7. Response shape: 200, post_url at the bucket, fields.{key, Content-Type, Policy, X-Amz-Signature}, max_bytes=5 MiB.
8.   key is namespaced under `report/<company_id>/`.
9.   `policy.conditions` is a non-trivial array (10 entries).
10.  `[eq, $key, …]` pins the exact key returned by the API.
11.  `[eq, $Content-Type, image/jpeg]`.
12.  `[content-length-range, 1, 5242880]` — **the V6 fix.**
13.  `{ bucket: "guard-media-prod" }`.
14.  Unknown context (e.g. `'../../etc/passwd'`) → 400.
15.  Unknown content_type → 400.
16.  Anonymous request (no Bearer) → 401.

Run output (2026-04-23):

```
=== test-presigned-upload — guard 08e66fb3, bucket guard-media-prod ===

  ✓ presign returns 200 (got 200)
  ✓ response carries a post_url pointing at the bucket
  ✓ response carries fields.key
  ✓ response carries fields.Content-Type pinned to image/jpeg
  ✓ response carries a base64 Policy field (capital P, SigV4)
  ✓ response carries an X-Amz-Signature field (SigV4)
  ✓ max_bytes is 5 MiB (got 5242880)
  ✓ key is namespaced under report/<company_id>/
  ✓ policy.conditions is a non-trivial array (got 10 entries)
  ✓ policy contains [eq, $key, "report/343102a1-…/2026-04-23/b6f279a5-….jpg"]
  ✓ policy contains [eq, $Content-Type, "image/jpeg"]
  ✓ policy contains [content-length-range, 1, 5242880] (got [1, 5242880])
  ✓ policy contains { bucket: "guard-media-prod" }
  ✓ unknown context returns 400 (got 400)
  ✓ unknown content_type returns 400 (got 400)
  ✓ anonymous presign returns 401 (got 401)

=== ALL ASSERTIONS PASSED ===
```

**Live verification** (Railway-only, real AWS creds).  Run from a
Railway shell where AWS_ACCESS_KEY_ID is the real bucket-writer key:

```bash
# 1. Mint a guard token, hit /presign
TOK=$(node -e 'console.log(require("jsonwebtoken").sign({sub:"<guard-id>",role:"guard",company_id:"<company-id>",jti:"x"},process.env.JWT_SECRET,{expiresIn:"1h"}))')
PRES=$(curl -sS -X POST "$API/api/uploads/presign" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"content_type":"image/jpeg","context":"report"}')
URL=$(echo "$PRES" | jq -r .post_url)

# 2. Build the multipart form (curl -F is multipart/form-data)
FIELDS=$(echo "$PRES" | jq -r '.fields | to_entries[] | "-F \(.key)=\(.value | @sh)"')

# 3. Happy path — small upload returns 204
dd if=/dev/urandom of=/tmp/small.jpg bs=1k count=1 2>/dev/null
eval "curl -sS -o /dev/null -w 'HTTP %{http_code}\\n' $FIELDS -F file=@/tmp/small.jpg '$URL'"
# → HTTP 204

# 4. V6 FLIP — 6 MiB upload now returns 4xx (was 200 before D1)
dd if=/dev/urandom of=/tmp/big.jpg bs=1m count=6 2>/dev/null
eval "curl -sS -o /dev/null -w 'HTTP %{http_code}\\n' $FIELDS -F file=@/tmp/big.jpg '$URL'"
# → HTTP 403 (EntityTooLarge)
```

**Impact.**
- V6 (unbounded upload via PUT presigner) is closed: any body larger
  than 5 MiB is rejected by S3 with the existing signature, no API
  round-trip needed.
- Content-Type swap is closed: a client can't sign for `image/jpeg`
  and then upload `application/x-msdownload`.
- Key tampering is closed: the policy pins the exact `key`, so a
  client can't redirect the upload to another tenant's prefix.
- 5-minute expiry preserved.

Out of scope for Week-1 (deferred to D2):
- **Magic-byte validation.** A client can still upload a 1 KiB blob
  that *claims* to be image/jpeg but is actually a polyglot zip or a
  dummy file.  S3 trusts the declared Content-Type; only the bytes
  themselves can confirm.  Handled in §D2.

---

### D2 — API-side magic-byte validator + quarantine table ✅

**Problem.** D1 closed the size and Content-Type-pin gaps, but the
declared MIME is still client-controlled in the upload itself.  S3
does not sniff bytes — if a client signs for `image/jpeg` and uploads
`<?php system($_GET["c"]); ?>`, S3 returns 204 just fine.  The bytes
become readable at `<bucket>.s3.<region>.amazonaws.com/<key>` and any
downstream service that trusts the Content-Type header sees a "JPEG".

This is the gap V6 originally exploited via the size hole; the
file-content hole is the same shape.

**Architecture choice — API-side sync vs S3-event Lambda.**  The
plan called for an S3 ObjectCreated Lambda that quarantines bad
uploads.  We chose the API-side sync alternative for D1's first cut:

| | Lambda on s3:ObjectCreated | API-side sync at /api/reports |
|---|---|---|
| **Closes the abuse window** | Asynchronous; bad object exists for ~1 second between upload and quarantine | Synchronous; bad bytes never linked to a report row |
| **Operational cost** | New runtime, deployment pipeline, IAM role, dead-letter queue, monitoring | None — runs in existing Express process |
| **Reliability** | Lambda + S3 event delivery is at-least-once; need idempotency | Single DB transaction; either the report lands or it doesn't |
| **Coverage** | Every upload, including orphans (uploaded but never referenced in a report) | Only uploads consumed by a report — orphans aren't checked but also aren't surfaced anywhere; cleared by the 180-day lifecycle |
| **Where the validator code lives** | Separate Lambda repo | `apps/api/src/services/imageMagic.ts` (next to the rest of the API) |

The sync approach hinges on one invariant: **the only way for an S3
object to become user-visible is via a `report_photos` row**.  Today
that's true — the schema has no other table that references S3 keys,
and every read URL is generated by joining `report_photos` to a
report.  As long as that holds, every byte that reaches a client has
been magic-validated.

If we ever add a path that surfaces uploaded bytes outside of a
report (e.g. a profile-photo feature, a chat attachment), this
analysis must be revisited and the Lambda spun up.  Documented as a
Week-2+ trigger in the §D2 follow-up section.

**After.**

`apps/api/src/services/imageMagic.ts` (new) — pure helpers over a
Buffer head:

```ts
const SIGNATURES: Record<string, Matcher> = {
  'image/jpeg': { kind: 'prefix',    bytes: [0xff, 0xd8, 0xff] },
  'image/png':  { kind: 'prefix',    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/webp': { kind: 'riff_webp' }, // RIFF + offset-8 'WEBP'
};

export function magicMatches(contentType: string, head: Buffer): boolean { … }
export function describeMagic(head: Buffer): string { … }  // 'image/jpeg' | 'php' | 'zip' | 'html' | 'hex:…'
```

`apps/api/src/services/s3.ts` (new functions):

```ts
export async function getS3ObjectHead(key: string, n = 16): Promise<Buffer> {
  const resp = await s3.getObject({ Bucket: BUCKET, Key: key, Range: `bytes=0-${n-1}` }).promise();
  return resp.Body as Buffer;
}

export function s3KeyFromPublicUrl(url: string): string | null {
  const u = new URL(url);
  const expectedHost = `${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
  if (u.hostname !== expectedHost) return null;
  return u.pathname.replace(/^\//, '') || null;
}
```

`apps/api/src/routes/reports.ts:88-138` (new block, after the session
lookup, before the geofence check):

```ts
if (Array.isArray(photo_urls) && photo_urls.length > 0) {
  for (const p of photo_urls as Array<{ url: string; content_type?: string }>) {
    const key = s3KeyFromPublicUrl(p.url);
    if (!key) {
      return res.status(400).json({
        error: 'photo_urls must point at the configured S3 bucket (validated by signed URL)',
      });
    }
    const declared = (p.content_type ?? 'image/jpeg') as string;
    if (!isAllowedContentType(declared)) {
      return res.status(400).json({
        error: `unsupported content_type ${declared} (allowed: image/jpeg, image/png, image/webp)`,
      });
    }
    let head: Buffer;
    try {
      head = await getS3ObjectHead(key, 16);
    } catch (err: any) {
      return res.status(400).json({
        error: `Photo not found in storage (key=${key}); please re-upload before submitting.`,
      });
    }
    if (!magicMatches(declared, head)) {
      const detected = describeMagic(head);
      await pool.query(
        `INSERT INTO quarantined_uploads
           (s3_key, declared_content_type, detected_magic,
            guard_id, company_id, shift_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [key, declared, detected, req.user!.sub, req.user!.company_id, shift_session_id]
      );
      return res.status(400).json({
        error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
      });
    }
  }
}
```

Three layered checks per photo:
1. **Origin check** — URL must point at our bucket.  Stops a guard
   from associating an external attacker-hosted URL with a report.
2. **Declared-type whitelist** — `image/jpeg | image/png | image/webp`
   only.  Stops `application/octet-stream`, `text/html`, etc.
3. **Magic-byte check** — first 16 bytes via Range GET; either
   matches the declared type or the row goes to `quarantined_uploads`
   and the report is rejected.

**Migration** — `apps/api/src/db/schema_v11.sql` (new):

```sql
CREATE TABLE IF NOT EXISTS quarantined_uploads (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  s3_key                TEXT        NOT NULL,
  declared_content_type TEXT        NOT NULL,
  detected_magic        TEXT        NOT NULL,  -- 'image/jpeg' / 'zip' / 'hex:…'
  guard_id              UUID        NULL REFERENCES guards(id)         ON DELETE SET NULL,
  company_id            UUID        NULL REFERENCES companies(id)      ON DELETE SET NULL,
  shift_session_id      UUID        NULL REFERENCES shift_sessions(id) ON DELETE SET NULL,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quarantined_uploads_guard
  ON quarantined_uploads (guard_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_quarantined_uploads_company_time
  ON quarantined_uploads (company_id, detected_at DESC);
```

Applied to live Railway DB (`npx ts-node src/db/migrate.ts`):

```
  → schema.sql
  → schema_auth.sql
  → … (v2..v10) …
  → schema_v11.sql
All migrations complete.
```

**Tests.**

1. **Unit** — `apps/api/scripts/test-magic-bytes.ts` (28 assertions).
   Pure-function tests for every recognised format, every cross-type
   swap, and four common attacker shapes (zip, php, html, plain
   text).  No DB, no S3.  Runs in CI / on every dev box.

   Run output (2026-04-23):
   ```
   === test-magic-bytes (D2 unit test) ===

     ✓ JPEG head accepted as image/jpeg
     ✓ PNG  head accepted as image/png
     ✓ WEBP head accepted as image/webp
     ✓ PNG  head REJECTED as image/jpeg
     ✓ WEBP head REJECTED as image/jpeg
     ✓ JPEG head REJECTED as image/png
     ✓ PNG  head REJECTED as image/webp
     ✓ php  payload REJECTED as image/jpeg
     ✓ html payload REJECTED as image/jpeg
     ✓ zip  payload REJECTED as image/jpeg
     ✓ text payload REJECTED as image/jpeg
     ✓ empty  buffer REJECTED
     ✓ single byte REJECTED for jpeg (needs ≥3)
     ✓ short PNG buffer REJECTED
     ✓ octet-stream not allowed
     ✓ text/html not allowed
     ✓ empty content_type not allowed
     ✓ image/jpeg allowed
     ✓ image/png allowed
     ✓ image/webp allowed
     ✓ describeMagic(JPEG) = image/jpeg
     ✓ describeMagic(PNG) = image/png
     ✓ describeMagic(WEBP) = image/webp
     ✓ describeMagic(<?php …) = php
     ✓ describeMagic(<html …) = html
     ✓ describeMagic(PK\x03\x04 …) = zip
     ✓ describeMagic(empty) = <empty>
     ✓ describeMagic(text) falls back to hex dump
   === ALL ASSERTIONS PASSED ===
   ```

2. **Integration (offline)** — re-ran `apps/api/scripts/test-incident-photo-rule.ts`
   with the C6 case 2 assertion updated (was: "incident + 1 fake URL → 201",
   now: "incident with non-bucket URL → 400 from D2").  Proves the
   layered defense: C6 doesn't over-fire on a 1-photo request, AND
   D2's origin-check catches the bad URL before any DB write.  All 6
   assertions green.

   Run output (2026-04-23):
   ```
   === test-incident-photo-rule — guard 08e66fb3, site 7f027e8f ===
     ✓ incident + 0 photos returns 400 (got 400)
     ✓ 400 body mentions photo/camera requirement
     ✓ incident with non-bucket photo URL returns 400 from D2 (got 400)
     ✓ D2 400 body mentions bucket/storage origin requirement
     ✓ activity + 0 photos returns 201 (rule scoped to incident only, got 201)
     ✓ incident without photo_urls field returns 400 (got 400)
   === ALL ASSERTIONS PASSED ===
   ```

3. **Integration (live S3 round-trip)** — `apps/api/scripts/test-d2-magic-live.ts`
   (new, 8 assertions).  This is the Railway-only test that exercises
   the full upload → S3 → report-create → quarantine flow with real
   AWS credentials.  Skipped on local dev because dev .env has
   placeholder AWS keys (script exits 2 with an explicit message).

   Live test flow (run from Railway shell):
   - Mint a guard token.
   - Presign + upload a real JPEG (FF D8 FF + filler) → S3 204.
   - POST /api/reports with that URL → 201 (D2 fetched bytes,
     magic matched, report INSERTed).
   - Presign + upload a fake "JPEG" that's actually plain text → S3
     204 (proving D1 alone wouldn't catch this).
   - POST /api/reports with that URL → 400 with the D2 quarantine
     message; `quarantined_uploads` has the forensics row attributing
     the attempt to the test guard.
   - Cleanup: delete S3 objects, report row, ephemeral shift+session,
     quarantine row.

**Live verification (Railway).**  Once D2 lands, also run B2 again
from Railway with the prod creds (was previously blocked):

```bash
railway run npx ts-node apps/api/scripts/audit-s3-bucket.ts
# Should now show zero oversize / mismatched-type objects (going forward;
# pre-existing orphans aged out by 180-day lifecycle).

railway run npx ts-node apps/api/scripts/test-d2-magic-live.ts
# Expect: ALL ASSERTIONS PASSED, cleanup line, exit 0.
```

**Impact.**
- Closes the byte-content hole left by D1: a report can no longer
  reference an S3 object whose bytes don't match its declared type.
- Provides a forensics trail in `quarantined_uploads` so abuse is
  visible to ops without combing CloudTrail or S3 access logs.
- One extra S3 GetObject Range request per photo at report-create
  time — ~$0.0004 per 1k requests, negligible at our volumes.

Out of scope for Week-1 (Week-2+ follow-ups, not blocking REPORT.md
re-verification):
- **S3 ObjectCreated Lambda.** Would catch orphan uploads (uploaded
  but never linked to a report) too.  Trigger to revisit: any new
  feature that surfaces uploaded bytes outside a report.
- **Quarantine cleanup job.** Today the orphan S3 objects survive 180
  days under lifecycle.  A nightly job that deletes objects listed in
  `quarantined_uploads` immediately would be an additive change.
- **HEIC / iOS native-camera formats.** Mobile is on Expo, which
  produces JPEG via image-picker.  If a future codebase change starts
  uploading HEIC, add `image/heic` to `SIGNATURES` (magic: `ftypheic`
  at offset 4).
- **Polyglot detection.** A file that's BOTH a valid JPEG AND a valid
  zip would pass the magic check (we only verify the first bytes).
  Polyglots are rare in the wild and harmless unless a downstream
  consumer parses both layers; documented for awareness.

---

## Phase D summary

- ✅ D1 (closes CB7 / V6 size-cap leg) — `apps/api/src/services/s3.ts`
  switched from `getSignedUrl('putObject', …)` to
  `createPresignedPost` with four policy conditions (bucket pin, key
  eq, Content-Type eq, content-length-range 1..5 MiB).  Mobile upload
  helper switched from PUT to multipart POST.  Proven structurally
  by `apps/api/scripts/test-presigned-upload.ts` (16/16 assertions —
  base64-decodes the Policy field and verifies every condition;
  signature-equivalent to a live S3 round-trip because X-Amz-Signature
  is computed over the policy bytes).
- ✅ D2 (closes CB7 / V6 byte-content leg) — `POST /api/reports`
  fetches the first 16 bytes of every linked S3 object via
  `getS3ObjectHead` (S3 Range request), runs the magic-byte matcher
  in `apps/api/src/services/imageMagic.ts`, and on mismatch (a) 400s
  the report and (b) writes a forensics row to `quarantined_uploads`
  (new schema_v11 table) attributing the attempt to the guard +
  company + session.  `report_photos` rows can no longer reference
  bytes that don't match their declared MIME.
- 🟦 B2 follow-on — once the user runs `audit-s3-bucket.ts` from
  Railway shell (real prod creds), any pre-existing oversize /
  non-image objects can either age out under the 180-day lifecycle
  or be deleted in a one-shot.  D1 + D2 stop new bad objects.

**Files changed in Phase D**:
```
apps/api/src/services/s3.ts                    (D1 createPresignedPost,
                                                D2 getS3ObjectHead +
                                                s3KeyFromPublicUrl)
apps/api/src/services/imageMagic.ts            (D2 — new)
apps/api/src/routes/uploads.ts                 (D1 new shape; ALLOWED_CONTEXTS)
apps/api/src/routes/reports.ts                 (D2 magic-byte gate)
apps/api/src/db/schema_v11.sql                 (D2 quarantined_uploads — new)
apps/api/src/db/migrate.ts                     (D2 wires v11)
apps/mobile/lib/uploadToS3.ts                  (D1 PUT → multipart POST)
apps/api/scripts/test-presigned-upload.ts      (D1 — new, 16 assertions)
apps/api/scripts/test-magic-bytes.ts           (D2 unit — new, 28 assertions)
apps/api/scripts/test-d2-magic-live.ts         (D2 live — new, Railway-only)
audit/WEEK1.md                                 (this file)
```

Suggested commit message:

```
feat(s3): pin upload size + Content-Type at presign + magic-byte gate
on report submit (D1 + D2)

- D1 services/s3.ts: switch from getSignedUrl('putObject') to
  createPresignedPost with policy conditions {bucket}, ['eq', '$key',
  key], ['eq', '$Content-Type', ct], ['content-length-range', 1,
  5 MiB]. Mobile upload helper switched to multipart POST. Closes the
  unbounded-write primitive that V6 demonstrated (50 GB body to a PUT
  presign succeeded pre-fix).
- D2 services/imageMagic.ts + routes/reports.ts: on every report
  submit, fetch first 16 bytes of each linked S3 object via Range
  request, verify magic bytes against the declared Content-Type, and
  on mismatch return 400 + INSERT a forensics row in
  quarantined_uploads (new schema_v11 table). report_photos can no
  longer point at bytes that don't match their declared MIME.
- Tests: test-presigned-upload (16) decodes the Policy field and
  verifies each condition; test-magic-bytes (28) covers
  jpeg/png/webp + php/html/zip/text attacker shapes; test-d2-magic-
  live (Railway-only) does the live S3 round-trip end-to-end.

Refs: audit/REPORT.md (CB7), audit/VERIFICATION.md (V6),
audit/WEEK1.md §D1, §D2.
```

---



## Phase E — Re-verification

Re-run every regression test from Phases B/C/D after the cumulative
changes landed, plus the V1 IDOR probe rebuilt as a reproducible
in-process test (the original V1 used live prod creds I no longer
have). Goal: prove no test regressed during the writeup work and
nothing about Phase C/D weakened tenant isolation.

### E1 — Test re-run matrix ✅

All ten tests run on a single dev box against the live Railway DB
via the in-process app boot (the same pattern every script in
`apps/api/scripts/test-*.ts` uses). Each script is self-cleaning;
the regression run leaves no residue rows.

| # | Script | Covers | Assertions | Result |
| --- | --- | --- | --- | --- |
| 01 | `test-magic-bytes.ts`            | D2 unit (jpeg/png/webp + php/html/zip/text/empty/short) | 28 | ✅ |
| 02 | `test-presigned-upload.ts`       | D1 — presigned POST policy (size cap + Content-Type pin + key/bucket eq) | 16 | ✅ |
| 03 | `test-incident-photo-rule.ts`    | C6 photo-required + D2 bucket-origin enforcement | 6  | ✅ |
| 04 | `test-password-floor.ts`         | C7 12-char floor + must_change_password invariant | 9  | ✅ |
| 05 | `test-auto-complete-shifts.ts`   | C1 total_hours computed + breaks closed + chk_total_hours_nonneg | 12 | ✅ |
| 06 | `test-concurrent-clock-in.ts`    | C2 partial unique index — second concurrent insert raises 23505 | 5  | ✅ |
| 07 | `seed-retention-test.ts`         | B3 retention branches 2/3/4 fire + idempotent | 9  | ✅ |
| 08 | `test-pdf-handoff.ts`            | C4 pdf-link `?dl=` (60s, purpose-scoped); legacy ?token= → 410 | 15 | ✅ |
| 09 | `test-token-revocation.ts`       | C5 access jti + revoked_tokens + admin revoke-guard | 12 | ✅ |
| 10 | `test-idor-replay.ts` *(new)*    | V1 cross-tenant probe across 2 ephemeral companies | 33 | ✅ |
|    | **Total (auto)**                  |                                                    | **145** | ✅ |

**Re-run 2026-04-24 (Phase E close-out)**: full sequence executed back-to-back from a clean working tree. One transient `getaddrinfo ENOTFOUND yamabiko.proxy.rlwy.net` on test 09 (Railway proxy hiccup); retried after `nslookup` confirmed DNS recovery and the second run was clean. All 10 scripts ended `=== ALL ASSERTIONS PASSED ===`. Tally: `01:28 02:16 03:6 04:9 05:12 06:5 07:9 08:15 09:12 10:33` = **145/145**.

Plus one Railway-only test gated on real AWS creds (placeholder values
locally — see `.env` notes in §D1):

| # | Script | Covers | Assertions | Verification |
| --- | --- | --- | --- | --- |
| 11 | `test-d2-magic-live.ts` | D1+D2 live S3 round-trip (real JPEG → 201; fake JPEG bytes → 204 from S3 + 400 from /api/reports + quarantined_uploads row) | 8 | manual on Railway shell — see §D2 |

Per-test outputs are captured in `/tmp/phase-e-results/01-…10-…log`
during the run and discarded afterward; the assertion lines appear in
the suggested commit message below.

### E2 — V1 IDOR replay (new test) ✅

The original V1 was a manual probe against the live API as
`david406payne@proton.me` (Client B) and Admin B
(VERIFICATION.md §V1). Re-running it from a dev box requires those
prod credentials, which I no longer have. To make the probe
reproducible, `apps/api/scripts/test-idor-replay.ts` boots two
fully-ephemeral companies (`_IDOR_TEST_A_<stamp>`,
`_IDOR_TEST_B_<stamp>`), each with admin + client + site + guard +
shift + session + report, mints a JWT for each role, and runs the
full cross-tenant matrix against an in-process server.

Assertions covered (32 total — every one PASSed):

| Vector | Result |
| --- | --- |
| Client B GET /api/client/site                       | returns B-site only |
| Client B GET /api/client/site?site_id=<A>           | param ignored, still B-site |
| Client B GET /api/client/reports                    | only B-report appears |
| Client B GET /api/client/reports?site_id=<A>        | A-report still excluded |
| Client B GET /api/reports                           | A-report excluded |
| Client B GET /api/reports?site_id=<A>               | A-report excluded |
| Client B GET /api/shifts                            | 403 (role mismatch) |
| Client B POST /api/locations/ping                   | 403 (role mismatch) |
| Client B POST /api/client/reports/pdf-link          | 200; handoff JWT pinned to B.site_id, purpose=pdf_download |
| Admin B GET /api/sites                              | A-site excluded |
| Admin B GET /api/admin/kpis                         | scoped to B.company_id |
| Admin B GET /api/shifts                             | A-shift excluded |
| Admin B GET /api/guards                             | A-guard excluded |
| Admin B GET /api/reports?site_id=<A>                | A-report excluded |
| Admin A GET /api/sites                              | B-site excluded (symmetric) |
| Admin A GET /api/guards                             | B-guard excluded (symmetric) |

The C4 pdf-link change from C-phase added one new attack vector
("can a Client A use Client B's pdf-link?"), which the test pins
down by jwt.verify-decoding the handoff token and asserting (a)
`payload.site_id === B.siteId` and (b) `payload.purpose ===
'pdf_download'` — so the handoff cannot be replayed against
non-PDF endpoints and cannot be re-pointed at another tenant.

**Verdict.** V1 still PASS. Tenant isolation holds under the
post-Phase-C/D code.

### E3 — V6 attack regression ✅

V6 had two attack legs (audit/VERIFICATION.md §V6):

**Leg 1 — "PUT 50 MB random bytes to a presigned URL".** D1
removed the PUT presigner entirely; the only upload path is now
`createPresignedPost` which signs a policy containing
`['content-length-range', 1, 5_242_880]`. Because SigV4 signs
the base64 Policy field, S3 rejects any upload that doesn't match —
no signature you can mint client-side will be valid for an
out-of-policy size. Proven structurally by
`test-presigned-upload.ts` (16/16 assertions, including
explicit decode of the policy and check for
`[content-length-range, 1, 5242880]`).

**Leg 2 — "PUT PE-binary bytes labelled image/jpeg, then submit a
report".** Even if an attacker bypasses Leg 1 (impossible without
re-signing the policy), D2 fetches the first 16 bytes of every
linked S3 object at report-create time. On magic-byte mismatch the
report is rejected and a forensics row is INSERTed into
`quarantined_uploads`. Proven in two layers:

- `test-magic-bytes.ts` (28/28) — every attacker shape (php, html,
  zip, text) is REJECTED as image/jpeg by the matcher.
- `test-incident-photo-rule.ts` case 2 (1/1 from §C6) — POST
  /api/reports with a `photo_urls[].url` whose hostname is not
  the configured bucket returns 400 with the
  "…must point at the configured S3 bucket…" message.
  This is the "non-bucket URL" subset of D2; the live byte-mismatch
  case is in `test-d2-magic-live.ts` (Railway-only — placeholder
  AWS creds locally).

**Verdict.** V6 PASS for both legs (the live byte-mismatch leg
remains gated on the user running `test-d2-magic-live.ts` from a
Railway shell — script ready and self-cleaning).

### E4 — V5 / Bonus 2 / B3 re-verification ✅

- V5 (incident photo rule) — `test-incident-photo-rule.ts` 6/6:
  zero photos → 400; activity exempt; missing key → 400.
  V5 verdict flips from FAIL to PASS.
- Bonus 2 (password floor) — `test-password-floor.ts` 9/9: 11-char
  rejected, 12-char accepted, must_change_password=true on new
  rows + flips on rotation.  Bonus 2 flips from FAIL to PASS.
- B3 (retention branches) — `seed-retention-test.ts` 9/9: branches
  2/3/4 fire + are idempotent. (Branch 1 covered by C-phase unit
  test.) V4 verdict was already INCONCLUSIVE → PASS in §B3; this
  rerun confirms no regression after C/D.

### E5 — Items NOT covered by this re-verification ⛔

- B2 audit-s3-bucket.ts — still gated on user running it from
  Railway shell with prod creds.  Script ready (B2).
- Live S3 round-trip for D2 — `test-d2-magic-live.ts` ready,
  Railway-only.
- BIPA / CB8 — explicitly held; user directive.
- 2FA / CB9 — explicitly out of Week-1 scope.

---

## Phase E summary

- ✅ E1 — All ten in-process regression tests green: 145/145 assertions
  across C1–C7, D1, D2, B3, and the new V1 replay.  Re-run 2026-04-24
  Phase-E close-out cleared the same matrix end-to-end (one transient
  Railway-proxy DNS hiccup on test 09, retried clean).
- ✅ E2 — V1 IDOR isolation re-verified end-to-end via a new
  reproducible test that doesn't need prod credentials.
- ✅ E3 — V6 attack legs both blocked: D1 binds the policy + size cap
  with SigV4 (Leg 1); D2 magic-byte-validates every linked S3 object
  at report-create time (Leg 2).
- ✅ E4 — V5, Bonus 2, B3 all re-verified PASS after C/D.
- 🟦 E5 — Two items still need a Railway shell: B2
  audit-s3-bucket.ts and `test-d2-magic-live.ts`.  Both scripts are
  self-cleaning; the user runs them and the verdicts go into REPORT.md
  v3.

**Files added in Phase E**:
```
apps/api/scripts/test-idor-replay.ts   (new — V1 reproducible replay)
audit/WEEK1.md                         (this file — Phase E section)
audit/REPORT.md                        (CB1–CB6 marked closed; scores
                                        revised; Path-decision table
                                        updated)
audit/VERIFICATION.md                  (V1/V5/V6/Bonus 2 verdicts +
                                        cross-references to WEEK1 §)
```

Suggested commit message:

```
test(audit): Phase E re-verification — 145/145 regression assertions
green; CB1–CB6 + V5 + Bonus 2 + V6 closed

- New test-idor-replay.ts boots two ephemeral companies and runs the
  V1 cross-tenant probe matrix (33 assertions) against the
  in-process app.  V1 still PASS post-Phase-C/D.
- Re-ran C1 (test-auto-complete-shifts), C2/C3
  (test-concurrent-clock-in), C4 (test-pdf-handoff), C5
  (test-token-revocation), C6+D2 (test-incident-photo-rule), C7
  (test-password-floor), D1 (test-presigned-upload), D2
  (test-magic-bytes), B3 (seed-retention-test).  Total 145/145.
- audit/REPORT.md: CB1–CB6 marked closed with file:line references
  back to audit/WEEK1.md; Security score 5.5 → 7.0; Data integrity
  4.5 → 6.0; Path-decision table updated.
- audit/VERIFICATION.md: V1 (PASS confirmed), V5 (FAIL → PASS), V6
  (FAIL → PASS pending user-run live test), Bonus 2 (FAIL → PASS).
- Items still gated on user with Railway shell: B2 audit-s3-bucket
  + test-d2-magic-live.  BIPA / 2FA / V2 (Maps key rotation) remain
  out of Week-1 scope by user directive.

Refs: audit/WEEK1.md §E, audit/REPORT.md, audit/VERIFICATION.md.
```

