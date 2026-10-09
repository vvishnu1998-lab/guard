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
2. **PROXY** — the normal path. **Since 2026-10-08 the default is the "any guard"
   method (Vishnu):** merge within **60 s** of the first new STARNET ping at or after
   a :00 or :30 boundary, from **any** STARNET guard on post. A new ping is a 201: a
   new `location_pings` row; a 200 is a resend. No STARNET ping by boundary + 10 min:
   stop, no merge.
   - **Prechecks first:** CI green and the merge state CLEAN; the PR head pinned;
     `main` pinned; the newest Railway deployment SUCCESS from `main`, and `/health`
     reporting `main`.
   - **Merges happen while Vishnu is present.** No single-guard UA calibration and
     no scheduled wake-ups.
   - **The tool is `scripts/ops/any-guard-merge.py`.** It reads through the
     `postgres-readonly` role in a read-only transaction, and its one write is
     `gh pr merge --merge --match-head-commit`. Dry-run it on the previous wave first,
     with a deadline still in the future.
   - **This replaces D23's one-calibrated-guard gate** (`scripts/ops/proxy-merge.sh`).
     That gate kept failing on things outside the code: a guard's phone changing
     between days, two guards on an identical UA, ad-hoc shifts, and a session
     wake-up that never fired, which missed #97's 10-08 window.
3. **OVERRIDE** — Vishnu waives it explicitly. Record as a bypass and capture what
   landed during the window.

**An `eas update` is not an API deploy.** Publishing a bundle restarts nothing; a
running app keeps its loaded JS and only swaps on cold start. Honour the gate if
asked, but do not reason as though an OTA can interrupt a shift mid-request.

**Tier 0 read-only prod queries go through `postgres-readonly` only.** There are
**50** public base tables. That role holds table-level SELECT on **42** of them and
**column-level** SELECT on the other 8 — `guards`, `company_admins`, `clients`,
`guard_devices`, `login_attempts`, `password_reset_tokens`, `revoked_tokens`,
`vishnu_state`. On those 8 the grant **excludes the credential columns**, so the
role **cannot read them**: `password_hash`, `tokens_not_before`, `push_token`,
`otp_hash`, `token`, `jti`.

**This corrects the previous text, which said "all 48 public tables" and "can read
every credential column".** The second half was wrong in the safe direction, and it
was corrected 2026-09-15 rather than left alone because a policy doc that overstates
a role's reach invites a wrong risk call later. Proof, from the role itself:

```
SELECT count(password_hash) FROM guards;   ->  ERROR: permission denied for table guards
SELECT count(*)             FROM guards;   ->  49          (column-level grant, no table grant)
```

Two practical consequences, both of which have already misled a reading of this
role:

* `has_table_privilege(current_user, 'guards', 'SELECT')` returns **false** while
  `SELECT count(*) FROM guards` **succeeds**. A column-level grant does not show up
  as a table privilege. Do not conclude a table is unreadable from that function.
* `information_schema.columns` is privilege-filtered, so it **under-reports** those
  8 tables — 523 columns against `pg_attribute`'s 534, 8 tables disagreeing. Take
  column inventories from `pg_attribute`. Every other table, including `sites` and
  `shifts`, agrees exactly.

"Read-only" is still not "harmless": the *guard data* rule above governs what may
leave the query. The credential columns are now enforced by the grant rather than by
discipline — but the rule stands for everything the grant does not cover.
