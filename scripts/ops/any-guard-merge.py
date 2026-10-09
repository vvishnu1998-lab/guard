#!/usr/bin/env python3
"""any-guard-merge.py — merge a PR within 60 s of the first STARNET ping after a boundary.

Vishnu's "any guard" method (2026-10-08): no single-guard calibration. The trigger
is the first new location_pings row (a 201) from ANY STARNET guard at or after the
boundary, read from the database through the postgres-readonly tool's own login
(claude_readonly, inside BEGIN READ ONLY ... ROLLBACK; the URL is never printed).

  any-guard-merge.py PR HEAD MAIN DEPLOY BOUNDARY_UTC DEADLINE_UTC [--live]

Preflight refuses unless: the PR is OPEN at HEAD with every check green (and, live,
not a draft and CLEAN); origin/main is MAIN; the newest Railway deployment is DEPLOY,
SUCCESS, built from MAIN; /health reports MAIN. Then it waits for the boundary,
polls every 2 s, and on the first STARNET ping re-checks the PR head, CLEAN and main
and makes the ONE write: gh pr merge --merge --match-head-commit HEAD. No ping by
the deadline, a ping older than 50 s when seen, or any failed check: NO MERGE.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time

REPO = 'vvishnu1998-lab/guard'
STARNET = '27c4d404-8769-49ca-bfd6-93cb9b890067'
MAX_AGE_S = 50          # Vishnu's limit is 60 s; 10 s is kept for the merge call itself
POLL_S = 2


def log(msg):
    print(f"{dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')} {msg}", flush=True)


def sh(cmd, timeout=60):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def utc(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def pr_state(pr):
    rc, out, err = sh(['gh', 'pr', 'view', pr, '-R', REPO, '--json',
                       'state,isDraft,headRefOid,mergeStateStatus,statusCheckRollup,mergedAt,mergeCommit'])
    if rc:
        raise RuntimeError(f'gh pr view failed: {err[:200]}')
    return json.loads(out)


def checks_green(p):
    states = [(c.get('conclusion') or c.get('state') or '') for c in p.get('statusCheckRollup') or []]
    return bool(states) and all(s in ('SUCCESS', 'NEUTRAL', 'SKIPPED') for s in states), states


def origin_main():
    rc, out, _ = sh(['git', '-C', '/Users/vishnuvardhanreddy/guard', 'ls-remote', 'origin', 'refs/heads/main'])
    return out.split()[0] if rc == 0 and out else None


def newest_deployment():
    env = {**os.environ, 'RAILWAY_NO_TELEMETRY': '1'}
    r = subprocess.run(['railway', 'deployment', 'list', '--service', 'guard', '--environment', 'production', '--json'],
                       capture_output=True, text=True, timeout=45, env=env, cwd='/Users/vishnuvardhanreddy/guard')
    d = json.loads(r.stdout)[0]
    return d['id'], d['status'], (d.get('meta') or {}).get('commitHash')


def health_commit():
    rc, out, _ = sh(['curl', '-s', '-m', '15', 'https://api.netraops.com/health'])
    return json.loads(out).get('commit') if rc == 0 and out else None


URL = json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['postgres-readonly']['args'][-1]


def first_starnet_ping(boundary, deadline):
    sql = ("BEGIN READ ONLY;\n"
           "SELECT to_char(p.pinged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), g.badge_number, p.guard_id "
           "FROM location_pings p JOIN guards g ON g.id = p.guard_id "
           f"WHERE g.company_id = '{STARNET}' AND p.pinged_at >= '{boundary}' AND p.pinged_at < '{deadline}' "
           "ORDER BY p.pinged_at LIMIT 1;\nROLLBACK;\n")
    r = subprocess.run(['/opt/homebrew/opt/postgresql@18/bin/psql', URL, '-X', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'],
                       input=sql, capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError('db: ' + r.stderr.replace(URL, '<url>')[:200])
    rows = [l for l in r.stdout.splitlines() if '|' in l]
    return rows[0].split('|') if rows else None


def main():
    a = sys.argv[1:]
    live = '--live' in a
    a = [x for x in a if x != '--live']
    if len(a) != 6:
        sys.exit(__doc__)
    pr, head, main_sha, deploy, boundary, deadline = a
    b, d = utc(boundary), utc(deadline)
    if not (dt.timedelta(0) < d - b <= dt.timedelta(minutes=25)):
        sys.exit('REFUSING: the deadline must be after the boundary and at most 25 min later')
    log(f'armed pr={pr} mode={"--live" if live else "--dry-run"} boundary={boundary} deadline={deadline} head={head[:8]} main={main_sha[:8]} deploy={deploy[:8]} max_age={MAX_AGE_S}s')

    # ── preflight ──
    p = pr_state(pr)
    green, states = checks_green(p)
    problems = []
    if p['state'] != 'OPEN': problems.append(f"state {p['state']}")
    if p['headRefOid'] != head: problems.append(f"head {p['headRefOid']}")
    if not green: problems.append(f'checks {states}')
    if live and p['isDraft']: problems.append('still a draft')
    if live and p['mergeStateStatus'] != 'CLEAN': problems.append(f"merge state {p['mergeStateStatus']}")
    m = origin_main()
    if m != main_sha: problems.append(f'origin/main {m}')
    dep = newest_deployment()
    if not (dep[0] == deploy and dep[1] == 'SUCCESS' and dep[2] == main_sha): problems.append(f'deployment {dep}')
    h = health_commit()
    if h != main_sha: problems.append(f'/health {h}')
    log(f"preflight: pr={p['state']} draft={p['isDraft']} {p['mergeStateStatus']} head={p['headRefOid'][:8]} checks={len(states)} main={str(m)[:8]} deployment={dep[0][:8]} {dep[1]} {str(dep[2])[:8]} health={str(h)[:8]}")
    if problems:
        log('ABORT preflight: ' + '; '.join(problems))
        print('NO MERGE PERFORMED')
        sys.exit(2)

    # ── wait for the boundary, then poll ──
    while dt.datetime.now(dt.timezone.utc) < b:
        time.sleep(0.5)
    log('boundary reached; polling the database every 2 s for the first STARNET ping')
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        if now >= d:
            log('ABORT no STARNET ping by the deadline')
            print('NO MERGE PERFORMED')
            sys.exit(3)
        try:
            row = first_starnet_ping(boundary, deadline)
        except Exception as e:  # a failed read is not a ping; keep polling until the deadline
            log(f'db read failed: {e}')
            row = None
        if row:
            at, badge, guard = row
            age = (dt.datetime.now(dt.timezone.utc) - utc(at)).total_seconds()
            log(f'FIRST STARNET PING {at} {badge} guard={guard[:8]} age={age:.1f}s')
            if not live:
                log('dry run: the live run would re-check the PR and main, then merge' + ('' if age <= MAX_AGE_S else f' (this ping is {age:.0f}s old: the live run would ABORT)'))
                print('NO MERGE PERFORMED (dry run)')
                sys.exit(0)
            if age > MAX_AGE_S:
                log(f'ABORT the ping was {age:.1f}s old when seen (limit {MAX_AGE_S}s)')
                print('NO MERGE PERFORMED')
                sys.exit(4)
            p = pr_state(pr)
            m = origin_main()
            log(f"pre-merge: head={p['headRefOid'][:8]} {p['mergeStateStatus']} draft={p['isDraft']} main={str(m)[:8]}")
            if p['headRefOid'] != head or p['mergeStateStatus'] != 'CLEAN' or p['isDraft'] or m != main_sha:
                log('ABORT pre-merge check failed')
                print('NO MERGE PERFORMED')
                sys.exit(5)
            age = (dt.datetime.now(dt.timezone.utc) - utc(at)).total_seconds()
            log(f'MERGING (ping age {age:.1f}s)')
            rc, out, err = sh(['gh', 'pr', 'merge', pr, '-R', REPO, '--merge', '--match-head-commit', head], timeout=40)
            log(f'gh merge rc={rc} {out[:200]} {err[:200]}')
            p = pr_state(pr)
            done = (dt.datetime.now(dt.timezone.utc) - utc(at)).total_seconds()
            log(f"result: {p['state']} {p.get('mergedAt')} {(p.get('mergeCommit') or {}).get('oid')} (merge confirmed {done:.1f}s after the ping)")
            sys.exit(0 if p['state'] == 'MERGED' else 6)
        time.sleep(POLL_S)


if __name__ == '__main__':
    main()
