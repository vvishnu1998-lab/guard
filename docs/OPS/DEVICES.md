# DEVICES — STARNET device inventory

**Badge-only since 2026-10-13.** This file used to carry guard NAMES (it was split out of
`STATE.md` for that reason, N16); the repo is **public** and `POLICY.md` allows guard data
out as "guard_id, company_id, badge, counts only", so every name was replaced by the
guard's badge (N191). **The names remain in this repository's git history**; removing them
from `main`'s history is a separate, not recommended, rewrite.

**Still NOT included in the triage context pack** (that was a decision at the time and
nothing here changes it). If you add a collector or extend the pack, do not add this file to
it without a new decision.

## STARNET device inventory — verified 2026-09-05 08:36 UTC

Tenant resolved by id → name first: `27c4d404-8769-49ca-bfd6-93cb9b890067` = `STARNET SECURITY`.
IDs and badges only; no push-token values.

| badge | `client` identity string | last seen | reachable by current OTA? |
|---|---|---|---|
| GRD0004 | `platform/ios; version/1.0.17; build/41; runtime/1.0.17; update/01a05fb1-…` | 2026-09-04T22:55Z | **yes** (runtime 1.0.17) |
| GRD0005 | `platform/android; version/1.0.16; build/17; runtime/1.0.16; update/01a04071-…` | 2026-09-05T00:57Z | **NO** — runtime 1.0.16 |
| GRD0007 | `platform/ios; version/1.0.16; build/41; runtime/1.0.16; update/01a02a71-…` | 2026-09-04T00:17Z | **NO** — runtime 1.0.16 |
| GRD0002 | `NULL` | 2026-09-01T02:03Z | **UNKNOWN** — never sent a client header |
| GRD0001, GRD0006, GRD0008, GRD0009 | `NULL` | = claimed_at (never used since) | **UNKNOWN** |

`client` is written only by `claimDevice` (`apps/api/src/services/deviceRegistry.ts`), on
guard login (only when the login carries a push token) and on
`POST /api/auth/guard/fcm-token`, from the request's `X-NetraOps-Client` header
(`COALESCE`: an absent header keeps the stored value). The mobile login request sends no
such header (`store/authStore.ts` `_request`: Content-Type only), so a login stores `NULL`
for a new push token and keeps the old value for a known one. The app posts its token
through `apiClient`, which sends the header, on every signed-in launch
(`app/_layout.tsx:123`); that is what fills `client`. `clock-in`, `handoff-clock-in`, `ping`
and `clock-in-verification` only LOG the header (`[client.identity]`,
`services/clientIdentity.ts`) and write nothing.
A `NULL` means no token POST has landed since the claim: notification permission not
granted, the token fetch failed, the guard is still at the forced password change
(`app/_layout.tsx:117` skips the POST while `mustChangePassword`; the change then revokes
the row with `password_change`), the bundle predates the header (runtime 1.0.14), or no
signed-in launch since — not that the app is broken.
*Corrected 2026-09-29;* this paragraph said the four guard write routes wrote `client`.
The table above is a 2026-09-05 snapshot: STATE.md's channel section has the 2026-09-29
counts.

---
