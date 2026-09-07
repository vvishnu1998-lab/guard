/**
 * Rate-limited reporting for "no active device, push skipped" on REQUEST paths.
 *
 * Why this is not the cron fix. The three reminder crons (pingReminder,
 * preShiftReminder, shiftStartReminder, lateClockInReminder) count skips into a
 * tick-scoped counter and print one `skipped_no_device=N` on their existing
 * summary line — they have a natural batch boundary to report on. swapPush and
 * shiftPush do not: they run inside a request, once per recipient, with no tick
 * and no summary line to hang a total off. A counter there would be written and
 * never read.
 *
 * So these two keep a Sentry event, but at most ONE per 10 minutes per
 * (flow, company_id), carrying how many occurrences it stands for.
 *
 * The tenant key is the point. OPEN-ITEMS N20: "None tags company_id
 * consistently, which is the part that actually matters: the difference between
 * 'test tenant, ignore' and 'paying customer, act' is currently discoverable
 * only by querying the DB." Historical events on issue 7633312535 under
 * `flow: swap_push` carried company_id 27c4d404-8769-49ca-bfd6-93cb9b890067 on
 * 2026-08-30 and 2026-09-01, so STARNET has reached this path before — and
 * keying the limiter per company means a burst on the test tenant can never
 * suppress the first report for the paying one.
 *
 * `company_id` and `flow` are tags because both are low-cardinality and are how
 * you would triage. `guard_id` is NOT a tag — one per guard is unbounded
 * cardinality — but every occurrence is logged with it, so Railway keeps the
 * full detail at full resolution.
 *
 * Incident: docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md.
 */
import { pool } from '../db/pool';
import { Sentry } from './sentry';

export const PUSH_SKIP_WINDOW_MS = 10 * 60 * 1000;

interface SkipWindow {
  lastCaptureAt: number;
  suppressed: number;
}

// Per process, not per request. Deliberately unbounded in principle and bounded
// in practice: one entry per (flow, company_id) seen since boot, which is a
// handful of flows times a single-digit tenant count.
const windows = new Map<string, SkipWindow>();

/**
 * The guard's tenant, or null. NEVER THROWS — same contract as
 * getActivePushToken, and for the same reason: swapPush's caller runs its push
 * block fire-and-forget, so a rejection here would surface as an unhandled
 * promise rejection rather than a handled error. A failed lookup degrades to
 * company=unknown, which still reports.
 */
async function companyIdForGuard(guardId: string): Promise<string | null> {
  try {
    const res = await pool.query<{ company_id: string }>(
      'SELECT company_id FROM guards WHERE id = $1',
      [guardId],
    );
    return res.rows[0]?.company_id ?? null;
  } catch (err) {
    console.error('[push.skip] company lookup failed for guard', guardId, err);
    return null;
  }
}

/**
 * Record one skipped push. Logs every occurrence; reports to Sentry at most
 * once per PUSH_SKIP_WINDOW_MS per (flow, company_id).
 *
 * Awaiting this does not change what is written: at both call sites the
 * in-app notification row is already committed by the time it runs, and the
 * push was going to be skipped either way.
 */
export async function reportPushSkip(
  flow: string,
  guardId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const companyId = await companyIdForGuard(guardId);
  const company = companyId ?? 'unknown';

  // Every occurrence, always. This is the line that keeps per-guard resolution
  // once the Sentry event has been rate-limited away.
  console.warn(`[push.skip] flow=${flow} guard=${guardId} company=${company}`);

  const key = `${flow}:${company}`;
  let w = windows.get(key);
  if (!w) {
    w = { lastCaptureAt: 0, suppressed: 0 };
    windows.set(key, w);
  }
  w.suppressed += 1;

  const now = Date.now();
  // lastCaptureAt starts at 0, so the first occurrence for a (flow, company)
  // always reports rather than waiting out a window.
  if (now - w.lastCaptureAt < PUSH_SKIP_WINDOW_MS) return;

  Sentry.captureMessage('push_skip_null_token', {
    level: 'warning',
    tags: { flow, company_id: company },
    extra: {
      ...extra,
      guard_id: guardId,
      occurrences_since_last_report: w.suppressed,
      window_minutes: PUSH_SKIP_WINDOW_MS / 60000,
    },
  });
  w.lastCaptureAt = now;
  w.suppressed = 0;
}

/** Test-only: the window state is per-process and has no TTL. */
export function __resetPushSkipState(): void {
  windows.clear();
}
