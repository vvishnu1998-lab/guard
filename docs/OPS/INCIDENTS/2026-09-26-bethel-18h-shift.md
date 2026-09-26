# 2026-09-26 — Bethel AME Church: a 6-hour shift created as 18 hours

A STARNET SECURITY shift at Bethel AME Church was created at 12:03:57 PT on
2026-09-25 as **12:00 → 06:00 next day (18 h)** when 12:00 → 18:00 was intended.
The guard left at ~18:05 PT. The platform treated them as on duty all night:
35 missed-ping windows, overnight reminders and missed-report alerts, a clock-out
reminder at 05:55 AM, and an auto clock-out at 06:30 PT recording **18.41 h**.
The 09:00 PT daily report would have sent those figures to the site's client.
Both records were corrected by hand before 09:00 PT.

Identifiers (guard data as uuid + badge + tenant, per POLICY):

| thing | id |
|---|---|
| tenant | STARNET SECURITY `27c4d404-8769-49ca-bfd6-93cb9b890067` |
| site | Bethel AME Church `53c71c64-1973-4f82-be9c-98e4800beece` |
| shift | `c3574592-3a97-4fe0-a190-bd5f3b435018` |
| session | `cc1cf358-5c26-4f6a-9618-d716bacdda6c` |
| guard | GRD0005, `4a71d17d-d74a-4437-8269-cb1da0802d0d` |
| created_by | company_admin `35afa653-7e03-4b4c-9242-c3819ff88b29` |
| geofence violation | `201fea51-1b23-4642-9ae6-0895af7bec8e` |

---

## 1. Timeline

All from production reads (postgres-readonly, PT via `to_char`) unless marked.

| UTC | PT | event |
|---|---|---|
| 2026-09-23 04:55 | 09-22 21:55 | Client `fd7d556b` created with `clients.site_id` = Bethel. From here the 09:00 PT daily report goes to a real recipient (the Railway log of the 09-25 run shows two Bethel shifts rendered and sent). |
| 2026-09-25 19:03:57 | 09-25 **12:03:57** | Shift `c3574592` created, `source` manual, **12:00 → 06:00 next day** — four minutes after its own start. `shift_assigned` notification at the same second. |
| 19:05:13 | 12:05:13 | GRD0005 clocks in; session `cc1cf358`. |
| 20:17 – 00:25 | 13:17 – 17:25 | Five `activity` reports, all in-fence. **Zero pings** all shift — this guard has sent none on any session since 2026-09-04 (N115). |
| 23:07:02 | 16:07:02 | Railway deployment `d2f7f870` (commit `8de7a94`) goes live with 3 STARNET sessions open, this one included (N114). |
| 2026-09-26 01:05:45 | 09-25 **18:05:45** | Native geofence **exit**: violation `201fea51` (`position_source` `site` — the fence centre, so the time is evidence and the position is not). `geofence_breach` notification. The code path also emails every active STARNET admin; delivery is not logged on success, so it is **UNVERIFIED**. Nothing from the device after this. |
| 01:00 – 13:00 | 18:00 – 06:00 | Overnight, against an 06:00 end: 24 `ping_reminder`, 25 `missed_ping`, 13 `activity_report_reminder`, 12 `missed_report` notifications; 24 `missed_pings` rows and 12 `missed_reports` rows for windows starting at or after 18:00. |
| 12:55:00 | 05:55:00 | `clock_out_reminder` push. |
| 12:57 | 05:57 | Read-only audit starts. |
| 13:30:00.818 | **06:30:00.818** | `autoCompleteShifts` closes the session at the sweep time: `clock_out_reason` `auto`, `total_hours` **18.413**; violation `201fea51` resolved at 06:30 with **744 min** off-post. |
| 13:58:44 – 14:19:24 | 06:58:44 – 07:19:24 | **Q11, then 8-a, applied by Vishnu** (below). Bounded by audit reads — at 06:58:44 PT the session was still `auto`; at 07:19:24 PT both corrections were in place — and by the SQL files: 8-a's COMMIT file was written at 07:12:36 PT, so 8-a ran between 07:12:36 and 07:19:24 PT. No update timestamp exists on these rows, so the exact minutes are not recorded. |
| 16:00 | 09:00 | `dailyShiftEmail` run — reads the corrected rows. **UNVERIFIED at the time of writing** (08:24 PT: `daily_report_email_sent` still false). |

## 2. Root cause

**The create modal silently rolls an end time that is earlier than the start into
the next day.** `isOvernight` is `end < start` on the clock face
(`apps/web/components/admin/ScheduleShiftModal.tsx:226`); the single-shift and
repeat paths then add a day (`:266`, `:273`). The only feedback is a small
"Overnight — ends next day" hint (`:355`). Entering 06:00 for 6 PM produces an
18-hour shift with no confirmation.

Nothing downstream catches it:

- `POST /api/shifts` checks that the fields are present — no end > start check,
  no maximum duration (`apps/api/src/routes/shifts.ts:376`).
- Once the guard clocked in, **no UI or API can fix it.** `PATCH /api/shifts/:id`
  refuses `active` (`:1644`) and any shift with a session (`:1669-1681`), and no
  admin route closes a session.
- `autoCompleteShifts` closed the session 30 minutes after the (wrong) end and
  stamped `clocked_out_at = NOW()`, so the record carried 18.41 h.

**Precedent — the same mistake, 2026-08-23.** Shift `b3a29807` at the same site
was 08:00 → 02:00 next day (18 h); its session was closed manually after 2.34 h, so
it produced no inflated hours. Same AM/PM pattern.

**Ruled out:**

- *The guard stayed on post overnight.* The native region exit at 18:05:45 PT and
  the absence of any report, ping or re-entry afterwards say otherwise. The device
  kept its armed region until then; nothing was received after.
- *An admin extended the shift later.* `shift_schedule_audit` has **0** rows for
  `c3574592` (the table has 28 rows, latest 2026-09-24); the edit route could not
  have touched an active shift anyway.

## 3. Fix sha

**Data (no code): two hand corrections, applied by Vishnu 2026-09-26, Tier 2.**

- **Q11** — shift `scheduled_end` → 2026-09-25 18:00 PT, status `completed`;
  session closed at 18:00 PT with `clock_out_reason = 'admin_corrected'` and
  `total_hours` from the job's own formula = **5.912851 h**; violation `201fea51`
  re-resolved with the job's own rule → `resolved_at` = its `occurred_at`
  (18:05:45 PT), **0 min**. No breaks existed.
- **8-a** — deleted the overnight stored rows for this session only: **24
  `missed_pings` + 12 `missed_reports`** with windows starting at or after
  18:00 PT. Kept: **11** `missed_pings` (12:30 – 17:30) and **1** `missed_report`
  (16:00).

**The SQL that ran** — copied byte-for-byte into `2026-09-26-bethel-18h-shift/`.
Vishnu executed all four with `psql -v ON_ERROR_STOP=1 -f` **directly from these
paths** on 2026-09-26, in the order listed:
`/private/tmp/claude-501/-Users-vishnuvardhanreddy-guard/0684c545-86d8-4d7a-a59f-7d168ae2ce8d/scratchpad/<file>`.
mtime is the source file's, before copying.

| file | role | sha256 | mtime (PT) |
|---|---|---|---|
| `q11_bethel_c3574592_correction.sql` | Q11 preview (ends `ROLLBACK`) | `cb9bb224f6d49d8b47d2b1ccbec65a1b70478a5ca8ff869f1471e5f21b7359ca` | 2026-09-26 06:07:14 |
| `q11_bethel_c3574592_correction_COMMIT.sql` | Q11 applied | `897c227bf8fd0d9286341a87348ef7a38fb660106234fdb20a149bcb2feba43b` | 2026-09-26 06:58:37 |
| `q8a_bethel_c3574592_missed_rows.sql` | 8-a preview (ends `ROLLBACK`) | `43425bd5bf40ac8702914a9620e8c93455e6329ed915cbc95295daa948ff9696` | 2026-09-26 07:01:51 |
| `q8a_bethel_c3574592_missed_rows_COMMIT.sql` | 8-a applied | `35636b8b43712962d189ac5f2918abb5ae3a07c0781757762b2e5d1c6d5804dd` | 2026-09-26 07:12:36 |

Each COMMIT file differs from its preview in the final statement only
(`diff` → one changed line): Q11's reads `COMMIT;   -- PREVIEW. Change to COMMIT
only after approval.` — the keyword alone was swapped, so the comment went stale;
8-a's reads `COMMIT;`. Both carry in-transaction assertions (exact row counts,
preconditions). Before they ran, each was tested on a throwaway local PG 18.6
seeded from copies of the audited rows:
- **Q11:** the preview rolled back from both starting states (session open;
  already swept at 06:30), the COMMIT variant landed, a re-run refused, and a
  manually closed session refused.
- **8-a:** the preview rolled back, the COMMIT variant landed, a re-run refused,
  and the pre-Q11 state refused.

8-a's precondition requires Q11's end state, so the order above is enforced by
the SQL itself.

**Code: `92e5fbc`** — `fix(api): auto clock-out records the scheduled end, not the
sweep time` (U4a, branch `fix/autoclose-anchor-scheduled-end`). **Not merged, not
deployed** at the time of writing. It removes the 30-35 min an auto-close adds;
it does not stop an 18-hour shift being created (U5) or make it correctable
while active (U2).

## 4. Verification

Production reads after the corrections (2026-09-26, 07:19 PT and again 08:24 PT):

| check | value |
|---|---|
| shift status / window | `completed`, 2026-09-25 12:00 → 18:00 PT |
| session clock-out / reason / total_hours | 18:00:00 PT, `admin_corrected`, 5.912851 |
| violation `201fea51` | resolved 18:05:45 PT, 0 min |
| breaks on the session | 0 |
| `missed_pings` / `missed_reports` on the session | 11 / 1 |
| rows with `clock_out_reason = 'admin_corrected'` platform-wide | 1 (this session) |

The corrected figures on the client's daily report (5h55m, clock-out 6:00 PM, pings
0/11) are what `sendDailyShiftReport` renders from those rows by construction
(`services/email.ts:773`, `:783`, `:664`). **Not yet observed** — the 09:00 PT run
had not happened when this was written.

## What the corrections did NOT undo

- **103 notification rows** on the session (76 created after 18:00 PT) and the
  pushes that went with them, including the 05:55 AM clock-out reminder. 36 of
  them (24 `missed_ping`, 12 `missed_report`) now carry a `missedPingId` /
  `missedReportId` pointing at a deleted row. Inert: the guard's feed shows these
  types only while their session is open (`routes/notifications.ts:96-100`).
- The 18:05 PT **breach notification, guard push and admin breach email**
  (email delivery UNVERIFIED).
- The **violation row** itself — still listed on the client security-events page,
  now at 0 minutes.
- `clock_out_reminder_sent_at` (05:55 PT) and `last_ping_reminder_window` (05:30 PT)
  on the session.
- **No audit row.** `shift_schedule_audit` only accepts `action =
  'shift_schedule_edited'` by `company_admin`/`vishnu`; a hand correction cannot be
  recorded there honestly. This file is the record.
- **No notice to the guard.** No `shift_schedule_edited` push; the guard's app kept
  the 06:00 end until a cold start.
- `'admin_corrected'` is a value no code writes (N120).
- The precedent shift `b3a29807` (2026-08-23) was not touched; it has no inflated
  hours.

## Decisions taken in the incident (2026-09-26, Vishnu)

| # | decision | became |
|---|---|---|
| **1-a** | Correct this shift: `scheduled_end` → 2026-09-25 18:00 PT; session closed at 18:00 PT; open breaks closed; `total_hours` recomputed with `autoCompleteShifts`' exact formula; shift `completed`. Conditional on the evidence showing activity through the 17:30 PT window. | Q11 |
| **2-a** | Admin EDIT TIMES on the existing shift detail page: a scheduled shift edits start + end; an active shift edits the end only; an end already in the past on an active shift closes the session at that time. Mobile refetch follows later as an OTA. | D20, U2 |
| **3-b** | Grace 30 → 15 min. Auto-close records `GREATEST(clocked_in_at, scheduled_end)` instead of `NOW()`. | D18 — U4a (anchor, `92e5fbc`), U4b (grace) |
| **4-a** | Confirm step on create/edit when the duration exceeds 12 h. | D20, U5 |
| **5-a** | 1-a's condition accepted on presence evidence — last report 17:25:35 PT in-fence, native geofence exit 18:05:45 PT, zero pings all shift. Clock-out anchored at 18:00 PT. | Q11 |
| **6-a** | `clock_out_reason = 'admin_corrected'` — the only in-DB trace of the hand correction, since `shift_schedule_audit`'s CHECK cannot record one; the row loses the AUTO_CLOSED flag in the hours export. | Q11; N120 |
| **7-a** | Violation `201fea51` re-resolved by the job's own rule — born after the corrected end, so resolved at `occurred_at`, 0 minutes; the row stays on the client violations list. | Q11 |
| **8-a** | Delete this session's overnight stored rows: `missed_pings` and `missed_reports` with windows starting at or after 18:00 PT (24 + 12); keep the in-shift rows (11 + 1). | 8-a SQL |

Later decisions from the same review are recorded in `../DECISIONS.md` as D18
(auto clock-out anchor, grace, backfill), D19 (Payable hours) and D20 (admin shift
edits, 12-hour confirm).

## 5. Learning

- `../DECISIONS.md` **D18, D19, D20** (new).
- `../OPEN-ITEMS.md` **N110 – N121** (new), filed from this incident and the U4a
  review.
- Code: `92e5fbc` (U4a) on `fix/autoclose-anchor-scheduled-end`; U4b (grace 30 →
  15), U2 (edit an active shift's end), U5 (12-hour confirm) and U6 (Payable)
  are decided and not yet built.
- The 206 historical auto clock-outs that carry the same 30-35 min are corrected by
  rule, not in this incident: the q9c backfill runs only after U4a is deployed and
  verified (D18).
