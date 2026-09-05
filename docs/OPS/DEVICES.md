# DEVICES — STARNET device inventory

**Deliberately NOT included in the triage context pack.** This is the only
operational document that carries guard NAMES, and the pack is fed to a model
whose report must contain IDs, badges and counts only (`POLICY.md`). Splitting
it out of `STATE.md` is what lets the whole pack be name-free rather than
relying on the prompt to suppress what it was shown. Tracked as N16 in
`OPEN-ITEMS.md`.

If you add a collector or extend the pack, do not add this file to it.

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
