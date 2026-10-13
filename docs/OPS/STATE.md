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
| branch protection on `main` | **ENFORCED** — **three** required status checks: `Scan for hard-coded secrets`, `Ping window anchor (TS vs SQL)` **and** `tsc (src + scripts) and the N78/N91 response-body floor`. **This row said "two" from 2026-09-08 until 2026-09-23**; the `typecheck` context was added to the protection after the row was written, and nothing updated it. Verified 2026-09-23 with `gh api repos/vvishnu1998-lab/guard/branches/main/protection --jq .required_status_checks.contexts`. `strict: true`, `enforce_admins: true`, `allow_force_pushes: false`, `allow_deletions: false`, `required_approving_review_count: 0`, `required_linear_history: false` |
| CI | **four** workflows: `gitleaks` (266080625), `ops-triage` (350875238), `window-anchor` (353361978), `typecheck` (359257173) — all active. **This row said "three" until 2026-09-23**; `typecheck` (N97) landed after the row was last written and nothing updated it, so a PR author reading this file would not have known `check:types` runs on every PR. **Not advisory** — `gitleaks`, `window-anchor` **and `typecheck`** supply the three required contexts, so any one failing blocks the merge (`typecheck` confirmed required 2026-09-23; see the protection row above). |
| `typecheck` steps | `npm --prefix apps/api run check:types` (= `tsc --noEmit` over **both** `tsconfig.json` and `tsconfig.scripts.json`), then the N78/N91 floor: `grep -rnE 'error:.*err\??\.(message|detail|hint|constraint|code)' apps/api/src/` with the sense INVERTED — a match FAILS the job. Run both locally before pushing. |

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

## Shipped 2026-10-13 — PR #108, /app: the one URL for the guard app (a static page, the `src` tag registry, the app-host redirect), by OVERRIDE — `check:app-page` passes against www ~15:08 PT; iPhone tap PASSED (Vishnu); Search Console: Vishnu, the evening of 10-13, not a blocker

| thing | value |
|---|---|
| merge | PR #108 merged as `875a75d` at **15:04:58 PT (22:04:58Z) by OVERRIDE**. Vishnu: "OVERRIDE — merge #108 now. After deploy: run check:app-page against www, confirm /app loads on my iPhone (I'll tap it), then Search Console URL Inspection." Prechecks: head `c9f538a` directly on `b9335d6`, MERGEABLE/CLEAN, 5 of 5 checks green (the three required contexts, Vercel, Vercel Preview Comments). `gh pr merge --merge --match-head-commit c9f538a…`. Before it, 15:04:47 PT: 3 STARNET sessions open, last ping 15:01:38 PT, control counts matching. |
| Railway | `45b817a2-3654-4d03-a3c1-9c0479774f92` **SUCCESS** at 15:07:16 PT from `875a75d` (pending 15:05:02). |
| web | Vercel production on `875a75d`: success at 15:08:00 PT. |
| health | `/health` commit `875a75d`, first seen 15:07:18 PT by a 10 s poll; `/health/crons` 20 jobs, `stale: []`. `/app` returned 200 from 15:08:01 PT (it was 404 at 15:05:09). |
| restart window | 15:04:58–15:07:18 PT (merge to the first poll that saw the new commit; the container switch itself was NOT timed, so no overlap figure). STARNET, counts via `postgres-readonly`: **1 location ping and 1 notification landed**; 0 session starts or ends, 0 breaks, 0 checkpoint scans, 0 device claims, 0 guard auth events; the 3 open sessions stayed open. Control: 1 platform-wide ping, 0 platform-wide auth events. From 15:07:18 to ~15:08 PT: 0 of each. Not captured: the old container's last request (Railway logs were not read). |
| verification | `APP_BASE=https://www.netraops.com npm run check:app-page` (from `apps/web`): every assertion passes, including 9 user agents (Googlebot Smartphone, Slackbot, WhatsApp, facebookexternalhit, none) getting one byte-identical 200 with no Location and no `Vary: User-Agent`, and `app.netraops.com/app?src=welcome_email` → 308 → the www URL with the query kept. **Control:** the same script, run against production before the merge, failed 404 on every check. **iPhone (Vishnu, 2026-10-13 afternoon PT): pass**: the App Store link only, no Google Play, no QR, and the button opens the NetraOps listing. Search Console URL Inspection: Vishnu, the evening of 2026-10-13 (no Chrome extension was connected to the session, so it could not be run from it); he said not to block on it. |
| visible change | `/app` exists: a light tile with **text links** ("Available on the App Store" / "Available on Google Play"; no badge artwork yet: both badges ship together in one follow-up PR, Google's file is gated behind Partner Marketing Hub approval), a desktop-only QR, OG/Twitter card, canonical, `MobileApplication` JSON-LD with no rating/review/offers, and a sitemap entry. On a confident iPhone only the App Store link shows; on Android only Google Play; everyone else (iPad in desktop mode, crawlers with JavaScript, no JavaScript) sees both. No redirect anywhere. **Nothing links to `/app` yet** except the sitemap. |
| audit | The Phase 1 register (518 rows) and negatives (209) are in `docs/OPS/audits/store-links/`. |

---

## Shipped 2026-10-13 — PR #106, B5: the company letterhead on the admin alerts and account emails, every style inline (N182), month-name dates, by OVERRIDE — verified 2026-10-13 12:06 PT; Gmail verified ~12:40 PT

| thing | value |
|---|---|
| merge | PR #106 merged as `dde311c` at **11:59:55 PT by OVERRIDE**. Vishnu: "OVERRIDE on #106. Don't arm the merge script, don't wait for pings. Merge as soon as CI is green, then run the post-deploy checks and record what landed during the restart window." The session pushed the branch and opened the PR at ~11:52 PT under two exact-command allow rules Vishnu approved (the auto-mode classifier had refused the push). One read at 11:59:51: 5/5 SUCCESS, CLEAN, head `4a3be2d`, main `c83ddc8`. Then one call, `gh pr merge 106 --merge --match-head-commit 4a3be2d…`. The merge tree equals the head's tree (`f5e184b6`). |
| Railway | `a5e85d02-7c1b-4fb0-86b6-072dca5249b5` **SUCCESS** at 12:02:30 PT from `dde311c`. |
| web | Vercel production on `dde311c`: success at 12:02:19 PT. |
| health | `/health` commit `dde311c`; `/health/crons` 20 jobs, `stale: []`; route control 401. |
| switchover | The old container (`420878c2`, from #105's `c83ddc8`) served its last request at 12:01:25.4 and stopped at 12:02:36.8 PT. The new one served its first at 12:02:25.5, so they overlapped. Over its whole life (10-12 18:45 to 10-13 12:02 PT) the old one served 9,525 requests: 73 were 499s, every one a GET (client aborts; 59 on `GET /api/checkpoints/mine`, 10-12 18:49 to 23:04 PT), and 0 were 5xx. To 12:06 the new one served 26 requests, with 0 5xx and 0 499, and logged no error. Sentry, 11:44–12:04 PT: API, none; mobile, none. |
| restart window | 11:59:55–12:02:37 PT, all on the old container: STARNET's 12:00 cron tick (6 notifications, 12:00:00–12:00:01) and one STARNET location ping at 12:00:24 (`POST /api/locations/ping` 201). Two upload presigns (200) also landed, at 12:00:22 and 12:01:15 (tenant not attributed). STARNET wrote nothing else in the 15 minutes before the merge or after the stop, to 12:04 PT. |
| visible change | The admin alerts show the company block (logo inline by CID, name, contact lines) above their coloured band, and end "Powered by NetraOps"; they still have no Reply-To. The company's guard, client and secondary-admin welcomes carry its letterhead, and replies go to its contact email when it has a usable one. All five account emails drop "Do not reply to this email". Every email carries its styles inline (N182) and prints month-name dates. STARNET has a logo, a usable contact email and 2 active admins (read-only booleans, 2026-10-12): its admins' next alert carries its letterhead, and a welcome it sends takes its Reply-To. |
| B4's first live run | STARNET's 09:00 PT daily reports on 2026-10-13, on `420878c2` (B4): "[daily-email] Done — sent: 1 (partial: 0), skipped: 15 (no_client 14, client_access_disabled 1), failed: 0; emails delivered: 1, failed: 0". One shift flagged at 09:00:01, one recipient. No letterhead lookup failure, logo warning, 2 s timeout or 400 resend was logged; Sentry API, no issues. The delivered email itself was not seen. |
| test emails | Vishnu approved one batch ("go", 2026-10-13 ~12:24 PT) after setting a test logo and his own Gmail as Star Guard's contact email. A dry run of `~/guard-wt/ops-polish/b5-batch.js` through `railway ssh` on the guard service matched the plan at 12:25:18–21. It found Star Guard's "test site", a 3,002-byte PNG logo and Reply-To his Gmail; nothing was sent. Then one `SEND=1` run at 12:25:31–59 PT sent 8 emails to his Gmail only, each answered with SendGrid 202. In order: 1 incident alert `Dr3s9XO7TO2bQ_q1YmfQbQ`; 2 daily shift report `sz2o4IjgQHOZk3JHPuA6pQ`; 3 missed shift `UumctVnkTTmp4DUFuF_DaA`; 4 coverage swap `hkalq0P5Sm6G0vwO_pQBaA`; 5 client welcome `rninBKknQQaRDwrySi9ssw`; 6 password reset `XkBblXiMRhSnyOFYcVnN9A`; 7 incident alert without a letterhead `pxxADWlxR5GHFvHaCA5q8A`; 8 the ASCII-only control of 1 `i--ovW4rSBOsDSaJ_xCCgw`. No database writes. **Gmail (Vishnu, 2026-10-13 ~12:32 PT):** N182 is fixed on 1, 5, 7 and 8: the body is aligned, the buttons are amber, and #7's navy header renders with no white on white. "[Message clipped]": 1, 5 and 8 are not clipped; 7 (the incident alert without a letterhead) is. #1 went out `iso-8859-1` with `=B7` and was not clipped, so the non-ASCII explanation is disproved. Raw diff of #7 (`1a136ba803da6ae9`) against #1 (`1a136ba3a7cf30a1`), read through the Gmail connector: #7 is a single-part `text/html` message of 8,908 bytes; #1 is `multipart/related` (HTML plus the inline logo), 14,087 bytes. Both are `iso-8859-1` quoted-printable, have SendGrid's open pixel after the page table, and started their own thread. Their HTML is the same template except for the header and footer. **Vishnu, ~12:40 PT:** 3, 4 and 6 are not clipped either. #6 is single-part with the NetraOps header, so neither the single-part structure nor the NetraOps header explains #7; only #7 clips. The cause is unknown and affects only the incident alert without a letterhead. It is parked as low priority, with no more test sends (N185). **B5 VERIFIED in Gmail (Vishnu): all 8 render correctly; N182 closed.** Settings: Vishnu set them at 12:24:37 (PATCH 200) and 12:24:42 (logo POST 200), and undid them at 12:37:35 (`DELETE /api/admin/company/logo` 200) and 12:37:42 (PATCH 200). No logo-deletion failure was logged, and Sentry's API project had no issues. Star Guard's profile is empty again (read-only, 12:39 PT); `logo_updated_at` now reads 12:37:34. |

---

## Shipped 2026-10-12 — PR #105, B4: the security company's letterhead on the two client emails, by OVERRIDE — verified 2026-10-12 19:02 PT; Gmail verified 19:25 PT

| thing | value |
|---|---|
| merge | PR #105 merged as `c83ddc8` at **18:45:05 PT by OVERRIDE**. Vishnu opened it at 18:39:53 PT; the auto-mode classifier had refused both `gh pr create` and the GitHub tool from the session. Vishnu: "Read CI once. If green + CLEAN with pins holding (head a967394, main d6c8b7d), merge (OVERRIDE)." One read at 18:45:01: 5/5 SUCCESS, CLEAN, both pins held. Then one call, `gh pr merge 105 --merge --match-head-commit a967394…`. The merge tree equals the head's tree (`d27fcf7a`). |
| Railway | `420878c2-26fe-4d88-9526-ea6b9469f2dc` **SUCCESS** at 18:46:29 PT from `c83ddc8`. |
| web | Vercel production on `c83ddc8`: success at 18:46:54 PT. |
| health | `/health` commit `c83ddc8`; `/health/crons` 20 jobs, `stale: []`; route control 401. |
| switchover | The old container (`f0c408d4`, from #104's `d6c8b7d`) served its last request at 18:46:18.1 and stopped at 18:46:39.6 PT. The new one served its first at 18:46:25.4, so they overlapped with no gap. Over its whole life (17:27 to 18:46) the old one served 770 requests, 0 at 499 or above. To 19:01 the new one served 364 requests with 0 5xx. It had 17 GET 499s at 18:49–18:50 (client aborts, no writes). Its other 4xx were the 401 control, a 404 on `GET /` and a 401 on `/api/chat/rooms`. Sentry, 18:41–19:02 PT: API, none; mobile, none new. |
| restart window | 18:45:05–18:46:40, with no STARNET write (a ping and a device check-in in the 15 minutes before). After it, on `420878c2`, all 201: GRD0032's clock-in (18:47:35) and its verification, its reports (18:50:09, 19:00:39) and its 19:00:11 ping. The 19:00 cron tick ran there: 9 notifications and one missed ping, GRD0013's 18:30 window (N168). |
| visible change | The incident alert and the daily shift report carry the company's letterhead: the logo inline by Content-ID, the name and contact lines, and "Powered by NetraOps". They take the company's Reply-To when it has one, and print month-name dates. STARNET's first are its 09:00 PT daily reports on 2026-10-13. |
| test email | Vishnu approved one send. At 18:45:36 PT he saved a test logo and his own Gmail as contact email on Star Guard, whose profile had been empty. The first one-off aborted on a wrong site id (the session's error), with nothing sent. At 19:01:16 a dry run of the corrected one-off, through `railway ssh` on the guard service, matched what was expected. At 19:01:26 one email went to Vishnu's Gmail: SendGrid 202, `pCYXxHJRRB-pkLG838rKdQ`. **Gmail (Vishnu, read from the raw message `1a132fe449f83678`):** top-level `multipart/related`; the logo part `image/png` with `Content-ID: <company-logo>` and `Content-Disposition: inline; filename="logo.png"`; one `cid:company-logo` reference in the HTML; Reply-To his Gmail; the footer's "Provided by Star Guard", reply line and "Powered by NetraOps"; SPF, DKIM (netraops.com and sendgrid.info) and DMARC pass; delivered to the Inbox (Updates tab), not spam. At 19:06:42 Vishnu removed the logo (DELETE 200; the S3 object was deleted, with no failure logged) and at 19:06:53 cleared the contact email (PATCH 200). Star Guard's profile is empty again; `logo_updated_at` now reads 19:06:42. |

---

## Shipped 2026-10-11 — PR #103, N178: the client report covers whole days in Pacific, by OVERRIDE — verified 2026-10-11 22:32 PT

| thing | value |
|---|---|
| merge | PR #103 merged as `edb2a45` at **22:15:05 PT by OVERRIDE**. Vishnu: "OVERRIDE: open PR, wait for CI green + CLEAN, merge immediately, pinned head, no retry." The PR was opened at 22:10:43. At 22:15:00 the CI state was read once: 5/5 SUCCESS, CLEAN, head `1bc1c9e`, `main` `147430b`. Then one call, `gh pr merge 103 --merge --match-head-commit 1bc1c9e…`. The merge tree equals the head's tree (`e300011d`). |
| Railway | `5987ea3c-4eaf-44fa-b728-bb61cc0fa267` **SUCCESS** at 22:16:08 PT from `edb2a45`. |
| web | Vercel production on `edb2a45`: success at 22:16:43 PT. |
| health | `/health` commit `edb2a45`; `/health/crons` 20 jobs, `stale: []`; route control 401. |
| switchover | The old container (`ff81a87c`) served its last request at 22:16:03.95 and stopped at 22:16:21.6 PT. Over its whole life (21:51 to 22:16) it served 442 requests, 0 at 499 or above. The new deployment served 170 requests by 22:31, none at 499 or above; its only 4xx were the 401 control and the known GET `/api/inspections/session/:id` 404. Sentry, 22:12–22:32 PT: API, no issues; mobile, no new issues. |
| restart window | 22:15:05–22:16:22, with no STARNET write (4 pings and 3 reports in the 15 minutes before). The old container issued two upload URLs (`POST /api/uploads/presign`, 22:15:38 and 22:15:42), and no submission followed them. From 22:15 to 22:45 PT the only guard submissions from any tenant were the 22:30 wave's three STARNET pings: no report, clock-in, clock-out, clock-in check, inspection, scan, task or dead letter (the newest of `offline_dead_letters`' 6 rows is from Oct 9). Whose the two were is unknown; no request failed. The 22:30 wave was the write-path control: GRD0001, GRD0027 and GRD0030 pinged (22:30:13–22:30:37), all 201 on `5987ea3c`. |
| visible change | Client reports: "Oct 11" is Oct 11 00:00 to 23:59:59 PT, whatever form the portal sends the range in. The printed period is the days counted, the download panel's preview counts the same days, and the file is dated in Pacific. A daily report downloaded after 17:00 PT used to print "Oct 10 – Oct 11" and file the evening's reports under the next day. |

---

## Shipped 2026-10-11 — PR #102, the nightly purge drains notifications in batches instead of halting at the row cap, by OVERRIDE — verified 2026-10-11 21:41 PT by the session that merged it

| thing | value |
|---|---|
| merge | PR #102 merged as `147430b` at **21:35:08 PT by OVERRIDE**: Vishnu waived the ping gate. Head `b72ebae`. |
| Railway | `9229e025-b631-4c26-87e6-0a505d0e0277` **SUCCESS** from `147430b`; `/health` reported `147430b` at 21:36:22.7 PT. |
| retention switches + redeploy (Vishnu, by OVERRIDE, between ping waves) | ~21:47 PT: Vishnu set two Railway variables on guard/production with `--skip-deploys`: `RETENTION_LIVE_STEPS=admin_client_previews,revoked_tokens,notifications` and `RETENTION_DRY_RUN=false`. ~21:49: his first `railway redeploy` failed (the CLI rejected `--environment`), and nothing restarted. ~21:50: `railway redeploy --service guard --yes` restarted it as `ff81a87c-723a-4e46-848b-38ef21d51bdd` (created 21:50:03.8 PT, Railway reason `redeploy`, same image `147430b`), so the container picked up the new variables. 21:53: he verified `/health` on `147430b` and that `printenv` shows both variables. The switch: `9229e025` served its last request at 21:51:03.9 and stopped at 21:51:30.2, and `ff81a87c` served its first at 21:51:25.6, so they overlapped with no gap. 0 5xx and 0 499 on either from 21:44 to 21:58 (96 + 31 requests). Over their whole lives `9229e025` served 123 requests and `ff81a87c` 442, none at 499 or above. No STARNET write landed 21:47–21:52. First live purge: 2026-10-13 00:00Z, those three steps only. |
| first live purge | 2026-10-13 00:00Z (Mon 17:00 PT) on `5987ea3c` (release `edb2a45`): `dry_run=false`, live = admin_client_previews, revoked_tokens, notifications. Deleted 10,427 of 15,747 candidates in 0.3 s. **notifications** 10,000 of 12,464 due (drained; 2,464 left for later runs; the oldest remaining row is 2026-09-09 18:00:01.7Z, just after the predicted batch end). **admin_client_previews** 7 of 7. **revoked_tokens** 420, read from the Railway log line because Sentry scrubs this step. 29/29 steps ran: 0 halted, 0 errored, no unknown live steps, S3 0 deleted and 0 failed. The other 26 steps stayed dry (step1_ping_photos would delete 2,561, clock_in_photo_30d 271). The 2026-10-11 prediction was 12,461 → 10,000, 7, and ≈420–425. Sentry: only the info-level summary (NETRAOPS-API-C). |
| web | Vercel production on `147430b`: success at 21:37:01 PT, per its GitHub deployment record. |
| switchover | The old deployment (`ee2dd3a4`) served its last request at 21:36:19.9 PT; the merging session measured a 2.76 s gap to the new one. |
| restart window | 21:33:08–21:41:22.7 PT: 0 STARNET writes (control: the 21:00 and 21:30 waves found 8 pings and 12 notifications), 0 5xx, 0 upstream errors, and 20/20 heartbeats ok. |
| visible change | None at the merge: the purge was still a dry run, because RETENTION_DRY_RUN and RETENTION_LIVE_STEPS were unset in production. The next check was the 2026-10-13 00:00Z run summary: notifications `drained: true`, about 2.5k remaining, `any_halted: false`. Vishnu turned three steps live at ~21:47 PT; see "retention switches + redeploy" and "first live purge" above. |
| note | The remote branch `fix/retention-notifications-drain` was not deleted: `--delete-branch` failed locally. Deleting it is Vishnu's call. |

---

## Shipped 2026-10-11 — PR #101, the PDF polish pass: dates by month name in site time (N105), the address comma, badge spacing, answered-late seconds and N177, by OVERRIDE — verified 2026-10-11 21:02 PT

| thing | value |
|---|---|
| merge | PR #101 merged as `c1a364f` at **20:39:30 PT by OVERRIDE**: Vishnu waived the ping gate ("OVERRIDE: cancel the 21:00 armed run and merge #101 now. I'm waiving the ping gate."). His conditions held. The armed 21:00 "any guard" run was stopped first; its log shows it had only armed and passed preflight. CI was 5/5 green and CLEAN; head `e3f763b` and `main` `c278689` were pinned; there was one merge call and no retry (`gh pr merge 101 --merge --match-head-commit e3f763b…`). The merge tree equals the approved head's tree (`78851430`). A dry run on the 20:30 wave had passed: it saw GRD0024's 20:30:09 ping 2.4 s after it landed. |
| Railway | `ee2dd3a4-df27-47d0-9977-51d980f447d4` **SUCCESS** at 20:40:35 PT from `c1a364f`. |
| web | Vercel production on `c1a364f`: success at 20:40:53 PT. |
| health | `/health` commit `c1a364f`; `/health/crons` 20 jobs, `stale: []`; route control 401. |
| switchover | The old container (`db50935d`) stopped at 20:40:46.1 PT; its last request was at 20:40:25. Over its whole life (12:01 to 20:40 PT) it served 2,535 requests, with 0 5xx and 1 client abort (16:29). The new deployment served 346 requests by 21:01, none at 499 or above; its only 4xx were the 401 control and the known GET `/api/inspections/session/:id` 404. Sentry, the 25 minutes after: API 0; mobile, only old info-level events. |
| restart window | 20:39:30–20:40:47, with no STARNET write; the last one before the merge was at 20:34:30. The 20:40 cron tick ran on the old container. The 21:00 wave was the write-path control: GRD0030, GRD0001, GRD0027 and GRD0024 pinged (21:00:11–21:01:19), and reports landed at 21:00:42, 21:00:52 and 21:01:56, all on the new deployment. |
| visible change | Both client-facing PDFs changed: every date spells its month, in US order; the site security report's dates and times are in site time (N105); a letterhead address line that ends in a comma prints one comma; the activity log's badges clear the detail line and the guard's name; a miss answered under a minute late reads in seconds; and the hours total no longer runs into its label (N177). |

---

## Shipped 2026-10-11 — PR #100, the client's site security report carries the security company's letterhead (Phase B, stage B3) — verified 2026-10-11 12:31 PT

| thing | value |
|---|---|
| merge | PR #100 merged as `c278689` at **12:00:21 PT** by the **"any guard" method** (POLICY.md, route 2). Boundary 12:00:00; the first STARNET ping was GRD0023's at 12:00:15.6; `scripts/ops/any-guard-merge.py` confirmed the merge 7.9 s later. A dry run on the 11:30 wave passed first. |
| Railway | `db50935d-7b96-4e69-ab7b-e6b527b8b202` **SUCCESS** at 12:01:30 PT from `c278689`. |
| web | Vercel production on `c278689`: success at 12:02:04 PT, per its GitHub deployment record. |
| health | `/health` commit `c278689`; `/health/crons` 20 jobs, `stale: []` (12:01:52 PT); route control 401. |
| switchover | The old container (`673bfc2f`) stopped at 12:01:46.8; its last request was at 12:01:26.9. Its whole life (10-09 00:29 to 10-11 12:01) was read in 6-hour chunks, each rc=0. One chunk hit the 5,000-line cap, and its missing half hour was read again. The total: 0 5xx and 12 client aborts, all GETs, none in the restart window. The new deployment served 95 requests by 12:31, none at 499 or above; its only 4xx was the 401 control. Sentry, the 30 minutes after the merge: API 0; mobile, only the known MOBILE-13. |
| restart window | 12:00:21–12:01:47. The one STARNET write, a report at 12:01:26, got a 201 from the old deployment. None landed 12:01:47–12:16:47. The 12:30 wave was the write-path control: GRD0023's 12:30:34 ping got a 201 from the new deployment. |
| visible change | Every client who downloads a site security report gets the letterhead of the company that runs the site, so STARNET's client gets STARNET's: every contact field and the logo. Vishnu verified on 2026-10-11, before the merge, that STARNET's logo renders: in its Activity Logs PDF, on all 7 pages. No client had downloaded a report by 12:12 PT. |

---

## Shipped 2026-10-09 — PR #99, the guard's hours PDF carries the employer's letterhead (Phase B, stage B2), by OVERRIDE — verified 2026-10-09 00:47 PT

| thing | value |
|---|---|
| merge | PR #99 merged as `9298b6c` at **00:29:24 PT by OVERRIDE**: Vishnu waived the ping gate ("OVERRIDE: merge B2 now, no ping gate. I'm waiving it."). His conditions held: CI green and CLEAN; head `e648693` and `main` `ee34721` pinned; one merge call, no retry (`gh pr merge 99 --merge --match-head-commit e6486934…`); the usual post-deploy checks, including any STARNET write in the restart window. The merge tree equals the approved head's tree (`b02cc99d`). |
| Railway | `673bfc2f-08b8-4989-9a75-364db6bb0fcf` **SUCCESS** at 00:31:34 PT from `9298b6c`. |
| web | Vercel production succeeded at 00:31:03 PT. |
| health | `/health` commit `9298b6c` (checked again at 00:47); `/health/crons` 20 jobs, none stale; route control 401. |
| switchover | The new container started at 00:31:28.9 and the old one (`6e832272`) stopped at 00:31:44.8. The old deployment served 4,835 requests over its life with 0 5xx and 102 client aborts, none in the restart window. The new deployment served 105 requests by 00:47, none at 499 or above; its only 4xx was the 401 control, and its 81 3xx were GET 304s. `offline_dead_letters`: none. Sentry, the 20 minutes after: API 0, mobile 0. |
| restart window | 00:29:24–00:31:45, and no STARNET write failed. Three 00:30 pings got 201s from the old deployment (GRD0028 00:30:12, GRD0027 00:30:20, GRD0024 00:31:06). The 00:30 cron tick ran once, on the old container (7 notifications, 2 `missed_pings`). The old deployment's 72 requests in the window had one non-2xx, the known GET `/api/inspections/session/:id` 404. After the switch, GRD0024's 00:32:01 report got a 201 from the new deployment. |
| visible change | The guard's own hours PDF (`GET /api/shifts/my-hours.pdf`, the mobile download) carries the employer's letterhead, layout (a). STARNET's profile was empty at the merge, so its guards saw the name only. It has been filled in since (`updated_at` 2026-10-10 17:03 PT: every contact field and a logo), so they now get the full letterhead. Vishnu verified on 2026-10-11 that the logo renders: in STARNET's Activity Logs PDF, on all 7 pages. |
| sessions that did not ping at 00:30 | Both predate the merge. GRD0012 had not pinged all shift (N173). GRD0018 pinged at 23:30 and missed the 00:00 window before the merge. |

---

## Shipped 2026-10-08 — PR #98, N171: no CSV or XLSX cell from user-typed data runs as a formula — verified 2026-10-08 19:18 PT

| thing | value |
|---|---|
| merge | PR #98 merged as `ee34721` at **19:00:47 PT** by the **"any guard" method** (POLICY.md, route 2). Boundary 19:00:00; the first STARNET ping was GRD0015's at 19:00:42.0; `scripts/ops/any-guard-merge.py` confirmed the merge 7.4 s later. A dry run on the 18:30 wave had correctly declined an 11-minute-old ping. The merge tree equals the approved head's tree (`ebcbf11`). |
| Railway | `6e832272-0c8d-4d34-bd02-6e058e8169d0` **SUCCESS** at 19:02:22 PT from `ee34721`. |
| web | Vercel production on `ee34721`: success at 19:02:26 PT, per its GitHub deployment record. |
| health | `/health` commit `ee34721`; `/health/crons` 20 jobs, `stale: []` (19:18 PT). |
| switchover | The new container started at 19:02:16 and the old one (`ea07afba`) stopped at 19:02:33. The old deployment served 999 requests over its life with 0 5xx and 1 client abort (18:43). The count ran in 30-min chunks, each rc=0, because a single whole-life `railway logs` query had failed with rc=1, which is a failure, not a zero. The new deployment served 223 requests by 19:18, none at 499 or above. Sentry, 18:58–19:18 PT: 0 on the API; on mobile, only the known info-level MOBILE-10. |
| restart window | No STARNET write between the merge and the old container stopping. After the switch, the new deployment took a clock-in with its verification (19:12:43), two reports (19:14, 19:17) and the 19:10 cron notification. |
| visible change | A CSV or XLSX text cell that starts with `= + - @`, a tab or a CR now carries a leading apostrophe. Ordinary names, descriptions and every figure are unchanged. |

---

## Shipped 2026-10-08 — PR #97, company letterhead on the admin surfaces (Phase B, stage B1) — verified 2026-10-08 17:50 PT

| thing | value |
|---|---|
| merge | PR #97 merged as `1632dd6` at **17:32:41 PT** by the **"any guard" method**, the new default (POLICY.md, route 2): merge within 60 s of the first STARNET ping after the boundary. Boundary 17:30:00; the first STARNET ping was GRD0015's at 17:32:33.5; `scripts/ops/any-guard-merge.py` confirmed the merge 9.9 s later. The merge tree equals the approved head's tree (`882b83d`). A wake-up for the planned 16:30 window never fired, and nothing ran then. |
| Railway | `ea07afba-2284-4f97-bb77-56586910a249` **SUCCESS** at 17:34:06 PT from `1632dd6`. |
| web | Vercel production on `1632dd6`: success at 17:34:00 PT, per its GitHub deployment record. |
| health | `/health` commit `1632dd6`; `/health/crons` 20 jobs, `stale: []` (17:50 PT). |
| switchover | The new container started at 17:34:00 and the old one (`aecfab2d`) stopped at 17:34:17. 0 5xx on the old deployment over its whole life (37 client aborts, all before 17:06) and 0 on the new one (162 requests by 17:50). Sentry, 17:30–17:50 PT: 0 issues on the API; on mobile, only the known MOBILE-13 (N168). |
| restart window | No STARNET write between the merge and the old container stopping. The next two pings, GRD0026 at 17:35:04 and GRD0024 at 17:40:10, were answered 201 by the new deployment. |
| visible change | Every tenant's admins: the Activity Logs PDF, the billing hours XLSX, the analytics CSV (including the live-status violations download) and, from the 2026-11-01 run, the monthly hours XLSX carry the company letterhead. STARNET's profile is empty, so theirs shows the name only: "STARNET SECURITY". |

---

## Shipped 2026-10-07 — PR #95, letterhead module (Phase B, stage B0) — verified 2026-10-07 17:31 PT

| thing | value |
|---|---|
| merge | PR #95 merged as `09791dd` at **17:00:54 PT** by gate route **PROXY** (`scripts/ops/proxy-merge.sh --live`). Gating guard GRD0024, recalibrated at 16:17 and 16:48 on its 15:30, 16:00 and 16:30 pings. Its day phone that day was iOS `NetraOps/48 CFNetwork/3860.700.1 Darwin/25.6.0`, not the `okhttp/4.12.0` of 10-06, and was the only one with that UA among the three open sessions, all STARNET. GRD0024 pinged at 17:00:34 and the merge ran at ping age 16 s. The branch had been rebased onto `4404f43` (#96); the merge tree equals the approved head's tree (`f8363cbd`). |
| Railway | `aecfab2d-be84-4266-af33-d1c2e33cd7fb` **SUCCESS** at 17:03:36 PT from `09791dd`. |
| web | Vercel production on `09791dd`: success at 17:02:41 PT, per its GitHub deployment record. |
| health | `/health` commit `09791dd`; `/health/crons` 20 jobs, `stale: []` (17:20 PT). |
| switchover | The new container started at 17:03:08 and the old one stopped at 17:03:50. 0 5xx on either deployment over its whole life. Sentry, 17:00–17:20 PT: on the API only the info-level `retention_run_summary` at 17:00:00, before the merge; on mobile, 0. |
| restart window | One STARNET write between the merge and the old container stopping: a report at 17:01:16. No guard traffic in the 15 min after the switch. The 17:30 pings from GRD0015 and GRD0024 then landed on the new deployment (201). |
| visible change | None: no report passed a letterhead yet. `POST /logo` now refuses a logo that does not decode (N167). |
| #96 | Play Store assets (`marketing/play-store` only), merged 2026-10-06 19:59 PT as `4404f43`, outside a gate window. It restarted Railway (`29d8d13a`). Checked read-only at 00:20 the next day: 0 5xx on both deployments, the 20:00 cron ran once, every STARNET write landed, Sentry 0 on the API. |

---

## Shipped 2026-10-06 — PR #94, Company Profile web Settings page (Phase A complete) — verified 2026-10-06 16:21 PT

| thing | value |
|---|---|
| merge | PR #94 merged as `5def3a5` at **16:03:49 PT** by gate route **PROXY** (`scripts/ops/proxy-merge.sh --live`). Gating guard: GRD0024. Its `okhttp/4.12.0` was recalibrated on its 15:34:32 ping and was the only Android UA among the four open sessions, all STARNET; Vishnu excluded GRD0026. Boundary 16:00 PT; GRD0024 pinged at 16:03:38 and the merge ran at ping age 8 s. The merge tree equals the approved head's tree. |
| Railway | `0b9f2a1b-1f7f-463d-93d3-994f5eb1e458` **SUCCESS** at 16:05:27 PT from `5def3a5`. A web-only merge still restarts Railway: no watch paths (N154). |
| web | Vercel production on `5def3a5`: success at 16:05:25 PT, per its GitHub deployment record. |
| health | `/health` commit `5def3a5`; `/health/crons` 20 jobs, `stale: []` (16:21 PT). |
| switchover | 0 5xx and 0 499: the old deployment served 147 requests (its last at 16:05:25), the new one 139 by 16:21. Sentry, 16:04-16:21 PT: 0 issues on API and on mobile. |
| restart window | From the merge (16:03:49) to the switchover (16:05:27): one STARNET write, GRD0024's report at 16:04:01, answered 201 by the old deployment. |
| prod logo test | Run by Vishnu from Settings, logged in as Star Guard's primary admin. Upload: POST /logo 200 at 16:11:44, with an audit row from NULL to `company-logos/b7c7d32d-…/0317354a-….png`. Reload: GET 200, the preview came back. Remove: DELETE 200 at 16:12:13, with an audit row back to NULL. Both audit rows name the active primary admin, Star Guard has no logo again, and no delete-failure warning fired. Bucket versioning keeps the removed object as a noncurrent version. **PASSED.** |

---

## Shipped 2026-10-06 — PR #93, Company Profile API (Phase A) — verified 2026-10-06 14:17 PT

| thing | value |
|---|---|
| merge | PR #93 merged as `66ac758` at **14:00:20 PT** by gate route **OVERRIDE**. The 13:30 PROXY run aborted with no merge when its gating guard, GRD0026, went silent. Vishnu then waived the single-guard gate: merge within 60 s of the first STARNET 201 ping after 14:00:00 PT from any guard, and no merge if none landed by 14:10. The first was GRD0010's ping at 14:00:07.844 PT. Prechecks passed (head `e3cf4fb` CLEAN, main `deab5eb`, deployment `80e63900` SUCCESS). One `gh pr merge --match-head-commit` merged it 9 s after the ping. |
| Railway | `b553eae1-1d34-4549-809b-9a0d8dbdcae6` **SUCCESS** at 14:01:46 PT from `66ac758`; the previous `80e63900` was removed. No DB step: v82 shipped with #92. |
| health | `/health` commit `66ac758`; `/health/crons` 20 jobs, `stale: []` (14:17 PT). |
| routes | Without a token: `GET /api/admin/company` went from 404 (13:05 PT) to **401** after the deploy. `POST /api/admin/company/logo` returns **401**. `GET /api/admin/company/logo` returns 404 because there is no GET handler, by design. |
| restart window | From the merge (14:00:20) to the switchover (14:01:46): **0 STARNET writes** across the 25 event types checked (pings, sessions, reports, notifications, missed pings and reports, breaks, scans, violations, devices and others). After the merge the old deployment served only reads; its last request was at 14:01:25. |
| switchover | 0 5xx: the old deployment served 32 requests from 13:58, the new one 232 by 14:17. Sentry, 14:00-14:17 PT: `netraops-api` 0 issues; `netraops-mobile` only the recurring MOBILE-13, 0 new. First STARNET writes on the new deployment: GRD0024's ping (14:05:34) and report (14:05:56), both 201, then GRD0026's ping (14:11:53) and GRD0013's report (14:17:28). |
| still to run | The prod logo upload and remove on Star Guard. Vishnu runs it from the Settings page after the web PR ships (his call, 2026-10-06). |

---

## Shipped 2026-10-06 — PR #92, schema v82 (Company Profile, Phase A) — verified 2026-10-06 12:34 PT

| thing | value |
|---|---|
| merge | PR #92 merged as `deab5eb` at **12:06:02 PT** by gate route **PROXY** (`scripts/ops/proxy-merge.sh --live`). Gating guard GRD0024 (`okhttp/4.12.0`, calibrated against its DB ping rows; GRD0010 was ineligible because GRD0013's open session shared its iOS UA). Boundary 12:00 PT; GRD0024's ping 12:05:47.159 PT; merged at ping age 12 s. CONDITION was unavailable (N166). |
| v82 | **Applied by hand by Vishnu as `postgres` before the merge**: `scripts/ops/v82_company_profile.sql` (preview, ROLLBACK), then `v82_company_profile_COMMIT.sql`; summary row `14 \| t \| 4 \| t`. Verified via `postgres-readonly` at 11:49:58 PT: eight new `companies` columns with the v82 types, all NULLable, no DEFAULT; `company_profile_audit` present, FK `ON DELETE CASCADE`, readable by `claude_readonly`, 0 rows. |
| Railway | `80e63900-c04d-4559-b709-3a6a3ee58663` **SUCCESS** at 12:08:44 PT from `deab5eb`; the previous `950665a1` was removed. |
| health | `/health` commit `deab5eb`; `/health/crons` 20 jobs, `stale: []` (12:24 PT). |
| switchover | 0 5xx: the old deployment served 45 requests during the build, the new one 89 by 12:24. Sentry `netraops-api` and `netraops-mobile`: 0 issues seen and 0 new, 12:08-12:24 PT. First STARNET writes on the new deployment: pings at 12:30:20, 12:30:23 and 12:31:47 PT, all 201. |
| schema tip | **v82** applied in prod; `migrate.ts` ends `'schema_v82.sql'`. Read `migrate.ts` for the next free number, never this row. |
| S3 IAM | `starguard-app` is allowed `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `guard-media-prod/company-logos/*`: `aws iam simulate-principal-policy`, run by Vishnu 2026-10-06. |

---

## Schema — verified 2026-09-14 18:55 UTC (v69-v77 applied; v68 rows retained)

The tip below is superseded: v82 is applied (section above). The rows stay as the record of v67-v77.

| thing | value |
|---|---|
| tip in `migrate.ts` (file) | **v77** — `files` array ends `'schema_v76.sql', 'schema_v77.sql'` (`apps/api/src/db/migrate.ts:10`) |
| tip on disk | **v77** — `ls schema_v*.sql \| sort -V \| tail -1` → `schema_v77.sql`. 76 `schema_v*.sql` on disk (78 `.sql` total, incl. `schema.sql` and `schema_auth.sql`), 78 entries in the array, no duplicates, every entry resolves. |
| tip applied in prod DB | **v77** — `pg_constraint` returns `shifts_no_guard_overlap` on `shifts` with `contype='x'`, and `pg_extension` returns `btree_gist 1.8`. **Applied by hand by Vishnu 2026-09-13**, re-verified by catalog read 2026-09-14. Full `pg_get_constraintdef` below. |
| **v67** | **APPLIED 2026-09-05.** `to_regclass('public.cron_heartbeats')` returns `cron_heartbeats` — v67's entire contract. |
| **v68** | **APPLIED 2026-09-08** (PR #21). `shift_sessions.ping_interval_minutes INTEGER NULL`, no default, no CHECK. 211 sessions: **210 NULL, 1 stamped `30`** (first at 19:00:14Z), so the Phase D `COALESCE(x, 30)` resolves to 30 for every row that exists. |
| **v69** | **APPLIED** — `chk_shift_sessions_ping_interval_minutes` present on `shift_sessions`. |
| **v70** | **APPLIED** — `to_regclass('public.site_config_audit')` is non-null. |
| **v71** | **APPLIED** — `shifts.source` present; `chk_shifts_source` and `chk_shifts_created_by_role` both present on `shifts`. |
| **v72** | **APPLIED** — `to_regclass('public.idx_shifts_guard_scheduled')` is non-null. |
| **v73** | **APPLIED** — `to_regclass('public.idx_shifts_scheduled_start')` is non-null. |
| **v74** | **APPLIED** — `chk_shift_reassignments_direction` present; `shift_reassignments.new_guard_id` has `attnotnull = false`. |
| **v75** | **APPLIED** — `shifts.guard_id` and `clock_in_verifications.site_photo_url` both `attnotnull = false`; `to_regclass('public.idx_prt_token')` is non-null. |
| **v76** | **APPLIED** — `shifts.unstaffed_warning_sent_at` present. |
| **v77** | **APPLIED 2026-09-13 BY HAND** (PR #52, `f027f72` / merge `addb974`). Constraint and extension quoted below. |
| **v78** | **FREE** — no `schema_v78.sql` on disk; the chain ends at v77. |

### v77 — the exact verification

Read from the production catalog 2026-09-14 18:55 UTC via `postgres-readonly`:

```
conname              | shifts_no_guard_overlap
contype              | x
table                | shifts
pg_get_constraintdef | EXCLUDE USING gist (guard_id WITH =,
                       tstzrange(scheduled_start, scheduled_end) WITH &&)
                       WHERE (((status)::text = ANY ((ARRAY['scheduled'::character varying,
                       'active'::character varying])::text[])))

extname    | btree_gist
extversion | 1.8
```

**This table was nine versions stale for six days and that staleness shipped a false
P2 to Slack.** On 2026-09-14, `ops-triage` run `34881357451` posted
`BROKE P2 · N45 guard-overlap constraint (schema_v77) shipped in code but migration
not confirmed applied`. The constraint had been applied the previous evening. The
model was not guessing: `scripts/ops/triage.sh` embeds this file **verbatim and in
full** into the context pack, so the `v68` rows above and the `v69 FREE` row were
handed to it as ground truth, and it cited them.

The lesson is the same one the v66 note below already records, with one addition:
**a stale row here is not a documentation defect, it is an input to an automated
alarm.** `c_schema_applied` in `scripts/ops/triage.sh` now reads the catalog on
every run, so the brief no longer depends on this table being fresh — but the table
is still what a human reads first, and it must be corrected when a migration is
applied by hand, in the same sitting.

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

## Mobile — `app.json` re-read 2026-09-29 at `95a10a38`; builds table from Vishnu's build list and App Store Connect, 2026-09-29

`apps/mobile/app.json` literal values:

| field | value |
|---|---|
| `expo.version` | `1.0.18` (bumped in `b0f3c85`, 2026-09-18). The 1.0.17 runtime's JS is published from `batch/mobile-18`'s `ddc6f0a` (D21) |
| `expo.runtimeVersion` | `{"policy": "appVersion"}` → resolves to **`1.0.18`** on main |
| `expo.ios.buildNumber` | `41` |
| `expo.android.versionCode` | `17` |
| `expo.updates.url` | `https://u.expo.dev/5fd28125-2461-4165-b9df-7f34ced8b194` |
| `expo.updates.checkAutomatically` | `ON_LOAD` |
| owner / slug | `vvishnu1998` / `guard` |

**`buildNumber` and `versionCode` in `app.json` are ignored.** EAS remote
versioning is source of truth. The real shipped numbers, from `eas build:list`:

| platform | appVersion | build | commit | profile / channel | status | created |
|---|---|---|---|---|---|---|
| IOS | 1.0.17 | **48** (`8d8ecd90`) | `c932c09` | production | FINISHED. App Store: **approved, "Pending Developer Release"** — not released on the App Store. Guards run it through **TestFlight** (internal + Public Beta, 24 installs); **that TestFlight build expires ~2026-11-28 (N153)** | 2026-08-30T01:21:10Z |
| ANDROID | 1.0.17 | **24** (`fe3c1ff2`) | `c932c09` | production | FINISHED | 2026-08-30T01:21:11Z |
| ANDROID | 1.0.18 | **25** (`53f0189b`) | `b0f3c85` | not given | not given | 2026-09-18 |
| ANDROID | 1.0.18 | **26** (`7dc508bf`) | `7bff232` (API 36) | production | Play production review submitted 2026-09-18, managed publishing ON — **outcome UNVERIFIED**. Same fingerprint as vc27 | 2026-09-18 |
| ANDROID | 1.0.18 | **27** (`b08cbf4c`) | `7bff232` | production | **CANCELED**, no artifact — **next production build is vc28** | 2026-09-18 |
| ANDROID | 1.0.18 | **27** (`6113295c`) | `579ee12` | preview (APK) | FINISHED | 2026-09-27 |
| ANDROID | 1.0.16 | 23 | `ef1e230` | smoke | FINISHED | 2026-08-23T19:29:21Z |
| ANDROID | 1.0.16 | 23 | `4cd4956` | development | FINISHED | 2026-08-23T18:17:27Z |

Rows vc24–vc27 and iOS 48's build id: Vishnu's `eas build:list`, 2026-09-29 (dates only;
vc25's profile and status were not given). App Store status: Vishnu, from App Store
Connect, 2026-09-29.

`c932c09` = `feat(mobile): download hours summary as PDF from the profile screen`.

---

## EAS channels + update groups — updated 2026-10-11 (batch 19's groups from Vishnu's publish record of 2026-10-10; publish time from the first adopted update id; adoption from `guard_devices.client` and Sentry's `ota_updates.update_id`)

Channels: `production`, `preview`, `smoke`, `development` (`eas channel:list`, last run
2026-09-05). A binary polls only its own channel, and only its own runtime (policy
`appVersion`). An update applies on the second launch after publish (`ON_LOAD`,
`fallbackToCacheTimeout: 0`). How to publish: DECISIONS D21, release-ops §3b.

| channel | runtime | current group | from | published (PT) | rollback target |
|---|---|---|---|---|---|
| production | 1.0.17 | `cfde98cf-9fe6-474e-873c-96557edb1c1a` (batch 19; ios `01a12664-a070-7d24-88b6-d36c9a39dd2a`, android UNVERIFIED) | `a02c583` | 2026-10-10 08:18:11 (from the ios update id) | republish `fe530a7a-3a3d-406e-8125-2d8be8df6ecc` (batch 18, `ddc6f0a`, 2026-09-29 11:33:06) |
| production | 1.0.18 | `fa07bddb-5b49-41e1-9cf4-78c111108227` (batch 19) | `30f8689` | 2026-10-10, minutes after 08:18; the exact second is UNVERIFIED until a 1.0.18 phone adopts it | republish `ce679c72-2a37-4034-a29d-1be16afab7e3` (batch 18, `f5a84c4`, 2026-09-29 16:39:24) |
| preview | 1.0.18 | `facf85c4-7562-4a24-87c8-4fcc1d5742b9`, republished from production `fa07bddb` (same bundles) | `30f8689` | 2026-10-10, same | republish `429943ab-8561-4766-b031-635587d0a6c3` (batch 18, `f5a84c4`, 2026-09-29 08:39:30) |
| preview | 1.0.17 | `ff99ee6f-f732-449c-9eae-38a0fe3f224c` | UNVERIFIED | 2026-09-02 | — |
| smoke | 1.0.17 | `2e20d40d-ffb3-4689-a7a2-af5183b2995b` at 2026-09-05; **UNVERIFIED since** | — | — | — |
| development | — | none at 2026-09-05; **UNVERIFIED since** | — | — | — |
| (any) | 1.0.16 | last updates 2026-08-22 (iOS `01a02a71…`) and 2026-08-26 (Android `01a04071-040b…` 16:39:03, `01a04071-d36e…` 16:39:56, `01a04072…` 16:40:23 — likely one change on three channels); groups and channels UNVERIFIED | — | — | none planned (N115) |

**batch/mobile-19, published 2026-10-10 and pushed.** `a02c583` is the 1.0.17 tree and `30f8689` the
1.0.18 tree (a merge of `f5a84c4`). Both were exported and gated with `scripts/ops/ota-export-and-gate.sh`
(D21) at 08:15–08:16 PT: RESULT PASS, 71-file manifests OK, DSN file deleted.
- Native fingerprints are unchanged from the store builds: 1.0.17 `476dd916`, 1.0.18 `0a0d45d1`.
- **Contents (N173):**
  - PING NOW on home, through the same gate as the active-shift tile, and a "PING DUE NOW" line.
  - The answered window is remembered across restarts, and a backfill no longer un-answers it.
  - An open break dims PING on both screens.
  - "(late)" is shown only when the server recorded the ping late.
  - A notifications-off banner that names the Settings path.
- Simulator-tested against a local API on 2026-10-09 and 10-10.
- **The preview channel still has a live binary.** Sentry had 5 events from the batch-18 preview
  Android update (`01a0edd2…`) on 2026-10-09, so the preview publish was needed.
- **Older groups, kept for history:**
  - Production 1.0.17 had `9db401c9-6319-49b4-ab17-64cf559995a0` before batch 18 (`b3dcd55`,
    2026-09-17 15:07). **It has no Sentry DSN and the 30-min grace (N152, N138).** Before that it
    had `948d55c8-75da-44ea-8a2f-6847d87144a7` (batch-17).
  - Production and preview 1.0.18 had no group before batch 18, so rolling back past it means the
    embedded bundle: `7bff232` on vc26, `579ee12` on vc27.

Earlier 1.0.17 production group: `9386a6d2` (2026-09-10; update ids `01a08a24…`, per
netraops-invariants). Other 1.0.17 update ids seen on devices, channel UNVERIFIED:
`01a096c1…` (2026-09-12, Android only), `01a09773…` (2026-09-12).

**Preview reaches a paying customer.** STARNET guard GRD0024 (`94ab7696`) ran the vc27
preview APK (Vishnu gave it to them; confirmed 2026-09-29), `guard_devices` rows on embedded
`dc827710…` from 2026-09-28 04:52 to 2026-09-29 14:23 PT, when the guard signed in on an
iPhone again (production, `01a0b168…`). The Android row never adopted `429943ab`.

Non-revoked STARNET `guard_devices` rows at 2026-10-11 10:03 PT:
- **4 iPhones on batch 19's `01a12664…`:** GRD0018, GRD0027, GRD0028, GRD0030.
- **7 on batch 18's `01a0ee71…`**, GRD0008 and GRD0012 among them.
- **4 on older updates, and 3 with no client string.**
- **Batch 19 also runs on GRD0013, GRD0023 and GRD0024,** per Sentry. Their rows do not show it:
  they have none, or it has not updated.
- **GRD0008 is now on an iPhone (1.0.17).** Its Android 1.0.16 rows are revoked.
- **GRD0013 and GRD0016 have never had a row,** because notifications were never granted.

N138 has the uuids.

History, verified 2026-09-05 08:33 UTC (`eas channel:list`):

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
