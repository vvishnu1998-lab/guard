# 2026-09-06 — STARNET +4 sites go-live readiness (N29)

**Type:** readiness check, read-only. Not an outage.
**Verified:** 2026-09-07 02:30–02:45 UTC (2026-09-06 19:30–19:45 PT), `main` @ `0a5439e`,
`postgres-readonly` only, `railway variables` read once for one key.
**Go-live:** 2026-09-07 (tomorrow PT). Tenant `27c4d404-8769-49ca-bfd6-93cb9b890067`.
**Tier:** 0 (read-only). Every action below that touches STARNET data is Tier 2 and is
Nataniel's in the admin portal, not ours.

Verdicts: **READY** = nothing further needed for tomorrow; **BLOCKED** = a guard cannot
work tomorrow until the named action happens; **UNVERIFIED** = cannot be read from
repo / DB / CLI here and names who fills it.

---

## 0. Two premises in the brief are wrong — read first

**(a) "A new site without a `site_geofence` row is a P1: clock-in will be rejected."**
**False.** `services/geofence.ts:162-184` — `validateAtSite` returns
`{ allowed: true, reason: 'no_geofence' }` when the row is absent:

```
// No fence row at all → legacy site, allow. The admin must define a fence
// before this site becomes audit-compliant.
```

A missing fence means clock-in and pings are **accepted from anywhere**, silently.
The failure mode is the opposite of the one the brief expected. Moot tonight — all
four new sites have a fence row (§1) — but the invariant is worth keeping straight:
**a fenceless site is unenforced, not blocked.**

**(b) "`MOCK_LOCATION_ENFORCEMENT` applies by default."**
Its **code default is `off`** (`services/mockLocation.ts:53-59`: unset, empty or
unrecognised → `'off'`). **But production has it set to `on`** — `railway variables
--service guard --environment production` → `"MOCK_LOCATION_ENFORCEMENT": "on"`,
read 2026-09-07 02:3xZ. The module's own header says *"Ship at `off`. Move to
`shadow`, measure for at least a week, then consider `on`"* and *"Until the shadow
data explains that shape, `on` is not safe."* No entry in `DECISIONS.md`, `STATE.md`
or any skill records the flip. See §5 for what that means tomorrow.

---

## 1. Sites

All STARNET sites, `sites LEFT JOIN site_geofence`. Four created in the last 14 days —
all four on 2026-09-06 between 22:11Z and 22:34Z, `contract_start = 2026-09-07`,
`contract_end = NULL`, `timezone = America/Los_Angeles`, `ping_interval_minutes = 30`,
`address` present, `is_active = true`, `client_access_disabled_at = NULL`.

| site_id | name | created | fence row | radius_m | polygon verts | center | geocoded | `checkpoints_enabled` | site verdict |
|---|---|---|---|---|---|---|---|---|---|
| `015a37e9-7566-46b9-9cd6-c40705e2e2d7` | CCDC Folsom | 09-06 22:11Z | **yes** (22:33Z) | 90 | 4 | yes | yes | true | READY (fence) |
| `a4588d96-b45e-4fdb-a1f1-34a9cada6015` | CCDC Broadway | 09-06 22:12Z | **yes** (22:31Z) | 70 | 4 | yes | yes | true | READY (fence) |
| `ab450901-c434-417c-b5b6-292b4d09e80c` | 375 Shopping Complex | 09-06 22:13Z | **yes** (22:29Z) | 300 | 4 | yes | yes | true | READY (fence) |
| `7fabf0ee-f100-43e4-aabd-71cf0dae31fc` | Jasper | 09-06 22:34Z | **yes** (22:35Z) | **50** | 4 | yes | **no** | true | READY (fence) — see note |
| `fea19254-6d65-4fbb-9f17-022081cf3472` | 23000 Cristo Rey Los Altos | 07-17 | yes | 190 | 4 | yes | yes | true | existing |
| `53c71c64-1973-4f82-be9c-98e4800beece` | Bethel AME Church | 08-20 | yes | 100 | 16 | yes | yes | **false** | existing (D11) |
| `6c638a80-a887-4375-9687-bfb6c1acb3bc` | william pen hotel | 08-16 | **no** | — | — | — | yes | true | `is_active = false`, ignore |

- `grace_radius_meters = 50` on every fence row. **It is not read by `validateAtSite`**
  (the SELECT at `geofence.ts:168-170` fetches polygon, center, radius only). The
  server budget is `radius_meters + accuracy_m + 20` (`SAFETY_MARGIN_M`, `:80`),
  OR the 4-vertex polygon. Do not reason from the grace column.
- **Jasper: 50 m is the tightest fence STARNET has**, and its `sites.geocoded_lat/lng`
  is NULL. The geocode is editor pre-fill only and takes no part in validation, so
  this is cosmetic — but a 50 m radius with a phone reporting 30 m accuracy leaves
  100 m of budget, and the polygon is the only other way in. If tomorrow's first
  Jasper clock-in is rejected `GEOFENCE_FAILED`, the radius is the first suspect.
  Jasper has no shifts yet (§3), so this cannot bite tomorrow.
- `checkpoints_enabled` is `true` on all four by column default
  (`information_schema`: `DEFAULT true`; the site INSERT at `routes/sites.ts:146`
  does not set it). All four have **0 `site_checkpoints` rows**. Effect: the QR
  scanner tab is shown with nothing to scan. No cron enforces checkpoint coverage
  (none in `apps/api/src/jobs/`), so this is cosmetic, not a block.
- 0 `site_scheduling_profiles`, 0 `site_vehicles`, `vehicle_inspection_required = false`
  on all four.

## 2. Guards created in the last 14 days

Five, all created 2026-09-06 22:48Z–23:08Z, all `is_active = true`,
all **`must_change_password = true`**, all **0 `guard_devices` rows**,
`phone_number` NULL on all.

| guard_id | badge | assigned site (`guard_site_assignments`, from 09-07) | future shifts | auth_events | `login_attempts` | verdict |
|---|---|---|---|---|---|---|
| `c4c9b7f7-a578-42bc-856e-9876d7e1765e` | GRD0010 | 375 Shopping Complex | **9** (first **Thu 09-11 14:00 PT**) | **0** — never attempted login | none | **BLOCKED** — can wait until 09-10 |
| `7b79fc50-b91a-465c-9b7c-cabf10ab1f9a` | GRD0011 | 375 Shopping Complex | **17** (first **Mon 09-07 14:00 PT — TOMORROW**) | **0** — never attempted login | none | **BLOCKED — TONIGHT** |
| `d0c5780b-3711-4754-94cb-cbe9028ef16f` | GRD0012 | Jasper | 0 | 1 `welcome_email_resent` (browser = admin) | none | no shift; can wait |
| `95505419-123e-4f70-abf1-88c7f8742d54` | GRD0013 | Jasper | 0 | **4 `login_failed`** (mobile app, 23:04–23:11Z) + 1 `password_reset_emailed` (23:05Z) | `failed_count = 3`, not locked | no shift; **credentials broken** |
| `faf47dd5-9686-44a1-8623-994e8a26fcb3` | GRD0014 | Jasper | 0 | 2 `welcome_email_resent` (browser) + **1 `login_failed`** (mobile app, 23:18Z) | `failed_count = 1`, not locked | no shift; **credentials broken** |

Reading:

- **A `guard_devices` row is written on successful login with a push token.** Zero
  rows plus zero `auth_events` (GRD0010, GRD0011) means **the app has not been opened
  against this account at all** — not installed, or installed and never logged in.
  Neither can receive a push; neither has changed the temporary password.
- GRD0013 and GRD0014 **have the app installed** (the failed logins carry a mobile
  user-agent) and are **failing on the password**. GRD0013 got a reset email at
  23:05Z and then failed twice more. Lockout is 5 failures → 30 min
  (`routes/auth.ts:15-18`); GRD0013 is at 3. Two more wrong attempts lock the
  account for half an hour. Neither has a shift, so this is not a tomorrow blocker,
  but it is the only live signal of *how* onboarding is going: 2 of 2 guards who
  tried, failed.
- **The two guards that actually have shifts are the two that have never tried.**
- `guard_site_assignments` and `shifts` agree: GRD0010/11 → 375 Shopping Complex,
  GRD0012/13/14 → Jasper. **CCDC Folsom and CCDC Broadway have no guard assigned
  and no shift** — either they are not staffed tomorrow, or the staffing has not
  been entered. UNVERIFIED which — **Nataniel fills**.
- Platform of the five is UNVERIFIED (no device row). Matters for §5.

## 3. Shifts, and what a guard without one can do

**Brief expected 0. Actual: one of the four new sites is fully scheduled.**

| site | future non-cancelled shifts | pattern | guards | first |
|---|---|---|---|---|
| 375 Shopping Complex | **26** scheduled, 0 unassigned | **14:00–00:00 PT daily**, 09-07 → 10-10 | GRD0011 ×17, GRD0010 ×9 | **Mon 09-07 14:00 PT** |
| CCDC Folsom | **0** | — | — | — |
| CCDC Broadway | **0** | — | — | — |
| Jasper | **0** | — | — | — |
| Bethel AME (existing) | 21 (15 scheduled, **6 unassigned**) | 08–14 / 10–16 / 12–18 / 14–20 PT | GRD0004, GRD0005, GRD0008 | 09-07 10:00 PT |
| Cristo Rey (existing) | 0 (3 cancelled) | — | — | — |

**Does clock-in require a shift? Yes, absolutely.** There is no ad-hoc session path.

- The route is shift-scoped: `POST /shifts/:id/clock-in` (`routes/shifts.ts:3407`).
  Its first query is
  `SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = 'scheduled' FOR UPDATE`
  (`:3443-3446`) → `404 Shift not found or not schedulable` otherwise.
- `shift_sessions.shift_id` is **NOT NULL** (`information_schema`). A session
  without a shift cannot exist at the schema level.
- Clock-in opens **30 minutes before `scheduled_start`** and not earlier
  (`:3458-3474`, `422 TOO_EARLY`). A 14:00 shift is clockable from 13:30 PT.
- `grep -rni "ad-hoc\|adhoc\|unscheduled\|walk-in" routes/ jobs/` → **0 hits**.

**Does `pingReminder` fire without a schedule?** The question cannot arise: it
selects `FROM shift_sessions ss JOIN shifts s ON s.id = ss.shift_id`
(`jobs/pingReminder.ts:234-235`) and anchors every window on
`s.scheduled_start` (`:229, :249`). No shift → no session → no row.

**Does the daily client report include ad-hoc sessions?** Same answer:
`jobs/dailyShiftEmail.ts:26-30` selects `FROM shifts WHERE status = 'completed'
AND daily_report_email_sent = false AND scheduled_end` in the last 36 h. It is
keyed on the shift, and a session cannot exist without one.

**Consequence for tomorrow:** a guard at CCDC Folsom, CCDC Broadway or Jasper with
no shift row **cannot start work in the app at all**. The app will show no shift
and offer no clock-in. Nothing will be recorded, no ping reminders, no report.
If those posts are staffed tomorrow, **the shifts must exist before 13:30 PT for a
14:00 start (or 30 min before whatever the start is)** — that is Nataniel's
schedule screen, Tier 2, and it is the single hard gate.

What the crons do to a scheduled shift nobody clocks into (relevant because
GRD0011 has one tomorrow and no app):

| T | job | effect |
|---|---|---|
| T−60 min | `preShiftReminder` (`*/5`) | push → **skipped, no device**; emits a `push_skip_null_token` Sentry warning (N20) |
| T+0..5 | `shiftStartReminder` | same |
| T+10 | `missedShiftAlert` | **email to company admin only** (`jobs/missedShiftAlert.ts:9`) — STARNET has 2 `company_admins` rows |
| T+10 / T+15 | `lateClockInReminder` | push → skipped; admin email at the 15 |
| `scheduled_end` + 30 | `autoCompleteShifts` | `status → 'missed'` (`:236-248`) |
| next 09:00 PT | `dailyShiftEmail` | not selected (`status <> 'completed'`) |

So a no-show tomorrow at 375 Shopping Complex is visible to Nataniel by **14:10 PT**
via email, and to nobody else.

## 4. Client reports per new site

| site | `clients` rows (`site_id`) | `client_sites` rows | daily report recipient |
|---|---|---|---|
| CCDC Folsom | **0** | 0 | **nobody** |
| CCDC Broadway | **0** | 0 | **nobody** |
| 375 Shopping Complex | **0** | 0 | **nobody** |
| Jasper | **0** | 0 | **nobody** |
| Cristo Rey | 1 (active, has logged in) | 1 | the one client |
| Bethel AME | 0 | 1 | **see finding** |

STARNET has **one** client account in total (`clients WHERE company_id` → 1).

What "nobody" does: `sendDailyShiftReport` (`services/email.ts:466-491`) joins
`LEFT JOIN clients c ON c.site_id = si.id AND c.is_active = true`, and on a NULL
`client_email` logs *"skipped — no active client for site"* and **flags the shift
`daily_report_email_sent = true` anyway** so it never retries. A shift completed
tomorrow at 375 Shopping Complex therefore produces **no report, and the DB looks
as if one was sent.** Adding a client later does not backfill.

**Side finding — the daily report ignores `client_sites`.** The recipient join is
on `clients.site_id`, but the admin "link client to another site" path writes only
`client_sites` (`routes/clients.ts:330`; `sendIncidentAlert` at `email.ts:291-302`
*does* use the junction). Bethel AME has 0 `clients.site_id` rows and 1
`client_sites` row, and **30 completed Bethel shifts are flagged
`daily_report_email_sent = true`** — from the DB alone it is impossible to tell
whether those 30 were sent or skipped, because both paths set the same flag.
**UNVERIFIED which; the `[email] sendDailyShiftReport: skipped` log line at the
next 09:00 PT run is the proof either way.** If skipped, Bethel has had no client
report since 2026-08-20, and **linking the existing client to the four new sites
the same way will produce none for them either.** A per-site `clients` row (the
`routes/clients.ts:131` path) is the only shape the report reads today.

## 5. Enforcement on new sites, by default

**Geofence — applies, no per-site toggle, and it is the same code on every site.**
`validateAtSite` (`services/geofence.ts:162-215`): `polygonOk || radiusOk`, radius
budget `radius_meters + accuracy + 20 m`. Reject = HTTP 422 on:

- clock-in → `GEOFENCE_FAILED` (`routes/shifts.ts:3479-3496`)
- handoff clock-in (`routes/shifts.ts:2115`)
- ping → `PING_OFF_POST` (`routes/locations.ts:405-465`, also persisted as an
  `off_post_events` row)
- clock-in-verification (`routes/locations.ts:813`)
- task completion (per the comment at `locations.ts:401-403`)
- clock-out is **persist-and-flag, never rejected** (`clock_out_within_geofence`).

No fence row → allow (§0a). There is **no** site-level switch for any of this.
`checkpoints_enabled` gates **only the QR scanner** (`routes/sites.ts:192`,
`apps/mobile/lib/siteFlags.ts:25`, absent → true) — `DECISIONS.md` D11 reads it as
"enforcement off" for Bethel, which is broader than what the flag does in code.
Default `true`; all four new sites `true`.

**Mock-location — `on` in production, Android only, and the brief did not know.**
`checkMockLocation` runs **before** the transaction on clock-in
(`routes/shifts.ts:3429-3439`), handoff clock-in (`:2130`), ping
(`locations.ts:270-280`), clock-in-verification (`:846-851`), checkpoint link and
scan (`checkpoints.ts:390-394, 459-463`). With mode `on`, an Android device whose
OS reports `isMocked = true` gets **422 `MOCK_LOCATION_REJECTED` — "We couldn't
verify your location. Please contact your supervisor."** — a message that
deliberately names neither the cause nor the fix (`mockLocation.ts:68-84`).
iOS never reports the signal and is permanently allow (`:45-49`).

Evidence of impact so far (STARNET, 14 d): **35 sessions, 0 with
`clock_in_location_mocked = true`, 21 NULL** (iOS / older client). Railway logs
retrievable here cover only ~1 h 45 m (00:45Z–02:30Z, 3000 lines, mostly
`break_expiry.tick`) and contain 0 `mock.reject` lines — **too short a window to
prove anything.** Whether `on` was set deliberately, when, and by whom is
**UNVERIFIED — Vishnu fills.** The module's own safety criterion says `on` is
not yet justified. Five new guards of unknown platform arrive tomorrow; **an
Android guard with a mock-location app selected in Developer options will be
refused at clock-in with no usable error text.** Changing the flag is Tier 2
(guard-facing enforcement); this check only records that it is set.

## 6. Deploy-gate impact

Forward STARNET open-session windows, from `shifts` (non-cancelled, future), PT:

| site | daily window |
|---|---|
| Bethel AME | 08:00–14:00 / 10:00–16:00 / 12:00–18:00 / 14:00–20:00 (varies by day; 6 unassigned) |
| 375 Shopping Complex | **14:00–00:00, every day 09-07 → 10-10** |
| CCDC Folsom, CCDC Broadway, Jasper | none yet |

Sessions auto-close at `scheduled_end + 30 min`, so the 375 Shopping Complex
session persists to ~00:30 PT. Union: **STARNET has an open session roughly
08:00–00:30 PT every day from tomorrow.** The gate's CONDITION route (0 active,
0 open) is now available only **~00:30–08:00 PT** — and only until Jasper or the
CCDC sites get shifts. Outside that, every push to `main` — docs included, per
`POLICY.md` — is PROXY (ping lands, push inside 90 s) or OVERRIDE.

Coverage from contract fields: **not derivable.** `sites` carries
`contract_start` / `contract_end` only (no hours, no days), all four have
`contract_end = NULL`, and `site_scheduling_profiles` has 0 rows for every STARNET
site. The shift table is the only source of expected coverage.

At write time (02:3xZ): STARNET open sessions **0**; control across all tenants
**3** (test tenant). Mechanism proven non-empty.

## 7. Checklist — tonight vs can wait

**Nataniel, tonight (before 13:30 PT 09-07), all Tier 2 / admin portal:**

1. **GRD0011 `7b79fc50` must install the app, log in, and change the temporary
   password.** First shift is 09-07 14:00 PT at 375 Shopping Complex; clock-in
   opens 13:30. Zero auth events — this guard has not tried. Without it:
   no clock-in, a `missed` shift, an admin email at 14:10, no report.
2. **If CCDC Folsom, CCDC Broadway or Jasper are staffed tomorrow, create the
   shifts.** No shift = no clock-in, full stop (§3). Guards for Jasper exist
   (GRD0012/13/14); none for either CCDC site.
3. **If any client should receive tomorrow's reports for the new sites, create
   a per-site client row** (`clients.site_id`), not a site link. A link produces
   no daily report (§4). Note it does not backfill — a report is skipped and
   flagged sent the morning after the shift.

**Can wait (this week):**

4. GRD0010 `c4c9b7f7` — same as (1), first shift **Thu 09-11 14:00 PT**.
5. GRD0013 `95505419` and GRD0014 `faf47dd5` — app installed, password failing.
   GRD0013 is 2 failures from a 30-min lockout. Resend / reset and confirm a
   successful login (a `guard_devices` row appearing is the proof). No shifts
   yet, so not a tomorrow blocker.
6. GRD0012 `d0c5780b` — has not tried yet; no shifts.
7. Jasper 50 m radius — leave unless the first clock-in rejects; then widen.
8. `checkpoints_enabled = true` with 0 checkpoints on all four — cosmetic;
   either add checkpoints or set false. Nataniel's call.

**Vishnu:**

9. **`MOCK_LOCATION_ENFORCEMENT = on` in prod** — confirm it is deliberate and
   record the decision in `DECISIONS.md`, or move it to `shadow`. Tier 2 either
   way. Not tonight unless an Android guard is refused tomorrow.
10. Verify the Bethel daily-report question at the 09:00 PT run tomorrow:
    `railway logs | grep "sendDailyShiftReport: skipped"`. If Bethel appears,
    the `client_sites` gap is real and has been silent since 08-20.
11. Deploy gate: plan merges for **00:30–08:00 PT** or use PROXY. The docs-only
    merge carrying this file is itself a Railway restart.

**Ready, no action:** all four fence rows (polygon + center + radius present),
addresses, timezone, `is_active`, 375 Shopping Complex schedule (26 shifts, 2
guards, through 10-10).

## What could not be verified here

- Platform (iOS/Android) of the five new guards — no device row yet.
- Whether CCDC Folsom / CCDC Broadway are staffed tomorrow.
- Whether Bethel's 30 flagged reports were sent or skipped (§4).
- Who set `MOCK_LOCATION_ENFORCEMENT=on`, and when (§5).
- Whether any of the five guards received the welcome email — `auth_events` records
  resends (2 guards), not deliveries; SendGrid delivery state is console-only.
