import { Pool, type PoolClient } from 'pg';
import * as Sentry from '@sentry/node';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // rejectUnauthorized: false allows Railway's proxy SSL cert to work correctly.
  // Railway's internal proxy uses a self-signed cert that fails strict verification.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  // Increased from 2000ms — Railway proxy latency can exceed 2s on cold start
  connectionTimeoutMillis: 30000,
});

// Fields only. The error object itself can carry err.client (pg-pool attaches
// the whole pg Client on the idle path: host, port, user, database, socket),
// so logging the object prints all of that.
function pgErrorFields(err: Error): { code?: string; severity?: string; message: string } {
  const e = err as Error & { code?: string; severity?: string };
  return { code: e.code, severity: e.severity, message: e.message };
}

pool.on('error', (err) => {
  // Log but do NOT exit — a single dropped idle connection should not kill the server
  console.error('Unexpected error on idle client', pgErrorFields(err));
});

// A CHECKED-OUT client has no 'error' listener of its own: pg-pool removes its
// idle listener on checkout and puts it back on release. pg's Client emits
// 'error' whenever its connection dies (unexpected close, socket error, or a
// FATAL such as 57P01 when Postgres restarts), even while a query is in
// flight, and an 'error' with no listener throws and kills the process. The
// listener below covers exactly the checked-out window, for pool.connect()
// and pool.query() clients alike. The in-flight query still rejects and its
// caller still handles that. The dead client is dropped on release, or via
// pg-pool's idle listener when its socket closes.
//
// A dying client usually emits twice (the FATAL, then the close), and one
// Postgres restart can hit every checked-out client at once, so each client
// is reported to Sentry at most once.
const reportedClients = new WeakSet<PoolClient>();

function onCheckedOutClientError(this: PoolClient, err: Error): void {
  const fields = pgErrorFields(err);
  console.error('[pg.client_error] checked-out client error', fields);
  if (reportedClients.has(this)) return;
  reportedClients.add(this);
  // Without Sentry.init there is no client, and withIsolationScope would not
  // fork: clearing below would then clear the process-wide default scopes.
  if (!Sentry.getClient()) return;
  try {
    // This runs in the async context of whichever request first opened the
    // client's socket, possibly minutes ago and for another user, so the
    // active scopes carry that request's user, tags and URL, and its span
    // would link this event to that request's trace. Drop the span and clear
    // both scopes.
    Sentry.withActiveSpan(null, () => {
      Sentry.withIsolationScope((isolationScope) => {
        isolationScope.clear();
        isolationScope.setSDKProcessingMetadata({ request: undefined, normalizedRequest: undefined });
        Sentry.withScope((scope) => {
          scope.clear();
          scope.setLevel('warning');
          scope.setTag('flow', 'db_pool');
          scope.setTag('pg_code', fields.code ?? 'none');
          scope.setFingerprint(['db_pool', 'checked_out_client_error', fields.code ?? fields.message]);
          Sentry.captureException(err);
        });
      });
    });
  } catch {
    // Never throw from an 'error' listener: that is the crash this prevents.
  }
}

// 'acquire' fires before pg-pool removes its idle listener, and 'release'
// after it puts that listener back, so a client is never without one.
pool.on('acquire', (client) => {
  client.on('error', onCheckedOutClientError);
});

pool.on('release', (_err, client) => {
  client.removeListener('error', onCheckedOutClientError);
});
