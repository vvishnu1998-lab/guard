/**
 * off_post_events — the one place that writes the append-only off-post
 * evidence log.
 *
 * THREE CALLERS, ONE WRITER. routes/locations.ts writes it when a ping is
 * rejected off-post and when a boundary exit is suppressed during a break;
 * routes/reports.ts writes it when an off-post incident report is accepted
 * during a break. Those were three hand-rolled INSERTs with three different
 * column lists and three different failure behaviours; this collapses them.
 *
 * ── EVERY WRITE HERE IS BEST-EFFORT AND NEVER THROWS ────────────────────
 *
 * This function returns a boolean and swallows everything. That is the whole
 * contract. Evidence is valuable, but it is NEVER the reason a guard's
 * request fails:
 *
 *   * the ping rejection must still return its 422,
 *   * the break suppression must still return its 200 ON_BREAK,
 *   * the incident report must still be accepted with its 201.
 *
 * The precedent is the existing try/catch at locations.ts:680-692
 * ("Evidence write is best-effort; suppression must never 500").
 *
 * ── SCHEMA CAPABILITY PROBE (why this is not just an INSERT) ────────────
 *
 * off_post_events gains `break_session_id`, a wider `reason`, and nullable
 * lat/lng in schema_v61 — which is NOT applied to prod at the time of
 * writing and is deliberately gated behind the Phase 2 deploy. Code and
 * schema will therefore be out of step for a while, in BOTH directions
 * (a rollback puts old code on a new schema).
 *
 * A single fixed INSERT cannot straddle that. In particular, naively adding
 * break_session_id to the ping-rejection INSERT would raise 42703 on a
 * pre-v61 database and, because the write is swallowed, would SILENTLY STOP
 * recording ping_reject rows that record correctly today. That is a
 * regression disguised as a no-op — the failure mode this codebase has been
 * bitten by repeatedly. So we probe what the table actually has and build
 * the statement to fit.
 *
 * The probe is cached. A NEGATIVE result is re-probed after PROBE_TTL_MS so
 * that applying v61 heals a running API within a minute and does not need a
 * restart; a POSITIVE result is cached for the life of the process, because
 * columns are not removed in normal operation.
 */

import type { Pool, PoolClient } from 'pg';

/** What the log records about an off-post moment. */
export type OffPostSource =
  /** POST /locations/ping returned 422 PING_OFF_POST. */
  | 'ping_reject'
  /** POST /locations/violation suppressed a boundary exit during a break. */
  | 'break_exit'
  /** POST /reports accepted an off-post incident during a break, without
   *  raising a violation or waking an admin. */
  | 'incident_break';

export interface OffPostEventInput {
  shiftSessionId: string;
  guardId: string;
  siteId: string;
  source: OffPostSource;
  /** Null when the caller genuinely has no fix. Recorded as NULL, never
   *  guessed and never defaulted to 0,0 — a fabricated coordinate is worse
   *  than an absent one. Requires schema_v61's DROP NOT NULL; on an older
   *  database a null-coordinate row simply does not write. */
  lat: number | null;
  lng: number | null;
  accuracyM?: number | null;
  distanceM?: number | null;
  reason: string | null;
  /** The break open at the time, when there was one. Requires schema_v61. */
  breakSessionId?: string | null;
  expiresAt: Date | string | null;
}

interface TableCapability {
  hasBreakSessionId: boolean;
  reasonMaxLen: number;
  coordsNullable: boolean;
}

const PROBE_TTL_MS = 60_000;
let cached: TableCapability | null = null;
let cachedAt = 0;

/** Never throws. On any probe failure returns the most conservative shape,
 *  which is the pre-v61 schema — that shape writes successfully on BOTH
 *  schemas, so a failed probe degrades to "works, minus the link". */
async function capability(db: Pool | PoolClient): Promise<TableCapability> {
  const fresh = cached && (cached.hasBreakSessionId || Date.now() - cachedAt < PROBE_TTL_MS);
  if (cached && fresh) return cached;
  try {
    const { rows } = await db.query<{ column_name: string; is_nullable: string; character_maximum_length: number | null }>(
      `SELECT column_name, is_nullable, character_maximum_length
         FROM information_schema.columns
        WHERE table_name = 'off_post_events'
          AND column_name IN ('break_session_id', 'reason', 'lat')`,
    );
    const reason = rows.find((r) => r.column_name === 'reason');
    const lat    = rows.find((r) => r.column_name === 'lat');
    cached = {
      hasBreakSessionId: rows.some((r) => r.column_name === 'break_session_id'),
      reasonMaxLen:      reason?.character_maximum_length ?? 16,
      coordsNullable:    lat?.is_nullable === 'YES',
    };
    cachedAt = Date.now();
  } catch {
    cached = { hasBreakSessionId: false, reasonMaxLen: 16, coordsNullable: false };
    cachedAt = Date.now();
  }
  return cached;
}

/** Exposed for tests only — drops the memoised probe. */
export function _resetOffPostCapabilityCache(): void {
  cached = null;
  cachedAt = 0;
}

/**
 * Append one evidence row. Returns true if a row was written.
 *
 * Never throws, never rejects. A false return means the evidence was lost,
 * not that the caller's request failed — callers must ignore the value
 * except for logging.
 */
export async function recordOffPostEvent(
  db: Pool | PoolClient,
  input: OffPostEventInput,
): Promise<boolean> {
  try {
    const cap = await capability(db);

    // A null coordinate cannot be stored before schema_v61 drops the NOT
    // NULL. Bail deliberately rather than firing an INSERT we know raises
    // 23502, so the log line says WHY instead of surfacing a constraint name.
    if ((input.lat === null || input.lng === null) && !cap.coordsNullable) {
      console.warn(
        `[off_post_events.skipped] source=${input.source} session=${input.shiftSessionId} ` +
        `— no coordinates and lat/lng are still NOT NULL (schema_v61 not applied)`,
      );
      return false;
    }

    // Truncate rather than overflow. Pre-v61 `reason` is VARCHAR(16) and the
    // break-exit literal is 33 chars; a 22001 would lose the whole row, and a
    // truncated reason beside a correct source is far more useful than no
    // evidence at all.
    const reason = input.reason === null
      ? null
      : input.reason.slice(0, cap.reasonMaxLen);

    const cols = ['shift_session_id', 'guard_id', 'site_id', 'source',
                  'lat', 'lng', 'accuracy_m', 'distance_m', 'reason', 'expires_at'];
    const vals: unknown[] = [
      input.shiftSessionId, input.guardId, input.siteId, input.source,
      input.lat, input.lng, input.accuracyM ?? null, input.distanceM ?? null,
      reason, input.expiresAt,
    ];

    if (cap.hasBreakSessionId) {
      cols.push('break_session_id');
      vals.push(input.breakSessionId ?? null);
    } else if (input.breakSessionId) {
      console.warn(
        `[off_post_events.link_dropped] source=${input.source} session=${input.shiftSessionId} ` +
        `break=${input.breakSessionId} — break_session_id column absent (schema_v61 not applied); ` +
        `row still written without the link`,
      );
    }

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `INSERT INTO off_post_events (${cols.join(', ')}) VALUES (${placeholders})`,
      vals,
    );
    return true;
  } catch (err) {
    // The whole point of this function. Log loudly, return false, never throw.
    console.error(
      `[off_post_events.failed] source=${input.source} session=${input.shiftSessionId}:`,
      err,
    );
    return false;
  }
}
