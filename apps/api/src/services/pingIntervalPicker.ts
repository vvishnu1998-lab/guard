/**
 * The admin picker's allowed ping cadences, and the validator for them.
 *
 * SERVER-ONLY, and deliberately a module of its own rather than a function
 * inside routes/sites.ts: that file imports multer, s3 and firebase, so a
 * standalone test importing the validator would drag all three in. Same
 * reasoning as services/pingIntervalGate.ts.
 *
 * ── THE ROUTE IS STRICTER THAN THE SCHEMA, ON PURPOSE ───────────────────
 *
 * sites.ping_interval_minutes permits 5..240 (schema_v14.sql:39) and
 * shift_sessions.ping_interval_minutes permits the same (schema_v69). This
 * validator admits only {15, 30, 45} — the picker set locked as D15.
 *
 * That asymmetry is intentional and has precedent in the very file that
 * uses it: routes/sites.ts:172 rejects any `timezone` outside
 * ALLOWED_TIMEZONES while the column is bare text. Route strict, schema
 * permissive.
 *
 * WHY THE SCHEMA STAYS 5..240 rather than being narrowed to match:
 * sites.ping_interval_minutes is the SOURCE the clock-in snapshot copies
 * verbatim into shift_sessions (routes/shifts.ts). If the session CHECK were
 * narrower than a value some site already held, that INSERT would throw —
 * and that INSERT is inside the clock-in transaction, so the failure mode is
 * A GUARD WHO CANNOT START THEIR SHIFT. The two column CHECKs must agree
 * with each other; only the ROUTE is allowed to be narrower, because a
 * rejected PATCH costs an admin one error toast and nothing else.
 *
 * Below 15 also matters behaviourally, which is why the picker floor is not
 * arbitrary: apps/web/lib/lateness.ts clamps its staleness grace below 15,
 * and jobs/pingReminder.ts's recovery range inverts at or under a 10-minute
 * cadence (see OPEN-ITEMS N42). Those paths were written to degrade
 * gracefully on data the picker cannot produce; this validator is what keeps
 * them unreachable through the product.
 */

/** The cadences the admin picker offers. D15. */
export const PING_INTERVAL_PICKER_MINUTES: readonly number[] = [15, 30, 45];

export type PingIntervalValidation =
  | { ok: true;  value: number }
  | { ok: false; error: string };

/**
 * Validate a client-supplied cadence.
 *
 * Rejects, each with a named 400 message rather than a bare "invalid":
 *   * absent / null / undefined  — nothing to change
 *   * non-number (including the string "30", which JSON.parse would not
 *     have produced but a hand-rolled client might send)
 *   * non-integer (30.5)
 *   * an integer outside the picker set — INCLUDING 5 and 240, which the
 *     COLUMN permits. The route is the narrower boundary; see the header.
 *
 * Never throws.
 */
export function validatePingInterval(raw: unknown): PingIntervalValidation {
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'ping_interval_minutes is required' };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: 'ping_interval_minutes must be a number' };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, error: 'ping_interval_minutes must be a whole number of minutes' };
  }
  if (!PING_INTERVAL_PICKER_MINUTES.includes(raw)) {
    return {
      ok: false,
      error: `ping_interval_minutes must be one of: ${PING_INTERVAL_PICKER_MINUTES.join(', ')}`,
    };
  }
  return { ok: true, value: raw };
}

/** Max stored length of the optional free-text note. */
export const MAX_REASON_LEN = 500;

/**
 * Normalise the optional `reason`. Absent, non-string or blank -> null, so
 * the column holds a note or nothing, never an empty string. Length-capped
 * because it is attacker-controlled free text landing in a durable row.
 */
export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_REASON_LEN);
  return trimmed.length > 0 ? trimmed : null;
}
