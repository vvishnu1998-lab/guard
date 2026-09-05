# CRONS — the 19-job fleet

Verified 2026-09-05 against `main` @ `40d2297`. This is the reference Phase 2
(heartbeats) builds from. Re-derive from source before trusting it after any
change under `apps/api/src/jobs/`.

**There are 19 scheduled jobs, not 5.** All are registered by bare import
side-effect in `apps/api/src/index.ts:38-56`:

```
apps/api/src/index.ts:37  // Cron jobs
apps/api/src/index.ts:38  import './jobs/nightlyPurge';
   … through …
apps/api/src/index.ts:56  import './jobs/clockOutReminder';
```

All 19 use `node-cron@3.0.3`. `grep -rn "setInterval" apps/api/src` returns exactly
one hit — a comment at `routes/shifts.ts:2619`. There are no hand-rolled timers.

---

## The node-cron `task-failed` finding — read this before designing any alerting

**A throw inside a tick cannot kill the timer loop, and cannot crash the process.
It also cannot be seen.**

1. `node_modules/node-cron/src/scheduler.js:36` —
   `this.timeout = setTimeout(matchTime, delay)` sits inside `matchTime`,
   unconditional, entirely independent of task execution. The 1-second poll
   re-arms no matter what the task did.

2. `node_modules/node-cron/src/task.js:24-25` —
   ```js
   return exec
       .then(() => this.emit('task-finished'))
       .catch((error) => this.emit('task-failed', error));
   ```
   node-cron `.catch()`es every async rejection itself, so it never reaches Node's
   unhandled-rejection path and never reaches Sentry's
   `onUnhandledRejectionIntegration`.

3. `grep -rn "task-failed" apps/api/src` → **no matches.** No listener is ever
   attached to `_task`. `'task-failed'` is not `'error'`, so an emit with zero
   listeners is a silent no-op.

4. There is no global net either: `grep -rn "unhandledRejection\|uncaughtException" apps/api/src/`
   returns nothing. The comment at `jobs/autoCompleteShifts.ts:304` referring to
   "the global unhandled-rejection net" describes something that does not exist.
   (Moot in practice — node-cron catches first.)

**Consequence.** A job whose tick throws before its own `catch` — or that has no
`catch` — produces **no log, no Sentry event, no crash, no restart**. It silently
does nothing, forever, while `/health` keeps returning `{"status":"ok"}`.

**Design implication for Phase 2:** heartbeats must be *positive emission* with
absence-alerting. Error-driven alerting cannot work here, and "no output" is the
normal steady state for 13 of the 19 jobs (see table) so silence is not a signal.

---

## Catch coverage

**Four jobs have no top-level catch at all:**

| job | unwrapped call | note |
|---|---|---|
| `dailyShiftEmail` | `pool.query` at `:24` | DB blip at 09:00 PT → "Starting" logged, "Done" never, nothing else |
| `missedShiftAlert` | `pool.query` at `:25` | fully silent |
| `monthlyHoursReport` | `pool.query` at `:52` | "Starting" logged, "Done" never |
| `nightlyPurge` | — | **deliberate**, documented at `nightlyPurge.ts:58-63`: *"Exceptions are deliberately not caught here."* Each step has its own try/catch → `errorStep()`. |

**Six jobs report a top-level failure to Sentry:** `autoCompleteShifts`,
`breakExpiryCron`, `clockOutReminder`, `missedReportCron`, `orphanedSessionCheck`,
`taskDueCron`.

**Nine jobs catch to `console.error` only — the error exists solely in Railway
stdout:** `chatRetention`, `expireSwapRequests`, `handoffNudge`,
`lateClockInReminder`, `locationIntegrityCron`, `missedPingCron`, `pingReminder`,
`preShiftReminder`, `shiftStartReminder`.

Two sharp edges inside that set:
- **`pingReminder` imports Sentry but does not use it at `:407`** — its top-level
  catch is `console.error` only.
- **`missedPingCron` does not import Sentry at all.**

---

## The 19 jobs

| # | Job (file:line) | Interval | TZ | QUIET tick logs | ACTIVE tick logs | Throw → |
|---|---|---|---|---|---|---|
| 1 | `autoCompleteShifts.ts:281` | `*/5 * * * *` | container (UTC) | **`[auto_complete_shifts.tick]` {all zeros, duration_ms} — HEARTBEAT** | + `[autoCompleteShifts] Auto-completed N shift(s), closed N open session(s), N open break(s)` | caught `:302` → console + **Sentry** |
| 2 | `breakExpiryCron.ts:339` | `* * * * *` | container (UTC) | **`[break_expiry.tick]` {all zeros, duration_ms} — HEARTBEAT** | + `[breakExpiry] auto-closed N break(s), finalized N overrun verdict(s) (N flagged), return-checked N (N pushed)` | caught `:363` → console + **Sentry** |
| 3 | `chatRetention.ts:8` | `0 * * * *` | container (UTC) | **nothing** (gated `rowCount > 0`) | `[chat-retention] Deleted N messages older than 48h` | caught `:16` → console only |
| 4 | `clockOutReminder.ts:220` | `*/5 * * * *` | container (UTC) | **`[clock_out_reminder.tick]` {claimed:0, pushed:0, failed:0, duration_ms} — HEARTBEAT** | same nonzero; `[clock_out_reminder] push failed session=…`; Sentry warn `clock_out_reminder_push_failed` when `failed > 0` | caught `:207` → console + **Sentry** |
| 5 | `dailyShiftEmail.ts:19` | `0 9 * * *` | **America/Los_Angeles** | `[daily-email] Starting at <ISO>` + `[daily-email] Done — sent: 0, failed: 0` (both unconditional) | + `[daily-email] Failed for shift <id>` | **NO top-level catch** → silent; "Starting" with no "Done" |
| 6 | `expireSwapRequests.ts:243` | `* * * * *` | container (UTC) | **nothing** — both halves early-return at `:124` and `:226` (`if (!result.rowCount) return 0`) *before* their logs | `[expire-swap] handoff: N row(s) expired (window 30m)` / `[expire-swap] swap: N row(s) expired (window 24h / start-1h)` / `[expire-swap] reminder: N pending swap(s) reminded at halfway` | 2 catches `:249`, `:254` → console only |
| 7 | `handoffNudge.ts:113` | `*/5 * * * *` | container (UTC) | **nothing** — early return `:76` precedes the log at `:109` | `[handoff-nudge] nudged N stuck handoff(s)` | caught `:116` → console only |
| 8 | `lateClockInReminder.ts:114` | `*/5 * * * *` | container (UTC) | **nothing** (gated `t10+t15+t30+skipped > 0`) | `[lateClockIn] fired t+10=N t+15=N t+30=N skipped=N (Nms)` | caught `:194` → console only |
| 9 | `locationIntegrityCron.ts:40` | `20 0 * * *` | **America/Los_Angeles** | `[integrity.cron] complete in Nms new_flags=0 …` (unconditional) | same nonzero | caught `:33` → console only |
| 10 | `missedPingCron.ts:81` | `*/5 * * * *` | container (UTC) | **nothing** (gated `created > 0 \|\| considered > 20`) | `[missedPingCron] considered=N created=N`; `[missedPing.waived.break] session=… window=…` | caught `:194` → console only, **no Sentry import** |
| 11 | `missedReportCron.ts:118` | `*/5 * * * *` | container (UTC) | **nothing** (same gate) | `[missedReportCron] considered=N created=N` | caught `:267` → console + **Sentry** |
| 12 | `missedShiftAlert.ts:24` | `*/5 * * * *` | container (UTC) | **nothing** — `if (result.rows.length === 0) return;` at `:32` | `[missed-shift] N missed shift(s) detected` + `[missed-shift] Alert sent for shift <id>` | **NO top-level catch** → silent |
| 13 | `monthlyHoursReport.ts:35` | `0 12 1 * *` | container (UTC) | `[monthly-hours] Starting at <ISO>` + `[monthly-hours] Done at <ISO>` | + `[monthly-hours] Generated for company <id> Y-M` | **NO top-level catch** → silent |
| 14 | `nightlyPurge.ts:53` | `0 0 * * *` | **container (UTC) — see note** | `[retention] starting nightly purge (dry_run=true)` + `[retention.<step>] DRY_RUN would delete N` ×9 + `[retention] complete in Ns — candidate=N deleted=N` | + `[retention.<step>] deleted N rows` / `HALT` | **NO catch at cron level** (deliberate) → silent |
| 15 | `orphanedSessionCheck.ts:151` | `10 * * * *` | container (UTC) | **`[orphaned_session_check.tick]` {orphaned:0, duration_ms} — HEARTBEAT** | + `[orphaned_session_check] N open session(s) on shifts outside ('active','scheduled') — statuses=…` + Sentry `captureMessage` | caught `:135` → console + **Sentry** |
| 16 | `pingReminder.ts:181` | `* * * * *` | container (UTC) | **nothing** — `if (pingsFired > 0)` at `:313`; `if (minute !== 0) return` at `:318` skips 59 of 60 ticks; `if (!rows.length) return` at `:319` | `[pingReminder] schedule-anchored: fired N ping reminder(s)`; hourly `[pingReminder] Sent activity-report reminder to N of M active guards`; `[pingReminder.skipped.break]` / `.skipped.answered` / `[activityReportReminder.skipped.break]` / `[taskReminder.skipped.break]` | caught `:407` → **console only, no Sentry** (despite importing it) |
| 17 | `preShiftReminder.ts:37` | `*/5 * * * *` | container (UTC) | **`[preShiftReminder] candidates=0 success=0 failure=0`** in `finally` — HEARTBEAT | same nonzero | caught `:123` → console only |
| 18 | `shiftStartReminder.ts:36` | `*/5 * * * *` | container (UTC) | **`[shiftStartReminder] candidates=0 success=0 failure=0`** in `finally` — HEARTBEAT | same nonzero | caught `:120` → console only |
| 19 | `taskDueCron.ts:55` | `*/5 * * * *` | container (UTC) | **nothing** (gated `notified > 0 \|\| deferred > 0 \|\| considered > 20`) | `[taskDueCron] considered=N notified=N deferred=N` | caught `:186` → **Sentry** + console |

**Existing heartbeats: 6 of 19** — #1, #2, #4, #15, #17, #18.
**13 of 19 are indistinguishable from dead on a quiet tick.**

---

## Timezone note

Only two jobs pass a `timezone` option: `dailyShiftEmail` (#5) and
`locationIntegrityCron` (#9), both `America/Los_Angeles`. `grep -L timezone
apps/api/src/jobs/*.ts` confirms the other 17 use the container clock (UTC on
Railway).

For the 15 interval-based jobs (`*/5`, `* * * * *`, hourly) this is irrelevant.
It matters for exactly one job:

**`nightlyPurge` runs `0 0 * * *` with no timezone → 00:00 UTC ≈ 17:00 PT.** The
"nightly" purge runs at 5 PM Pacific, mid-evening-shift. `locationIntegrityCron.ts:8-9`
claims it *"Runs at 00:20 PT — deliberately 20 minutes after nightlyPurge (00:00)"*.
That comment is false: locationIntegrity at 00:20 PT is 07:20/08:20 UTC, roughly
**8 hours** after the purge, not 20 minutes. Tracked as N5 in `OPEN-ITEMS.md`.

`monthlyHoursReport` (`0 12 1 * *`, no TZ → 12:00 UTC) is deliberate and documented
in its own header — 12:00 UTC clears local midnight for every US zone with margin.
