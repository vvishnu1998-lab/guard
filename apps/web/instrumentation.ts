/**
 * Next.js instrumentation hook — registers the server and edge SDKs.
 *
 * Next.js 14.2 defaults `experimental.instrumentationHook` to false, so this
 * file is only loaded because next.config.js opts in. Without that flag the
 * server and edge runtimes would silently report nothing.
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Captures errors thrown in nested React Server Components. Next.js calls
 * this from 15.0 onward; on 14.x it is exported but never invoked, so server
 * errors here arrive via the runtime's own handlers instead.
 */
export const onRequestError = Sentry.captureRequestError;
