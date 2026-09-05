#!/usr/bin/env zsh
#
# Apply branch protection to main. PREPARED, NOT RUN. Vishnu runs this once,
# from his own shell, per docs/OPS/RUNBOOK-phase4-apply.md step (f).
#
# WHY required_approving_review_count IS 0
# ----------------------------------------
# This is a single-owner repository. GitHub does not let an author approve
# their own pull request, so any count above 0 would make main permanently
# unmergeable by the only person who merges. Requiring one review here does
# not add a reviewer -- it removes the ability to ship.
#
# The gate is therefore not "someone approved it". The gate is:
#   - a pull request is REQUIRED (no direct pushes to main, for anyone,
#     including admins -- enforce_admins is true)
#   - the gitleaks scan must PASS before merge, and the branch must be up to
#     date with main first (strict: true)
#   - force pushes and branch deletion are refused outright
#   - the only account that can merge is Vishnu's. The triage runner's token
#     has contents:read and cannot merge, cannot push, and cannot alter this
#     policy.
#
# STATUS CHECK NAME
# -----------------
# The context below is the check-run NAME as GitHub reports it, which is the
# workflow job's `name:` field -- NOT the job key. .github/workflows/gitleaks.yml
# has job key `scan` with `name: Scan for hard-coded secrets`, and the
# check-runs API confirms the reported name:
#
#   gh api repos/vvishnu1998-lab/guard/commits/<sha>/check-runs
#   -> name: 'Scan for hard-coded secrets' | conclusion: success
#
# Using "scan" here would create a required check that never reports, and main
# would block forever waiting for it.
#
# required_linear_history is false: merge commits are how this repo integrates
# branches, and every phase so far landed as a merge commit.

set -euo pipefail

REPO="vvishnu1998-lab/guard"
CHECK_NAME="Scan for hard-coded secrets"

printf 'Applying branch protection to %s:main\n' "$REPO"
printf 'Required status check: %s\n\n' "$CHECK_NAME"

gh api -X PUT "repos/${REPO}/branches/main/protection" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["${CHECK_NAME}"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON

printf '\nApplied. Verify with:\n'
printf '  gh api repos/%s/branches/main/protection\n' "$REPO"
printf '\nThen confirm a direct push is refused from a scratch commit.\n'
printf 'It must be REJECTED -- if it succeeds, the policy did not take.\n'
