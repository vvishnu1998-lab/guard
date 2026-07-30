---
name: security-review
description: Workflow for running security audits on a codebase and shipping the resulting fixes safely, including using a second AI model as an independent reviewer. Use this skill whenever the user asks for a security audit, security review, penetration-style code review, vulnerability triage, or wants to fix security findings (auth, IDOR, rate limiting, tenant isolation, injection, secrets) — even for a single finding.
---

# Security Review

Two halves: **running the audit**, **shipping the fixes**. Both have non-negotiable gates.

## 1. Running the audit

**Scope definition first.** Enumerate the attack surfaces before reading code: auth endpoints, unauthenticated endpoints, multi-tenant boundaries, file/media access, admin vs user privilege edges, third-party proxies (cost bombs), background jobs.

**Audit prompt structure (for an agent or second model):**
- Read-only. No fixes, no writes.
- Per finding, require: file:line, the vulnerable flow described concretely, a realistic exploit scenario, severity, and a proposed remediation direction.
- Require the auditor to cross-reference actual code — no findings from pattern-matching alone.

**Second-model review pattern:**
- Use a different/stronger model than the one that wrote the code as the auditor. Fresh eyes, no authorship bias.
- Validate the audit: spot-check several findings against source before trusting the batch. Count hallucination rate; a clean spot-check earns trust for the rest.
- The second model also reviews FIXES pre-ship (see gate below) — this is where it catches the bugs the fixer can't see.

**Triage:** classify every finding:
- **HIGH/P0** — exploitable now against real data (cross-tenant reads, IDOR, auth bypass). Fix immediately.
- **P1** — exploitable with effort, or DoS/cost vectors (unthrottled endpoints, lockout DoS, missing brute-force protection). Fix this cycle.
- **P2** — hardening (cookie flags, per-target rate limits). Scheduled.
- **P3** — hygiene (algorithm pinning, header polish). Batched.

Order within a tier by blast radius × exploit likelihood, not by ease.

## 2. Shipping fixes

**One finding per commit.** Never batch heterogeneous security fixes — each needs its own audit, review, and rollback path. "Ship all P1s at once" is a rejected pattern; counter-propose the smallest safe slice.

**Mandatory pre-fix audit gate (never skip, regardless of time pressure):**
1. Before writing the fix, verify every assumption it depends on against live state — schema columns exist, the code path behaves as the finding claims, the fix's SELECT/JOIN references real columns.
2. STOP. Present the pre-fix audit + proposed diff for human approval.
3. Only then implement.

This gate exists because security fixes routinely introduce their own bugs (a fix referencing a nonexistent column throws in prod on every request). The gate has caught exactly this class pre-ship.

**Defensive-fix rule:** when a defensive check covers all exploit cases and a root-cause fix requires risky reordering of existing logic — ship the defensive fix, log the root-cause cleanup in the backlog. Don't let perfect ordering block closing a live hole.

**Two-part migrations:** schema first, soak (~30 min), verify silent-clean deploy, then the code commit. Never simultaneous.

**Live-customer timing:** never ship fixes touching code paths a live user is actively exercising (login during their work hours, shift flows during a shift). Check the calendar/clock before every security deploy; defer or get explicit approval.

**Post-ship verification per fix:** exercise the previously-vulnerable path and confirm it's now denied (curl with wrong tenant token, repeated login attempts hit lockout, etc.). "Deployed" is not "verified".

## Recurring finding classes (check these in every audit)

- Cross-tenant access: every query on shared tables scoped by tenant; IDOR on any :id route.
- Unauthenticated endpoints: rate limits per-IP AND per-target (per-email on password reset — per-IP alone leaves an account-lockout DoS).
- Lockout symmetry: if user accounts lock on failed logins, admin/superadmin accounts must too — and locked accounts need auto-unlock (15–30 min) or lockout is itself a DoS.
- Side-effect ordering: audit logs / DB writes placed AFTER fallible external calls (email sends) are silently skipped on failure — destructive state changes must not precede their notification success.
- AI/third-party proxies: per-user throttle + global daily cap, or it's a cost bomb.
- Token handling: revocation paths for every principal type; pinned JWT algorithms; secrets never in query strings.
- Storage: bucket policies, presigned URL lifetimes, upload content validation (magic bytes, not extensions).

## Anti-patterns

- Skipping the pre-fix audit gate under time pressure.
- Batching multiple findings into one commit.
- Trusting an AI audit without spot-checking findings against source.
- Fixing the finding as written without verifying the claimed behavior exists.
- Rate-limiting per-IP only on account-targeting endpoints.
- Shipping auth changes during the affected users' active hours.
