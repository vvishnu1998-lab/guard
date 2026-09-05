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

---

# The runJob wrapper (Phase 2, 2026-09-05)

All 19 jobs now register through `runJob` in `apps/api/src/jobs/_run.ts`.
`grep -rn "cron.schedule" apps/api/src/jobs` returns hits in `_run.ts` only;
`grep -rn "runJob(" apps/api/src/jobs` returns 19 call sites.

**No job's inner logic changed.** Existing try/catch blocks, existing log lines
and the six pre-existing heartbeat lines are all untouched. The wrapper is
strictly additive.

## What each tick now does

1. If `sentryMonitor` is set, send a Sentry check-in `in_progress`.
2. Run the job body.
3. On a throw: log `[<name>] tick failed`, report to Sentry tagged
   `job=<name>`, mark the tick `error`. **The throw never escapes** — which is
   what makes the failure visible instead of vanishing into node-cron's
   unlistened `task-failed` emit.
4. In `finally`: send the closing check-in (`ok` / `error`) if enabled, then
   upsert one row into `cron_heartbeats`.

The heartbeat write is inside its own try/catch and can never throw. Between
merging this code and applying v67 the table does not exist, and in that window
every job runs normally and only logs `[<name>] heartbeat write failed`.
Verified against a throwaway local database on 2026-09-05 by dropping the table
and re-running all 19: every job still executed, only the heartbeat line
errored.

## Why captureCheckIn and not `Sentry.withMonitor`

`withMonitor` exists in `@sentry/node` 8.55.2 (`@sentry/core`
`exports.d.ts:95`) and is the documented ergonomic wrapper. **It is not safe
for an async callback that can reject.** From
`node_modules/@sentry/core/build/cjs/exports.js:170-179`:

```js
if (is.isThenable(maybePromiseResult)) {
  Promise.resolve(maybePromiseResult).then(
    () => { finishCheckIn('ok'); },
    e => { finishCheckIn('error'); throw e; },
  );
}
```

The promise that `.then()` returns is discarded — not returned, not awaited,
not caught. When the callback rejects, the handler re-throws into that orphaned
promise, producing a genuine unhandled rejection separate from the one the
caller awaits. Node 20+ defaults to `--unhandled-rejections=throw` and
`package.json` pins `engines >=20.0.0`, so the process would terminate and
Railway would restart it (`ON_FAILURE`, max 3 retries).

Using it would have converted today's silent-failure mode into a crash loop.
`captureCheckIn` (`exports.js:128-140`) is synchronous, returns a string, and
creates no promise at all.

## Why `task-failed` attaches to a private field

node-cron 3.0.3 emits `task-failed` on the **inner `Task`**, not on the
`ScheduledTask` that `schedule()` returns (`src/scheduled-task.js` constructs
`this._task = new Task(func)`; `src/task.js:25` emits on that). Attaching to
the returned object alone would be a listener that can never fire, so
`attachTaskFailedListener` reads `_task` defensively and falls back to the
public object if the internal shape changes.

It is belt-and-braces regardless: the tick callback no longer rejects, so this
path is unreachable in normal operation.

## The 19 registrations

**`sentryMonitor` is now `false` on all 19 jobs.** The capability is retained
in `_run.ts` behind the flag -- it is off, not deleted -- and `_run.test.ts`
still exercises both branches.

Dead-cron detection moved to `GET /health/crons` probed by Sentry Uptime. Two
reasons, one of them measured:

1. **Cost.** The three per-minute jobs alone would produce roughly 1.3M
   check-ins a month, and the org's cron-monitor quota could not be read from
   the Sentry API.
2. **The check-ins were producing false alarms.** Measured 2026-09-05:
   `orphanedSessionCheck` ran at 10:10:00.430Z, completed in 80 ms and wrote
   `last_result='ok'`; Sentry raised `Cron failure: orphanedsessioncheck`
   (issue `NETRAOPS-API-G`) at 10:20:00Z -- exactly `max_runtime` (10 min)
   later. That is the signature of an `in_progress` check-in Sentry received
   and a closing `ok` it never matched, so it timed the check-in out. Why the
   closing check-in did not match is UNCONFIRMED. A monitor that reports
   failures for jobs that ran fine trains you to ignore it.

| job name (= `cron_heartbeats.job_name` = Sentry monitor slug) | expr | timezone | `sentryMonitor` |
|---|---|---|---|
| `autoCompleteShifts` | `*/5 * * * *` | container (UTC) | **false** |
| `breakExpiryCron` | `* * * * *` | container (UTC) | **false** |
| `chatRetention` | `0 * * * *` | container (UTC) | **false** |
| `clockOutReminder` | `*/5 * * * *` | container (UTC) | **false** |
| `dailyShiftEmail` | `0 9 * * *` | **America/Los_Angeles** | **false** |
| `expireSwapRequests` | `* * * * *` | container (UTC) | **false** |
| `handoffNudge` | `*/5 * * * *` | container (UTC) | **false** |
| `lateClockInReminder` | `*/5 * * * *` | container (UTC) | **false** |
| `locationIntegrityCron` | `20 0 * * *` | **America/Los_Angeles** | **false** |
| `missedPingCron` | `*/5 * * * *` | container (UTC) | **false** |
| `missedReportCron` | `*/5 * * * *` | container (UTC) | **false** |
| `missedShiftAlert` | `*/5 * * * *` | container (UTC) | **false** |
| `monthlyHoursReport` | `0 12 1 * *` | container (UTC) | **false** |
| `nightlyPurge` | `0 0 * * *` | container (UTC) | **false** |
| `orphanedSessionCheck` | `10 * * * *` | container (UTC) | **false** |
| `pingReminder` | `* * * * *` | container (UTC) | **false** |
| `preShiftReminder` | `*/5 * * * *` | container (UTC) | **false** |
| `shiftStartReminder` | `*/5 * * * *` | container (UTC) | **false** |
| `taskDueCron` | `*/5 * * * *` | container (UTC) | **false** |

**Zero with Sentry check-ins (Phase 4, 2026-09-05).** Both timezone options are preserved
exactly as they were; the other 17 jobs pass no options object at all, which is
byte-identical to the two-argument `cron.schedule` calls they replaced.

Boot log: `[jobs] registered 19 jobs with heartbeats`, emitted from
`index.ts` after the job imports (registration is an import side-effect, so
calling it earlier would report 0).

## Reading the heartbeats

```sql
SELECT job_name, last_result, NOW() - last_tick_at AS age
FROM cron_heartbeats ORDER BY age;
```

A row whose `age` exceeds its job's interval is the alarm. There is no history
in this table — `job_name` is the primary key and each tick overwrites the row,
so it never grows and needs no retention step. The history lives in Sentry.

`last_error` is truncated to 500 characters by the writer. It is a triage hint;
the full error is in Sentry and in the Railway log.

## REVOKE caveat — affects this table's neighbours, not this table

`scripts/ops/readonly-column-revoke.sql` narrows `claude_readonly` from
table-level SELECT to column-level SELECT on eight tables (`guards`,
`company_admins`, `clients`, `guard_devices`, `password_reset_tokens`,
`revoked_tokens`, `login_attempts`, `vishnu_state`).

**Column-level grants do not extend to columns added later.** After that script
runs, any `ALTER TABLE ADD COLUMN` on those eight tables produces a column
`claude_readonly` cannot read, and the failure is a runtime 42501 on a query
that used to work — typically a `SELECT *`. Any future migration touching those
tables must carry its own `GRANT SELECT (new_column)`, or deliberately withhold
it. Tracked as N10 in `OPEN-ITEMS.md`.

`cron_heartbeats` itself keeps a plain table-level grant and is unaffected.

## UNVERIFIED

- **Sentry cron-monitor quota.** `GET /api/0/organizations/netraopscom/`
  returns HTTP 200 with `status: active` but no `planTier` field, an empty
  `quota` object, and no cron-related entries in `features`. The plan name
  could not be determined from the API. The conservative rule above (no
  check-ins for per-minute jobs) stands until Vishnu confirms the quota.
- **Production runtime behaviour.** Everything above was verified against a
  throwaway local Postgres 14.22 database, not production. Confirmed there: the
  full migration chain applies from empty including v67, v67 is idempotent on
  re-run, `[jobs] registered 19 jobs with heartbeats` prints,
  `cron.getTasks()` returns 19, all 19 write `last_result='ok'`, and dropping
  the table degrades to log-only without stopping any job. Production
  verification happens at `RUNBOOK-phase2-apply.md` step (h).

---

# GET /health/crons (Phase 4, 2026-09-05)

The dead-cron probe. `GET /health` is **not** a substitute: it runs `SELECT 1`
and nothing else, so a wedged job leaves it returning `{"status":"ok"}`.

Route: `apps/api/src/index.ts`, immediately after `/health`, under the same
`globalLimiter` (500 requests / 15 min). Logic lives in `computeStaleJobs`
(`jobs/_run.ts`) so it is unit-testable without express or a database.

## The 2x rule

Two rules, depending on whether the job has ever ticked:

- **Has a row** — stale when the row is older than **twice** its own interval.
  2x absorbs one skipped tick without alarming; beyond that is a real gap.
- **No row** — stale only once it has been *registered* for longer than that
  same 2x window. Before then, "no row" means "not due yet".

Exactly 2x is not stale on either branch; one tick past it is (both boundaries
asserted in `_healthCrons.test.ts`).

Intervals are derived at registration by `cronIntervalSeconds`, a deliberately
narrow helper covering the five shapes actually in use. Anything else **throws
at boot**, so an unsupported expression fails loudly rather than silently
producing a wrong threshold. `cron-parser` is not a dependency and was not
added for five patterns.

| expression | interval |
|---|---|
| `* * * * *` | 60 s |
| `*/N * * * *` | N x 60 s |
| `M * * * *` | 3600 s |
| `M H * * *` | 86400 s |
| `M H D * *` | 2678400 s (31 d — the longest month, so the threshold never fires early on a short one) |

## Responses

| condition | status | body |
|---|---|---|
| all fresh | 200 | `{"status":"ok","jobs":19,"stale":[]}` |
| any stale | 503 | `{"status":"stale","jobs":19,"stale":[{"job","age_s","interval_s","last_result"}]}` |
| DB unreachable | 503 | `{"status":"error"}` |

`age_s` and `last_result` are `null` for a job that has never ticked, which
distinguishes "never ran" from "ran and went quiet".

A heartbeat row with no matching registered job is **ignored**, not reported —
that is a renamed or removed job leaving a stale row behind, not an outage.

Job names and timings only. No guard, site or tenant data passes through this
route, per the data rule in `POLICY.md`.

## ACCEPTED v1 LIMIT — detection lag

Lag scales with the interval, because the threshold is a multiple of it:

| job class | flagged after |
|---|---|
| per-minute (3 jobs) | ~2 minutes |
| `*/5` (10 jobs) | ~10 minutes |
| hourly (2 jobs) | ~2 hours |
| **daily (3 jobs)** | **up to 48 hours** |
| **monthly (1 job)** | **about 62 days** |

A `monthlyHoursReport` that dies is not detected for two months. Accepted for
v1. The fix is to compare against the next expected fire time rather than a
multiple of the interval, which needs a real cron parser.

## First-tick grace (Phase 4.1)

A job that has never ticked is **not** immediately stale. `RegisteredJob`
records `registeredAt` at boot, and the no-row branch waits the same 2x window
before reporting.

Without it, every never-ticked job was stale the instant the process booted, so
this route returned **503 from deploy until all 19 jobs had fired** — up to a
month from a fresh database, gated by `monthlyHoursReport`. That is a probe
that alarms continuously and then gets muted, right before it would start
meaning something.

**It costs no detection speed.** The grace uses the same 2x threshold as the
row-age branch, so a genuinely dead job is caught on exactly the same schedule:
a daily job within 48 hours, the monthly one within about 62 days. The only
thing removed is the false positive at t=0.

`registeredAt` resets on every restart, which is correct — a fresh process
legitimately has no row yet for a job that is not due. A job that **has** a row
is unaffected: the row outlives restarts and its age is measured from the last
real tick, so a just-restarted process still reports a long-dead job
(asserted).

Measured in production 2026-09-05 11:00Z, before this change shipped: 15 of 19
rows present, all `last_result='ok'`; the four absent were exactly the daily and
monthly jobs — `dailyShiftEmail`, `locationIntegrityCron`, `monthlyHoursReport`,
`nightlyPurge` — none of which had been due since the deploy. Under the grace
rule that state is **200 `stale:[]`**, which is the honest answer.
