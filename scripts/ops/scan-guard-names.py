#!/usr/bin/env python3
"""
Find guard NAMES in the tracked tree without ever reading a name out of the database (N191).

The repo is PUBLIC and POLICY.md lets guard data out of the database as
"guard_id, company_id, badge, counts only". To check the tree for names you
would normally need the names; this needs only ONE-WAY HASHES of them.

  1. Get the hashes (a comma-separated list of md5 digests of every lower-cased
     name token of three or more letters, across all tenants), e.g. through the
     read-only database tool or psql:

       SELECT string_agg(h, ',') FROM (SELECT DISTINCT md5(lower(t)) AS h
         FROM guards g, regexp_split_to_table(g.name, '[^A-Za-z]+') t
         WHERE length(t) >= 3) x;

  2. Save the output to a file OUTSIDE the repo (it is not secret in the sense of
     a password, but there is no reason to commit it) and run, from the repo root:

       python3 scripts/ops/scan-guard-names.py --hashes ~/guard-private/guard-name-hashes.txt

It tokenises every tracked text file into words of three or more letters, hashes
each lower-cased word the same way, and prints file:line:token for every hit
that is not on the allowlist. Exit 0 = clean, 1 = hits. `--allow` takes a file
of `path-or-*:token` lines; the default is scripts/ops/guard-name-scan.allow,
which lists the REVIEWED exceptions (common words that are also a name token,
placeholder and fixture names, a customer contact, the owner's own name). A hit
is a lead, not a verdict: read the line.

Not covered: names in binary files (images, PDFs, spreadsheets), names with a
spelling the database does not hold, and names that are not in `guards` (a
customer's admin or client contacts).
"""
import argparse, hashlib, os, re, subprocess, sys

NOISE = {'guard', 'test', 'vishnu', 'starnet', 'star'}
SKIP_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.mp4', '.mov', '.woff', '.woff2',
            '.ttf', '.otf', '.zip', '.xlsx', '.svg', '.lock', '.keystore', '.jks', '.p12', '.mp3'}

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--hashes', required=True, help='file holding the comma-separated md5 digests')
    ap.add_argument('--allow', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'guard-name-scan.allow'))
    a = ap.parse_args()
    hashes = {h.strip().lower() for h in re.split(r'[,\s]+', open(os.path.expanduser(a.hashes)).read()) if h.strip()}
    if not hashes or not all(re.fullmatch(r'[0-9a-f]{32}', h) for h in hashes):
        print('the hashes file must hold md5 hex digests only', file=sys.stderr)
        return 2
    allow = set()
    if os.path.exists(a.allow):
        for line in open(a.allow, encoding='utf-8'):
            line = line.split('#')[0].strip()
            if line:
                allow.add(line)
    root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
    os.chdir(root)
    files = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, check=True).stdout.split('\n')
    hits = 0
    for p in files:
        if not p or os.path.splitext(p)[1].lower() in SKIP_EXT or p.endswith('package-lock.json') or not os.path.exists(p):
            continue
        try:
            if os.path.getsize(p) > 4_000_000:
                continue
            text = open(p, encoding='utf-8').read()
        except (OSError, UnicodeDecodeError):
            continue
        for i, line in enumerate(text.split('\n'), 1):
            for m in re.finditer(r'[A-Za-z]{3,}', line):
                w = m.group(0).lower()
                if w in NOISE or hashlib.md5(w.encode()).hexdigest() not in hashes:
                    continue
                if f'{p}:{w}' in allow or f'*:{w}' in allow:
                    continue
                hits += 1
                print(f'{p}:{i}: {w}')
    print(f'\n{hits} hit(s)' if hits else '\nclean: no un-reviewed guard-name token in any tracked text file')
    return 1 if hits else 0

if __name__ == '__main__':
    sys.exit(main())
