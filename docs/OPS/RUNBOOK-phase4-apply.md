# RUNBOOK — apply Phase 4

For Vishnu. Top to bottom. zsh-safe: no inline `#` comments in any command, and
`printf` rather than `echo` wherever a literal is written.

Step (b) restarts the API (Tier 1). Step (f) changes repository policy and will
lock you out of direct pushes to `main` — that is the point, but do it
deliberately.

---

## Prerequisite — the prod database URL now lives elsewhere

`~/guard/.env` no longer points at production. It points at local Postgres
(`127.0.0.1:5432/guard_dev`), so a stray command cannot reach the customer's
database by default. The production URL moved to `~/guard/.env.prod`
(gitignored, mode 600).

To run anything against production:

```bash
set -a; source ~/guard/.env.prod; set +a
printf 'host: %s\n' "$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@##')"
```

The second line prints only host and port, never the password. Expect
`yamabiko.proxy.rlwy.net:26339/railway`. If it prints `127.0.0.1:5432/guard_dev`
you sourced the wrong file and are pointed at your laptop.

---

## a. Add the GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret.
All five are read-only credentials. The workflow fails fast and by name if any
is missing, so a typo costs one 30-second run, not a silent no-op.

| secret | where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → **new key**, dedicated to this runner. Set the **$100 cap** on it in the console per `DECISIONS.md` D5. Do not reuse a personal key — you want to be able to revoke this one alone. |
| `SENTRY_AUTH_TOKEN` | the existing read token from `~/.sentryclirc`. Already scoped: it can read projects, issues, monitors and uptime, and is refused by `/api/0/api-tokens/` (403). |
| `RAILWAY_TOKEN` | Railway → project `adorable-courage` → Settings → Tokens → new token. **Choose read scope if the UI offers one.** |
| `DATABASE_READONLY_URL` | `postgresql://claude_readonly:<pw>@yamabiko.proxy.rlwy.net:26339/railway`, password from `~/.claude_readonly_pw`. **Public proxy host, not the internal one** — GitHub runners are outside Railway. This role cannot read any credential column. |
| `SLACK_WEBHOOK_URL` | Slack → new incoming webhook, app name **Triage**. |

`GITHUB_TOKEN` is provided automatically; the workflow declares
`permissions: contents: read` so it cannot write.

## b. Gate check, then merge

Confirm zero open STARNET sessions immediately before merging. The merge
restarts the API.

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS starnet_open FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id WHERE ss.clocked_out_at IS NULL AND g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067';"
```

Expect `0`. Then sanity-check the query itself — an empty result from a broken
join looks identical to a true zero:

```bash
psql "$DATABASE_URL" -c "SELECT c.name, COUNT(*) FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id JOIN companies c ON c.id = g.company_id WHERE ss.clocked_out_at IS NULL GROUP BY c.name;"
```

If the first is 0 and the second returns rows for other tenants, the gate is
open by the CONDITION route. Record which route you used — `POLICY.md` requires
naming it.

```bash
gh pr merge <n> --merge --delete-branch
```

## c. Check the new route

```bash
curl -s https://api.netraops.com/health/crons
```

**Do not expect 200 on merge day.** A job that has never ticked has no
heartbeat row and counts as stale, so this returns **503** listing the
daily/monthly jobs that have not been due yet. Measured 2026-09-05: 15 of 19
rows present, all `ok`; the four absent were `dailyShiftEmail`,
`locationIntegrityCron`, `monthlyHoursReport`, `nightlyPurge`.

What to check instead:

- the response parses, and `jobs` is **19**
- every entry in `stale` is one of those four daily/monthly jobs
- **no `*/5` or per-minute job appears in `stale`** — one that does is a real
  finding

`monthlyHoursReport` fires on the 1st, so full green takes up to a month.

## d. Repoint the Sentry uptime monitor — ONLY once step (c) returns 200

Sentry → Alerts → Uptime Monitoring → the existing monitor (id `8024493`,
currently `https://www.netraops.com`) → edit URL to:

```
https://api.netraops.com/health/crons
```

**Do not do this while step (c) still returns 503.** The monitor treats
non-2xx as down, so repointing early gives you a monitor that alarms
continuously for up to a month and gets muted or ignored — exactly when it
would start being meaningful.

If you want API uptime covered in the meantime, add a **second** monitor on
`https://api.netraops.com/health` and leave the crons one until it is green.

## e. Trigger the triage runner

GitHub → Actions → **ops-triage** → Run workflow. Leave `focus` empty for a
standard run.

Expect a Slack post within about 5 minutes and a `report.md` artifact on the
run. A post whose first line is `# Triage FAILED` is a **runner** failure, not
an all-green result — the script labels it explicitly so it cannot be misread.

The most likely first-run failures are a missing or wrong secret (the script
names which one) and an `ANTHROPIC_API_KEY` that has not had its cap set.

## f. Apply branch protection

```bash
zsh ~/guard/scripts/ops/branch-protection.sh
```

Then confirm it took:

```bash
gh api repos/vvishnu1998-lab/guard/branches/main/protection
```

Expect a policy body rather than `404 Branch not protected`.

Then confirm a direct push is refused. Make a scratch commit on a throwaway
branch and attempt to push it straight to `main`; the push **must be
rejected**. If it succeeds, the policy did not take — `enforce_admins` is the
setting that makes it apply to you.

Note the review count is **0** deliberately. This is a single-owner repo and
GitHub forbids self-approval, so any higher number makes `main` permanently
unmergeable. The gate is that a PR is required, gitleaks must pass, force
pushes and deletions are refused, and the runner's token cannot merge.

## g. Delete the leftover Sentry cron monitors

Sentry → Crons. **11 monitors exist** and all are active:
`orphanedsessioncheck`, `chatretention`, and nine `*/5` ones
(`autocompleteshifts`, `clockoutreminder`, `handoffnudge`,
`lateclockinreminder`, `missedpingcron`, `missedreportcron`,
`missedshiftalert`, `preshiftreminder`, `shiftstartreminder`).

Delete all 11. After this merge no job sends check-ins, so none will reappear —
if one does, a `sentryMonitor: true` survived the flip and that is worth
finding.

Delete rather than mute. A muted monitor is one someone un-mutes later and
misreads.

---

## Rollback

- **Code** — revert the merge commit; Railway redeploys. `/health/crons`
  disappears with it. If the uptime monitor was already repointed, point it
  back at `https://www.netraops.com` first, or it will alarm on a 404.
- **The runner** — disable the `ops-triage` workflow in the Actions tab. It
  holds only read credentials, so a bad run costs API budget and a noisy Slack
  post, nothing else.
- **Branch protection** — `gh api -X DELETE repos/vvishnu1998-lab/guard/branches/main/protection`.
- **Local `.env`** — the pre-Phase-4 files are saved as `.env.bak-prod` and
  `apps/api/.env.bak-prod`. Restoring either re-points your laptop at
  production, so do it only if you mean to.
