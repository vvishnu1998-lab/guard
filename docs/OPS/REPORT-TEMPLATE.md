# REPORT TEMPLATE

The exact shape every triage run must emit. Section order and headings are
fixed; the runner's output is diffed against previous runs, and a moved heading
reads as a change.

Fill every cell. A cell with nothing to say says `none` or `UNVERIFIED` — never
blank, because a blank cell reads as "fine" and that is how a signal gets
missed.

**Data rule, absolute:** `guard_id`, `badge_number`, `company_id`, `site_id`,
`shift_id`, `session_id` and counts only. Never names, emails, phone numbers,
or coordinates. If a query would return them, select only the allowed columns.
Badges collide across tenants, so a badge alone is not an identifier — pair it
with `company_id`.

---

## Header

| field | value |
|---|---|
| run id | GitHub Actions run id, or `local` for a manual run |
| time | ISO 8601 with offset, plus the same instant as `HH:MM PT` |
| main sha | short sha of `origin/main` at collection time |
| deployment id | current Railway deployment id and status |
| trigger | `schedule` or `workflow_dispatch` (with the `focus` input if given) |

## Signals

One row per signal. `status` is `ok` / `warn` / `fail` / `UNVERIFIED`.
`evidence` names the command or query and its result size — not prose.

| signal | status | value | evidence |
|---|---|---|---|
| `/health` | | body | `curl` + HTTP code |
| `/health/crons` | | `jobs:N stale:M` | `curl` + HTTP code |
| deployment | | id + status | `railway status` / `railway logs` line count |
| Sentry `netraops-api` | | issue count last 6h | API path + row count |
| Sentry `netraops-mobile` | | issue count last 6h | API path + row count |
| STARNET open sessions | | count | query + row count |
| customer signal | | active guards this 7d vs prior 7d | query + both counts |

## Findings

Grouped by severity, most severe first. Omit a severity heading only if it has
no findings; do not write "none" under a heading you kept.

Severity maps to the `POLICY.md` ladder — a finding's severity is about
customer impact, and the **Tier** on its proposed fix is about who may approve
that fix. They are independent: a P3 cleanup touching guard-facing enforcement
is still Tier 2.

### P0 — customer-affecting now
### P1 — customer-affecting soon, or silent data loss
### P2 — degraded, not yet customer-visible
### P3 — hygiene, drift, stale docs

Each finding:

- **What** — one sentence.
- **Evidence** — the query and its row count, or the log lines and how many.
  Never a claim without one.
- **Blast radius** — as IDs and counts. Which `guard_id`s, which `site_id`s,
  how many sessions. `unknown` if it cannot be bounded from read-only access.
- **Root cause** — a falsifiable claim, or the literal word `UNCONFIRMED`. A
  plausible story with no way to test it is `UNCONFIRMED`.
- **Proposed fix** — sized `S` / `M` / `L`, with its `POLICY.md` Tier.

## Evidence

The raw material behind the tables above: queries with row counts, log excerpts
with line counts, API paths with response sizes. Enough that a reader can
re-run any claim without guessing what was run.

Log excerpts are quoted with their line count. "Nothing in the logs" is only
admissible alongside the count of lines actually searched.

## Decisions

A numbered list. Each item is a decision **Vishnu** makes, not one the runner
made. Options are lettered, and one line at the end recommends one.

```
1. <the decision>
   a. <option>
   b. <option>
   c. <option>
   rec: <a/b/c> — <one line why>
```

If there is nothing to decide, write `No decisions this run.`

## Weekly

**Mondays only.** Omit this section entirely on other days.

| item | value |
|---|---|
| expiries within 30 days | from `EXPIRIES.md`, or `none` / `UNVERIFIED` |
| open-items delta | new / closed since the last report |
| last Nataniel contact | date from `STATE.md`, or `UNVERIFIED` |

---

## When there is nothing to report

Say **All green** — and still fill in the Header, Signals and Evidence
sections. An all-green run with no evidence table is indistinguishable from a
run that failed to collect anything, which is the failure mode this whole loop
exists to eliminate.
