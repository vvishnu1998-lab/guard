# INCIDENTS

One file per incident. Filename: `YYYY-MM-DD-short-slug.md`.

An incident gets a file when production behaved differently from what anyone
expected and someone had to find out why — whether or not a customer noticed, and
whether or not code changed in the end. A wrong diagnosis that cost hours is worth
a file; so is a bug that turned out to be already fixed.

---

## Required sections

Every incident file has these five, in this order. A section with nothing in it
says so explicitly rather than being dropped.

### 1. Timeline

UTC timestamps, and PT in parentheses where a site-local hour matters. Include
when it *started*, not just when it was noticed — those are usually far apart, and
the gap is itself a finding.

### 2. Root cause

The mechanism, not the symptom. "Pushes stopped arriving" is a symptom; "login
writes `fcm_token = $1 ?? null`, so any login without a token nulls it
permanently" is a mechanism.

State what was **ruled out** and how. Wrong hypotheses that were expensive to
eliminate belong here — they are what stops the next person re-running them.

### 3. Fix sha

The commit(s), and the **deployment** that carried them. Merged is not deployed.
If nothing was changed, say `no code change` and explain why that was correct.

### 4. Verification

What proved the fix worked, in production. Name the evidence: the query and its
row count, the log line and its timestamp, the Sentry event that stopped
appearing. Include the window you looked at and why that window — a 3-hour window
and a 2-minute window over the same data have produced opposite conclusions here.

"Deployed successfully" is not verification. Neither is a clean Sentry window
after an OTA until a device has actually taken the update.

### 5. Learning

What changes as a result. One of:

- a new item in `../OPEN-ITEMS.md` (with its number)
- a new or amended entry in `../DECISIONS.md`
- a change to `../POLICY.md` or `../CRONS.md`
- an update to a skill under `.claude/skills/`
- explicitly: nothing — this was a one-off and here is why it cannot recur

An incident whose Learning section is empty has not been closed out.

---

## Notes

- **IDs only.** Guard data in these files is `guard_id`, `company_id`, badge, and
  counts — never names, emails, coordinates, or token values (`../POLICY.md`).
  Badges collide across tenants, so a badge alone is not an identifier: always
  pair it with the tenant, or use the uuid.
- **Name the ref you read.** An audit of mobile behaviour that read `main` when the
  shipped binary came from a batch branch describes code no user runs. Record
  `git show <sha>:<path>` where it applies.
- Link related incidents to each other. Repetition across files is the signal that
  something structural is wrong.
