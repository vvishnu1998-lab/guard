# RUNBOOK — N23 Anthropic budget isolation

For Vishnu. Console + Railway + GitHub work; **no code change**. The API keeps
reading `ANTHROPIC_API_KEY` exactly as it does today — only the *value* changes,
and only the *workspace* it belongs to.

zsh-safe: no inline `#` comments, `printf` rather than `echo`.

---

## Why

On 2026-09-06 the triage runner and the product's report-enhancement feature
drew on the **same org credit balance**. The runner drained it, and a STARNET
guard tapped **Enhance** and read Anthropic's billing message on their phone
mid-shift. Full account:
`docs/OPS/INCIDENTS/2026-09-06-enhancement-credit-exhaustion.md`.

The code fix in that incident makes the *next* exhaustion invisible to guards —
a one-line notice, text preserved, submit unaffected. **This runbook makes it not
happen.** They are complementary: without this, the product's availability
depends on the runner's spending discipline.

**Order matters.** Do (a) and (b) before (c). Deleting the old key first takes
both surfaces down at once.

---

## (a) Runner workspace — $20/month

Console → **Settings → Workspaces → Create Workspace**.

| field | value |
|---|---|
| Name | `netraops-ops-runner` |
| Monthly spend limit | **$20** |

Then, **inside that workspace**, → API Keys → Create Key. Name it
`ops-triage-runner`. Copy it once.

GitHub → repo **Settings → Secrets and variables → Actions** → `ANTHROPIC_API_KEY`
→ **Update secret** → paste.

$20 is deliberately generous against the measured target of ~$0.35/run
(`DECISIONS.md` D13) — about 57 runs, against roughly 30 scheduled. Headroom for
manual runs, not for a runaway. **N21 is the item that replaces this estimate
with a measured figure**; revisit the limit once three daily runs have been
costed.

## (b) App workspace — $30/month, alert at $15

Console → Settings → Workspaces → Create Workspace.

| field | value |
|---|---|
| Name | `netraops-app` |
| Monthly spend limit | **$30** |
| Alert threshold | **$15** |

Inside it → API Keys → Create Key, named `netraops-app-enhance`. Copy it once.

### The Railway write needs a restart, so it is gated

`ANTHROPIC_API_KEY` is read at module load — `apps/api/src/routes/ai.ts:29-33`
constructs the client at import time, not per request — so **the new value does
not take effect until the service restarts**. `--skip-deploys` is therefore
wrong here: it would leave the API holding the old key while the Console shows a
new one, which is worse than either state on its own.

This is a restart on a live API. **Hold the deploy gate** (`POLICY.md`).

```bash
set -a; source ~/guard/.env.prod; set +a
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS starnet_open FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id WHERE ss.clocked_out_at IS NULL AND g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067';"
```

Expect `0`. Then prove the query works rather than trusting a bare zero:

```bash
psql "$DATABASE_URL" -c "SELECT g.company_id, COUNT(*) FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id WHERE ss.clocked_out_at IS NULL GROUP BY g.company_id;"
```

If the first is `0` and the second returns rows for other tenants, the gate is
open by the **CONDITION** route. If STARNET guards are on shift, wait or use the
**PROXY** route. Record which one you used — `POLICY.md` requires naming it.

Then set the variable, letting it deploy:

```bash
railway variables --set ANTHROPIC_API_KEY=<the netraops-app key> --service guard
```

Wait for the deployment to reach SUCCESS before continuing.

## (c) Delete the old key

Only after (a) and (b) are both live and verified below. Console → the **old**
key → Delete.

Deleting is the point: while it exists, anything still holding it draws on the
shared balance and this whole exercise proves nothing. If something breaks after
deletion, that something was an unknown consumer — which is worth discovering
now rather than during the next incident.

## (d) Org auto-reload

Console → **Plans & Billing → Auto-reload**: purchase **$25** when the balance
falls below **$5**.

Auto-reload is the backstop, not the control. The per-workspace limits in (a)
and (b) are what stop one surface starving the other; auto-reload only stops the
org hitting zero. **Both are needed** — a workspace can hit its own cap while the
org still has credit, and the org can hit zero while both workspaces are inside
their caps. That second case is exactly what happened on 2026-09-06.

---

## Verification

Both must pass. They exercise the two keys independently, which is the entire
point of the split.

### 1. Runner key — one triage dry run

GitHub → Actions → **ops-triage** → Run workflow → set **`dry_run: true`**.

A dry run collects the pack and uploads it **without calling the model**, so it
costs nothing and proves the workflow, the secrets and the collectors. Expect the
run to succeed with a `triage-context-<run_id>` artifact.

Then run it **again with `dry_run: false`** — that is the one that actually
exercises the new key. Expect a Slack post. A post whose first line is
`# Triage FAILED` is a runner failure, not an all-green result.

### 2. App key — one enhancement call from the test tenant

**Use the Star Guard test tenant (`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`), not
STARNET.** Log in as a test guard, clock in, open a new report, and type **at
least 10 words** — the button stays disabled below that
(`MIN_ENHANCE_WORDS`, `reports/new.tsx:46`) and the API independently rejects
text under 10 characters.

Tap **Enhance**.

**Expect the enhanced text to come back.** Then confirm server-side:

```bash
railway logs --service guard --environment production --lines 200 | grep ai.enhance
```

Expect a line beginning `[ai.enhance.success] guard=... company=...` with token
counts. If you instead see `[ai.enhance.failed] ... status=...`, the new key is
not working — check that the Railway deployment actually restarted after (b).

### 3. Confirm the isolation actually holds

The above proves both keys work. It does **not** prove they are isolated — that
only shows up under load. The cheap standing check is the Console:

Console → Usage → filter by workspace. After a few days, `netraops-ops-runner`
and `netraops-app` should each show their own spend. **If one shows zero while
the other shows everything, the split did not take** and both surfaces are still
on one key.

---

## Rollback

- **(a) or (b) wrong key** — the old key still exists until you do (c), so
  restore the previous value and restart. This is the reason (c) is last.
- **After (c)** — there is no rollback to the old key; it is gone. Create a
  replacement in the affected workspace and set it the same way. The API restart
  is required either way.
- **Limits too tight** — raising a workspace limit takes effect immediately and
  needs no restart. Only the *key value* needs a restart.

---

## What this does not fix

Budget isolation stops the runner starving the product. It does **not** stop the
*app's own* workspace hitting its $30 cap — a burst of guard enhancement traffic
can still exhaust it. That case is handled by the code fix (a one-line notice,
text preserved, submit unaffected) and bounded by the in-process rate limiter at
`ai.ts:56-59`: 20 requests per guard per hour, 500 globally per day.

Note the limiter's own caveats, documented at `ai.ts:49-55`: it is in-memory, so
a restart clears it, and per-instance, so the effective ceiling is N × those
numbers if Railway ever scales out.
