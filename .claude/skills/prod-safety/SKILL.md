---
name: prod-safety
description: Production change discipline, incident forensics methodology, and secrets hygiene for any live system. Use this skill whenever work touches a production database, live deployment, schema migration, environment variables, credentials/API keys, or when debugging a production bug or incident — even if the user doesn't say "production safety". Applies to any project with real users or live data.
---

# Prod Safety

Three disciplines for any system with live users: **safe changes**, **incident forensics**, **secrets hygiene**.

## 1. Safe change discipline

**Sequencing:**
- Schema before code. Apply migrations to prod first, verify clean, then ship code that references new columns. Never reverse.
- For security-sensitive two-part changes: soak ~30 min between schema deploy and code deploy — confirm the migration deployed silently clean before code depends on it.
- One logical change per commit. Per-commit rollback safety. Never batch heterogeneous risky changes to save time.

**Verification before writing:**
- Probe the actual schema (`information_schema` or equivalent) before writing any query that references columns. A missing column in a SELECT can throw and silently kill downstream async work.
- Verify env vars after setting: pull them back and length-check. Trailing newline bytes from `echo`/heredoc corrupt secrets — always `printf "%s" | <cli env add>`.
- Never trust memory or docs about prod state. Query it.

**Blast radius (mandatory when live users exist):**
Before any deploy, answer:
1. Who is active right now (shifts, sessions, business hours)?
2. Which code paths could they exercise during/after this deploy?
3. If this breaks, what's the user-visible failure and the rollback time?
4. Is there a freeze window (customer trial, active review, live event)?

If the change touches live-user code paths during their active window: defer, or get explicit user approval with the risk stated.

**Approval gates (never skip):**
- Any production DB write.
- Any security-related change.
- Any destructive/irreversible action (deletes, rotations, bucket policy).
- Anything touching a paying customer's data.

**Migration execution pattern:**
- Run migrations via a direct authenticated pipe with fail-fast (`psql -v ON_ERROR_STOP=1` piped SQL or equivalent) so credentials never land in shell history and the run aborts on first error.
- Private-network DB hostnames don't resolve from a workstation — use the public URL variable for workstation-run migrations.
- Confirm the app's start command actually runs migrations; many don't — run manually and verify version table after.

## 2. Incident forensics

**Method — always in this order:**
1. **Reproduce/confirm** with real data before theorizing. Query the actual records, hit the actual endpoint, read the actual logs. If the problem can't be confirmed, STOP — do not manufacture a fix.
2. **Classify** the layer: backend (query/logic), frontend (call/state/render), or data (bad records). Check each layer's actual output, not its expected output.
3. **Timeline reconstruction** for auth/security incidents: order events from logs/audit tables with timestamps. Identify what changed, when, and via which endpoint.
4. **Root cause, stated as a falsifiable claim** with the evidence that proves it.
5. Only then design the fix. Prefer a defensive fix that covers all cases over a risky root-cause reorder; log the root-cause cleanup in the backlog.

**Rules:**
- Never assert how code/UI behaves without reading the file or observing it live. If unverified, say "unverified".
- Silent failure hunting: look for error paths with no logging/monitoring capture (swallowed catches, post-throw log calls that never run). Ordering matters — audit logs written after a fallible send are skipped on failure.
- After the fix: verify end-to-end with the same reproduction that confirmed the bug.

**Screenshot-triage:** when the report is a screenshot + one line, extract: screen/route, visible IDs, expected vs actual, then run the method above. Don't ask questions the screenshot already answers.

## 3. Secrets hygiene

- Set env vars only via `printf "%s" | <cli>` — never `echo`, never heredoc. Verify by pulling and length-checking.
- Any secret that appears in a screenshot, chat, log, or commit is BURNED. Rotate immediately, then clean the exposure. No "probably fine".
- Never paste secrets into prompts, code comments, or shell commands that persist in history. Use env references or piped stdin.
- Rotation procedure: generate new → set on all consumers (verify each) → confirm services healthy → revoke old. Never revoke first.
- Track which services hold which secrets; a rotation is incomplete until every consumer is updated and verified.
- Dead/legacy secret env vars are risk surface — schedule cleanup, note any code that silently falls back to another secret.

## Anti-patterns

- Shipping code before its migration.
- Fixing an unconfirmed problem.
- Deploying to a code path a live user is actively exercising, without approval.
- `echo $SECRET | cli env add` (newline corruption + history exposure).
- Revoking a credential before its replacement is verified everywhere.
- Batching multiple risky changes into one deploy "to save a cycle".
