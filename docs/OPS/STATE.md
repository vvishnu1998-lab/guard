# STATE — state of the world

Every line below was verified at the timestamp on its section. Nothing here is
copied from chat memory. A value that could not be checked from repo, DB, or CLI
is marked **UNVERIFIED** and names who fills it.

Re-verify before acting. This file goes stale the moment something deploys.

---

## Git — verified 2026-09-08 21:40 UTC (14:40 PT)

| thing | value |
|---|---|
| `main` sha | `dfdcc8c` |
| `main` subject | `Merge pull request #23 from vvishnu1998-lab/feat/thread-ping-interval` |
| last known good `main` sha | `996733c` (PR #19) — Railway `7579554d-4209-4b20-bd73-20208a4818fb` SUCCESS, `/health/crons` 200 with 19 jobs and `stale: []`, `/health` 200, and GitHub's combined status on the sha is `success` on **both** contexts (`adorable-courage - guard`, `Vercel`). Vercel alias confirmed by content-hash match between the apex and the Production deployment, not by trusting the dashboard. **NOT advanced to `dfdcc8c`**: PRs #18/#21/#22/#23 merged green, but "last known good" in this table means post-merge Railway + `/health/crons` + Vercel alias re-verified on the sha, and that pass has not been run since. Advance it only after re-running those four checks. |
| working tree | clean (untracked only: `.playwright-mcp/`, `.vscode/`, `load test/`, `marketing/`, 4 loose PNGs) |
| branch protection on `main` | **ENFORCED** — **two** required status checks: `Scan for hard-coded secrets` **and** `Ping window anchor (TS vs SQL)`. `strict: true`, `enforce_admins: true`, `allow_force_pushes: false`, `allow_deletions: false`, `required_approving_review_count: 0`, `required_linear_history: false` |
| CI | **three** workflows: `gitleaks` (266080625), `ops-triage` (350875238), `window-anchor` (353361978) — all active. **Not advisory** — `gitleaks` and `window-anchor` supply the two required contexts, so either failing blocks the merge. |

**Worktrees** (`git worktree list`) — 6 exist under `.claude/worktrees/`; none pins
`main`. The primary checkout at `/Users/vishnuvardhanreddy/guard` is on `main` @ `e7e868a`.

### Direct refspec pushes to `main` are DEAD — PR flow only

Pushing a bare sha at `main` (`<sha>:main`) **cannot work any more**, whatever the diff
contains — docs-only included. Protection rejects it with **GH006** ("Changes must be
made through a pull request"), naming the expected `Scan for hard-coded secrets` status.
This is not a permissions problem to route around: `enforce_admins: true`, so it binds
the repo owner too.

**This cost a night's plan.** The split-push sequence for the vehicle-inspection work
was built on the "NONE / 404 Branch not protected" row that stood here until this
commit. That row was accurate when written on 2026-09-05 and went stale silently — no
announcement, and nothing in the repo records who enabled protection or when. The push
was rejected, nothing landed, and the work was re-cut as PR #16 (API + docs) and
PR #17 (web + docs).

**Ordering now lives in the PR sequence, not in the commit order.** A change whose parts
must land in a set order — here the API endpoint before the web tab that calls it, or
the tab 404s — needs **one PR per stage**, each merged and verified before the next is
opened. A single branch carrying the commits in the right order does *not* give you
that: merging it lands everything at once.

`strict: true` compounds this — a PR must be up to date with `main` before it can merge,
so a second PR opened alongside the first needs a rebase once the first lands. Open them
sequentially, not in parallel.

**Re-verify this row before planning any push.** It flipped once with no signal; the
only reliable check is
`gh api repos/vvishnu1998-lab/guard/branches/main/protection` at the moment of use.

---

## Shipped 2026-09-08 — per-site ping cadence, Phases A/B/C/D

Four PRs, merged in order. **All four are behavioural no-ops today**: every one
of the 23 production sites reads `ping_interval_minutes = 30`, and the
capability gate returns 30 for every client in the field. What shipped is the
plumbing and the proof, not a change in what any guard experiences.

| PR | branch | what |
|---|---|---|
| **#18** | `fix/live-status-lateness-anchor` | live-status lateness anchored on `scheduled_start`; `check-window-anchor` wired to CI |
| **#21** | `feat/schema-v68-session-ping-interval` | `schema_v68` — the column, nullable, unread |
| **#22** | `feat/session-ping-interval-snapshot` | snapshot written at clock-in on both paths, capability-gated |
| **#23** | `feat/thread-ping-interval` | interval threaded through all six grid consumers |

### #18 — live-status lateness was wrong in production, in BOTH directions

`computeLateness(last_ping_at, [0, 30])` graded every ping against `:00`/`:30`
past the hour. Ping windows are `scheduled_start + N*30min`, which lands there
only when `scheduled_start` does — true for **466 of 492** production shifts,
false for **26**.

**The case worth naming is the UNDERSTATEMENT, not the overstatement.** On
session `9021350a` (375 Shopping Complex, `scheduled_start` **14:48 PT**,
2026-09-07) a ping submitted at **18:04:21** for the **17:48** window is **16
minutes late** and the column rendered it **`+4m late`**. The column made a late
guard look punctual. The mirror case — an on-time 15:18 ping rendering
`+18m late` — is the visible half and the harmless one.

That asymmetry is the whole point: had it only ever exaggerated, the column
could have been read as a conservative over-estimate and left alone.

Fixed by `computeLatenessAnchored`, measuring `(ping − scheduled_start) mod
interval`. No API change was needed — `scheduled_start` had been on
`GET /api/admin/live-guards` since `9c98957`; the client simply never declared
it. Unknown anchor, or a ping preceding `scheduled_start`, renders the bare time
with **no lateness clause**: state WHEN, not HOW LATE.

`computeLateness` is byte-identical to its pre-PR form and still serves the two
hourly-report columns, whose cadence really is wall-clock top-of-hour.

**This bug class had already been found and fixed once**, in the activity log
(`ActivityLogTable.tsx`). The comment left behind by that fix asserted
`computeLateness` was "still correct for the live-status page" — wrong twice
(it never measured "vs. now"; there *was* an anchor available) — and that
sentence is why the second call site survived. Corrected in the same PR.

### #18 — `check-window-anchor` previously exited 0 with no database

Three source comments claimed the script "fails the build". Nothing ran it:
`build` is `tsc` alone, `apps/api` has no `test` script, and the only workflows
were `gitleaks` and `ops-triage`.

Worse, wiring it as-is would have produced a **permanently green required check
that verified nothing**: with no connection string the script exits **0** with a
`SKIPPED` notice. Measured both ways before the fix — `exit 0` with a database,
`exit 0` without one.

`REQUIRE_DB=1` turns that skip into a hard failure with the reason printed;
unset, the bare-checkout skip is unchanged. `.github/workflows/window-anchor.yml`
runs it on every PR and push to `main` against a throwaway `postgres:16` service
container — **no secret, no schema seeding**, because the script's query is a
`generate_series` over bind parameters and touches no table. CI therefore never
points at production.

This is the same silent-failure class as the `railway-logs` collector, which
exited 0 while printing its own error and was recorded as a successful
collection. Reintroducing it inside the commit meant to close it would have been
the whole point missed.

### #21 / #22 — the snapshot

`schema_v68` adds `shift_sessions.ping_interval_minutes INTEGER NULL` — no
default, no CHECK. NULL means "session predates the column", which is a
different statement from "runs on 30"; readers `COALESCE(x, 30)` in one place
rather than a backfill asserting a cadence nobody measured.

Written once at clock-in on **both** session-creation paths —
`POST /:id/clock-in` and `POST /:id/handoff-clock-in`, the only two INSERTs into
`shift_sessions` outside five unwired test scripts.

**Capability-gated on `runtime/`.** Honouring a non-30 cadence is a JS-level
capability in `apps/mobile/lib/pingSchedule.ts`, which hardcodes 30 on every
shipped build. Stamping 45 onto a session whose handset still counts in 30-minute
steps would judge the guard against a grid their own app never showed them.
Threshold `MIN_RUNTIME_READING_SESSION_INTERVAL = '1.1.0'` **does not exist** —
production is on runtime 1.0.17 — so the gate returns 30 for every client today.

`handoff-clock-in` already joined `sites` and cost no extra round trip; `si` was
deliberately kept out of `FOR UPDATE OF ssr, sh`. `clock-in` reads the site value
as its **own** SELECT rather than joining `sites` into a query carrying a bare
`FOR UPDATE`, which in Postgres locks a row from every table in the join and
would serialise concurrent clock-ins across every guard at that site.

**Wire change, recorded as such and not as "no behaviour change":** both routes
end in `RETURNING *`, so the clock-in and handoff-clock-in **201 bodies each
gained a `ping_interval_minutes` field**. Additive and inert — mobile types the
response narrowly, spreads it into a store that is not persisted, and nothing
branches on it.

### #23 — threaded through all six grid consumers

`scheduleWindows`, `completedTrackableWindows` and `windowJustClosed` take an
**optional** trailing `intervalMs`, defaulting to `PING_WINDOW_MS` so frozen
`shiftHours.ts` (Phase E) keeps compiling untouched. Consumers, all reading the
**session snapshot**:

`missedPingCron` · `pingReminder` · `services/email.ts` · `routes/locations.ts` ·
`routes/activityLog.ts` · `scripts/check-window-anchor.ts`

**`activityLog.ts` was a sixth consumer nobody had counted.** It carried an
independent `const WINDOW_MIN = 30` and its own grid loop, importing nothing from
`pingWindows.ts`, and it drives the activity log and its PDF export — both
client-facing. Threading the other five and leaving it would have put the log on
a different grid from `missed_pings` for the same shift.

`RECOVERY_MS` moved from tick-scoped to per-row: `min(10 min, interval/3)`. The
old flat 10 minutes was justified as "well inside the 30-min window", which stops
being true as cadence varies — 67% of a 15-minute window, and at a cadence of 10
or below the range spans past the next window's close, at which point
`windowJustClosed` has already advanced and the recovery **silently becomes a
no-op**. At 30 min the formula computes exactly 10 minutes.

The `n < 250` loop bounds were a latent bug, not merely a literal: 250 silently
meant "125 hours" only because the interval was 30. At interval 15 the same
literal caps the grid at 62 h — enough to **truncate** a long shift's window list
with no error. Now span-derived, yielding exactly 250 at 30 minutes.

### The proof — 211-session golden, byte-identical

Before branching, window lists were enumerated for **all 211 production
sessions** using the shipped code, from a frozen input fixture so the two runs
differ **only in code** — never in data or clock. Re-run on the threaded branch
fed `COALESCE(snapshot, 30)`:

```
before  211 sessions  228990 bytes  md5 a36238a254c16082023e4b7c08e20851
after   211 sessions  228990 bytes  md5 a36238a254c16082023e4b7c08e20851
```

**Byte-identical, 0 differing lines.** Four independent projections per session:
`completedTrackableWindows` at a far-future `now`, the same at the session's real
close, `scheduleWindows`' full label→start map, and `windowJustClosed`.

**Exhaustive, not sampled** — 210 of 211 rows are NULL and the one stamped row is
30, so `COALESCE(x, 30)` yields 30 for every session that exists in production.

The golden is **not committed**: it holds session ids. Regenerate it before any
future phase that touches the grid; comparing against the shipped code is the
only form of this proof that is not a tautology.

`check-window-anchor` now runs **36 comparisons** — 6 cases × 15/30/45/60/75/90.
The 30-minute row (`16/16/24/15/1/24`) is byte-identical to the pre-change 6-case
output and is the regression guard.

---

## Railway (API) — deployment row verified 2026-09-08 07:35 UTC; rest 2026-09-05 11:00 UTC (Phase 4)

| thing | value |
|---|---|
| project / env / service | `adorable-courage` / `production` / `guard` (`railway status`) |
| current deployment id | `e47c6396-6fd3-429b-82b9-75ef9d0d505c` |
| status | **SUCCESS** |
| deployed at | 2026-09-08 00:30:39 -07:00 |
| previous deployments | all `REMOVED` (Railway retains one active) — `22b51990-6fbe-48db-a6b4-c345175e4b77` and `dfe120b8-00fe-4907-b3a1-6fe1f4a8f29a` went `REMOVED` as each successor landed |
| `/health` live body | `{"status":"ok","db":"connected"}` — HTTP 200 |
| `/health/crons` live body | `{"status":"ok","jobs":19,"stale":[]}` — HTTP 200 |

**Deployment → commit linkage is READ, not inferred.** `railway deployment list`
still does not print a commit sha — but Railway posts a commit status back to
GitHub, so the mapping is one call and needs no dashboard:

```bash
gh api repos/vvishnu1998-lab/guard/commits/<sha>/status \
  --jq '.statuses[] | "\(.context)\t\(.state)\t\(.target_url)"'
```

For `e7e868a` (2026-09-08 07:35 UTC) that returns both deploy targets:

```
adorable-courage - guard  success  https://railway.com/project/6bb1814f-…/service/0d067db4-…?id=e47c6396-6fd3-429b-82b9-75ef9d0d505c&environmentId=9df064b0-…
Vercel                    success  https://vercel.com/vvishnu1998-labs-projects/guard/2v1xSXRCzxWm7fCjTcsuxWthFMdj
```

The Railway `target_url` carries `id=<deployment id>`, so commit → deployment is
exact. To pull just the id:

```bash
gh api repos/vvishnu1998-lab/guard/commits/<sha>/status \
  --jq '.statuses[] | select(.context|startswith("adorable-courage")) | .target_url' \
  | grep -oE 'id=[0-9a-f-]+'
```

`gh api repos/vvishnu1998-lab/guard/deployments?sha=<sha>` gives the same linkage
from the other direction, with an `environment` of `Production` (Vercel) or
`adorable-courage / production` (Railway).

**This replaces a timestamp-correlation inference** that previously stood here —
it matched a gitleaks run against a deployment start time 2 seconds apart and was
labelled "strong but circumstantial", with the deployed commit sha marked
UNVERIFIED pending a dashboard check. That method is no longer needed and should
not be reached for: it fails silently whenever two pushes land close together,
which is exactly when knowing the deployed sha matters most.

`/health` checks **only** `SELECT 1` (`apps/api/src/index.ts:125-132`). It does not
check S3, SendGrid, FCM, Sentry, or cron liveness. A wedged cron still returns
`{"status":"ok"}`.

---

## Schema — verified 2026-09-08 21:40 UTC (v68 applied; v66 rows corrected)

| thing | value |
|---|---|
| tip in `migrate.ts` (file) | **v68** — `files` array ends `'schema_v67.sql', 'schema_v68.sql'` (`apps/api/src/db/migrate.ts:10`) |
| tip on disk | **v68** — `ls schema_v*.sql \| sort -V \| tail -1` → `schema_v68.sql`. 67 files on disk, 67 entries in the array, no duplicates, every entry resolves. |
| tip applied in prod DB | **v68** — `information_schema.columns` shows `shift_sessions.ping_interval_minutes` `integer`, `is_nullable=YES`, `column_default=null`. Applied by Vishnu 2026-09-08. |
| **v67** | **APPLIED 2026-09-05.** `to_regclass('public.cron_heartbeats')` returns `cron_heartbeats` — v67's entire contract. |
| **v68** | **APPLIED 2026-09-08** (PR #21). `shift_sessions.ping_interval_minutes INTEGER NULL`, no default, no CHECK. 211 sessions: **210 NULL, 1 stamped `30`** (first at 19:00:14Z), so the Phase D `COALESCE(x, 30)` resolves to 30 for every row that exists. |
| **v69** | **FREE** — no `schema_v69.sql` on disk; the chain ends at v68. |

**The v66 rows above were stale for three days.** This table recorded v66 as the
tip of both the file and the DB while v67 was already applied and v68 was free.
The lesson is the one the invariants file already states: **read the chain from
`migrate.ts` and `ls schema_v*.sql` at the start of every session, never from
this table.** This section is a snapshot, and the number moves within a session.

**There is no migrations ledger table.** A `pg_class` sweep for `%migration%` /
`%schema_version%` / `%migrate%` in `public` returns zero rows. `migrate.ts`
replays the full hardcoded 68-file array on every invocation and relies on each
file being idempotent. The "applied tip" above is therefore inferred from schema
objects, not read from a ledger — that is the only method available.

`npm start` does **not** run migrations: `apps/api/railway.json` sets
`"startCommand": "node dist/index.js"`, `"buildCommand": "npm install && npm run build"`
(`tsc` only). `db:migrate` is invoked by nothing in the build or deploy chain.

---

## Mobile — verified 2026-09-05 08:32 UTC

`apps/mobile/app.json` literal values:

| field | value |
|---|---|
| `expo.version` | `1.0.17` |
| `expo.runtimeVersion` | `{"policy": "appVersion"}` → resolves to **`1.0.17`** |
| `expo.ios.buildNumber` | `41` |
| `expo.android.versionCode` | `17` |
| `expo.updates.url` | `https://u.expo.dev/5fd28125-2461-4165-b9df-7f34ced8b194` |
| `expo.updates.checkAutomatically` | `ON_LOAD` |
| owner / slug | `vvishnu1998` / `guard` |

**`buildNumber` and `versionCode` in `app.json` are ignored.** EAS remote
versioning is source of truth. The real shipped numbers, from `eas build:list`:

| platform | appVersion | build | commit | channel | status | created |
|---|---|---|---|---|---|---|
| IOS | 1.0.17 | **48** | `c932c09` | production | FINISHED | 2026-08-30T01:21:10Z |
| ANDROID | 1.0.17 | **24** | `c932c09` | production | FINISHED | 2026-08-30T01:21:11Z |
| ANDROID | 1.0.16 | 23 | `ef1e230` | smoke | FINISHED | 2026-08-23T19:29:21Z |
| ANDROID | 1.0.16 | 23 | `4cd4956` | development | FINISHED | 2026-08-23T18:17:27Z |

`c932c09` = `feat(mobile): download hours summary as PDF from the profile screen`.

---

## EAS channels + last update group — verified 2026-09-05 08:33 UTC

Channels (`eas channel:list`): `production`, `preview`, `smoke`, `development`.

| channel | last update group | message | runtime | platforms |
|---|---|---|---|---|
| production | `6536a189-52c6-4816-bda9-bcb7ba44116d` | "logout revokes session tokens" | 1.0.17 | android, ios |
| preview | `ff99ee6f-f732-449c-9eae-38a0fe3f224c` | "logout revokes session tokens" | 1.0.17 | android, ios |
| smoke | `2e20d40d-ffb3-4689-a7a2-af5183b2995b` | "logout revokes session tokens" | 1.0.17 | android, ios |
| development | — | **no updates ever published** | — | — |

All three live channels are current at runtime **1.0.17** and carry the same
change. Published 2026-09-02 by `vvishnu1998`.

**Runtime gate consequence:** any device below runtime 1.0.17 cannot receive these
updates at all and needs a store install. Device inventory below shows two STARNET
guards in that position.

---

Device inventory: see DEVICES.md (not included in the triage context pack — contains guard names).

## STARNET sites — verified 2026-09-07 02:30 UTC (2026-09-06 19:30 PT)

**Expansion: +4 sites created 2026-09-06, go-live 2026-09-07.** All four have a
`site_geofence` row (4-vertex polygon + center + radius). Only 375 Shopping Complex
has shifts (26, 14:00–00:00 PT daily through 10-10, 2 guards). Five new guards
(GRD0010–GRD0014), **none has logged in; GRD0011 has a shift tomorrow 14:00 PT.**
Readiness check: `INCIDENTS/2026-09-06-starnet-expansion-readiness.md` (N29).

| site_id | name | `checkpoints_enabled` | `is_active` | fence | timezone |
|---|---|---|---|---|---|
| `fea19254-6d65-4fbb-9f17-022081cf3472` | 23000 Cristo Rey Los Altos | true | true | r=190 m, 4 verts | America/Los_Angeles |
| `53c71c64-1973-4f82-be9c-98e4800beece` | Bethel AME Church | **false** | true | r=100 m, 16 verts | America/Los_Angeles |
| `6c638a80-a887-4375-9687-bfb6c1acb3bc` | william pen hotel | true | **false** | **none** | America/Los_Angeles |
| `015a37e9-7566-46b9-9cd6-c40705e2e2d7` | CCDC Folsom (**new 09-06**) | **false** | true | r=90 m, 4 verts | America/Los_Angeles |
| `a4588d96-b45e-4fdb-a1f1-34a9cada6015` | CCDC Broadway (**new 09-06**) | **false** | true | r=70 m, 4 verts | America/Los_Angeles |
| `ab450901-c434-417c-b5b6-292b4d09e80c` | 375 Shopping Complex (**new 09-06**) | true | true | r=300 m, 4 verts | America/Los_Angeles |
| `7fabf0ee-f100-43e4-aabd-71cf0dae31fc` | Jasper (**new 09-06**) | **false** | true | r=50 m, 4 verts | America/Los_Angeles |

**`checkpoints_enabled` corrected 2026-09-08** — this table recorded `true` for
CCDC Folsom, CCDC Broadway and Jasper. Production says **`false`** for all three.
Re-read directly: `SELECT name FROM sites WHERE NOT checkpoints_enabled` returns
exactly four rows — **Bethel AME Church, CCDC Broadway, CCDC Folsom, Jasper**.
375 Shopping Complex is `true` and was recorded correctly.

Nothing in this file dates the flip, so **UNVERIFIED: whether the three were
created `false` on 09-06 or toggled since.** `sites` has no `updated_at`, so the
DB cannot answer it either — the only trace would be an admin action log.
Consequence, since checkpoints are guard-facing: scanning is **off** at three of
the four new sites, and `siteFlags.ts` fails safe to TRUE only when the field is
ABSENT, never when it is explicitly `false`.

**Platform-wide site count: 23** (22 active). All 23 read
`ping_interval_minutes = 30`. Recorded because two source comments claimed "15
production sites" — see the correction note in the Schema section.

**`MOCK_LOCATION_ENFORCEMENT` is `on` in Railway production** (read 2026-09-07
02:3xZ). Code default is `off`; no decision records the flip. See N29 §5.

---

## Open STARNET sessions at write time — verified 2026-09-05 08:34 UTC

**0.**

```sql
SELECT COUNT(*) FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id
WHERE ss.clocked_out_at IS NULL
  AND g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067';
→ 0
```

Mechanism proven non-empty before trusting the zero: `all_open_now = 6` at the same
instant (all on `Star Guard`, the test tenant). STARNET's last clock-in was
2026-09-04T20:16:30.767Z. An empty result from a broken join is indistinguishable
from a true zero — this is why the control query is recorded alongside.

**This is a snapshot. Re-run immediately before any merge to main.**

---

## Store review status

- **App Store / TestFlight review status: UNVERIFIED.** Cannot be queried from any
  CLI available here (no App Store Connect API access configured locally). **Vishnu fills.**
- **Google Play review / rollout status: UNVERIFIED.** Same reason. **Vishnu fills.**
- What *is* verified: iOS Build **48** (v1.0.17, `c932c09`) exists on EAS with
  status `FINISHED`, created 2026-08-30T01:21:10Z, channel `production`. "Finished
  building" says nothing about review state.

See `FREEZES.md` — an unresolved review is a freeze condition.

---

## Phase 4 additions — verified 2026-09-05 11:00 UTC

| thing | value |
|---|---|
| `api.netraops.com` | **LIVE.** `curl https://api.netraops.com/health` → HTTP 200 `{"status":"ok","db":"connected"}` |
| `guard-production-6be4.up.railway.app` | still serving; same body. Both hosts front the same service. |
| `GET /health/crons` | **LIVE.** Returns 200 `{"status":"ok","jobs":19,"stale":[]}` (2026-09-05 12:00Z). The Phase 4.1 first-tick grace is working: the four daily/monthly jobs have still never ticked and are correctly not reported. |
| readonly column revoke | **APPLIED.** `has_column_privilege('claude_readonly','guards','password_hash','SELECT')` → **false** |
| Sentry cron monitors | **11 exist, all active, and are NOW ALARMING FALSELY.** Phase 4 (deployment `1da8d450`, 2026-09-05 11:35:57Z) stopped sending check-ins, so the still-armed monitors began reporting missed ones: **9 `Cron failure:` issues at 2026-09-05T11:52:00Z** (`shiftstartreminder`, `clockoutreminder`, `handoffnudge`, `missedshiftalert`, `autocompleteshifts`, `missedpingcron`, `preshiftreminder`, `lateclockinreminder`, `missedreportcron`), plus `chatretention` at 11:10. **All are false**: every job is running — heartbeat ages 35-36s, all `last_result='ok'`, and `/health/crons` returns 200 `stale:[]`. `RUNBOOK-phase4-apply.md` step (g) — delete all 11 — is now urgent, not housekeeping. Slugs are lowercased by Sentry. |
| Sentry uptime monitor | id `8024493`, still pointing at `https://www.netraops.com` (the **web** app). **To be repointed at `https://api.netraops.com/health/crons` after merge.** With the Phase 4.1 first-tick grace the route answers 200 immediately on a healthy deploy, so no waiting period applies. See `RUNBOOK-phase4-apply.md` step (d). |
| local `.env` | **now points at local Postgres** `127.0.0.1:5432/guard_dev`. The production URL moved to `~/guard/.env.prod` (gitignored, mode 600). |

### Production table count

**49 tables** in `public`. A full replay of the `migrate.ts` chain into an empty
database produces **48**. The difference is `password_reset_tokens`, which
exists in production but is created by no migration and referenced by no code
(0 rows). Tracked as **N15** in `OPEN-ITEMS.md`.

`AGENTS.md` says 48, which was correct when written (pre-v67) and is now one
short. Left as-is rather than churning it every migration; this table is the
authority.

### Last Nataniel contact

The line below is **machine-read** by the `customer-pulse` collector
(`scripts/ops/triage.sh`) and feeds the CUSTOMER line of the daily Slack brief.
Keep the exact `Nataniel last contact: YYYY-MM-DD` form — the collector matches
it literally.

Nataniel last contact: 2026-09-06

**Real contact date as of 2026-09-06** — the STARNET +4 site expansion
(CCDC Folsom, CCDC Broadway, 375 Shopping Complex, Jasper; go-live 2026-09-07).
Previously a seeded placeholder. **Vishnu maintains it**: update it whenever you
actually speak to Nataniel.

---

## Triage runner — verified 2026-09-05 12:00 UTC (Phase 4.2)

**Signals are collected in shell; the model reads only.**

`scripts/ops/triage.sh` gathers every live signal into `/tmp/triage-context.md`
*before* `claude` is invoked. The model's allowlist is
`Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(cat /tmp/triage-context.md)`
— no psql, no curl, no railway, no WebFetch — and the run passes
`--permission-mode dontAsk`.

**Why.** Run `33964038694` reported **SUCCESS** while collecting nothing: every
Bash and WebFetch call came back `requires approval`, and the report was
authored from `STATE.md` alone. `claude -p` starts in **Manual** permission mode
on every plan, so with nobody to answer, anything outside the allow rules is
denied — and the old rules were too specific to match what the model actually
typed (one interpolated a quoted database URL into a prefix rule; `WebFetch` was
never listed at all).

A triage pass that silently reports on nothing is worse than none, because its
output is indistinguishable from a clean run.

**The eleven collectors**, each wrapped so a failure writes
`COLLECTOR FAILED: <name>: <error>` into the pack and the run continues:
`health`, `health-crons`, `cron-heartbeats`, `starnet-open-sessions` (with a
per-`company_id` control count), `customer-signal`, `open-geofence-violations`
(>6h, excluding Bethel AME per D11), `stuck-sessions` (>3h past
`scheduled_end`), `railway-logs`, `sentry-netraops-api`,
`sentry-netraops-mobile`, `git-log`.

Every query selects **ID and count columns only**. Verified on the 2026-09-05
local run: the live-signals half of the pack contained **0 email addresses, 0
coordinate pairs, 0 phone numbers and 0 guard names**.

**Cadence: daily, targeting the 08:00 PT hour.** `cron: '7 13 * * *'` since
2026-09-07 — nominally 06:07 PT, aimed early because GitHub ran this repo's
schedules **2-4 h late** on 09-05/06 (D12 amendment). GitHub Actions
cron is always UTC with no timezone option, so this is 08:00 PDT most of the
year and 07:00 PST between the November and March switches — accepted rather
than adding two cron entries and a date guard. Restores `DECISIONS.md` D7; the
6-hourly schedule it replaces was shake-out only. `workflow_dispatch` unchanged.

**Pack trimmed for cost (D13).** `railway-logs` 300 -> 100 lines, `git log`
-20 -> -10, `SENTRY_ISSUE_CAP` 15 -> 10, `--max-turns` 40 -> 15, and
`OPEN-ITEMS.md` embedded as **open items only** — the "Carried items" archive
and every item marked CLOSED are dropped, with the omission stated in the pack
itself. The Sentry `lastSeen` filter widened 6h -> 24h to match the daily
cadence; a daily run filtering to 6h would silently drop 18 hours of issues.

Measured on the same machine, before and immediately after the code change:
**1421 -> 1114 lines, 67,251 -> 49,875 bytes (-26%)**. Live signals 463 -> 263;
repo memory 958 -> 851.

**Re-measured after writing this section: 1190 lines / 54,213 bytes.** Documenting
the trim added ~76 lines to the pack, because `STATE.md`, `DECISIONS.md` and
`OPEN-ITEMS.md` are all embedded in it. Net against the 1421 baseline is
**-16% lines / -19% bytes** — the honest figure to plan cost against, and the
one that will drift upward every phase.

**Short of the "roughly halved" target**, and that self-inflation is why.
`STATE.md` — this file — is 348+ lines, roughly a third of the whole pack and
larger than every live signal combined, and it grows by a section per phase. It
is still embedded in full. Splitting it is the next lever: see **N21**.

**Dry run.** `workflow_dispatch` takes `dry_run: true`, which collects and
uploads the pack without calling the model — a cheap way to prove collection
works. The context pack is uploaded as an artifact on **every** run, dry or not,
including failures: a report claiming all-green is only trustworthy alongside
the signals it was written from.

Latest local run (2026-09-05, post-trim, post-docs): **1190 lines, 0 collector failures.**
Section line counts — `health` 2, `health-crons` 4, `cron-heartbeats` 18,
`starnet-open-sessions` 8, `customer-signal` 4, `open-geofence-violations` 1,
`stuck-sessions` 1, `railway-logs` 100, `sentry-netraops-api` 14,
`sentry-netraops-mobile` 4, `git-log` 10.

**Repo memory in the pack is now name-free (Phase 4.3, N16).** The pack embeds
`STATE.md`, `OPEN-ITEMS.md`, `FREEZES.md`, `DECISIONS.md`, `POLICY.md` and
`REPORT-TEMPLATE.md` — and **not** `DEVICES.md`. The device-inventory table,
the only place carrying guard NAMES, moved verbatim to `DEVICES.md`; nine
further name occurrences in `OPEN-ITEMS.md` and `FREEZES.md` were replaced in
place with `guard_id` + `badge_number` + `company_id`. Post-fix scan of all six
embedded files: **0 names**. Structural, not prompt-dependent: the model is no
longer shown what it is told not to repeat.

### Runner follow-ups — verified 2026-09-05 (Phase 4.3)

**Railway logs collector fixed.** Run `33964954767` recorded `railway-logs` as a
successful 3-line collection. The three lines were:

```
No service linked
Run `railway service` to link a service
  → Run `railway service` to link a service.
```

A GitHub runner has no `~/.railway` link and `RAILWAY_TOKEN` alone does not
imply a service. The call is now
`railway logs --service guard --environment production --lines 300`.

**Two bugs, not one.** The missing flag was the visible half. The other half was
in the harness: `railway` **exits 0** while printing that error, so the
collector wrapper — which only tested exit status — logged it as a success. That
is the same silent-failure class this whole loop exists to remove, built into
the detector. The collector now also matches the error text explicitly and
returns non-zero, so a repeat is loud.

**Model pinned.** Run `33964954767` passed no `--model`, and its workflow log
names no model, so what served that report is **unverifiable after the fact**.
`triage.sh` now takes `MODEL`, defaulting to `claude-sonnet-5`. The workflow
sets it: scheduled runs get `claude-sonnet-5`; a manual run with a non-empty
`focus` gets `claude-opus-5`, on the reasoning that a human supplying a focus
is chasing something and that is an alarm.

**Corrected to Claude 5 ids (Phase 4.3b, 2026-09-05).** The Phase 4.3 dispatch
specified `claude-sonnet-4-6` and `claude-opus-4-1`; those are Claude
4-generation ids and were flagged as such at the time. They are now
`claude-sonnet-5` and `claude-opus-5`.

**Still UNVERIFIED: neither id has been exercised.** `claude -p` cannot
authenticate on this workstation, so the first proof either id is accepted will
be a CI run. Confirm against the Console model list. A rejected id surfaces as a
startup error, which `triage.sh` flags separately from a triage failure — so a
wrong id shows up as a wrong id, not as a bad report.

**Actions on Node 24.** GitHub removes Node 20 from hosted runners on
2026-09-16. Verified from each action's own `action.yml` at each tag rather than
from a README: `actions/checkout` v4=node20 / v5,v6,v7=node24;
`actions/setup-node` v4=node20 / v5,v6,v7=node24; `actions/upload-artifact`
v4=node20, **v5=node20**, v6,v7=node24; `gitleaks/gitleaks-action` v2=node20,
v3=node24. All bumped to the current major (v7 / v7 / v7 / v3).

`upload-artifact@v5` is the trap: it was released as "supports Node v24" but its
`action.yml` still declares `node20`, so a v4→v5 bump would have looked like a
fix and changed nothing.

**gitleaks was the urgent one.** It is the required status check for branch
protection, and v2 stops working entirely on 2026-09-16 — after which `main`
would be unmergeable. v3.0.0's notes state the migration is runtime-only: "No
changes to inputs, outputs, or behavior." The job's `name:` is unchanged, so the
required context `Scan for hard-coded secrets` still matches.

**Prompt preface.** The prompt now opens with an instruction to emit only the
report — no preface, no acknowledgement, no explanation of tools or permissions.

### Incident 2026-09-05 — push_skip_null_token

`docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md`. **RESOLVED 2026-09-05**,
merge `3b3c9a1`, deployment `9775a777-9523-4b58-91c0-9e49edd6b21e` (16:12:04Z).
**P3, no customer impact, no STARNET exposure.** Sentry `netraops-api` issue
`7633312535`: 6 `flow: ping_reminder` events in the 30 min before deploy, **0**
in the 30 min after, across a window boundary that previously fired — while the
three affected sessions kept receiving their in-app reminders at the same
cadence (1 per 30-min window, before and after).

`pingReminder` emitted a `warning`-level Sentry event per reminder for any guard
with no push token. Three **test-tenant** guards with open sessions and zero
`guard_devices` rows produced 9 events/hour. The job was behaving correctly —
it skips the push and still writes the in-app notification — so this was noise,
not a fault. Fixed by counting the skips per tick and reporting them in the
existing summary lines instead of emitting per occurrence.

**Three claims in the original triage finding were wrong**, and two of them
traced to the collector rather than the model:

- the Sentry issue id had a transposed digit and returned HTTP 403;
- "count 303 in 24 h" was the **lifetime** total since 2026-07-25; the real 24h
  figure was 54;
- "firing continuously" described 19 hours of zero followed by a flat 9/hour.

`c_sentry` now emits `count_24h` and `lifetime` as separate columns with
`firstSeen`, summed per issue from Sentry's hourly buckets — the issues
*listing* embeds bucket data that disagrees with the per-issue endpoint
(measured: 0 vs 4 for the same issue in the same window), so the collector pays
one extra call per recent issue for a number that is actually right. The prompt
now requires ids to be copied verbatim.

Five other call sites still emit per occurrence and `ACTIVE_PUSH_TOKEN_SQL`
still lacks `LIMIT 1` — both deferred to **N20** as one PR.
