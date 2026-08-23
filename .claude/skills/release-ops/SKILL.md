---
name: release-ops
description: Release engineering for web and mobile apps — branch strategy, build verification gates, app store submission operations (iOS App Store / TestFlight / Google Play), responsive QA, and pre-launch checklists. Use this skill whenever the user is cutting a build, managing release branches, submitting to an app store, preparing reviewer accounts, verifying UI across devices, or preparing any product launch — even if they only mention "build", "release", "TestFlight", "Play Store", or "launch".
---

# Release Ops

Four disciplines: **branch/build strategy**, **build gates**, **app store ops**, **QA + launch checklists**.

## 1. Branch strategy (batch pattern for mixed monorepo work)

- Backend/API changes ship to `main` immediately (cheap deploys).
- Expensive-build targets (mobile) accumulate on a long-lived `batch/<target>-N` branch; no builds until explicitly triggered.
- **Critical rule — the full cycle: accumulate on `batch/<target>-N` → ship a build from it → merge that branch to main (`--no-ff`, NEVER squash; the individual commits are the record of what shipped in each build) → cut `batch/<target>-N+1` off main.** The danger was never "main", it was **stale main**: cutting a new batch off a main that has NOT absorbed the last shipped batch silently drops every accumulated commit, and a build from the new branch regresses shipped features. Merging back before cutting is what makes main safe to cut from, and caps drift at one build. If the merge hasn't happened, cut off `batch/<target>-N`'s tip instead.
- Mixed commits (server + mobile in one change): commit together on the batch branch, then cherry-pick the server paths (`apps/api/**`) to main path-scoped. The mobile portion stays on the batch **until a build from it ships — then the branch merges to main per the cycle above.** Without that merge-back step, main's copy of the expensive-build target drifts arbitrarily far from what actually ships, and any audit reading it describes code no user runs.
- Flag breaking API↔client coupling before shipping the API half: will old deployed clients break against the new API?
- Hotfix override: on "emergency build", branch from main directly — don't route through the batch.

## 2. Build verification gates

**Pre-build gate (before triggering any build):**
```
pwd                      # correct repo
git rev-parse HEAD       # note the exact sha
git status               # clean tree
```
Confirm HEAD is the intended ref for this build and contains the accumulated work you expect — equalling main is fine on a freshly cut batch; being behind the last shipped batch is not.

**Post-build gate:** query the build system for the built artifact's commit hash and assert it equals the pre-build HEAD. A build from the wrong sha ships silently otherwise.

**Remote versioning:** if the build service manages version/build numbers remotely (e.g., EAS `appVersionSource: remote` + `autoIncrement`), the numbers in local config files are IGNORED and can lag — never trust or hand-edit them; the remote counter is the source of truth.

## 3. App store operations

**Reviewer test setup (iOS especially):**
- Seed a dedicated reviewer account: test user + realistic data + activatable flows (shifts/orders/content available every day of the review window, not just submission day).
- If the app gates on location/geofence: widen the geofence to the reviewer's likely region for the review window.
- **Log every temporary review accommodation as a revert-after-approval task with the exact original values.** Freeze the reviewer setup — no modifications until approval lands.
- Keep a seeding script; verify it actually ran successfully against prod before submission.

**Submission tracking:** record build number, version, submission ID, release mode (manual/auto), date. Track store-side expiries (e.g., Play Console AAB expiry) as dated risks.

**Credentials:** know which submissions need local key files vs server-stored keys; manual console upload is the fallback when automated submit is blocked.

## 3b. OTA channels — PUBLISH TO BOTH, ALWAYS

- **Every `eas update` goes to BOTH `--branch production` AND `--branch preview`.** A binary polls only the channel it was built with. A preview-profile build will NEVER see a production update, no matter how many times it relaunches — there is no fallback and no warning.
- **Precedent (2026-08-23).** Guards Nikith Reddy GRD0005 and Svineah GRD0008 (STARNET) were running `com.netraops.guard@1.0.16+23`, `environment: preview`. Every OTA — Wave 1 anti-spoof capture, Wave 2 provenance, the `X-NetraOps-Client` header — had gone to `production` only, and the `preview` branch had **zero update groups ever published**. Those two devices sat on the embedded bundle of a 08-20 APK for three days while enforcement they were the subject of ran on everyone else. The tell was `[client.identity] client="absent"` in the API log, plus `clock_in_fix_age_ms IS NULL` on a post-Wave-1 clock-in.
- **Diagnosing "the OTA didn't reach device X":** check `environment` on the Sentry release tag first (`preview` vs `production`) — that is the channel. Only then look at runtime version, relaunch count, or manifest fetch. Three of four hypotheses were wrong before the channel was checked.
- **Runtime gate is separate and harder.** `runtimeVersion: {policy: appVersion}`, so runtime == `app.json` `version`. A device below the published runtime can never be reached by ANY update and needs a store install — e.g. Nandu GRD0002 on `1.0.14+44` cannot receive a 1.0.16 OTA at all.
- **To bring a stale channel current without shipping new code:** `eas update:republish --group <groupId> --destination-branch <branch>`. It is ADDITIVE — verified 2026-08-23 that the source branch's group id and message were byte-identical before and after. Snapshot `eas branch:list` either side anyway.
- `eas update:list --branch <name>` showing `Group ID N/A` means the branch exists but nothing was ever published to it. That is not "up to date".

## 4. Responsive QA + launch checklist

**Viewport matrix (minimum):** small phone (~375px), large phone (~390px), desktop (~1280px). Verify every shipped UI change at all three.

**Automated ≠ real device.** Playwright/simulator passing is necessary, not sufficient. Before calling a customer-facing change verified: a real-device smoke test of the changed flows.

**Standard mobile adaptations:** cards-for-lists on narrow widths; `overflow-x-auto` for wide tables; breakpoint-gated layout (`md:`); grid-child hoisting (`md:contents`) to keep desktop grid shape while stacking on mobile.

**Client caching caveat:** mobile apps may cache server config (geofences, feature flags) at load — server-side changes don't propagate to open apps. Document the refresh path (re-login / reinstall) when testing.

**Pre-launch checklist (any SaaS/app):**
1. Security: auth flows audited, rate limits on unauthenticated endpoints, no secrets in repo/screenshots, buckets/storage locked down.
2. Credentials: all keys rotated post-development, env vars verified on every host.
3. Monitoring: error tracking live on every app (client + server), alert paths tested end-to-end (send a real test event).
4. Email/DNS: sender domains verified, deliverability tested to a real external inbox (check spam), reply-to and forwarders working.
5. Store readiness: screenshots at required sizes, reviewer account seeded and verified, privacy policy live and consistent between routes.
6. Data: no test data visible to real customers; tenant isolation spot-checked.
7. Rollback: every launch-day deploy individually revertible.

## Anti-patterns

- Cutting a new batch branch off a main that has not absorbed the last shipped batch (regression time bomb).
- Triggering a build without the pre-build gate, or skipping the post-build hash assertion.
- Hand-editing local build numbers under remote versioning.
- Modifying reviewer-facing data mid-review.
- Declaring UI verified from automated tests alone.
- Leaving a review-window accommodation (widened geofence, test flag) live after approval.
