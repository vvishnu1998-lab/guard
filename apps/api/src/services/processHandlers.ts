/**
 * N169. What the API does with an error that escapes everything: an exception thrown on a later tick, where no
 * try/catch and no Express handler can reach it, or a promise rejection that nothing handles.
 *
 * Until N169, @sentry/node's defaults decided, and only when SENTRY_DSN was set (services/sentry.ts):
 *   - an uncaught exception was reported as fatal, and the process exited, since no other listener existed;
 *   - an unhandled rejection was reported (mode 'warn'), and the process kept running.
 * Without a DSN (locally), Node's defaults applied, and both ended the process.
 *
 * The policy is now the API's own, the same with or without a DSN (Vishnu, 2026-10-15, decision 5a):
 *   - UNCAUGHT EXCEPTION: one log line, a fatal Sentry event, a flush capped at FLUSH_MS, then exit 1. After an
 *     uncaught exception the process is in an unknown state (Node's guidance), so it must not carry on; Railway
 *     starts a new one. The log line is how a restart shows in Railway's logs.
 *   - UNHANDLED REJECTION: one log line and an error event, and the process keeps running, as production always
 *     has.
 *
 * Both events carry the mechanism Sentry's own handlers gave them, so they group with any from before. Those two
 * handlers are left out of Sentry's defaults (services/sentry.ts), so these are the only ones.
 *
 * index.ts imports this module second, right after services/sentry, so the handlers are in place before anything
 * else loads. scripts/test-n169-process-handlers.ts proves both paths in child processes, index.ts included.
 */
import { Sentry } from './sentry';

/** How long an uncaught exception waits for its event to leave before the process exits. */
export const FLUSH_MS = 2000;

let exiting = false;

process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception; exiting', err);
  // A second one while the first is still being sent: logged above, not sent.
  if (exiting) return;
  exiting = true;
  process.exitCode = 1;
  try {
    Sentry.captureException(err, {
      originalException: err,
      captureContext: { level: 'fatal' },
      mechanism: { handled: false, type: 'onuncaughtexception' },
    });
  } catch {
    // The log line above is the record.
  }
  // The backstop, if the flush never settles.
  setTimeout(() => process.exit(1), FLUSH_MS + 1000);
  Sentry.flush(FLUSH_MS).then(() => process.exit(1), () => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] unhandled rejection; continuing', reason);
  try {
    Sentry.captureException(reason, {
      originalException: promise,
      captureContext: { extra: { unhandledPromiseRejection: true } },
      mechanism: { handled: false, type: 'onunhandledrejection' },
    });
  } catch {
    // A throw here would become an uncaught exception and end the process; the log line is the record.
  }
});
