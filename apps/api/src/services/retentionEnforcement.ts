/**
 * Retention enforcement gate — the two variables that decide whether
 * nightlyPurge may delete anything.
 *
 * IN ITS OWN MODULE SO IT CAN BE TESTED. jobs/nightlyPurge.ts registers a
 * cron at import time, so a test file that imported the gate from there
 * would start the scheduler as a side effect. services/_retentionEnforcement.test.ts
 * imports this instead and exercises every branch against a snapshot of
 * process.env.
 *
 * ── ENFORCEMENT: TWO VARIABLES, BOTH REQUIRED, BOTH READ PER RUN ────────
 *
 * Nothing deletes unless RETENTION_DRY_RUN is exactly 'false' AND the step's
 * own name appears in RETENTION_LIVE_STEPS. Every other combination is a
 * dry run. The full table, which is the whole safety argument:
 *
 *   RETENTION_DRY_RUN   RETENTION_LIVE_STEPS      result
 *   unset / anything     anything                  ALL DRY
 *     except 'false'
 *   'false'              unset / empty / spaces    ALL DRY
 *   'false'              a typo, ',,', ';', '*'    ALL DRY
 *   'false'              'step2_reports'           that step only
 *
 * ── WHY BOTH ARE FUNCTIONS AND NOT CONSTS ───────────────────────────────
 *
 * DRY_RUN used to be a module-scope const, which quietly broke the thing it
 * exists for: a Railway variable written with `--skip-deploys` does not
 * restart the service, so the process kept the boot-time value and the
 * master kill switch did nothing until someone forced a restart.
 * services/mockLocation.ts:40-45 records exactly this and says to prefer
 * `--skip-deploys` while a guard is on post — STARNET runs 24/7. A switch
 * that needs a cold boot is not a kill switch. Both are read per call now.
 *
 * ── ALLOWLIST, AND THE POLARITY IS NOT A MISTAKE ────────────────────────
 *
 * Structurally a verbatim copy of isExemptGuard (services/mockLocation.ts).
 * That function returns false on an absent, empty or malformed variable, and
 * there false means "not exempt", so the fail-safe direction is toward
 * ENFORCEMENT. Here false means "not in the allowlist", so the identical code
 * fails toward DRY-RUN. The mechanism is direction-neutral: it guarantees
 * "absent or malformed means nobody gets the special treatment", and the
 * special treatment is leniency there and destruction here.
 *
 * SO DO NOT INVERT IT. The tempting "fix" is a denylist — RETENTION_DRY_RUN_STEPS
 * naming what to skip — under which an unset variable, a dropped comma or a
 * typo deletes across every step. An allowlist makes the same three mistakes
 * cost one quiet night.
 *
 * ── NO WILDCARD ─────────────────────────────────────────────────────────
 *
 * '*' and 'all' are deliberately not special. They fall through to
 * .includes(), match no step name, and the run summary reports them under
 * unknown_live_steps. The asymmetry is the argument: a mistyped step name
 * costs one night of not deleting, while a working wildcard costs up to
 * 29 x STEP_ROW_CAP rows in a single run with no row-level undo — and it
 * would re-create the global switch this allowlist exists to replace.
 *
 * ── TOTAL, BY CONSTRUCTION ──────────────────────────────────────────────
 *
 * No JSON.parse, no RegExp construction, no destructuring, no indexing that
 * can land on undefined. `??` supplies a string before any method is called,
 * so every operation below is a String method on a String. There is no input
 * — including a megabyte of unicode — for which this throws.
 *
 * ── ONE INPUT NEVER REACHES THIS CODE AT ALL ────────────────────────────
 *
 * An environment variable containing a NUL byte is TRUNCATED at it, because
 * environment variables are NUL-terminated C strings. Node accepts the
 * assignment and reads back only what preceded the NUL — measured: an
 * 18-character value beginning with NUL reads back as length 0.
 *
 * So a NUL empties or shortens the allowlist before this function sees it,
 * and under an allowlist that means DRY. Under a denylist the identical
 * accident would have emptied the skip-list and deleted across every step.
 * Same accident, opposite outcome — which is the polarity argument again,
 * arriving from a direction nobody designs for. Asserted in
 * _retentionEnforcement.test.ts so the truncation point is recorded rather
 * than rediscovered.
 */
export function globalDryRun(): boolean {
  // Only the exact literal disarms it. No .trim(), no .toLowerCase(): a
  // variable set to 'False', ' false' or 'FALSE' leaves the purge dry, which
  // is the right answer for a value nobody typed deliberately.
  return process.env.RETENTION_DRY_RUN !== 'false';
}

/** The allowlist as written, lowercased and cleaned. Never throws. */
export function liveStepNames(): string[] {
  const raw = (process.env.RETENTION_LIVE_STEPS ?? '').toLowerCase();
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** May this step delete? False unless BOTH switches say yes. */
export function isStepLive(step: string): boolean {
  if (globalDryRun()) return false;
  const name = step.trim().toLowerCase();
  if (name === '') return false;
  return liveStepNames().includes(name);
}
