/**
 * Location integrity scan — nightly, ADVISORY ONLY.
 *
 * Writes rows to location_integrity_flags for a human to review. It does
 * not block anything, does not return anything to a client, and is never
 * consulted on a request path. A flag means "someone should look at this".
 *
 * Runs at 00:20 PT — deliberately 20 minutes after nightlyPurge (00:00) so
 * the two never contend, and late enough that the previous day's shifts have
 * auto-closed.
 *
 * Read the honest limit in services/locationIntegrity.ts before drawing any
 * conclusion from what this produces: a mock set to a never-before-recorded
 * coordinate with plausible accuracy defeats every check it runs.
 */
import { runJob } from './_run';
import { runLocationIntegrityScan } from '../services/locationIntegrity';

/** Lookback window. Wider than one day on purpose: the checks compare a
 *  coordinate against a guard's HISTORY, so a one-day window would miss a
 *  value first recorded last week. 30 days matches the backtest. */
const LOOKBACK_DAYS = 30;

export async function runLocationIntegrityJob(): Promise<void> {
  const started = Date.now();
  try {
    const results = await runLocationIntegrityScan(LOOKBACK_DAYS);
    const total = results.reduce((n, r) => n + r.inserted, 0);
    console.log(
      `[integrity.cron] complete in ${Date.now() - started}ms new_flags=${total} ` +
      results.map((r) => `${r.checkName}=${r.inserted}/${r.matched}`).join(' '),
    );
  } catch (err: any) {
    // Advisory job. Never let it take the process down.
    console.error(`[integrity.cron] FAILED: ${err?.message ?? err}`);
  }
}

// 00:20 America/Los_Angeles.
runJob('locationIntegrityCron', '20 0 * * *', runLocationIntegrityJob, { timezone: 'America/Los_Angeles', sentryMonitor: false });
