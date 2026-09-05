# RUNBOOK — apply Phase 2

For Vishnu. Run top to bottom. Every command is zsh-safe: no inline comments,
no bare `#`, and `printf` rather than `echo` wherever a literal is written.

Nothing here is optional and the order matters. Step (e) narrows a database
role; step (g) restarts the API. Both are Tier 2 or Tier 1 under
`POLICY.md` — do them with intent, not in a batch.

---

## Prerequisite — source the production URL

**Changed in Phase 4 (2026-09-05).** `~/guard/.env` no longer points at
production; it points at local Postgres (`127.0.0.1:5432/guard_dev`) so a stray
command cannot reach the customer's database by default. The production URL
lives in `~/guard/.env.prod` (gitignored, mode 600) under the name `DATABASE_URL`.

The earlier version of this step read `DATABASE_PUBLIC_URL` out of `.env`. That
key has never existed in `.env` — only `DATABASE_URL` did, already pointing at the
public proxy host — so that command silently set an empty variable. The check
below is what caught it.

```bash
cd ~/guard
set -a; source ~/guard/.env.prod; set +a
printf 'host set: %s\n' "$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@##')"
```

Expect `yamabiko.proxy.rlwy.net:26339/railway`. If it prints
`127.0.0.1:5432/guard_dev` you sourced `.env` instead of `.env.prod` and are
pointed at your laptop. If it prints nothing, `.env.prod` does not exist.

The internal hostname (`postgres.railway.internal`) resolves only inside
Railway and will hang from a workstation — `.env.prod` deliberately holds the
public proxy host.

---

## a. Move to the API workspace

```bash
cd ~/guard/apps/api
```

## b. Apply schema v67

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f src/db/schema_v67.sql
```

Creates `cron_heartbeats` and grants SELECT on it to `claude_readonly`. The
file is idempotent — `CREATE TABLE IF NOT EXISTS`, and the GRANT is guarded on
the role existing — so a re-run is harmless.

## c. Confirm the table exists

```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.cron_heartbeats');"
```

Expect: `cron_heartbeats`. A blank result means step (b) did not commit.

## d. Wait 30 minutes, then repeat (c)

The wait is deliberate. It confirms nothing else in the deploy pipeline drops
or recreates the table underneath you before the code that writes to it ships.

```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.cron_heartbeats');"
```

Expect: `cron_heartbeats`, same as before.

## e. Narrow the read-only role

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ~/guard/scripts/ops/readonly-column-revoke.sql
```

**Note the missing `-1`.** The script manages its own `BEGIN`/`COMMIT` so it is
a single transaction no matter how it is invoked. Adding `-1` would nest a
transaction inside psql's own and emit two warnings — "there is already a
transaction in progress" and "there is no transaction in progress" — which
would obscure a genuine failure. Leave it off.

This must run as a role that owns the eight tables (or as superuser). The
application user cannot change grants.

## f. Verify the revoke took

```bash
psql "$DATABASE_URL" -f ~/guard/scripts/ops/readonly-column-revoke.verify.sql
```

Expect: every `should_be_false` column is `f`, every `should_be_true` column is
`t`. Eleven result sets — one per secret column across the eight tables.

Any `t` under `should_be_false` means a credential column is still readable by
`claude_readonly` and the revoke did not take. Stop and investigate before
continuing.

## g. Gate check, then merge

Confirm zero open STARNET sessions immediately before merging. The merge
restarts the API.

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS starnet_open FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id WHERE ss.clocked_out_at IS NULL AND g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067';"
```

Expect `0`. If it is not zero, either wait, or use the PROXY route (push within
90 seconds of a STARNET ping landing) and record which route you used —
`POLICY.md` requires naming it.

If the count comes back `0`, sanity-check that the query itself is working
before trusting it — an empty result from a broken join looks identical to a
true zero:

```bash
psql "$DATABASE_URL" -c "SELECT c.name, COUNT(*) FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id JOIN companies c ON c.id = g.company_id WHERE ss.clocked_out_at IS NULL GROUP BY c.name;"
```

Then merge:

```bash
gh pr merge <n> --merge --delete-branch
```

## h. After 5 minutes, check the heartbeats

```bash
psql "$DATABASE_URL" -c "SELECT job_name, last_result, NOW()-last_tick_at AS age FROM cron_heartbeats ORDER BY age;"
```

Expect **19 rows**, every `last_result` = `ok`, and every `age` below that
job's own interval.

Five minutes is enough for the per-minute and `*/5` jobs only. The hourly,
daily and monthly jobs will not have a row yet, so a first check will show
fewer than 19 — that is correct, not a fault. The full set fills in over a
month; `monthlyHoursReport` is the last to appear.

Jobs and their intervals are listed in `CRONS.md`. Quick reference for the
slow ones: `chatRetention` and `orphanedSessionCheck` hourly,
`nightlyPurge` and `locationIntegrityCron` and `dailyShiftEmail` daily,
`monthlyHoursReport` on the 1st.

## i. Confirm the API is healthy

```bash
curl -s https://guard-production-6be4.up.railway.app/health
```

Expect: `{"status":"ok","db":"connected"}`.

Remember what this does and does not prove: `/health` runs `SELECT 1` and
nothing else. It cannot tell you a cron is wedged — that is what step (h) is
for.

## j. Check Sentry Crons

Sentry → Crons. Expect **16 monitors**, created automatically on each job's
first check-in. They will not all appear at once; a monitor exists only after
its job has ticked, so the daily and monthly ones arrive later.

The three per-minute jobs — `breakExpiryCron`, `expireSwapRequests`,
`pingReminder` — deliberately send **no** check-ins and will never appear here.
They are covered by `cron_heartbeats` only. See `CRONS.md` for why.

---

## Rollback

The code half is a normal revert: `git revert` the merge commit and let Railway
redeploy. `runJob` is additive — reverting restores the previous
`cron.schedule` calls and the jobs keep running either way.

The `cron_heartbeats` table can be left in place after a revert. It is written
by nothing else, costs one row per job, and dropping it is not urgent.

The column-level grants are the part that needs thought. To restore the
previous state:

```bash
psql "$DATABASE_URL" -c "GRANT SELECT ON guards, company_admins, clients, guard_devices, password_reset_tokens, revoked_tokens, login_attempts, vishnu_state TO claude_readonly;"
```

That re-widens the role to table-level SELECT including every credential
column. Only do it if something genuinely depends on reading those columns —
find out what, first.
