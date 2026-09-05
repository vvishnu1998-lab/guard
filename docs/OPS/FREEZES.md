# FREEZES

A freeze is a standing "do not write" over a named surface. Each entry names the
surface, why, and **the condition that ends it**. A freeze without an expiry
condition is a bug in this file.

Freeze-window changes are Tier 2 (`POLICY.md`) — live, Vishnu present.

---

## Active freezes

### F1 — guard `e8274964` GRD0002 (Star Guard)

**Surface:** guard account `e8274964-c274-4fde-ad4d-82bb1e128bc2`, badge `GRD0002`, tenant `Star Guard` (`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`).

**Verified 2026-09-05:** guard id `e8274964-c274-4fde-ad4d-82bb1e128bc2`, name
badge `GRD0002`, company `Star Guard`
(`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`). No `guard_devices` row (no push token).

**Reason:** UNVERIFIED — carried from chat memory. The account identity is
confirmed; the reason the freeze was placed is not recorded anywhere readable.
**Vishnu fills.**

**Expiry condition:** UNVERIFIED — **Vishnu fills.**

---

### F2 — Apple review surface

**Surface:** no writes to anything that could change what a reviewer sees, while
any App Store review is pending. In practice: mobile behaviour, reviewer
accounts/credentials, geofence widenings staged for review, and store metadata.

**Current pending build — verified 2026-09-05 against EAS:**

| field | value | source |
|---|---|---|
| iOS build | **48** | `eas build:list` → `appBuildVersion: "48"`, `platform: IOS` |
| Android build | 24 | same query, `platform: ANDROID` |
| appVersion | **1.0.17** | same |
| commit | **`c932c09`** | `gitCommitHash` |
| commit subject | `feat(mobile): download hours summary as PDF from the profile screen` | `git log -1 c932c09` |
| channel | `production` | same |
| EAS build status | `FINISHED` | same |
| built at | 2026-08-30T01:21:10Z | same |

**Review status: UNVERIFIED.** No App Store Connect or Play Console API access is
configured locally, so review state cannot be read from any CLI here. `FINISHED`
on EAS means the binary compiled — it says nothing about submission or review.
**Vishnu fills.**

**Expiry condition:** review **approved or rejected**, confirmed by Vishnu. Not
"probably done by now", not an inferred date — an explicit confirmation.

**Note:** any temporary review accommodation (widened geofences, seeded reviewer
accounts or shifts) is frozen with this entry and carries its own revert task with
the original values. See `OPEN-ITEMS.md` C3 for the reviewer seed script.

---

## Expired / lifted

*(none recorded yet — move entries here with the date and who confirmed the expiry
condition, rather than deleting them)*
