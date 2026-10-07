/**
 * test-pool-client-error.ts — a Postgres connection that dies under a CHECKED-OUT
 * pool client must not crash the API. End to end on a THROWAWAY LOCAL Postgres
 * CLUSTER that this script terminates backends on, resets sockets on, and stops
 * (-m fast and -m immediate) and restarts.
 *
 * THE DEFECT. pg-pool removes its idle 'error' listener when a client is checked
 * out and puts it back on release, so a pool.connect() client has NO 'error'
 * listener while it is held. pg's Client emits 'error' on any unexpected close:
 *   - no query in flight: usually TWICE (the FATAL, e.g. 57P01, then
 *     'Connection terminated unexpectedly' when the socket ends);
 *   - a query in flight: the FATAL rejects that query, then ONE emit on end.
 * An 'error' emit with no listener throws, and the process dies.
 *
 * THE FIX UNDER TEST (src/db/pool.ts). pool.on('acquire') adds
 * onCheckedOutClientError to the client, pool.on('release') removes it. The
 * listener logs '[pg.client_error]' and reports each client to Sentry at most
 * once, at level warning, with the stale request context of whoever first
 * opened the socket dropped (withActiveSpan(null) + cleared isolation and
 * current scopes), and only when a Sentry client exists.
 *
 * WHY CHILD PROCESSES. The defect IS a process crash, so every case runs in a
 * child (this file, `--child <case>`). The child writes PF_CHECK lines with
 * writeSync (each under PIPE_BUF, so atomic next to async console output). The
 * PARENT injects the faults it can (pg_terminate_backend, pg_ctl stop/start)
 * and writes those `.P` checks itself, so a precondition never races the crash
 * it causes. RULE: a child writes no check between a fault and its settle
 * point, so on an unfixed tree every post-fault check is missing,
 * deterministically. S6's socket reset is done by the child (in-process proxy);
 * S6.P is written before the reset.
 *
 * CRASH CLASSIFIER. A preloaded EventEmitter.prototype.emit wrapper writes
 * PF_UNHANDLED_EMIT {on, code, message} for every 'error' emit that has no
 * listener, and an uncaughtExceptionMonitor writes PF_UNCAUGHT. A dead child is
 * PG_UNHANDLED_ERROR only if a Client/BoundPool emit with a pg code or message
 * is followed by an uncaught exception with the same message; anything else is
 * OTHER. (Node's own "Emitted 'error' event" stderr line is NOT used: ts-node's
 * source-map-support shim suppresses it.)
 *
 * LOCAL CLUSTER ONLY. Refuses unless PGHOST is 127.0.0.1/localhost, DATABASE_URL
 * is unset, PGPORT is set and is not 5432 (the Homebrew PG14 guard_dev
 * service), DOTENV_CONFIG_PATH is /dev/null, PF_PGDATA is under /private/tmp
 * and holds the marker file NETRAOPS_THROWAWAY, its postmaster.pid names
 * PGPORT, SHOW data_directory on PGPORT is PF_PGDATA (re-checked before every
 * stop), and the template (PF_TEMPLATE) holds no company. Each mode gets a
 * fresh database created from the template, dropped afterwards unless --keep.
 *
 * ENV. PGHOST PGPORT PGUSER PGDATABASE(maintenance db) PF_TEMPLATE PF_PGDATA
 * PF_PGCTL PF_PGSET(lock|prod: which pg/pg-pool/pg-protocol set is expected to
 * resolve; C0.4 asserts it) PF_SRC_REPO(git worktree for origin/main; defaults
 * to ../.. of apps/api) PF_LOG_DIR(optional: per-child stdout/stderr files).
 * FLAGS. --tls: the app pool connects with pool.options.ssl =
 * { rejectUnauthorized: false } (production's value; the cluster must run
 * ssl=on). --sentry: children call the real Sentry.init BEFORE pg is required,
 * with src/services/sentry.ts's integrations and an in-memory recording
 * transport (no network); tracesSampleRate is 1.0, not production's 0.05, so
 * the stale span is always recorded. --mode X | --modes a,b | --matrix.
 * --only S1,S2. --keep. --verbose. --predict (print predicted sets and exit).
 *
 * MODES. fix loads src/db/pool.ts as it is. main compiles origin/main's pool.ts
 * under pool.ts's filename (negative control; valid only while nothing else
 * under apps/api/src differs from origin/main, which main/--matrix assert, for
 * the worktree including untracked files AND for the tree being run). M1..M9
 * compile the branch pool.ts with textual edits, each asserted to match exactly
 * once. M5-M7 only change Sentry behaviour and need --sentry; M9 only changes
 * behaviour without a Sentry client and refuses --sentry. --matrix exits 0 only
 * if every mode fails EXACTLY its predicted set (predicted() below).
 *
 * SETUP. The Phase 1 runner (not committed: it holds machine paths) did this,
 * one config per fresh cluster:
 *   1. initdb -D <under /private/tmp> -U tester -A trust; postgresql.conf:
 *      port=<not 5432>, listen_addresses='127.0.0.1', unix_socket_directories='',
 *      ssl=on with a self-signed server.crt/server.key (openssl req -x509);
 *      touch <pgdata>/NETRAOPS_THROWAWAY; start with LC_ALL=C (macOS).
 *   2. createdb pf_template; migrate it: env -u DATABASE_URL
 *      DOTENV_CONFIG_PATH=/dev/null PGHOST=127.0.0.1 PGPORT=… PGUSER=tester
 *      PGDATABASE=pf_template npx ts-node src/db/migrate.ts
 *   3. run from apps/api with the ENV above: node -r
 *      ts-node/register/transpile-only scripts/test-pool-client-error.ts
 *      --matrix [--tls] [--sentry]. For PF_PGSET=prod, first overlay pg 8.23.0,
 *      pg-pool 3.14.0, pg-protocol 1.16.0 and pg-connection-string 2.14.0 into
 *      apps/api/node_modules (of a copy of the tree, not a working checkout).
 */
import Module from 'node:module';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeSync, writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Client as PgClient } from 'pg';
import * as Sentry from '@sentry/node';

const API_DIR = path.resolve(__dirname, '..');
const SRC_REPO = process.env.PF_SRC_REPO ?? path.resolve(API_DIR, '../..');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const APP = 'pf-app';          // PGAPPNAME of the app pool in every child
const HARNESS = 'pf-harness';  // the harness's own raw connections
const LOCKER = 'pf-lock';
const VICTIM = 'pf-victim';    // C0b's deliberately unguarded raw client
const SETTLE_MS = 400;
const MIN = 60_000;
const IDLE_LOG = 'Unexpected error on idle client';       // pool.on('error'), both trees
const CHECKED_OUT_LOG = '[pg.client_error]';               // the fix's checked-out listener
const DRIVER_ON_WIRE = /57P01|terminat|Connection terminated|administrator command|not queryable/i;
const PG_CODES = new Set(['57P01', 'ECONNRESET', 'EPIPE']);
const PG_MESSAGES = ['Connection terminated unexpectedly', 'terminating connection due to administrator command'];
const STALE_USER = 'stale-user';
const STALE_TAG = 'stale-value';
const STALE_URL = 'http://stale.invalid/r';
const STALE_RE = /stale-user|stale-value|stale\.invalid/;
const PGSETS: Record<string, { pg: string; pgPool: string; pgProtocol: string }> = {
  lock: { pg: '8.20.0', pgPool: '3.13.0', pgProtocol: '1.13.0' },  // the repo's root lock
  prod: { pg: '8.23.0', pgPool: '3.14.0', pgProtocol: '1.16.0' },  // what production resolves
};

const argv = process.argv.slice(2);
const argVal = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => argv.includes(flag);
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));
const IS_CHILD = argVal('--child') !== undefined;
const SENTRY = IS_CHILD ? process.env.PF_SENTRY === '1' : hasFlag('--sentry');
const TLS = IS_CHILD ? process.env.PF_TLS === '1' : hasFlag('--tls');
const PGSET = process.env.PF_PGSET ?? '';

// pg is required lazily: with --sentry the child must run Sentry.init before
// the first require('pg'), or the auto-instrumentation never patches it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgLib = (): typeof import('pg') => require('pg');

// ════════════════════════════════════════════════════════════════════════════
// Case table. `.P` (fault injected) and `.1` (process survived) are written by
// the PARENT, except S6.P (child, before its own reset). Everything else is
// written by the child. A check that never arrives is a FAIL.
// ════════════════════════════════════════════════════════════════════════════
interface CaseDef { id: string; title: string; timeoutMs: number; checks: string[] }
const ids = (c: string, ...n: string[]) => n.map((x) => `${c}.${x}`);
const upTo = (c: string, last: number) => ids(c, ...Array.from({ length: last }, (_, i) => String(i + 1)));
const sentryIds = (c: string, sentry: boolean): string[] => (sentry ? ids(c, 'E1', 'E2', 'E3', 'E4') : []);

function caseTable(sentry: boolean): CaseDef[] {
  const E = (c: string) => sentryIds(c, sentry);
  return [
    { id: 'C0a', title: 'instrument: idle-in-transaction counter sees a deliberate leak; resolved driver set matches PF_PGSET', timeoutMs: 20_000, checks: ['C0.1', 'C0.4'] },
    { id: 'C0b', title: 'instrument: an unguarded raw pg.Client whose backend is terminated is classified PG_UNHANDLED_ERROR', timeoutMs: 20_000, checks: ['C0.2'] },
    { id: 'C0c', title: 'instrument: a plain thrown Error is classified OTHER', timeoutMs: 20_000, checks: ['C0.3'] },
    { id: 'C0d', title: 'instrument: the app pool TLS state and the Sentry state match the config', timeoutMs: 20_000, checks: ['C0.5', 'C0.6', ...(sentry ? ['C0.7', 'C0.8'] : [])] },
    { id: 'S1', title: 'checked-out client, idle in a transaction, backend terminated (two emits)', timeoutMs: 30_000, checks: [...ids('S1', 'P'), ...upTo('S1', 5), 'S1.M', ...E('S1')] },
    { id: 'S2', title: 'checked-out client with a query in flight, backend terminated (one emit)', timeoutMs: 30_000, checks: [...ids('S2', 'P'), ...upTo('S2', 5), ...E('S2')] },
    { id: 'S3', title: 'CONTROL: pool.query in flight, backend terminated (survives on origin/main too)', timeoutMs: 30_000, checks: [...ids('S3', 'P'), ...upTo('S3', 3)] },
    { id: 'S4', title: "(c) idle client in the pool, backend terminated -> pool.on('error') only", timeoutMs: 30_000, checks: [...ids('S4', 'P'), ...upTo('S4', 5), ...(sentry ? ['S4.E1'] : [])] },
    { id: 'S6', title: 'socket reset with no Postgres message (TCP RST via in-process proxy)', timeoutMs: 30_000, checks: [...ids('S6', 'P'), ...upTo('S6', 4), ...E('S6')] },
    { id: 'S7', title: 'the checked-out listener does not accumulate across checkouts', timeoutMs: 30_000, checks: upTo('S7', 4) },
    { id: 'V10', title: 'FATAL rejects an ACTIVE query, holder does a plain release() before the socket closes, next caller reuses the client', timeoutMs: 30_000, checks: [...ids('V10', 'P'), ...upTo('V10', 5), ...E('V10')] },
    { id: 'S8', title: '(d) POST /api/shifts/:id/clock-out, backend terminated while the UPDATE waits on a row lock', timeoutMs: 45_000, checks: ids('S8', 'P', '1', '3', '4', '5', '6') },
    { id: 'S9', title: '(d) PATCH /api/shifts/:id/cancel, backend terminated while SELECT ... FOR UPDATE waits', timeoutMs: 45_000, checks: ids('S9', 'P', '1', '3', '4', '5') },
    { id: 'S10', title: '(d) autoCompleteShifts tick through the real runJob wrapper, backend terminated mid-sweep', timeoutMs: 45_000, checks: ids('S10', 'P', '1', '3', '4', '5', '6', '7') },
    // Last: they stop and restart the cluster.
    { id: 'S5', title: 'pg_ctl stop -m fast + restart: A checked out in BEGIN, B idle, C pool.query in flight', timeoutMs: 90_000, checks: [...ids('S5', 'P'), ...upTo('S5', 7), ...E('S5')] },
    { id: 'S5i', title: 'pg_ctl stop -m immediate (SIGQUIT, crash recovery) + restart: same A/B/C', timeoutMs: 90_000, checks: [...ids('S5i', 'P'), ...upTo('S5i', 7), ...E('S5i')] },
  ];
}
const GLOBAL_CHECKS = ['G1'];

/**
 * PREDICTED failing sets — written before any run, from the mechanics above.
 * A mode passes the matrix only if its failing set is EXACTLY this.
 *
 * Emits per case while the client is CHECKED OUT (fix tree):
 *   S1 two (57P01, then end); S2 one (end; the FATAL rejected the query);
 *   S6 two (ECONNRESET, then close); V10 one (end, under the SECOND holder);
 *   S5 fast: A two (57P01, end), B idle, C's FATAL rejects its query (no emit);
 *   S5i immediate: the backend sends only a WARNING notice, so A one (end),
 *   C one (end: pg emits before it rejects the queued query, and pool.query's
 *   once-listener and the fix's listener both see it), B idle;
 *   S8/S9/S10 one each (FATAL rejects the waiting statement, the catch's
 *   ROLLBACK is queued, end emits).
 *
 * main / M1 (no checked-out listener at all): every case with a checked-out
 *   emit dies: S1 S2 S6 V10 S8 S9 S10 S5 S5i (all post-fault checks, and their
 *   Sentry checks); S7.3 (no listener while checked out). S3, S4 survive.
 * M2 (listener never removed on release): it accumulates, so S7.3 (count grows)
 *   and S7.4 (MaxListenersExceededWarning at the 11th checkout) fail, and an
 *   IDLE client keeps it, so S4.5 ('[pg.client_error]' for an idle client)
 *   fails; with Sentry, S4.E1 (an idle client reported), S5.E1 (B reported
 *   too: 2 events, not 1) and S5i.E1 (3, not 2). Dedupe keeps every other
 *   count at one.
 * M3 (once): the second emit on a checked-out client is unhandled, so the
 *   two-emit cases die: S1, S6, S5 (fast). S2, V10, S5i and the routes emit
 *   once and survive.
 * M4 (pool.on('error') removed): an idle client's error reaches pg-pool's
 *   idle listener, which re-emits on the pool with no listener: S4, S5, S5i die.
 * M5 (dedupe removed): one event per EMIT, so the two-emit cases report twice
 *   (E1), and the second event carries pg_code 'none', not the case's code
 *   (E2): S1, S6, S5.
 * M6 (no scope clearing): the stale user/tag/url reach the event (E3) in every
 *   case whose socket was opened in the stale context. Trace ids still differ:
 *   withActiveSpan(null) is kept, and the scope's propagation trace id is not
 *   the stale span's (OTel generates root span ids itself).
 * M6d / M6e (the metadata reset keeps only one of its two keys): the other
 *   stale key reaches event.request (E3) in the same six cases. M6d leaves
 *   request stale (requestDataIntegration's legacy fallback when
 *   normalizedRequest is unset); M6e leaves normalizedRequest stale.
 * M7 (no withActiveSpan(null)): the stale span stays active in the socket's
 *   async context, so the event joins its trace (E4) in the same six cases.
 * M9 (no getClient() guard; only meaningful WITHOUT Sentry): withIsolationScope
 *   does not fork under the default stack strategy, so clear() wipes the
 *   process-wide isolation scope: S1.M (marker tag) fails.
 * Checks no mode is predicted to fail (instrument controls, .P, S3, S7.2,
 * V10.P, G1) are regression guards and preconditions, not mutation-killed.
 */
function predicted(mode: string, sentry: boolean): string[] {
  const E = (c: string) => sentryIds(c, sentry);
  const dies = (c: string, last: number, extra: string[] = []) => [...upTo(c, last), ...extra, ...E(c)];
  const S1 = dies('S1', 5, ['S1.M']);
  const S2 = dies('S2', 5);
  const S6 = dies('S6', 4);
  const V10 = dies('V10', 5);
  const S5 = dies('S5', 7);
  const S5i = dies('S5i', 7);
  const S4 = [...upTo('S4', 5), ...(sentry ? ['S4.E1'] : [])];
  const routes = [...ids('S8', '1', '3', '4', '5', '6'), ...ids('S9', '1', '3', '4', '5'), ...ids('S10', '1', '3', '4', '5', '6', '7')];
  const stale6 = ['S1', 'S2', 'S6', 'V10', 'S5', 'S5i'];
  switch (mode) {
    case 'fix': return [];
    case 'main':
    case 'M1': return [...S1, ...S2, ...S6, ...V10, ...routes, ...S5, ...S5i, 'S7.3'];
    case 'M2': return ['S4.5', 'S7.3', 'S7.4', ...(sentry ? ['S4.E1', 'S5.E1', 'S5i.E1'] : [])];
    case 'M3': return [...S1, ...S6, ...S5];
    case 'M4': return [...S4, ...S5, ...S5i];
    case 'M5': return ids('S1', 'E1', 'E2').concat(ids('S6', 'E1', 'E2'), ids('S5', 'E1', 'E2'));
    case 'M6':
    case 'M6d':
    case 'M6e': return stale6.map((c) => `${c}.E3`);
    case 'M7': return stale6.map((c) => `${c}.E4`);
    case 'M9': return ['S1.M'];
    default: return refuse(`no prediction for mode ${mode}`);
  }
}

/** Textual mutations of the branch pool.ts; every edit must match exactly once. */
const MUTATIONS: Record<string, { what: string; sentry?: boolean; edits: Array<[string, string]> }> = {
  M1: { what: "the 'acquire' registration never fires", edits: [["pool.on('acquire',", "pool.on('pf-mutant-never',"]] },
  M2: { what: "removeListener on 'release' dropped (the checked-out listener leaks, one more per checkout)",
    edits: [["  client.removeListener('error', onCheckedOutClientError);\n", '']] },
  M3: { what: 'client.once instead of client.on for the checked-out listener',
    edits: [["client.on('error', onCheckedOutClientError);", "client.once('error', onCheckedOutClientError);"]] },
  M4: { what: "pool.on('error') (idle clients) removed", edits: [["pool.on('error',", "pool.on('pf-mutant-never-error',"]] },
  M5: { what: 'once-per-client Sentry dedupe removed', sentry: true, edits: [['  if (reportedClients.has(this)) return;\n', '']] },
  M6: { what: 'scope clearing removed (both clear() calls and the setSDKProcessingMetadata reset)', sentry: true,
    edits: [
      ['        isolationScope.clear();\n', ''],
      ['        isolationScope.setSDKProcessingMetadata({ request: undefined, normalizedRequest: undefined });\n', ''],
      ['          scope.clear();\n', ''],
    ] },
  M6d: { what: 'the metadata reset unsets normalizedRequest only (request stays stale)', sentry: true,
    edits: [['setSDKProcessingMetadata({ request: undefined, normalizedRequest: undefined })', 'setSDKProcessingMetadata({ normalizedRequest: undefined })']] },
  M6e: { what: 'the metadata reset unsets request only (normalizedRequest stays stale)', sentry: true,
    edits: [['setSDKProcessingMetadata({ request: undefined, normalizedRequest: undefined })', 'setSDKProcessingMetadata({ request: undefined })']] },
  M7: { what: 'withActiveSpan(null, ...) wrapper removed, its callback kept', sentry: true,
    edits: [['Sentry.withActiveSpan(null, () => {', '((run: () => void) => run())(() => {']] },
  M9: { what: 'the `if (!Sentry.getClient()) return;` guard removed', sentry: false, edits: [['  if (!Sentry.getClient()) return;\n', '']] },
};
const ALL_MODES = ['fix', 'main', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M6d', 'M6e', 'M7', 'M9'];

interface CheckResult { id: string; pass: boolean; detail: string }
interface Uncaught { origin?: string; name?: string; code?: string | null; message?: string }
interface EmitRec { on?: string; code?: string | null; message?: string }
type Verdict = 'SURVIVED' | 'PG_UNHANDLED_ERROR' | 'OTHER' | 'HUNG';

// ════════════════════════════════════════════════════════════════════════════
// Shared helpers
// ════════════════════════════════════════════════════════════════════════════
function refuse(msg: string): never {
  console.error(`REFUSING: ${msg}`);
  process.exit(2);
}

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) refuse(`PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`);
  if (process.env.DATABASE_URL !== undefined) refuse('DATABASE_URL must be unset (env -u DATABASE_URL).');
  if (!process.env.PGPORT || process.env.PGPORT === '5432') refuse('PGPORT must be set and must not be 5432 (the guard_dev service).');
  if (process.env.PF_REAL_PORT === '5432') refuse('PF_REAL_PORT must not be 5432.');
  if (process.env.DOTENV_CONFIG_PATH !== '/dev/null') refuse('DOTENV_CONFIG_PATH must be /dev/null so no .env is read.');
}

/** A connection the harness owns. It always has an 'error' listener, so a
 *  harness connection can never be the thing that crashes a child. */
async function harnessClient(database: string, application_name = HARNESS): Promise<PgClient> {
  const { Client } = pgLib();
  const c = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PF_REAL_PORT ?? process.env.PGPORT),
    user: process.env.PGUSER,
    database,
    application_name,
    ssl: false,
  });
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

interface Settled { rejected: boolean; hung: boolean; code: string | null; message: string; value?: any }
async function settle<T>(p: Promise<T>, ms = 5_000): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled>((r) => { timer = setTimeout(() => r({ rejected: false, hung: true, code: null, message: `no answer in ${ms} ms` }), ms); });
  const outcome = p.then(
    (value): Settled => ({ rejected: false, hung: false, code: null, message: 'resolved', value }),
    (e: any): Settled => ({ rejected: true, hung: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 120) }),
  );
  const r = await Promise.race([outcome, timeout]);
  if (timer) clearTimeout(timer);
  return r;
}
const desc = (s: Settled): string => (s.hung ? 'HUNG' : s.rejected ? `rejected ${s.code ?? ''} ${s.message}` : 'resolved');

/** Walk up from a resolved entry file to the package.json named `name`. */
function pkgVersionFrom(file: string, name: string): string {
  let d = path.dirname(file);
  for (let i = 0; i < 10; i += 1) {
    const p = path.join(d, 'package.json');
    if (existsSync(p)) {
      try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.name === name) return String(j.version); } catch { /* keep walking */ }
    }
    d = path.dirname(d);
  }
  return '?';
}
function resolvedVersions() {
  const fromPool = Module.createRequire(path.join(API_DIR, 'src/db/pool.ts'));
  const pgMain = fromPool.resolve('pg');
  const fromPg = Module.createRequire(pgMain);
  const f = {
    pg: pgMain,
    pgPool: fromPg.resolve('pg-pool'),
    pgProtocol: fromPg.resolve('pg-protocol'),
    pgcs: fromPg.resolve('pg-connection-string'),
    sentry: fromPool.resolve('@sentry/node'),
  };
  return {
    pg: pkgVersionFrom(f.pg, 'pg'),
    pgPool: pkgVersionFrom(f.pgPool, 'pg-pool'),
    pgProtocol: pkgVersionFrom(f.pgProtocol, 'pg-protocol'),
    pgcs: pkgVersionFrom(f.pgcs, 'pg-connection-string'),
    sentry: pkgVersionFrom(f.sentry, '@sentry/node'),
    files: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, realpathSync(v)])),
    overlay: realpathSync(pgMain).startsWith(realpathSync(path.join(API_DIR, 'node_modules')) + path.sep),
    samePg: realpathSync(require.resolve('pg')) === realpathSync(pgMain),
  };
}

const gitBlob = (buf: Buffer): string => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const git = (...args: string[]): string => execFileSync('git', ['-C', SRC_REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// ════════════════════════════════════════════════════════════════════════════
// CHILD
// ════════════════════════════════════════════════════════════════════════════
let FATAL = false;   // set by the uncaughtExceptionMonitor: nothing after it counts

function safeWrite(fd: number, s: string): void {
  for (let i = 0; i < 200; i += 1) {
    try { writeSync(fd, s); return; } catch (e: any) {
      if (e?.code !== 'EAGAIN') return;
      const until = Date.now() + 5; while (Date.now() < until) { /* spin: pipe full */ }
    }
  }
}

/** PF_CHECK lines stay under 512 bytes (PIPE_BUF on macOS) so they are atomic. */
function report(id: string, pass: boolean, detail: string): void {
  if (FATAL) return;
  let d = detail;
  let line = `PF_CHECK ${JSON.stringify({ id, pass, detail: d })}\n`;
  while (Buffer.byteLength(line) >= 511 && d.length > 0) {
    d = d.slice(0, Math.max(0, d.length - Math.max(8, Buffer.byteLength(line) - 500)));
    line = `PF_CHECK ${JSON.stringify({ id, pass, detail: `${d}…` })}\n`;
  }
  safeWrite(1, line);
}

async function finish(): Promise<void> {
  if (FATAL) { await sleep(8_000); process.exit(1); }   // Sentry's handler exits first
  safeWrite(1, 'PF_DONE\n');
  process.exit(0);
}

let faultSeq = 0;
function askParent(kind: string, extra: Record<string, unknown> = {}): Promise<any> {
  faultSeq += 1;
  const seq = faultSeq;
  return new Promise((resolve) => {
    const onMsg = (m: any) => {
      if (m && m.seq === seq) { process.off('message', onMsg); resolve(m); }
    };
    process.on('message', onMsg);
    process.send!({ seq, kind, ...extra });
  });
}

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
function refusingModule(name: string): unknown {
  return new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the pool client-error test`); }),
  });
}

/** Compile `source` AS src/db/pool.ts (same filename, same require resolution
 *  for 'pg' and '@sentry/node') and put it in require.cache before anything
 *  imports the pool. */
function installPoolSource(source: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript');
  const resolved = require.resolve('../src/db/pool');
  const js: string = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m: any = new Module(resolved, module);
  m.filename = resolved;
  m.paths = (Module as any)._nodeModulePaths(path.dirname(resolved));
  require.cache[resolved] = m;
  m._compile(js, resolved);
  m.loaded = true;
}

/** The classifier: every 'error' emit that has no listener, before it throws. */
function installEmitClassifier(): void {
  const orig = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function pfEmit(this: EventEmitter, type: string | symbol, ...args: any[]): boolean {
    if (type === 'error' && this.listenerCount('error') === 0) {
      const e = args[0];
      safeWrite(2, `PF_UNHANDLED_EMIT ${JSON.stringify({ on: (this as any)?.constructor?.name, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) })}\n`);
    }
    return orig.call(this, type, ...args);
  } as typeof orig;
}

// ── Sentry: real SDK, in-memory recording transport ─────────────────────────
type Envelope = [Record<string, any>, Array<[Record<string, any>, any]>];
const recorded: Envelope[] = [];
function initSentry(): void {
  // createTransport/parseEnvelope from the @sentry/core that @sentry/node uses.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const core = require(require.resolve('@sentry/core', { paths: [path.dirname(require.resolve('@sentry/node'))] }));
  Sentry.init({
    dsn: 'https://public@sentry.invalid/1',   // never contacted: the transport below records in memory
    environment: 'pf-harness',
    sampleRate: 1.0,
    tracesSampleRate: 1.0,                    // production: 0.05
    integrations: [Sentry.httpIntegration(), Sentry.expressIntegration()],   // src/services/sentry.ts's set
    transport: (opts: any) => core.createTransport(opts, async (req: { body: string | Uint8Array }) => {
      recorded.push(core.parseEnvelope(req.body) as Envelope);
      return { statusCode: 200 };
    }),
  });
}
const itemPayload = (p: any): any => {
  if (p instanceof Uint8Array) { try { return JSON.parse(Buffer.from(p).toString('utf8')); } catch { return {}; } }
  return p;
};
interface RecEvent { event: any; dsc: any }
async function recordedEvents(): Promise<RecEvent[]> {
  await Sentry.flush(3_000);
  const out: RecEvent[] = [];
  for (const [header, items] of recorded) {
    for (const [ih, payload] of items) if (ih.type === 'event') out.push({ event: itemPayload(payload), dsc: header.trace });
  }
  return out;
}
function recordedTransactions(): any[] {
  const out: any[] = [];
  for (const [, items] of recorded) for (const [ih, payload] of items) if (ih.type === 'transaction') out.push(itemPayload(payload));
  return out;
}

interface Checkout { client: any; same: boolean; staleTraceId: string | null }
/**
 * Opens the pool's first socket (so the pool must be empty) inside a STALE
 * request context when Sentry is on — a forked isolation scope with a user, a
 * tag and a request URL, and an active span — releases the client, then checks
 * the SAME client out again outside that context. pg's 'error' emit later runs
 * in the socket's async context, i.e. the stale one. Without Sentry the client
 * goes through the same connect/release/connect so the case logic is shared.
 */
async function staleCheckout(pool: any): Promise<Checkout> {
  let first: any = null;
  let traceId: string | null = null;
  const open = async (): Promise<void> => { first = await pool.connect(); await first.query('SELECT 1'); first.release(); };
  if (SENTRY) {
    await Sentry.withIsolationScope(async (iso) => {
      iso.setUser({ id: STALE_USER });
      iso.setTag('pf_stale', STALE_TAG);
      // Both keys, as @sentry/node's http instrumentation sets them. requestDataIntegration
      // prefers normalizedRequest and falls back to the legacy request object.
      iso.setSDKProcessingMetadata({
        request: { method: 'GET', url: '/r', originalUrl: '/r', protocol: 'http', headers: { host: 'stale.invalid' } },
        normalizedRequest: { url: STALE_URL, method: 'GET', headers: {} },
      });
      Sentry.getCurrentScope().setUser({ id: STALE_USER });
      Sentry.getCurrentScope().setTag('pf_stale_current', STALE_TAG);
      await Sentry.startSpan({ name: 'pf-old-span' }, async (span) => {
        traceId = span.spanContext().traceId;
        await open();
      });
    });
  } else {
    await open();
  }
  const client = await pool.connect();
  return { client, same: client === first, staleTraceId: traceId };
}

/** E1-E4: one event per dying checked-out client, its shape, no stale context. */
async function eventChecks(caseId: string, expect: number, codes: string[], co: Checkout): Promise<void> {
  const errs = (await recordedEvents()).filter((e) => e.event.type === undefined);
  const brief = errs.map((e) => `${e.event.level}/${e.event.tags?.flow}/${e.event.tags?.pg_code}`).join(' ');
  report(`${caseId}.E1`, errs.length === expect && errs.every((e) => e.event.tags?.flow === 'db_pool'),
    `error events ${errs.length}, expected ${expect} (one per dying checked-out client): ${brief || '-'}`);
  const shapeOk = (ev: any): boolean => {
    const code = ev.tags?.pg_code;
    const fp = ev.fingerprint;
    const msg = ev.exception?.values?.[0]?.value;
    return ev.level === 'warning' && ev.tags?.flow === 'db_pool' && typeof code === 'string' && codes.includes(code)
      && Array.isArray(fp) && fp.length === 3 && fp[0] === 'db_pool' && fp[1] === 'checked_out_client_error'
      && fp[2] === (code === 'none' ? msg : code);
  };
  report(`${caseId}.E2`, errs.length > 0 && errs.every((e) => shapeOk(e.event)),
    `expected pg_code ${codes.join('|')}: ${errs.map((e) => `${e.event.level} ${e.event.tags?.pg_code} ${JSON.stringify(e.event.fingerprint)}`).join(' | ') || '-'}`);
  const stale = errs.filter((e) => STALE_RE.test(JSON.stringify(e.event)));
  const s0 = stale[0]?.event;
  report(`${caseId}.E3`, co.same && errs.length > 0 && stale.length === 0,
    `same client as the stale socket ${co.same}; events with stale user/tag/url ${stale.length}/${errs.length}`
    + (s0 ? `: user ${JSON.stringify(s0.user ?? null)} tags ${Object.keys(s0.tags ?? {}).join(',')} url ${s0.request?.url ?? '-'}` : ''));
  const traces = errs.map((e) => [e.event.contexts?.trace?.trace_id, e.dsc?.trace_id] as [string | undefined, string | undefined]);
  report(`${caseId}.E4`, co.same && !!co.staleTraceId && errs.length > 0 && traces.every(([t, d]) => !!t && t !== co.staleTraceId && d !== co.staleTraceId),
    `stale span trace ${String(co.staleTraceId).slice(0, 12)}; event/envelope trace ids ${traces.map(([t, d]) => `${String(t).slice(0, 12)}/${String(d).slice(0, 12)}`).join(' ') || '-'}`);
}

async function loadPool(): Promise<any> {
  if (process.env.PF_POOL_SOURCE_B64) installPoolSource(Buffer.from(process.env.PF_POOL_SOURCE_B64, 'base64').toString('utf8'));
  const pool: any = (await import('../src/db/pool')).pool;
  if (pool.options?.connectionString) refuse('the app pool carries a connection string.');
  if (pool.options?.ssl !== false) refuse(`the app pool was built with ssl ${JSON.stringify(pool.options?.ssl)}; NODE_ENV must not be production.`);
  // --tls: production's value, set before the first connect (pg-pool passes
  // its options object to every new Client).
  if (TLS) pool.options.ssl = { rejectUnauthorized: false };
  return pool;
}

async function childMain(caseId: string): Promise<void> {
  refuseUnlessLocal();
  installEmitClassifier();
  process.on('uncaughtExceptionMonitor', (err: any, origin) => {
    FATAL = true;
    safeWrite(2, `PF_UNCAUGHT ${JSON.stringify({ origin, name: err?.name, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 200) })}\n`);
  });
  if (SENTRY) initSentry();   // before anything requires pg
  const warnings: string[] = [];
  process.on('warning', (w) => { warnings.push(w.name); });
  const errorLines: string[] = [];
  const origError = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    errorLines.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' '));
    origError(...a);
  };
  const countLines = (prefix: string): number => errorLines.filter((l) => l.startsWith(prefix)).length;
  const db = process.env.PGDATABASE!;

  // ── instrument controls ─────────────────────────────────────────────────
  if (caseId === 'C0a') {
    const leak = await harnessClient(db, APP);
    await leak.query('BEGIN');
    await leak.query('SELECT 1');
    const during = await idleInTxn(db);
    await leak.query('ROLLBACK');
    const after = await idleInTxn(db);
    await leak.end();
    report('C0.1', during === 1 && after === 0, `deliberate leak read ${during}, after ROLLBACK ${after}`);
    const v = resolvedVersions();
    const want = PGSETS[PGSET];
    report('C0.4', !!want && v.pg === want.pg && v.pgPool === want.pgPool && v.pgProtocol === want.pgProtocol && v.samePg,
      `PF_PGSET=${PGSET}: pg ${v.pg}, pg-pool ${v.pgPool}, pg-protocol ${v.pgProtocol}, pg-connection-string ${v.pgcs} (${v.overlay ? 'apps/api overlay' : 'root node_modules'}); harness and pool.ts load the same pg ${v.samePg}`);
    return finish();
  }
  if (caseId === 'C0b') {
    const { Client } = pgLib();
    const raw = new Client({ application_name: VICTIM, ssl: false });  // NO 'error' listener, on purpose
    await raw.connect();
    const pid = Number((await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await askParent('terminate-pid', { pid });
    await sleep(2_000);                                     // the unhandled emit lands here
    return finish();
  }
  if (caseId === 'C0c') {
    setTimeout(() => { throw new Error('pf deliberate non-pg crash'); }, 10);
    await sleep(2_000);
    return finish();
  }
  if (caseId === 'C0d') {
    const pool = await loadPool();
    const c = await pool.connect();
    const pid = Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const h = await harnessClient(db);
    let rows: any[] = [];
    try {
      rows = (await h.query(`SELECT a.pid, s.ssl, s.version FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid
                              WHERE a.datname = current_database() AND a.application_name = $1`, [APP])).rows;
    } finally { await h.end(); }
    c.release();
    report('C0.5', rows.length >= 1 && rows.some((r) => Number(r.pid) === pid) && rows.every((r) => r.ssl === TLS),
      `app-pool backends ${rows.length}: ssl ${rows.map((r) => `${r.ssl}${r.version ? `/${r.version}` : ''}`).join(',')}; expected ssl=${TLS}`);
    const hasClient = !!Sentry.getClient();
    report('C0.6', hasClient === SENTRY, `Sentry client ${hasClient ? 'initialised' : 'absent'}; expected ${SENTRY ? 'initialised' : 'absent'}`);
    if (SENTRY) {
      const wrapped = !!(pgLib().Client.prototype.query as any).__wrapped;
      await Sentry.startSpan({ name: 'pf-control-txn' }, async () => { await pool.query('SELECT 1 AS pf_control'); });
      await Sentry.flush(3_000);
      const dbSpans = recordedTransactions().flatMap((t) => t.spans ?? []).filter((s: any) => s.data?.['db.system'] === 'postgresql');
      report('C0.7', wrapped && dbSpans.length >= 1,
        `pg Client.prototype.query wrapped ${wrapped}; postgresql spans in recorded transactions ${dbSpans.length} (${dbSpans.map((s: any) => s.description).slice(0, 2).join('; ')})`);
      Sentry.captureMessage('pf-control-message');
      const got = (await recordedEvents()).filter((e) => e.event.message === 'pf-control-message').length;
      report('C0.8', got === 1, `captureMessage reached the recording transport ${got} time(s)`);
    }
    await pool.end().catch(() => undefined);
    return finish();
  }

  // ── stubs, before any app module loads (the test-clock-out-session-closed.ts set) ──
  const sentryCalls: Array<{ tags: Record<string, unknown> }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureException: (_e: unknown, ctx?: { tags?: Record<string, unknown> }) => { sentryCalls.push({ tags: ctx?.tags ?? {} }); return 'evt'; },
      captureMessage: () => 'evt', addBreadcrumb: () => undefined, captureCheckIn: () => 'chk',
      withScope: (fn: (s: unknown) => void) => fn({ setTag: () => undefined, setExtra: () => undefined }),
    },
  });
  let actor: Record<string, unknown> = {};
  inject('../src/middleware/auth', {
    requireAuth: () => (req: any, _res: unknown, next: () => void) => { req.user = actor; next(); },
    secretForRole: () => 'test-only',
  });
  inject('../src/services/email', new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : async () => undefined),
  }));
  inject('../src/services/s3', refusingModule('s3'));
  inject('../src/services/firebase', { sendPushNotification: async () => undefined, buildExpoPushMessage: () => ({}) });
  inject('../src/services/photoValidation', { validatePhotoOrQuarantine: async () => ({ ok: true }) });
  // node-cron: capture tick callbacks instead of arming timers (the _run.test.ts stub).
  const ticks: Array<() => Promise<void>> = [];
  const fakeTask = { _task: { on: () => undefined }, on: () => undefined, stop: () => undefined, start: () => undefined };
  inject('node-cron', { __esModule: true, default: { schedule: (_e: string, fn: () => Promise<void>) => { ticks.push(fn); return fakeTask; } } });

  // ── S6 re-points the pool at a proxy BEFORE the pool connects ────────────
  const pairs: Array<[net.Socket, net.Socket]> = [];
  if (caseId === 'S6') {
    const upstream = Number(process.env.PF_REAL_PORT);
    const proxy = net.createServer((down) => {
      const up = net.connect(upstream, '127.0.0.1');
      const kill = () => { down.destroy(); up.destroy(); };
      down.on('error', kill);
      up.on('error', kill);
      down.pipe(up);
      up.pipe(down);
      pairs.push([down, up]);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    process.env.PGPORT = String((proxy.address() as net.AddressInfo).port);
  }

  const pool = await loadPool();
  const backendPid = async (c: any): Promise<number> => Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const nextCheckoutPid = async (): Promise<number> => { const c = await pool.connect(); try { return await backendPid(c); } finally { c.release(); } };
  const selectOne = async (): Promise<Settled> => settle(pool.query('SELECT 1 AS one'));
  const inPool = (c: unknown): boolean => (pool._clients as unknown[]).includes(c); // pg-pool internal; same in 3.13/3.14
  const pidAlive = async (pid: number): Promise<boolean> => {
    const h = await harnessClient(db);
    try { return (await h.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount! > 0; } finally { await h.end(); }
  };
  const waitActive = async (pid: number): Promise<void> => {
    const h = await harnessClient(db);
    try {
      for (let i = 0; i < 100; i += 1) {
        const r = await h.query(`SELECT state, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid]);
        if (r.rows[0]?.state === 'active') return;
        await sleep(30);
      }
    } finally { await h.end(); }
  };

  switch (caseId) {
    case 'S1': {
      const co = await staleCheckout(pool);
      const c = co.client;
      await c.query('BEGIN');
      await c.query('SELECT 1');
      const pid = await backendPid(c);
      Sentry.getIsolationScope().setTag('pf_marker', 'keep');   // M9 control: must survive the listener
      await askParent('terminate-pid', { pid });
      await sleep(SETTLE_MS);
      const next = await settle(c.query('SELECT 1'));
      report('S1.2', next.rejected, `next query on the held client: ${desc(next)}`);
      c.release();
      const np = await nextCheckoutPid();
      report('S1.3', !inPool(c) && np !== pid, `broken client in pool after release: ${inPool(c)}; next checkout pid ${np} vs ${pid}`);
      const one = await selectOne();
      report('S1.4', !one.rejected && !one.hung, `pool.query: ${desc(one)}`);
      const n = await idleInTxn(db);
      const alive = await pidAlive(pid);
      report('S1.5', n === 0 && !alive, `idle in transaction ${n}; terminated pid alive ${alive}`);
      const marker = Sentry.getIsolationScope().getScopeData().tags.pf_marker;
      report('S1.M', marker === 'keep', `isolation-scope marker tag after the listener ran: ${String(marker ?? 'GONE')} (Sentry ${SENTRY ? 'on' : 'off'}; '[pg.client_error]' x${countLines(CHECKED_OUT_LOG)})`);
      if (SENTRY) await eventChecks('S1', 1, ['57P01'], co);
      break;
    }
    case 'S2': {
      const co = await staleCheckout(pool);
      const c = co.client;
      await c.query('BEGIN');
      const pid = await backendPid(c);
      const inflight = settle(c.query('SELECT pg_sleep(30)'), 10_000);
      await waitActive(pid);
      await askParent('terminate-pid', { pid });
      const r = await inflight;
      await sleep(SETTLE_MS);
      report('S2.2', r.rejected && r.code === '57P01', `in-flight query: ${desc(r)}`);
      c.release();
      const np = await nextCheckoutPid();
      report('S2.3', !inPool(c) && np !== pid, `broken client in pool: ${inPool(c)}; next pid ${np} vs ${pid}`);
      const one = await selectOne();
      report('S2.4', !one.rejected && !one.hung, `pool.query: ${desc(one)}`);
      const n = await idleInTxn(db);
      report('S2.5', n === 0, `idle in transaction ${n}`);
      if (SENTRY) await eventChecks('S2', 1, ['none'], co);
      break;
    }
    case 'S3': {
      const pid = await nextCheckoutPid();              // one idle client; pool.query reuses it
      const q = settle(pool.query('SELECT pg_sleep(30)'), 10_000);
      await waitActive(pid);
      await askParent('terminate-pid', { pid });
      const r = await q;
      await sleep(SETTLE_MS);
      report('S3.2', r.rejected && r.code === '57P01', `pool.query in flight: ${desc(r)}`);
      const one = await selectOne();
      report('S3.3', !one.rejected && !one.hung, `next pool.query: ${desc(one)}`);
      break;
    }
    case 'S4': {
      const pid = await nextCheckoutPid();              // released: now idle in the pool
      const before = countLines(IDLE_LOG);
      const beforeCo = countLines(CHECKED_OUT_LOG);
      await askParent('terminate-pid', { pid });
      await sleep(SETTLE_MS);
      const logged = countLines(IDLE_LOG) - before;
      const co = countLines(CHECKED_OUT_LOG) - beforeCo;
      report('S4.2', logged === 1, `pool.on('error') logged "${IDLE_LOG}" ${logged} time(s)`);
      const np = await nextCheckoutPid();
      report('S4.3', np !== pid, `next checkout pid ${np} vs terminated ${pid}`);
      const one = await selectOne();
      report('S4.4', !one.rejected && !one.hung, `pool.query: ${desc(one)}`);
      report('S4.5', co === 0, `the checked-out listener fired for an IDLE client: '${CHECKED_OUT_LOG}' x${co}`);
      if (SENTRY) {
        const errs = (await recordedEvents()).filter((e) => e.event.type === undefined);
        report('S4.E1', errs.length === 0, `Sentry events for an idle client's error: ${errs.length} ${errs.map((e) => e.event.tags?.flow).join(',')}`);
      }
      break;
    }
    case 'S6': {
      const co = await staleCheckout(pool);
      const a = co.client;
      await a.query('BEGIN');
      await a.query('SELECT 1');
      const pid = await backendPid(a);
      report('S6.P', pairs.length === 1, `${pairs.length} proxied connection(s) about to be reset (TLS ${TLS})`);
      for (const [down, up] of pairs.splice(0)) { down.resetAndDestroy(); up.destroy(); }
      await sleep(SETTLE_MS);
      const next = await settle(a.query('SELECT 1'));
      report('S6.2', next.rejected, `next query on the held client: ${desc(next)}`);
      a.release();
      const np = await nextCheckoutPid();
      report('S6.3', !inPool(a) && np !== pid, `broken client in pool: ${inPool(a)}; next pid ${np} vs ${pid}`);
      const one = await selectOne();
      await sleep(SETTLE_MS);
      const alive = await pidAlive(pid);
      const n = await idleInTxn(db);
      report('S6.4', !one.rejected && !one.hung && !alive && n === 0, `pool.query ${desc(one)}; old backend alive ${alive}; idle in transaction ${n}`);
      if (SENTRY) await eventChecks('S6', 1, ['ECONNRESET'], co);
      break;
    }
    case 'S7': {
      const pids: number[] = [];
      const counts: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const c = await pool.connect();
        pids.push(await backendPid(c));
        counts.push(c.listenerCount('error'));
        c.release();
      }
      await sleep(50);
      report('S7.2', pids.every((p) => p === pids[0]), `12 sequential checkouts, distinct backends: ${new Set(pids).size}`);
      report('S7.3', counts[0] >= 1 && counts.every((n) => n === counts[0]), `'error' listeners while checked out: ${counts.join(',')}`);
      const mle = warnings.filter((w) => w === 'MaxListenersExceededWarning').length;
      report('S7.4', mle === 0, `MaxListenersExceededWarning x${mle}`);
      break;
    }
    case 'V10': {
      // The FATAL rejects the in-flight query WITHOUT an emit and leaves the
      // client _queryable; the holder's plain release() puts it back idle, and
      // the next pool.connect() gets it — all inside the tick processing that
      // follows the FATAL's socket read, i.e. before the socket's EOF read.
      // The EOF then emits under the SECOND holder, and rejects its query.
      const co = await staleCheckout(pool);
      const a = co.client;
      const pid = await backendPid(a);
      let first: Settled = { rejected: false, hung: true, code: null, message: 'not settled' };
      let atRelease = { queryable: null as boolean | null, ended: null as boolean | null };
      let second: any = null;
      let secondQuery: Promise<Settled> = Promise.resolve({ rejected: false, hung: true, code: null, message: 'not sent' });
      const reused = new Promise<void>((resolve) => {
        a.query('SELECT pg_sleep(30)').then(() => { first = { rejected: false, hung: false, code: null, message: 'resolved' }; resolve(); }, (e: any) => {
          first = { rejected: true, hung: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 120) };
          const s = a.connection?.stream;
          atRelease = { queryable: a._queryable === true, ended: !!(s?.readableEnded || s?.destroyed) };
          a.release();                                         // plain release: no error passed
          pool.connect().then((b: any) => {
            second = b;
            secondQuery = settle(b.query('SELECT 1'));
            resolve();
          }, () => resolve());
        });
      });
      await waitActive(pid);
      await askParent('terminate-pid', { pid });
      await Promise.race([reused, sleep(10_000)]);
      const r2 = await secondQuery;
      await sleep(SETTLE_MS);
      report('V10.2', atRelease.queryable === true && atRelease.ended === false && second === a,
        `at the plain release: queryable ${atRelease.queryable}, socket ended ${atRelease.ended}; next pool.connect() got the same client ${second === a}`);
      report('V10.3', first.rejected && first.code === '57P01' && r2.rejected,
        `holder's query: ${desc(first)}; second caller's query: ${desc(r2)}`);
      if (second) second.release();
      const np = await nextCheckoutPid();
      report('V10.4', !inPool(a) && np !== pid, `broken client in pool after the second release: ${inPool(a)}; next pid ${np} vs ${pid}`);
      const one = await selectOne();
      const n = await idleInTxn(db);
      report('V10.5', !one.rejected && !one.hung && n === 0, `pool.query ${desc(one)}; idle in transaction ${n}`);
      if (SENTRY) await eventChecks('V10', 1, ['none'], co);
      break;
    }
    case 'S8':
    case 'S9':
    case 'S10': {
      await routeOrCronCase(caseId, { pool, db, ticks, sentryCalls, errorLines, setActor: (a) => { actor = a; } });
      break;
    }
    case 'S5':
    case 'S5i': {
      const stopMode = caseId === 'S5' ? 'fast' : 'immediate';
      // A checked out in BEGIN (its socket opened in the stale context); B and
      // C idle, C released last so pool.query takes C (LIFO).
      const co = await staleCheckout(pool);
      const a = co.client;
      const b = await pool.connect();
      const c = await pool.connect();
      await a.query('BEGIN');
      await a.query('SELECT 1');
      const cPid = await backendPid(c);
      b.release();
      c.release();
      const before = countLines(IDLE_LOG);
      const inflight = settle(pool.query('SELECT pg_sleep(60)'), 30_000);
      await waitActive(cPid);
      await askParent('stop', { mode: stopMode });
      await sleep(SETTLE_MS);
      const outage = await settle(pool.query('SELECT 1'), 5_000);
      await askParent('start');
      const cr = await inflight;
      const aNext = await settle(a.query('SELECT 1'));
      a.release();
      let after: Settled = { rejected: true, hung: false, code: null, message: 'not tried' };
      for (let i = 0; i < 10; i += 1) { after = await selectOne(); if (!after.rejected && !after.hung) break; await sleep(500); }
      const idleLogged = countLines(IDLE_LOG) - before;
      report(`${caseId}.2`, cr.rejected, `pool.query in flight across the stop: ${desc(cr)}`);
      report(`${caseId}.3`, outage.rejected && !outage.hung, `pool.query during the outage: ${desc(outage)}`);
      report(`${caseId}.4`, idleLogged >= 1, `pool.on('error') logged the idle client(s) ${idleLogged} time(s)`);
      report(`${caseId}.5`, aNext.rejected && !inPool(a), `held client after restart: ${desc(aNext)}; still in pool ${inPool(a)}`);
      report(`${caseId}.6`, !after.rejected && !after.hung, `pool.query after restart: ${desc(after)}`);
      const n = await idleInTxn(db);
      report(`${caseId}.7`, n === 0, `idle in transaction after restart ${n}`);
      if (SENTRY) await eventChecks(caseId, stopMode === 'fast' ? 1 : 2, stopMode === 'fast' ? ['57P01'] : ['none'], co);
      break;
    }
    default:
      refuse(`unknown case ${caseId}`);
  }
  await pool.end().catch(() => undefined);
  return finish();
}

/** Counted on a connection of its own, filtered to the app pool's name. */
async function idleInTxn(db: string): Promise<number> {
  const h = await harnessClient(db);
  try {
    return Number((await h.query(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND state IN ('idle in transaction', 'idle in transaction (aborted)')`, [APP])).rows[0].n);
  } finally { await h.end(); }
}

interface RouteCtx {
  pool: any; db: string; ticks: Array<() => Promise<void>>;
  sentryCalls: Array<{ tags: Record<string, unknown> }>; errorLines: string[];
  setActor: (a: Record<string, unknown>) => void;
}
async function routeOrCronCase(caseId: string, ctx: RouteCtx): Promise<void> {
  const h = await harnessClient(ctx.db);
  const q = (sql: string, params: unknown[] = []) => h.query(sql, params);
  const marker = `pfce-${caseId}-${Date.now().toString(36)}`;
  const t0 = new Date((await q(`SELECT date_trunc('second', NOW()) AS t0`)).rows[0].t0).getTime();
  const at = (m: number) => new Date(t0 + m * MIN);
  const companyId = (await q(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker])).rows[0].id;
  const siteId = (await q(`INSERT INTO sites (company_id, name, address, timezone, contract_start)
    VALUES ($1, $2, 'addr', 'America/Los_Angeles', CURRENT_DATE - 30) RETURNING id`, [companyId, `${marker} site`])).rows[0].id;
  const guardId = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number)
    VALUES ($1, $2, $3, 'x', $4) RETURNING id`, [companyId, `${marker} g`, `${marker}@test.invalid`, `PF${caseId}`])).rows[0].id;
  await q(`INSERT INTO guard_devices (guard_id, push_token, last_seen_at) VALUES ($1, $2, NOW())`, [guardId, `ExponentPushToken[${marker}]`]);
  await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, CURRENT_DATE - 30)`, [guardId, siteId]);
  const mkShift = async (s: number, e: number, status: string): Promise<string> => (await q(
    `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id`, [guardId, siteId, at(s), at(e), status, at(60 * 24 * 1500)])).rows[0].id;
  const mkSession = async (shiftId: string, inM: number): Promise<string> => (await q(
    `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
     VALUES ($1, $2, $3, $4, '(0,0)') RETURNING id`, [shiftId, guardId, siteId, at(inM)])).rows[0].id;

  const lock = await harnessClient(ctx.db, LOCKER);
  const idle0 = async (label: string, id: string) => { const n = await idleInTxn(ctx.db); report(id, n === 0, `${label}: idle in transaction ${n}`); };

  if (caseId === 'S10') {
    // The sweep is global, so refuse only if a session the SWEEP would touch
    // already exists (its own predicate). S8's session in a crashed mode is
    // open but not overdue, so it does not stop S10 from running.
    const { autoCloseDueSql } = await import('../src/constants/autoCloseGrace');
    const overdue = Number((await q(`SELECT count(*) AS n FROM shift_sessions ss JOIN shifts s ON s.id = ss.shift_id
       WHERE ss.clocked_out_at IS NULL AND ${autoCloseDueSql('s.scheduled_end')} AND s.status IN ('active', 'scheduled')`)).rows[0].n);
    if (overdue !== 0) refuse(`${overdue} overdue open sessions already exist; the sweep is global — use a fresh database.`);
    const sh = await mkShift(-405, -45, 'active');
    const ss = await mkSession(sh, -400);
    await import('../src/jobs/autoCompleteShifts');
    const run: any = await import('../src/jobs/_run');
    const idx = run.registeredJobs().findIndex((j: any) => j.name === 'autoCompleteShifts');
    if (idx < 0 || ctx.ticks.length !== run.registeredJobs().length) refuse('could not map the autoCompleteShifts tick.');
    const tick = ctx.ticks[idx];
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM shift_sessions WHERE id = $1 FOR UPDATE', [ss]);
    const t = settle(tick(), 10_000);
    await askParent('terminate-lock-waiter');
    const tr = await t;
    await sleep(SETTLE_MS);
    report('S10.3', !tr.rejected && !tr.hung, `tick promise: ${desc(tr)}`);
    const logged = ctx.errorLines.some((l) => l.startsWith('[autoCompleteShifts] Error:'));
    const captured = ctx.sentryCalls.some((c) => c.tags.flow === 'auto_complete_shifts');
    report('S10.4', logged && captured, `job log line ${logged}; Sentry stub capture (flow tag) ${captured}`);
    const hb = (await q(`SELECT last_result FROM cron_heartbeats WHERE job_name = 'autoCompleteShifts'`)).rows[0];
    report('S10.5', !!hb, `heartbeat row after the failed tick: ${hb ? `last_result=${hb.last_result}` : 'none'}`);
    const stillOpen = (await q(`SELECT clocked_out_at FROM shift_sessions WHERE id = $1`, [ss])).rows[0].clocked_out_at === null;
    await lock.query('ROLLBACK');
    const t2 = await settle(tick(), 10_000);
    const row = (await q(`SELECT clocked_out_at, clock_out_reason FROM shift_sessions WHERE id = $1`, [ss])).rows[0];
    report('S10.6', stillOpen && !t2.rejected && row.clock_out_reason === 'auto',
      `open after the failed tick ${stillOpen}; next tick ${desc(t2)}; reason ${row.clock_out_reason}`);
    await idle0('S10', 'S10.7');
  } else {
    // Mirrors index.ts: express-async-errors first, env 'production' (Railway's
    // NODE_ENV) so finalhandler omits the stack — set on the app, not the
    // process, because pool.ts reads NODE_ENV for ssl.
    await import('express-async-errors');
    const express = (await import('express')).default;
    const router: any = (await import('../src/routes/shifts')).default;
    const app = express();
    app.set('env', 'production');
    app.use(express.json());
    app.get('/__alive', (_req: any, res: any) => res.json({ ok: true }));
    app.use('/api/shifts', router);
    const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = (server.address() as net.AddressInfo).port;
    const call = (method: string, p: string, body?: unknown) => httpCall(port, method, p, body);

    if (caseId === 'S8') {
      const sh = await mkShift(-120, 60, 'active');
      const ss = await mkSession(sh, -118);
      const body = { lat: 37.78, lng: -122.41, accuracy: 10 };
      ctx.setActor({ sub: guardId, role: 'guard', company_id: companyId });
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM shift_sessions WHERE id = $1 FOR UPDATE', [ss]);
      const pending = settle(call('POST', `/api/shifts/${sh}/clock-out`, body), 10_000);
      await askParent('terminate-lock-waiter');
      const r = await pending;
      await sleep(SETTLE_MS);
      const alive = await settle(call('GET', '/__alive'));
      const w = r.value as HttpOut | undefined;
      report('S8.3', w?.status === 500 && alive.value?.status === 200, `clock-out answered ${w?.status ?? desc(r)} (${w?.contentType ?? ''}); /__alive ${alive.value?.status ?? desc(alive)}`);
      report('S8.4', !!w && !DRIVER_ON_WIRE.test(w.body), `body on the wire: ${JSON.stringify(w?.body?.slice(0, 120))}`);
      const unchanged = (await q(`SELECT clocked_out_at FROM shift_sessions WHERE id = $1`, [ss])).rows[0].clocked_out_at === null;
      await lock.query('ROLLBACK');
      const retry = await call('POST', `/api/shifts/${sh}/clock-out`, body);
      const closed = (await q(`SELECT clocked_out_at FROM shift_sessions WHERE id = $1`, [ss])).rows[0].clocked_out_at !== null;
      report('S8.5', unchanged && retry.status === 200 && closed, `session untouched by the failed call ${unchanged}; retry ${retry.status}; closed ${closed}`);
      await idle0('S8', 'S8.6');
    } else {
      const sh = await mkShift(24 * 60, 24 * 60 + 480, 'scheduled');
      ctx.setActor({ sub: (await q(`SELECT gen_random_uuid() AS id`)).rows[0].id, role: 'company_admin', company_id: companyId });
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [sh]);
      const pending = settle(call('PATCH', `/api/shifts/${sh}/cancel`, { reason: 'pf test' }), 10_000);
      await askParent('terminate-lock-waiter');
      const r = await pending;
      await sleep(SETTLE_MS);
      const w = r.value as HttpOut | undefined;
      let wire = '';
      try { wire = JSON.stringify(JSON.parse(w?.body ?? '')); } catch { wire = `(not JSON) ${w?.body?.slice(0, 80)}`; }
      report('S9.3', w?.status === 500 && wire === '{"error":"Failed to cancel shift"}', `cancel answered ${w?.status ?? desc(r)} ${wire}`);
      const statusBefore = (await q(`SELECT status FROM shifts WHERE id = $1`, [sh])).rows[0].status;
      await lock.query('ROLLBACK');
      const retry = await call('PATCH', `/api/shifts/${sh}/cancel`, { reason: 'pf test' });
      const statusAfter = (await q(`SELECT status FROM shifts WHERE id = $1`, [sh])).rows[0].status;
      report('S9.4', statusBefore === 'scheduled' && retry.status === 200 && statusAfter === 'cancelled',
        `status after the failed call ${statusBefore}; retry ${retry.status}; status ${statusAfter}`);
      await sleep(300);   // the route's post-response notification + push is unawaited
      await idle0('S9', 'S9.5');
    }
    server.close();
  }
  await lock.end().catch(() => undefined);
  // Fixtures stay: the database is dropped with the mode.
  await h.end().catch(() => undefined);
}

interface HttpOut { status: number; body: string; contentType: string }
function httpCall(port: number, method: string, p: string, body?: unknown): Promise<HttpOut> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), contentType: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PARENT
// ════════════════════════════════════════════════════════════════════════════
const execFileP = promisify(execFile);
interface RunEnv { db: string; maintDb: string; poolSourceB64?: string; mode: string }
interface CaseOutcome { verdict: Verdict; checks: Map<string, CheckResult>; stderr: string }
interface Restart { pgctl: string; pgdata: string }

function restartPrereqs(): Restart {
  const pgdata = process.env.PF_PGDATA;
  const pgctl = process.env.PF_PGCTL;
  if (!pgdata || !pgctl || !existsSync(pgctl)) refuse('PF_PGDATA and PF_PGCTL are required (S5/S5i stop and restart the cluster).');
  const real = realpathSync(pgdata);
  if (!real.startsWith('/private/tmp/')) refuse(`PF_PGDATA must be under /private/tmp (got ${real}).`);
  if (!existsSync(path.join(real, 'NETRAOPS_THROWAWAY'))) refuse('PF_PGDATA has no NETRAOPS_THROWAWAY marker file.');
  const pidLines = readFileSync(path.join(real, 'postmaster.pid'), 'utf8').split('\n');
  if (pidLines[3]?.trim() !== process.env.PGPORT) refuse(`postmaster.pid names port ${pidLines[3]?.trim()}, not PGPORT ${process.env.PGPORT}.`);
  return { pgctl, pgdata: real };
}

async function terminateAndWait(db: string, pid: number): Promise<{ ok: boolean; gone: boolean }> {
  const h = await harnessClient(db);
  try {
    const ok = (await h.query('SELECT pg_terminate_backend($1) AS ok', [pid])).rows[0].ok === true;
    let gone = false;
    for (let i = 0; i < 60 && !gone; i += 1) {
      gone = (await h.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount === 0;
      if (!gone) await sleep(50);
    }
    return { ok, gone };
  } finally { await h.end(); }
}

/** Find `KEY {json}` anywhere in a line: async console output can share a line. */
function tagged<T>(text: string, key: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(`${key} `);
    if (i < 0) continue;
    try { out.push(JSON.parse(line.slice(i + key.length + 1)) as T); } catch { /* torn line: ignored, and a missing check FAILS */ }
  }
  return out;
}

async function runCase(def: CaseDef, env: RunEnv, rp: Restart): Promise<CaseOutcome> {
  const checks = new Map<string, CheckResult>();
  const set = (id: string, pass: boolean, detail: string) => checks.set(id, { id, pass, detail });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env, PGDATABASE: env.db, PGAPPNAME: APP, PF_REAL_PORT: process.env.PGPORT,
    TS_NODE_TRANSPILE_ONLY: '1', DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
    PF_SENTRY: SENTRY ? '1' : '0', PF_TLS: TLS ? '1' : '0', PF_PGSET: PGSET,
  };
  delete childEnv.DATABASE_URL;
  delete childEnv.PGSSLMODE;
  if (env.poolSourceB64) childEnv.PF_POOL_SOURCE_B64 = env.poolSourceB64; else delete childEnv.PF_POOL_SOURCE_B64;

  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--child', def.id],
    { cwd: API_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.on('error', () => undefined);   // a send() to a child that just died must not crash the parent
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr!.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  let startBefore: number | null = null;
  let refusedDuringOutage = false;
  let serverStopped = false;
  /** Restart + <case>.P, whether the child asked for it or died while the server was down. */
  const startAndCheck = async (): Promise<void> => {
    await execFileP(rp.pgctl, ['start', '-D', rp.pgdata, '-l', path.join(rp.pgdata, 'pf-restart.log'), '-w', '-t', '60'], { timeout: 70_000 });
    serverStopped = false;
    const h = await harnessClient(env.maintDb);
    const after = new Date((await h.query('SELECT pg_postmaster_start_time() AS t')).rows[0].t).getTime();
    await h.end();
    const advanced = startBefore !== null && after > startBefore;
    set(`${def.id}.P`, refusedDuringOutage && advanced, `connect refused during the outage ${refusedDuringOutage}; postmaster start time advanced ${advanced}`);
  };

  // Serialised, and awaited after exit: a fault the parent is still injecting
  // when the child dies must still record its .P check.
  let chain: Promise<void> = Promise.resolve();
  child.on('message', (m: any) => { chain = chain.then(() => handleFault(m)); });
  const handleFault = async (m: any): Promise<void> => {
    let reply: Record<string, unknown> = { ok: false };
    try {
      if (m.kind === 'terminate-pid') {
        const r = await terminateAndWait(env.db, Number(m.pid));
        set(`${def.id}.P`, r.ok && r.gone, `pg_terminate_backend(${m.pid}) ${r.ok}; gone ${r.gone}`);
        reply = { ok: r.ok };
      } else if (m.kind === 'terminate-lock-waiter') {
        const h = await harnessClient(env.db);
        let pids: number[] = [];
        try {
          for (let i = 0; i < 100 && pids.length === 0; i += 1) {
            pids = (await h.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                                     AND application_name = $1 AND wait_event_type = 'Lock'`, [APP])).rows.map((r) => Number(r.pid));
            if (pids.length === 0) await sleep(50);
          }
        } finally { await h.end(); }
        const r = pids.length === 1 ? await terminateAndWait(env.db, pids[0]) : { ok: false, gone: false };
        set(`${def.id}.P`, pids.length === 1 && r.ok && r.gone, `app backends waiting on the lock: ${pids.length}; terminated ${r.ok}; gone ${r.gone}`);
        reply = { ok: r.ok };
      } else if (m.kind === 'stop') {
        const h = await harnessClient(env.maintDb);
        const dd = realpathSync((await h.query('SHOW data_directory')).rows[0].data_directory);
        startBefore = new Date((await h.query('SELECT pg_postmaster_start_time() AS t')).rows[0].t).getTime();
        await h.end();
        if (dd !== rp.pgdata) { child.kill('SIGKILL'); refuse(`refusing to stop: the server on PGPORT runs ${dd}, not ${rp.pgdata}.`); }
        const mode = m.mode === 'immediate' ? 'immediate' : 'fast';
        serverStopped = true;
        await execFileP(rp.pgctl, ['stop', '-D', rp.pgdata, '-m', mode, '-w', '-t', '30'], { timeout: 40_000 });
        refusedDuringOutage = await harnessClient(env.maintDb).then(async (c) => { await c.end(); return false; }, () => true);
        reply = { ok: true };
      } else if (m.kind === 'start') {
        await startAndCheck();
        reply = { ok: true };
      }
    } catch (e: any) {
      reply = { ok: false, error: String(e?.message ?? e).slice(0, 160) };
    }
    try { if (child.connected) child.send({ seq: m.seq, ...reply }); } catch { /* child gone */ }
  };

  const exit = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'SIGKILL', timedOut: true }); }, def.timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
  });
  await chain;
  // The child died between stop and start: the cluster must come back for the
  // next case, and <case>.P is still evaluated.
  if (serverStopped) await startAndCheck();
  await sleep(20);   // drain the last pipe chunks

  for (const r of tagged<CheckResult>(stdout, 'PF_CHECK')) if (!checks.has(r.id) || !r.id.endsWith('.P') || def.id === 'S6') checks.set(r.id, r);
  const done = /(^|\n|[^A-Z_])PF_DONE\n/.test(stdout);
  const uncaught = tagged<Uncaught>(stderr, 'PF_UNCAUGHT')[0];
  const emits = tagged<EmitRec>(stderr, 'PF_UNHANDLED_EMIT');
  const pgEmit = emits.find((e) => (e.on === 'Client' || e.on === 'BoundPool')
    && (PG_CODES.has(String(e.code)) || PG_MESSAGES.some((msg) => String(e.message).includes(msg))));
  let verdict: Verdict;
  if (exit.timedOut) verdict = 'HUNG';
  else if (exit.code === 0 && done && !uncaught) verdict = 'SURVIVED';
  else if (pgEmit && uncaught?.origin === 'uncaughtException' && uncaught.message === pgEmit.message) verdict = 'PG_UNHANDLED_ERROR';
  else verdict = 'OTHER';
  const how = `${verdict}${pgEmit ? ` (unhandled 'error' on ${pgEmit.on}: ${pgEmit.code ?? ''} ${String(pgEmit.message).slice(0, 60)})` : uncaught ? ` (${uncaught.code ?? ''} ${String(uncaught.message).slice(0, 60)})` : ''}; exit ${exit.code ?? exit.signal}`;
  if (def.id === 'C0b') set('C0.2', verdict === 'PG_UNHANDLED_ERROR' && exit.code !== 0 && checks.get('C0b.P')?.pass === true, `raw client death classified ${how}`);
  else if (def.id === 'C0c') set('C0.3', verdict === 'OTHER' && exit.code !== 0 && exit.code !== null, `plain throw classified ${how}`);
  else if (!def.id.startsWith('C0')) set(`${def.id}.1`, verdict === 'SURVIVED', `child ${how}`);
  for (const id of def.checks) if (!checks.has(id)) set(id, false, `not reached: child ${how}`);
  const logDir = process.env.PF_LOG_DIR;
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, `${env.mode}-${def.id}.out`), stdout);
    writeFileSync(path.join(logDir, `${env.mode}-${def.id}.err`), stderr);
  }
  return { verdict, checks, stderr };
}

async function runMode(mode: string, maintDb: string, rp: Restart): Promise<Map<string, CheckResult>> {
  let poolSourceB64: string | undefined;
  const branchPool = readFileSync(path.join(API_DIR, 'src/db/pool.ts'), 'utf8');
  if (mode === 'main') {
    poolSourceB64 = Buffer.from(git('show', 'origin/main:apps/api/src/db/pool.ts'), 'utf8').toString('base64');
  } else if (MUTATIONS[mode]) {
    let src = branchPool;
    for (const [from, to] of MUTATIONS[mode].edits) {
      const n = src.split(from).length - 1;
      if (n !== 1) refuse(`mutation ${mode}: expected exactly 1 ${JSON.stringify(from)} in src/db/pool.ts, found ${n}; the fix changed shape, update the spec.`);
      src = src.replace(from, to);
    }
    poolSourceB64 = Buffer.from(src, 'utf8').toString('base64');
  } else if (mode !== 'fix') refuse(`unknown mode ${mode}`);

  const template = process.env.PF_TEMPLATE;
  if (!template) refuse('PF_TEMPLATE (a migrated, empty template database) is required.');
  const db = `pfce_${mode.toLowerCase()}_${Date.now().toString(36)}`;
  const m = await harnessClient(maintDb);
  await m.query(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
  await m.end();
  const d = await harnessClient(db);
  const companies = Number((await d.query('SELECT count(*) AS n FROM companies')).rows[0].n);
  await d.end();
  if (companies !== 0) refuse(`template ${template} holds ${companies} companies; it must be a fresh migrated copy.`);

  const only = argVal('--only')?.split(',');
  const results = new Map<string, CheckResult>();
  const deaths: string[] = [];
  console.log(`\n══ mode ${mode}${MUTATIONS[mode] ? ` — ${MUTATIONS[mode].what}` : mode === 'main' ? " — origin/main's pool.ts" : ''} (db ${db})`);
  for (const def of caseTable(SENTRY)) {
    if (only && !only.includes(def.id)) continue;
    const o = await runCase(def, { db, maintDb, poolSourceB64, mode }, rp);
    if (o.verdict !== 'SURVIVED' && def.id !== 'C0b' && def.id !== 'C0c') deaths.push(`${def.id}:${o.verdict}`);
    console.log(`── ${def.id} ${def.title}`);
    for (const id of def.checks) {
      const r = o.checks.get(id)!;
      results.set(id, r);
      console.log(`  ${r.pass ? '✓' : '✗ FAIL:'} ${id} ${r.detail}`);
    }
    if (hasFlag('--verbose') && o.verdict !== 'SURVIVED') console.log(o.stderr.split('\n').slice(0, 30).map((l) => `      | ${l}`).join('\n'));
  }
  const g1 = deaths.every((x) => x.endsWith(':PG_UNHANDLED_ERROR'));
  results.set('G1', { id: 'G1', pass: g1, detail: `child deaths: ${deaths.length ? deaths.join(', ') : 'none'} (every death must be PG_UNHANDLED_ERROR)` });
  const h = await harnessClient(maintDb);
  if (!hasFlag('--keep')) await h.query(`DROP DATABASE "${db}" WITH (FORCE)`);
  await h.end();
  for (const id of GLOBAL_CHECKS) { const r = results.get(id)!; console.log(`  ${r.pass ? '✓' : '✗ FAIL:'} ${id} ${r.detail}`); }
  return results;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

/** main swaps only pool.ts, so nothing else under apps/api/src may differ from
 *  origin/main: checked on the worktree (tracked + untracked) AND on the tree
 *  this process actually runs (blob ids against origin/main's tree). */
function srcDiffPrecondition(): void {
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const worktree = [...new Set([
    ...lines(git('diff', '--name-only', 'origin/main', '--', 'apps/api/src')),
    ...lines(git('ls-files', '--others', '--exclude-standard', '--', 'apps/api/src')),
  ])].sort();
  const mainBlobs = new Map<string, string>();
  for (const l of lines(git('ls-tree', '-r', 'origin/main', '--', 'apps/api/src'))) {
    const [meta, p] = l.split('\t');
    mainBlobs.set(p, meta.split(' ')[2]);
  }
  const srcDir = path.join(API_DIR, 'src');
  const runBlobs = new Map<string, string>();
  for (const f of walkFiles(srcDir)) runBlobs.set(`apps/api/src/${path.relative(srcDir, f).split(path.sep).join('/')}`, gitBlob(readFileSync(f)));
  const run = [...new Set([...mainBlobs.keys(), ...runBlobs.keys()])].filter((p) => mainBlobs.get(p) !== runBlobs.get(p)).sort();
  console.log(`src vs origin/main — worktree ${SRC_REPO}: ${worktree.join(', ') || 'nothing'}; tree run here: ${run.join(', ') || 'nothing'}`);
  const want = 'apps/api/src/db/pool.ts';
  if (worktree.join(',') !== want || run.join(',') !== want) {
    refuse(`mode main swaps only pool.ts, but apps/api/src differs from origin/main in: worktree [${worktree.join(', ')}], run tree [${run.join(', ')}].`);
  }
}

async function parentMain(): Promise<void> {
  const cfgLine = `pgset=${PGSET || '?'} tls=${TLS ? 'on' : 'off'} sentry=${SENTRY ? 'on' : 'off'} node=${process.version}`;
  const requested = hasFlag('--matrix') && !argVal('--modes') && !argVal('--mode')
    ? ALL_MODES.filter((m) => MUTATIONS[m]?.sentry === undefined || MUTATIONS[m].sentry === SENTRY)
    : (argVal('--modes') ?? argVal('--mode') ?? 'fix').split(',').map((s) => s.trim()).filter(Boolean);
  for (const mode of requested) {
    if (!ALL_MODES.includes(mode)) refuse(`unknown mode ${mode}`);
    const s = MUTATIONS[mode]?.sentry;
    if (s !== undefined && s !== SENTRY) refuse(`mode ${mode} only changes behaviour with Sentry ${s ? 'ON (--sentry)' : 'OFF'}; it would be a vacuous control here.`);
  }
  if (hasFlag('--predict')) {
    console.log(`PREDICTED failing sets (${cfgLine}); checks per mode ${caseTable(SENTRY).reduce((n, c) => n + c.checks.length, 0) + GLOBAL_CHECKS.length}`);
    for (const mode of requested) console.log(`PREDICT ${mode.padEnd(4)} fails ${predicted(mode, SENTRY).length}: ${predicted(mode, SENTRY).join(',') || '-'}`);
    return;
  }
  if (!PGSETS[PGSET]) refuse('PF_PGSET must be lock or prod (the driver set C0.4 asserts).');
  refuseUnlessLocal();
  const rp = restartPrereqs();
  const maintDb = process.env.PGDATABASE ?? 'postgres';
  const h = await harnessClient(maintDb);
  const dataDir = realpathSync((await h.query('SHOW data_directory')).rows[0].data_directory);
  const serverVersion = (await h.query('SHOW server_version')).rows[0].server_version;
  const sslSetting = (await h.query('SHOW ssl')).rows[0].ssl;
  await h.end();
  if (dataDir !== rp.pgdata) refuse(`the server on PGPORT runs ${dataDir}, not PF_PGDATA ${rp.pgdata}.`);
  if (TLS && sslSetting !== 'on') refuse('--tls needs a cluster with ssl = on.');
  const v = resolvedVersions();
  const branchBlob = gitBlob(readFileSync(path.join(API_DIR, 'src/db/pool.ts')));
  let mainBlob = '(unknown)';
  let worktreeBlob = '(unknown)';
  try { mainBlob = git('rev-parse', 'origin/main:apps/api/src/db/pool.ts').trim(); } catch { /* printed as unknown */ }
  try { worktreeBlob = gitBlob(readFileSync(path.join(SRC_REPO, 'apps/api/src/db/pool.ts'))); } catch { /* printed as unknown */ }
  console.log(`config ${cfgLine}; server ${serverVersion} ssl=${sslSetting}`);
  console.log(`resolved: pg ${v.pg}, pg-pool ${v.pgPool}, pg-protocol ${v.pgProtocol}, pg-connection-string ${v.pgcs}, @sentry/node ${v.sentry}`);
  for (const [k, f] of Object.entries(v.files)) console.log(`  ${k}: ${f}`);
  console.log(`src/db/pool.ts blob (tree run here) ${branchBlob}; worktree ${worktreeBlob}; origin/main ${mainBlob}`);
  if (hasFlag('--matrix') || requested.includes('main')) srcDiffPrecondition();

  const summary: string[] = [];
  let ok = true;
  for (const mode of requested) {
    const t0 = Date.now();
    const r = await runMode(mode, maintDb, rp);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const failed = [...r.values()].filter((x) => !x.pass).map((x) => x.id).sort();
    const passed = r.size - failed.length;
    const expected = [...predicted(mode, SENTRY)].sort();
    const exact = !argVal('--only') ? failed.join(',') === expected.join(',') : true;
    if (hasFlag('--matrix') ? !exact : failed.length > 0) ok = false;
    const extra = failed.filter((x) => !expected.includes(x));
    const missing = expected.filter((x) => !failed.includes(x));
    summary.push(`SUMMARY ${mode.padEnd(4)} pass ${passed} fail ${failed.length} (predicted fail ${expected.length}) ${secs}s  `
      + `${exact ? 'AS PREDICTED' : `NOT AS PREDICTED; unexpected fails ${extra.join(',') || '-'}; predicted but passed ${missing.join(',') || '-'}`}`
      + `\nSUMMARY ${mode.padEnd(4)} failing: ${failed.join(',') || '-'}`);
  }
  console.log(`\nSUMMARY config ${cfgLine}\n${summary.join('\n')}\nSUMMARY RESULT ${ok ? 'OK' : 'NOT OK'}${hasFlag('--matrix') ? ' (matrix: every mode must fail exactly its predicted set)' : ''}`);
  process.exit(ok ? 0 : 1);
}

const childCase = argVal('--child');
(childCase ? childMain(childCase) : parentMain()).catch((err) => { console.error(err); process.exit(1); });
