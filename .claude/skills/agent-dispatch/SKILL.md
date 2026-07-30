---
name: agent-dispatch
description: Write structured dispatch prompts for coding agents (Claude Code or similar), project briefs that let agents build without business Q&A, resume prompts for interrupted work, and structured status audits. Use this skill whenever the user asks for a prompt to send to Claude Code, wants to delegate coding/investigation work to an agent, needs to resume an interrupted agent task, asks for a project/technical brief for an agent to build from, or asks for a full status of pending items.
---

# Agent Dispatch

Templates and rules for delegating work to coding agents. Four modes: **dispatch**, **brief**, **resume**, **status-audit**. Pick the mode from the user's ask; deliver the output in a single copy-paste code block.

## Universal dispatch rules

- Header line always states: repo path, target branch, read-only vs read-write.
- Numbered phases. Risky steps get explicit `STOP — report and wait for approval` between them.
- Explicit negative constraints: what NOT to touch, what NOT to trigger ("Do NOT trigger builds", "Do NOT write to prod", "Do NOT modify <protected data>").
- One logical unit per commit. Name the commit message format if the project has one.
- Required report format at the end of every dispatch:
  - Full diff per file
  - Typecheck/test results
  - Deploy status + verification evidence (curl output, query result, screenshot)
  - Anomalies — anything unexpected, even if worked around
- If the task depends on unverified assumptions (a column exists, an endpoint behaves a certain way), the dispatch's Phase 0 is a read-only audit that verifies them first.

## Mode 1 — Investigation dispatch (read-only)

```
<Repo path>. READ-ONLY. Do not modify any files or data.

Problem: <one-paragraph symptom, exact reproduction, IDs involved>

Investigate:
1. <check data layer — query the actual records>
2. <check API layer — what does the endpoint return>
3. <check client layer — what does the UI call/render>
4. Classify root cause: backend / frontend / data.

Report findings only. Propose fixes but DO NOT implement.
STOP after reporting.
```

## Mode 2 — Fix/feature dispatch (read-write)

```
<Repo path>, branch <X>. Read-write.

Context: <2-3 lines, link to prior findings if any>

=== PHASE 0: Audit ===
Verify current state: <specific assumptions to confirm — schema columns,
file contents, env vars>. Report. STOP for approval.

=== PHASE 1: <unit of work> ===
<Numbered implementation steps>
Commit: <message>. <Deploy/push instruction>.
Verify: <specific evidence to collect>.
STOP — report diff + verification. Wait for approval.

=== PHASE 2: <next unit> ===
...

Constraints:
- Do NOT <trigger builds / touch table X / modify tenant Y>.
- Any prod DB write requires explicit approval first.

Report per phase: diff per file, typecheck, deploy status, verification
evidence, anomalies.
```

## Mode 3 — Resume dispatch (interrupted work)

```
<Repo path>. Resume the incomplete task from <when>: <one-line task summary>.

1. Check recent git commits — determine what was already done.
2. Verify whether the original problem still exists (query real data /
   reproduce). If already fixed, STOP and report.
3. Resume from the last verified step. Do not redo completed work.
4. <Original acceptance criteria>

Report: what was already done, what you did now, verification evidence.
```

## Mode 4 — Project brief (for greenfield agent builds)

When the user wants an agent to build a project without constant business Q&A, produce a brief document covering, in order:

1. **Product summary** — what it is, who uses it, core flows.
2. **Roles & permissions** — every user type and what they can/can't do.
3. **Data model** — every table, columns, types, constraints, relationships. This is the section agents ask about most; make it exhaustive.
4. **Business rules** — edge cases, timezone handling, retention, notifications, validation rules. Write as testable statements.
5. **Tech stack decisions** — locked choices (framework, hosting, services) so the agent doesn't ask.
6. **Phased implementation plan** — build order with a verifiable milestone per phase.
7. **Explicitly open questions** — the short list the agent SHOULD ask the user about (credentials, accounts, external service keys).

Rule: everything the agent could ask that has an answer goes in the brief. Only genuinely-user-held items (keys, accounts, preferences not yet decided) go in section 7.

## Mode 5 — Status audit

When asked "full status" / "what's pending", produce:

```
## Shipped (this period)
- <item> — <commit/deploy ref> — verified how

## In flight
- <item> — current phase — what's blocking completion

## Blocked
- <item> — blocker — who/what unblocks it

## Deferred (with reason)
- <item> — why deferred — revisit trigger

## Risks / expiries
- <time-bound items: cert expiries, review deadlines, quota resets>
```

Every line names its evidence or blocker. No vague "in progress" without the specific next action.

## Anti-patterns

- Dispatching a fix before the problem is confirmed with real data.
- One giant phase with no STOP points — interruption corrupts state.
- Omitting negative constraints and hoping the agent infers them.
- Report format left unspecified — you get prose instead of evidence.
- Amending a dispatch mid-execution — prefer interrupt + re-paste a clean revised dispatch.
