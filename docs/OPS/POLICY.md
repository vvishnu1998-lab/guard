# POLICY — action tiers

Three tiers. Every action falls into one. When an action could plausibly sit in
two tiers, it takes the higher one.

---

## Tier 0 — no ask

- read-only prod queries
- Railway/Sentry reads
- branch work on `ops/*` or `feat/*`
- typecheck, tests, `next build`
- docs
- opening a draft PR
- Vercel preview

## Tier 1 — batched, one Slack reply or one PR approve

- merge to main (= Railway restart)
- expand-only schema migration
- OTA publish
- Vercel production alias
- updates to `docs/OPS` state files

## Tier 2 — live, Vishnu present

- prod DB write outside a migration
- contract-phase migrations
- EAS build
- store submission
- credential rotation
- anything sent to Nataniel/Sai/guards
- freeze-window changes
- anything touching STARNET data directly
- any change to guard-facing enforcement logic
- any change to `DECISIONS.md`

---

## Standing rules

- **Guard data leaves the DB as `guard_id`, `company_id`, badge, counts only.**
- **Examiner ≠ examinee.**
- **No action on silence.**

---

## Notes on applying the tiers

**"merge to main (= Railway restart)" is literal.** Every push to `main` triggers a
Railway rebuild and API restart — including a docs-only or `.claude/`-only push.
`apps/api/railway.json` sets build and deploy commands only; no `watchPatterns`
exist anywhere in the repo. Verified 2026-09-05: `railway.json` contains
`"buildCommand"`, `"startCommand"`, `restartPolicy` — and nothing else.

That means **merging this very file to `main` is a Tier 1 action that restarts the
API.** Hold the deploy gate for it like any other merge.

**The deploy gate has three routes. Name which one you used, every time.**

1. **CONDITION** — zero active STARNET shifts and zero open STARNET sessions. No
   ping can land, so the proxy is unsatisfiable while the thing it protects
   (nobody on post to disrupt) is trivially true. Safest window, not a bypass.
2. **PROXY** — the normal path: a STARNET ping row lands, push inside 90s. The
   gate is company-wide, not per-guard.
3. **OVERRIDE** — Vishnu waives it explicitly. Record as a bypass and capture what
   landed during the window.

**An `eas update` is not an API deploy.** Publishing a bundle restarts nothing; a
running app keeps its loaded JS and only swaps on cold start. Honour the gate if
asked, but do not reason as though an OTA can interrupt a shift mid-request.

**Tier 0 read-only prod queries go through `postgres-readonly` only.** That role
holds SELECT on all 48 public tables and **can read every credential column** —
`guards`/`company_admins`/`clients`.`password_hash`, `guard_devices.push_token`,
`password_reset_tokens.token`, `revoked_tokens.jti`, `login_attempts.otp_hash`.
"Read-only" is not "harmless": the *guard data* rule above governs what may leave
the query, and no credential column value may leave the DB at all.
