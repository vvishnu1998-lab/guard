# STATE — state of the world

Every line below was verified at the timestamp on its section. Nothing here is
copied from chat memory. A value that could not be checked from repo, DB, or CLI
is marked **UNVERIFIED** and names who fills it.

Re-verify before acting. This file goes stale the moment something deploys.

---

## Git — verified 2026-09-05 08:25 UTC (01:25 PT)

| thing | value |
|---|---|
| `main` sha | `57c26e146371212c1f5bf538cbbc09123348ed97` (`57c26e1`) — will be updated again post-merge of the Phase 4 branch |
| `main` subject | `Merge pull request #2 from vvishnu1998-lab/ops/phase-2-heartbeats` |
| last known good `main` sha | `57c26e1` — same as tip; no known-bad state as of this write |
| working tree | clean (untracked only: `.playwright-mcp/`, `.vscode/`, `load test/`, `marketing/`, 4 loose PNGs) |
| branch protection on `main` | **NONE** — `gh api repos/vvishnu1998-lab/guard/branches/main/protection` → 404 `"Branch not protected"` |
| CI | one workflow, `.github/workflows/gitleaks.yml`, active (id 266080625). Last 5 runs SUCCESS. Advisory only — main is unprotected, so a failing scan blocks nothing. |

**Worktrees** (`git worktree list`) — 6 exist under `.claude/worktrees/`; none pins
`main`. The primary checkout at `/Users/vishnuvardhanreddy/guard` is on `main` @ `40d2297`.

---

## Railway (API) — verified 2026-09-05 11:00 UTC (Phase 4)

| thing | value |
|---|---|
| project / env / service | `adorable-courage` / `production` / `guard` (`railway status`) |
| current deployment id | `087ead46-7087-4c6b-b047-c1d4679b8ae4` |
| status | **SUCCESS** |
| deployed at | 2026-09-05 02:14:23 -07:00 |
| previous deployments | all `REMOVED` (Railway retains one active) |
| `/health` live body | `{"status":"ok","db":"connected"}` — HTTP 200 |

**Deployment → commit linkage is INFERRED, not read from Railway.** `railway
deployment list` does not print a commit sha. The inference: the gitleaks run for
`main` @ `40d2297` (run 33836221028) completed 2026-09-04T04:16:47Z = 2026-09-03
21:16:47 PT, and deployment `48c7fbbe` started 21:16:45 PT — 2 seconds apart.
Treat as strong but circumstantial. **UNVERIFIED — deployed commit sha** (Vishnu
can confirm from the Railway dashboard).

`/health` checks **only** `SELECT 1` (`apps/api/src/index.ts:125-132`). It does not
check S3, SendGrid, FCM, Sentry, or cron liveness. A wedged cron still returns
`{"status":"ok"}`.

---

## Schema — verified 2026-09-05 08:34 UTC (v67 row updated 2026-09-05, Phase 2)

| thing | value |
|---|---|
| tip in `migrate.ts` (file) | **v66** — `files` array ends `'schema_v65.sql', 'schema_v66.sql'` (`apps/api/src/db/migrate.ts:10`) |
| tip on disk | **v66** — `ls schema_v*.sql \| sort -V \| tail -1` → `schema_v66.sql` |
| tip applied in prod DB | **v66** — `pg_attribute` probe: `geofence_violations.position_source` and `off_post_events.position_source` both `attnotnull = true`, which is v66's entire contract |
| **v67** | **APPLIED in production 2026-09-05.** `to_regclass('public.cron_heartbeats')` returns `cron_heartbeats`; 15 of 19 heartbeat rows present at 11:00Z, all `last_result='ok'`. The 4 absent are the daily/monthly jobs, which had not been due since deploy. |
| **v68** | **FREE** — no `schema_v68.sql` on disk; `migrate.ts` chain ends at v67 (68 files, verified applying clean from empty into a local `guard_dev` 2026-09-05). |

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

## STARNET device inventory — verified 2026-09-05 08:36 UTC

Tenant resolved by id → name first: `27c4d404-8769-49ca-bfd6-93cb9b890067` = `STARNET SECURITY`.
IDs and badges only; no push-token values.

| badge | guard | `client` identity string | last seen | reachable by current OTA? |
|---|---|---|---|---|
| GRD0004 | deepak naik | `platform/ios; version/1.0.17; build/41; runtime/1.0.17; update/01a05fb1-…` | 2026-09-04T22:55Z | **yes** (runtime 1.0.17) |
| GRD0005 | Nikith Reddy | `platform/android; version/1.0.16; build/17; runtime/1.0.16; update/01a04071-…` | 2026-09-05T00:57Z | **NO** — runtime 1.0.16 |
| GRD0007 | Anil | `platform/ios; version/1.0.16; build/41; runtime/1.0.16; update/01a02a71-…` | 2026-09-04T00:17Z | **NO** — runtime 1.0.16 |
| GRD0002 | Nandu | `NULL` | 2026-09-01T02:03Z | **UNKNOWN** — never sent a client header |
| GRD0001, GRD0006, GRD0008, GRD0009 | Bhanu, vamshi krishna, Svineah, Naveen Yatakari | `NULL` | = claimed_at (never used since) | **UNKNOWN** |

`client` is written only on `clock-in`, `handoff-clock-in`, `ping`, and
`clock-in-verification`. A `NULL` means the device row was claimed at login but no
qualifying write has happened since — not that the app is broken.

---

## STARNET sites — verified 2026-09-05 08:36 UTC

| site_id | name | `checkpoints_enabled` | `is_active` | timezone |
|---|---|---|---|---|
| `fea19254-6d65-4fbb-9f17-022081cf3472` | 23000 Cristo Rey Los Altos | true | true | America/Los_Angeles |
| `53c71c64-1973-4f82-be9c-98e4800beece` | Bethel AME Church | **false** | true | America/Los_Angeles |
| `6c638a80-a887-4375-9687-bfb6c1acb3bc` | william pen hotel | true | **false** | America/Los_Angeles |

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
| `GET /health/crons` | **404 in production** — the route ships in the Phase 4 branch and is not deployed yet |
| readonly column revoke | **APPLIED.** `has_column_privilege('claude_readonly','guards','password_hash','SELECT')` → **false** |
| Sentry cron monitors | **11 exist and are all active**, auto-created by the Phase 2/3 check-ins. Slugs are lowercased by Sentry (`orphanedsessioncheck`, not `orphanedSessionCheck`). Phase 4 turns check-ins off; these 11 must be deleted by hand. |
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

**UNVERIFIED** — not recorded anywhere in the repo. The Monday weekly section
of the triage report asks for it. **Vishnu fills.**
