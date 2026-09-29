import { Sentry } from '../services/sentry';

/**
 * N92. Edge-triggered reporting for the health probes.
 *
 * The probes used to swallow their errors in a bare `catch {}` — no binding,
 * no log, no Sentry. A production Postgres outage was therefore INVISIBLE in
 * the error stream from the one route whose job is to notice it. The 503 was
 * correct and an external monitor would see it; the point is that whoever
 * happened to be looking was the notification.
 *
 * WHY NOT JUST captureException IN THE CATCH. `services/sentry.ts:70` sets
 * `sampleRate: 1.0` — no sampling, no SDK-side dedup — so a capture in a probe
 * is one event per probe, for as long as the outage lasts. That is the N27/N28
 * defect class: the SendGrid retry storm exhausted the Sentry quota and blinded
 * error monitoring for 94 hours. Reporting an outage must not cost the ability
 * to see the next one.
 *
 * Today the rate would be small — nothing probes these endpoints on a schedule
 * except `ops-triage`, once daily, two curls per endpoint. But the repoint of
 * Sentry Uptime monitor 8024493 from www.netraops.com to /health/crons is
 * queued runbook work (RUNBOOK-phase4-apply.md step d), and its cadence is
 * minutes. Per-probe capture would go from ~2/day to 288–1440/day per endpoint
 * per outage the moment that lands. Edge-triggering makes the repoint safe to
 * do without coming back to this file.
 *
 * SO: log EVERY failure, capture ONCE per outage.
 *
 *   console.error  — every call, unconditionally. Railway logs are the first
 *                    place anyone looks, they are cheap, and a per-probe line
 *                    is exactly what tells you how long an outage has run.
 *   captureException — only on the healthy→unhealthy EDGE. One event says
 *                    "this started"; the thousandth says nothing new.
 *
 * Recovery is logged, never captured: an event for "it works again" costs
 * quota to report a non-problem.
 *
 * Deliberately has no timers and no clock. State is one boolean per probe,
 * flipped by the caller. There is nothing to leak, nothing to await, and the
 * behaviour is fully determined by the call sequence — which is what makes it
 * testable without a database or a DSN.
 */
export interface EdgeReporter {
  /** A probe failed. Logs always; captures only on the first failure. */
  fail(err: unknown): void;
  /** A probe succeeded. Logs only if it is recovering from a failure. */
  recover(): void;
}

export function makeEdgeReporter(name: string): EdgeReporter {
  // Starts optimistic. A process that boots into a broken database reports on
  // its first probe, which is the correct moment — not at import time, when
  // nothing has been observed yet.
  let healthy = true;

  return {
    fail(err: unknown): void {
      console.error(`[health:${name}]`, err);
      if (healthy) {
        healthy = false;
        Sentry.captureException(err, { tags: { flow: 'health', probe: name } });
      }
    },

    recover(): void {
      if (!healthy) {
        healthy = true;
        console.log(`[health:${name}] recovered`);
      }
    },
  };
}
