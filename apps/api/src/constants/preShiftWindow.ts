/**
 * The "one hour before the shift starts" band, in one place.
 *
 * TWO jobs select on this window and they must not drift apart:
 *
 *   jobs/preShiftReminder.ts      pushes the assigned guard  ("Shift in 1 hour")
 *   jobs/unstaffedPostWarning.ts  emails admins when there IS no assigned guard
 *
 * They are deliberately complementary — one fires when `guard_id` is set, the
 * other when the shift has nobody on it — so a shift should see exactly one of
 * them. If the bounds diverged, a window would open in which a post is neither
 * reminded nor warned about, and nothing would report that.
 *
 * ─── WHY THE BAND IS TEN MINUTES WIDE, NOT AN INSTANT ──────────────────
 *
 * Both jobs run on the five-minute cron. A band narrower than the tick
 * interval could fall between two ticks and match nothing. Ten minutes
 * against a five-minute cron gives every shift TWO ticks of opportunity, so a
 * single missed or delayed tick costs nothing. The `*_sent_at IS NULL` latch is what stops the
 * second tick re-sending.
 *
 * ─── THIS IS ZONE-FREE ARITHMETIC AND MUST STAY THAT WAY ───────────────
 *
 * `scheduled_start` is `timestamptz` — an instant. `NOW()` is an instant. An
 * INTERVAL is an absolute duration. So "between 55 and 65 minutes from now"
 * means the same thing at every site on earth, and a DST transition cannot
 * move it: an hour before an instant is 3600 seconds before it, always.
 *
 * The trap this avoids is computing the window in site-local wall-clock
 * ("the same hour, minus one"), which on a spring-forward night is either two
 * hours or zero. Site timezone is for DISPLAY only.
 *
 * The predicate is also sargable — it does not wrap the column — so it uses
 * idx_shifts_scheduled_start (schema_v73). Contrast missedShiftAlert.ts:28,
 * `scheduled_start + INTERVAL '10 minutes' <= NOW()`, which wraps the column
 * and therefore cannot.
 */

/** Lower edge of the band, in minutes ahead of now. */
export const PRE_SHIFT_WINDOW_MIN_MINUTES = 55;

/** Upper edge of the band, in minutes ahead of now. */
export const PRE_SHIFT_WINDOW_MAX_MINUTES = 65;

/**
 * SQL fragment: `<column> BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() +
 * INTERVAL '65 minutes'`. Both callers interpolate this rather than writing
 * the BETWEEN by hand, which is the point.
 *
 * The two values are compile-time numeric constants declared above and are
 * never user input — the same arrangement as SLOT_WINDOW_DAYS in
 * services/slotExpansion.ts. There is nothing here to interpolate unsafely.
 */
export function preShiftWindowSql(column: string): string {
  return `${column} BETWEEN NOW() + INTERVAL '${PRE_SHIFT_WINDOW_MIN_MINUTES} minutes'`
       + ` AND NOW() + INTERVAL '${PRE_SHIFT_WINDOW_MAX_MINUTES} minutes'`;
}
