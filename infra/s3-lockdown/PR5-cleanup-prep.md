# PR5 — At-rest cleanup, post-PR4

Surfaced 2026-06-10 during PR4 prep. Not for Sunday; queue after the flip beds in.

## 1. Pre-Apr-23 cohort

**28 objects** in `guard-media-prod` modified before the 2026-04-23 D1+D2
upload-hardening window (was 29 — one malicious test artifact deleted
pre-flip; see "RESOLVED PRE-FLIP" entry below). All remaining are
`clock_in/*` and `report/*` JPEGs from 2026-04-08 → 2026-04-19, two
companies' guards (343102a1 + b062f601).

**Spot check (2026-06-10):** 5 random samples — all valid JFIF JPEGs
(`ffd8ffe0` magic-byte prefix). Cohort presumed clean.

**Recommended action:**
1. Run a full magic-byte sweep over all 29 — `for k in <list>; do head 4 bytes; done`.
   Cheap (1 GET request per object, <$0.001 total).
2. If all pass: **leave the cohort as-is**. The retention-purge cron
   ([nightlyPurge.ts](apps/api/src/jobs/nightlyPurge.ts)) will reach them
   when their parent records hit the retention deadline. No urgency.
3. If any fail: quarantine those keys (`s3 mv` to a `quarantine/` prefix
   on the same bucket; preserve evidence for review).
4. Optionally backfill `ContentType: image/jpeg` via `copy-object` to
   each — none have it set today, which only matters if a downstream
   consumer ever inspects metadata. Currently nothing does.

### Confirmed malicious / test artifact — RESOLVED PRE-FLIP 2026-06-10T22:22:07Z

`report/b062f601-6173-461c-897e-af2c427e0fd7/2026-04-19/02321e6a-e9be-486a-9478-c0a277617715.jpg`
(49 bytes, uploaded 2026-04-19, **before D1/D2 hardening landed ~Apr 23**)

**What `file` reported:** `MS-DOS executable`
**Hex header:** `4D 5A 90 00 03 00 00 00` (DOS `MZ` magic + PE stub)
**Strings:** `FAKE_EXECUTABLE_DATA_masquerading_as_jpeg`

Almost certainly an artifact of the V6 audit attack that confirmed the
pre-D1 PUT-presigner had no Content-Type or size validation. Inert at
rest, but exposed via the public-read bucket policy that's about to
flip on Sunday — operator chose to delete pre-flip to (a) avoid the
versioning-delete-marker followup post-PR4 and (b) close the
public-read exposure window immediately.

**Status: DELETED 2026-06-10T22:22:07Z.**
- `aws s3 rm s3://guard-media-prod/report/b062f601-…/02321e6a-….jpg` → confirmed deleted
- `aws s3api head-object` → 404 Not Found
- Pre-Apr-23 cohort count: 29 → 28
- Versioning not yet enabled at delete time, so the delete is permanent;
  no version-marker cleanup needed in PR5.
- Do NOT re-process in PR5. Cohort sweep can skip this key.

## 2. `starguard-media` ghost bucket

Probed 2026-06-10. Empty (`Contents` returns null), no bucket policy
attached. Created 2026-04-01 — the pre-rename leftover per AGENTS.md.

**Action:** `aws s3api delete-bucket --bucket starguard-media`.
No dependencies, no rollback needed (re-create later if you ever need
the name back; bucket names are globally unique so squat early).

## 3. (Optional, defer) Storage-shape backfill

Per Section 4c decision: store S3 keys instead of full URLs going
forward. Migration is mechanical — one `UPDATE … SET col =
regexp_replace(col, '^https://.*\.amazonaws\.com/', '')` per of:

- `clock_in_verifications.selfie_url`
- `clock_in_verifications.site_photo_url`
- `geofence_violations.photo_url`
- `location_pings.photo_url`
- `report_photos.storage_url`
- `task_completions.photo_url`
- `sites.instructions_pdf_url`
- `monthly_hours_reports.s3_url`

`extractS3Key` already accepts both forms ([s3.ts](apps/api/src/services/s3.ts)),
so this can land any time without coupling to a code change.

Cost is one extra read per request to detect format. Negligible. Defer
until you're tired of seeing the warn lines in Sentry.
