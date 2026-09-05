# DISPATCH TEMPLATE

The shape that works: **PHASE 0 read-only → STOP → PHASE N → STOP → verify.**

Each phase ends with an explicit STOP. The agent does not proceed to the next
phase on its own, and the human decides whether the ground truth from the previous
phase changes the plan. Phase 0 is always read-only, and it exists specifically to
catch the assumptions the dispatch itself carries — a Phase 0 that only confirms
what you already believed was written too narrowly.

---

## Constraints header

Paste at the top of every dispatch, edited for the phase:

```
NETRAOPS OPS LOOP — PHASE <N>: <NAME>
Repo: ~/guard. <branch instruction>. <push instruction>.
Zero prod writes. DB reads via postgres-readonly only.
STARNET UUID always full: 27c4d404-8769-49ca-bfd6-93cb9b890067.
Every state line you write must be verified now against repo, DB, or CLI.
Unverifiable → write UNVERIFIED next to it.
Do not copy a value from memory or from this dispatch without checking it.
```

Each line earns its place:

- **`Repo: ~/guard`** — the agent may be started anywhere.
- **branch/push instruction** — say whether to cut a branch, which base, and
  whether to push. "No push — print the final SHA and STOP" keeps the human as the
  one who moves refs. **The refspec is the plan:** a split push is
  `git push origin <sha>:main`, not the generic form.
- **`Zero prod writes`** — states the blast radius up front rather than relying on
  the agent to infer it per-action.
- **`DB reads via postgres-readonly only`** — names the connection. The superuser
  MCP was deleted 2026-07-31 and must never be re-added.
- **Full STARNET UUID** — a truncated id returns zero rows, and an empty result
  from a wrong id is indistinguishable from an empty result from a true
  condition. This has caused a false "gate is open" reading before.
- **`verified now … UNVERIFIED`** — the load-bearing line. Without it an agent
  will restate the dispatch back to you as findings.
- **`Do not copy a value from memory or from this dispatch`** — closes the loop:
  values in the dispatch are hypotheses, not evidence.

---

## Phase 0 — read-only audit

```
CONTEXT
<one paragraph: what is being built, and why ground truth is needed first>

TASKS
1. <numbered, each independently checkable>
…

REPORT FORMAT
One section per task, numbered. Evidence under each claim:
file:line, command + output, query + row count.
End with:
- Blockers for Phase 1
- Blockers for Phase 2
- Anything that contradicts the following assumptions: <list them explicitly>

STOP after the report. Do not proceed to Phase 1.
```

**Always list the assumptions to be contradicted.** Naming them is what converts a
Phase 0 from a summary into a test. In the 2026-09-05 run, two of six named
assumptions were false ("5 crons exist" — there are 19; "no workflows exist" —
gitleaks has been running on every push to main since April).

---

## Phase N — do the work

```
NETRAOPS OPS LOOP — PHASE <N>: <NAME>
<constraints header>

<what to create or change, file by file>

Do NOT touch <explicit exclusions>.
Do NOT modify any file outside <allowed paths>.

COMMIT as one commit: "<type>(<scope>): <subject>"
Print git log -1 --stat and the SHA.

REPORT: per file, line count and every value marked UNVERIFIED.
Confirm zero files changed outside <allowed paths> via git diff --stat <base>..HEAD.

STOP. <who does what next, and what gates it>
```

Exclusions are as important as inclusions. "Do NOT touch
`.claude/settings.local.json`" prevents an agent tidying a file that contains a
credential.

---

## Verify

The verify step belongs to the human, and it is a different question from "did the
agent do what it said":

- `git diff --stat <base>..HEAD` — did anything change outside the allowed paths?
- Does each state line carry evidence, or does it restate the dispatch?
- Is every unverifiable value actually marked `UNVERIFIED`, or was one quietly
  asserted?
- Did the agent contradict any of the named assumptions? If it contradicted none,
  that is a signal to check whether it really looked.

---

## Gates

A phase that ends in a merge to `main` is gated. Merging restarts the API — every
push to `main` triggers a Railway rebuild regardless of what the diff touches
(no `watchPatterns` exist anywhere in the repo).

State the gate in the dispatch, and name which of the three routes was used:
**CONDITION** (zero open STARNET sessions), **PROXY** (push within 90s of a
STARNET ping), or **OVERRIDE** (explicit waiver, recorded as a bypass). See
`POLICY.md`.
