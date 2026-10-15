/**
 * test-n169-process-handlers.ts — what the API does with an error that escapes everything (N169, Vishnu's 5a).
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-n169-process-handlers.ts     (from apps/api)
 *
 * No database. Every case runs in a child process that loads the real modules from src/ (or BASE's, or a mutant),
 * reporting to a stand-in for Sentry's ingest on 127.0.0.1. Never Sentry itself: the child's environment is built
 * here from nothing, it runs in an empty directory, and dotenv is pointed at an empty file.
 *
 *   X  an uncaught exception, on a later tick: one log line, ONE fatal event, which reaches the ingest before the
 *      process exits, then exit 1 within FLUSH_MS + 1 s
 *   R  two unhandled rejections, an Error and a string: one log line and ONE error event each, no warning from
 *      Sentry, and the process carries on (an HTTP server it started still answers)
 *   E  the events group with production's: level, mechanism, exception and extra match what Sentry's own handlers
 *      sent at BASE, which logged no "[process]" line (the controls)
 *   D  without a DSN, as locally: the same lines and the same exits; at BASE a rejection ended the process
 *   B  index.ts itself: its boot error (no ALLOWED_ORIGINS), thrown after every import, is logged, reported fatal
 *      and exits 1, so the handlers are in place before the rest of the API loads
 *   S  the source: index.ts is BASE's plus the import, second; sentry.ts is BASE's plus the integrations filter;
 *      one listener for each event, and neither is Sentry's
 *   M  mutation controls: Sentry's defaults left in (its handlers beside ours: the string reported twice, its
 *      warning printed); no flush before the exit; exit 0; a rejection that ends the process; index.ts without
 *      the import
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/** main before N169 (PR #125's merge). */
const BASE = '2324b59264babddc783c7ead8b798a3db17f7121';
const API = path.join(__dirname, '..');
const FLUSH_MS = 2000;
const THROWN = 'n169 probe: thrown on a later tick';
const REJECTED = 'n169 probe: rejected, and nothing handles it';
const REJECTED_TEXT = 'n169 probe: a string, not an Error';
/** The first line of the warning Sentry's own rejection handler prints (mode 'warn'). */
const SENTRY_WARNING = 'This error originated either by throwing inside of an async function';
const BOOT = 'ALLOWED_ORIGINS is required';
const EXIT_LINE = '[process] uncaught exception; exiting';
const GO_ON_LINE = '[process] unhandled rejection; continuing';

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const read = (rel: string) => fs.readFileSync(path.join(API, rel), 'utf8');
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { cwd: API, encoding: 'utf8' });
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}`);
  return s.replace(from, to);
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

/** The child: a .ts loader (overrides first), then one scenario. Plain JS, so nothing compiles it but Node. */
const HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const API = process.env.N169_API;
const ts = require(require.resolve('typescript', { paths: [API] }));
const overrides = JSON.parse(fs.readFileSync(process.env.N169_OVERRIDES, 'utf8'));
require.extensions['.ts'] = function (m, filename) {
  const src = Object.prototype.hasOwnProperty.call(overrides, filename) ? overrides[filename] : fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(src, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true } }).outputText;
  m._compile(out, filename);
};
const say = (s) => process.stdout.write('N169 ' + s + '\\n');
const scenario = process.argv[2];
const modules = (process.argv[3] || '').split(',').filter(Boolean);
const load = (rel) => require(path.join(API, rel));
if (scenario === 'boot') {
  load('src/index.ts');
  say('BOOTED');
} else {
  const sentry = load('src/services/sentry.ts');
  for (const m of modules) load('src/services/' + m + '.ts');
  const ue = process.listeners('uncaughtException');
  const ur = process.listeners('unhandledRejection');
  const theirs = ue.filter((l) => l._errorHandler === true).length + ur.filter((l) => l.name === 'sendUnhandledPromise').length;
  say('listeners uncaughtException=' + ue.length + ' unhandledRejection=' + ur.length + ' sentry=' + theirs);
  if (scenario === 'throw') {
    setTimeout(() => { say('THROWING ' + Date.now()); throw new Error(${JSON.stringify(THROWN)}); }, 50);
    setTimeout(() => say('STILL-RUNNING'), 6000);
  } else if (scenario === 'reject') {
    const http = require('http');
    const server = http.createServer((q, r) => r.end('alive')).listen(0, '127.0.0.1', () => {
      Promise.reject(new Error(${JSON.stringify(REJECTED)}));
      Promise.reject(${JSON.stringify(REJECTED_TEXT)});
      setTimeout(() => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            say('server answered ' + b);
            server.close();
            sentry.Sentry.flush(2000).then(() => { say('DONE'); process.exit(0); });
          });
        });
      }, 300);
    });
  }
}
`;

interface SentryEvent {
  level?: string;
  extra?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string; mechanism?: { type?: string; handled?: boolean } }> };
}
interface Result {
  name: string;
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
  events: SentryEvent[];
  closedAt: number;
  envelopeErrors: number;
}
interface Case {
  name: string;
  scenario: 'throw' | 'reject' | 'boot';
  /** Modules loaded after services/sentry, as index.ts loads them. */
  modules?: string[];
  dsn: boolean;
  /** src-relative path → source, instead of the file on disk. */
  overrides?: Record<string, string>;
}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n169-'));
  const events = new Map<string, SentryEvent[]>();
  let envelopeErrors = 0;
  const ingest = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
        const project = /^\/api\/([^/]+)\/envelope\//.exec(req.url ?? '')?.[1] ?? '?';
        const lines = body.toString('utf8').split('\n').filter((l) => l.length > 0);
        for (let i = 1; i + 1 < lines.length; i += 2) {
          const header = JSON.parse(lines[i]) as { type?: string };
          if (header.type !== 'event') continue;
          const list = events.get(project) ?? [];
          list.push(JSON.parse(lines[i + 1]) as SentryEvent);
          events.set(project, list);
        }
      } catch {
        envelopeErrors += 1;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', () => resolve()));
  const port = (ingest.address() as AddressInfo).port;
  fs.writeFileSync(path.join(tmp, 'harness.js'), HARNESS);
  fs.writeFileSync(path.join(tmp, 'empty.env'), '');

  let project = 0;
  async function run(c: Case): Promise<Result> {
    project += 1;
    const id = String(project);
    const overridesFile = path.join(tmp, `overrides-${id}.json`);
    const abs: Record<string, string> = {};
    for (const [rel, src] of Object.entries(c.overrides ?? {})) abs[path.join(API, rel)] = src;
    fs.writeFileSync(overridesFile, JSON.stringify(abs));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      TZ: 'UTC',
      N169_API: API,
      N169_OVERRIDES: overridesFile,
      DOTENV_CONFIG_PATH: path.join(tmp, 'empty.env'),
      SENTRY_DSN: c.dsn ? `http://n169key@127.0.0.1:${port}/${id}` : '',
      SENTRY_ENV: 'n169-test',
      // Only the boot case loads the database module, and nothing in it may reach a database: port 9 refuses.
      PGHOST: '127.0.0.1',
      PGPORT: '9',
      PGDATABASE: 'n169_nothing_test',
      PGUSER: 'n169',
      SENDGRID_API_KEY: 'SG.stub',
      SENDGRID_FROM_EMAIL: 'alerts@example.invalid',
    };
    const child = spawn(process.execPath, [path.join(tmp, 'harness.js'), c.scenario, (c.modules ?? []).join(',')],
      { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
      child.on('close', (cd: number | null, sg: string | null) => resolve([cd, sg])));
    clearTimeout(killer);
    return { name: c.name, code, signal, out, err, events: events.get(id) ?? [], closedAt: Date.now(), envelopeErrors };
  }

  const ev0 = (r: Result) => r.events[0]?.exception?.values?.[0];
  const listenersOk = (r: Result) => r.out.includes('N169 listeners uncaughtException=1 unhandledRejection=1 sentry=0');
  /** Every way an uncaught-exception case can be wrong; [] when it is right. */
  function throwFaults(r: Result, dsn: boolean): string[] {
    const f: string[] = [];
    if (r.code !== 1 || r.signal !== null) f.push(`exit ${r.code} ${r.signal ?? ''}`.trim());
    if (r.out.includes('STILL-RUNNING')) f.push('it kept running');
    if (count(r.err, EXIT_LINE) !== 1) f.push(`${count(r.err, EXIT_LINE)} "${EXIT_LINE}" lines`);
    if (!r.err.includes(THROWN)) f.push('the log has no stack');
    if (!listenersOk(r)) f.push(`listeners: ${/N169 listeners [^\n]*/.exec(r.out)?.[0] ?? 'none'}`);
    const thrownAt = Number(/N169 THROWING (\d+)/.exec(r.out)?.[1] ?? NaN);
    if (!(r.closedAt - thrownAt < FLUSH_MS + 1000)) f.push(`exited ${r.closedAt - thrownAt} ms after the throw`);
    if (dsn) {
      if (r.events.length !== 1) f.push(`${r.events.length} events`);
      const e = ev0(r);
      if (r.events[0]?.level !== 'fatal') f.push(`level ${r.events[0]?.level}`);
      if (e?.value !== THROWN || e?.type !== 'Error') f.push(`exception ${e?.type}: ${e?.value}`);
      if (e?.mechanism?.type !== 'onuncaughtexception' || e?.mechanism?.handled !== false) f.push(`mechanism ${JSON.stringify(e?.mechanism)}`);
    } else if (r.events.length !== 0) f.push(`${r.events.length} events with no DSN`);
    return f;
  }
  /** The rejection events, the Error's first. */
  const byValue = (r: Result) => [...r.events].sort((x, y) =>
    (x.exception?.values?.[0]?.value === REJECTED ? 0 : 1) - (y.exception?.values?.[0]?.value === REJECTED ? 0 : 1));
  function rejectFaults(r: Result, dsn: boolean): string[] {
    const f: string[] = [];
    if (!r.out.includes('N169 server answered alive') || !r.out.includes('N169 DONE')) f.push('it did not carry on');
    if (r.code !== 0 || r.signal !== null) f.push(`exit ${r.code} ${r.signal ?? ''}`.trim());
    if (count(r.err, GO_ON_LINE) !== 2) f.push(`${count(r.err, GO_ON_LINE)} "${GO_ON_LINE}" lines`);
    if (!r.err.includes(REJECTED) || !r.err.includes(REJECTED_TEXT)) f.push('the log lacks a reason');
    if (r.err.includes(SENTRY_WARNING)) f.push("Sentry's own warning was printed too");
    if (!listenersOk(r)) f.push(`listeners: ${/N169 listeners [^\n]*/.exec(r.out)?.[0] ?? 'none'}`);
    if (dsn) {
      if (r.events.length !== 2) f.push(`${r.events.length} events`);
      byValue(r).forEach((ev, i) => {
        const e = ev.exception?.values?.[0];
        const want = i === 0 ? REJECTED : REJECTED_TEXT;
        if (ev.level !== 'error') f.push(`level ${ev.level}`);
        if (e?.value !== want || e?.type !== 'Error') f.push(`exception ${e?.type}: ${e?.value}`);
        if (e?.mechanism?.type !== 'onunhandledrejection' || e?.mechanism?.handled !== false) f.push(`mechanism ${JSON.stringify(e?.mechanism)}`);
        if (ev.extra?.unhandledPromiseRejection !== true) f.push('no extra.unhandledPromiseRejection');
      });
    } else if (r.events.length !== 0) f.push(`${r.events.length} events with no DSN`);
    return f;
  }
  function bootFaults(r: Result): string[] {
    const f: string[] = [];
    if (r.code !== 1 || r.signal !== null) f.push(`exit ${r.code} ${r.signal ?? ''}`.trim());
    if (r.out.includes('N169 BOOTED')) f.push('index.ts loaded without its boot error');
    if (count(r.err, EXIT_LINE) !== 1) f.push(`${count(r.err, EXIT_LINE)} "${EXIT_LINE}" lines`);
    if (!r.err.includes(BOOT)) f.push('the log has no boot error');
    const fatal = r.events.filter((e) => e.exception?.values?.[0]?.mechanism?.type === 'onuncaughtexception');
    if (fatal.length !== 1) f.push(`${fatal.length} uncaught-exception events`);
    if (fatal[0]?.level !== 'fatal' || !(fatal[0]?.exception?.values?.[0]?.value ?? '').startsWith(BOOT)) f.push(`event ${JSON.stringify(fatal[0]?.exception?.values?.[0]?.value)} ${fatal[0]?.level}`);
    const rejections = r.events.filter((e) => e.exception?.values?.[0]?.mechanism?.type === 'onunhandledrejection');
    if (rejections.length !== 0) f.push(`${rejections.length} rejections while index.ts loaded`);
    return f;
  }
  const show = (faults: string[]) => (faults.length ? ` [${faults.join('; ')}]` : '');
  const tail = (r: Result) => `\n      stdout: ${r.out.trim().split('\n').slice(-3).join(' | ')}\n      stderr: ${r.err.trim().split('\n').slice(0, 3).join(' | ')}`;

  // Sources, built eagerly: a stale anchor throws here, before any case runs.
  const handlersSrc = read('src/services/processHandlers.ts');
  const FLUSH_LINE = '  Sentry.flush(FLUSH_MS).then(() => process.exit(1), () => process.exit(1));';
  const noFlush = once(handlersSrc, FLUSH_LINE, '  process.exit(1);');
  const exitZero = once(once(handlersSrc, FLUSH_LINE, '  Sentry.flush(FLUSH_MS).then(() => process.exit(0), () => process.exit(0));'),
    '  process.exitCode = 1;', '  process.exitCode = 0;');
  const rejectExits = once(handlersSrc, "  console.error('[process] unhandled rejection; continuing', reason);\n",
    "  console.error('[process] unhandled rejection; continuing', reason);\n  process.exit(1);\n");
  const IMPORT = "// N169: what happens to an error that escapes everything. Second, so the handlers are in place before the rest\n"
    + "// of the API loads.\nimport './services/processHandlers';\n";
  const indexNoImport = once(read('src/index.ts'), IMPORT, '');
  const baseSentry = base('src/services/sentry.ts');
  const baseIndex = base('src/index.ts');

  try {
    section('X  an uncaught exception, with a DSN');
    const x = await run({ name: 'throw', scenario: 'throw', modules: ['processHandlers'], dsn: true });
    const xf = throwFaults(x, true);
    check(xf.length === 0, `logs "${EXIT_LINE}" once with the stack, sends ONE fatal event (onuncaughtexception, unhandled), which arrives before the exit, and exits 1 within ${FLUSH_MS + 1000} ms of the throw${show(xf)}`);
    if (xf.length) console.log(tail(x));

    section('R  two unhandled rejections, an Error and a string, with a DSN');
    const r = await run({ name: 'reject', scenario: 'reject', modules: ['processHandlers'], dsn: true });
    const rf = rejectFaults(r, true);
    check(rf.length === 0, `logs "${GO_ON_LINE}" once for each, with its reason, and no warning from Sentry; sends ONE error event for each (onunhandledrejection, extra.unhandledPromiseRejection); its HTTP server still answers; exit 0 at the end${show(rf)}`);
    if (rf.length) console.log(tail(r));

    section('E  the events are the ones production sent before (BASE: Sentry\'s own handlers, the controls)');
    const bx = await run({ name: 'base throw', scenario: 'throw', dsn: true, overrides: { 'src/services/sentry.ts': baseSentry } });
    const br = await run({ name: 'base reject', scenario: 'reject', dsn: true, overrides: { 'src/services/sentry.ts': baseSentry } });
    const key = (res: Result) => JSON.stringify(byValue(res).map((ev) => ({
      level: ev.level, type: ev.exception?.values?.[0]?.type, value: ev.exception?.values?.[0]?.value,
      mechanism: { type: ev.exception?.values?.[0]?.mechanism?.type, handled: ev.exception?.values?.[0]?.mechanism?.handled },
      extra: ev.extra?.unhandledPromiseRejection ?? null,
    })));
    check(bx.code === 1 && bx.events.length === 1 && !bx.err.includes('[process]') && bx.out.includes('sentry=2'),
      `BASE, uncaught exception: Sentry's handler sent ONE event and exited 1, with no "[process]" line (exit ${bx.code}, ${bx.events.length} events)`);
    check(br.code === 0 && br.events.length === 2 && br.out.includes('N169 server answered alive') && !br.err.includes('[process]') && br.err.includes(SENTRY_WARNING),
      `BASE, the two rejections: Sentry's handler sent ONE event each, printed its warning, and the process carried on (mode 'warn'), with no "[process]" line (exit ${br.code}, ${br.events.length} events)`);
    check(key(x) === key(bx), `the uncaught-exception event matches BASE's in level, exception and mechanism: ${key(x)}`);
    check(key(r) === key(br), `the rejection events match BASE's in level, exception, mechanism and extra: ${key(r)}`);

    section('D  without a DSN (locally)');
    const dx = await run({ name: 'throw, no DSN', scenario: 'throw', modules: ['processHandlers'], dsn: false });
    const dxf = throwFaults(dx, false);
    check(dxf.length === 0, `an uncaught exception: the same line, no event, exit 1${show(dxf)}`);
    const dr = await run({ name: 'reject, no DSN', scenario: 'reject', modules: ['processHandlers'], dsn: false });
    const drf = rejectFaults(dr, false);
    check(drf.length === 0, `the two rejections: the same lines, and the process carries on${show(drf)}`);
    const bdr = await run({ name: 'base reject, no DSN', scenario: 'reject', dsn: false, overrides: { 'src/services/sentry.ts': baseSentry } });
    check(bdr.code === 1 && !bdr.out.includes('N169 server answered'),
      `control, BASE without a DSN: the rejection ended the process (exit ${bdr.code}), as N169's entry said; it no longer does`);

    section('B  index.ts itself: its boot error, thrown after every import');
    const b = await run({ name: 'boot', scenario: 'boot', dsn: true });
    const bf = bootFaults(b);
    check(bf.length === 0, `"${BOOT}" is logged with "${EXIT_LINE}", sent as ONE fatal event, and the process exits 1; nothing loaded by index.ts rejected${show(bf)}`);
    if (bf.length) console.log(tail(b));

    section('S  the source');
    check(read('src/index.ts') === once(baseIndex, "import { Sentry } from './services/sentry';\n", `import { Sentry } from './services/sentry';\n${IMPORT}`),
      "index.ts is BASE's plus the processHandlers import, second, right after services/sentry");
    const expectedSentry = once(once(baseSentry,
      ' * Express error handling (default 500 response) continues to fire.\n */',
      ' * Express error handling (default 500 response) continues to fire.\n *\n'
      + ' * Process handlers: an uncaught exception or an unhandled rejection is the API\'s own policy, in\n'
      + ' * services/processHandlers.ts (N169), with or without a DSN. Sentry\'s two are left out of its defaults below.\n */'),
      '    integrations: [\n      Sentry.httpIntegration(),\n      Sentry.expressIntegration(),\n    ],',
      '    // A function, not an array: an array is ADDED to the defaults, and Sentry\'s two process handlers have to\n'
      + '    // come out of them. The API has its own (services/processHandlers.ts, N169). With Sentry\'s running beside\n'
      + '    // them, every rejection would print Sentry\'s warning as well, and a reason that is not an object (a string,\n'
      + '    // say) would be reported twice: Sentry marks an Error as sent, but cannot mark a string.\n'
      + '    integrations: (defaults) => [\n'
      + "      ...defaults.filter((i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'),\n"
      + '      Sentry.httpIntegration(),\n      Sentry.expressIntegration(),\n    ],');
    check(read('src/services/sentry.ts') === expectedSentry, "sentry.ts is BASE's plus the integrations filter and one header paragraph");
    check(listenersOk(x) && listenersOk(r), 'with a DSN: one uncaughtException and one unhandledRejection listener, and neither is Sentry\'s');
    check(x.envelopeErrors === 0 && b.envelopeErrors === 0, 'every envelope the stand-in ingest received parsed');

    section('M  mutation controls (each must fail its case)');
    const mutants: Array<[string, Case, (res: Result) => string[]]> = [
      ["Sentry's defaults left in (BASE's sentry.ts with the new handlers), an uncaught exception",
        { name: 'm1', scenario: 'throw', modules: ['processHandlers'], dsn: true, overrides: { 'src/services/sentry.ts': baseSentry } }, (res) => throwFaults(res, true)],
      ["Sentry's defaults left in, the two rejections",
        { name: 'm1r', scenario: 'reject', modules: ['processHandlers'], dsn: true, overrides: { 'src/services/sentry.ts': baseSentry } }, (res) => rejectFaults(res, true)],
      ['no flush before the exit',
        { name: 'm2', scenario: 'throw', modules: ['processHandlers'], dsn: true, overrides: { 'src/services/processHandlers.ts': noFlush } }, (res) => throwFaults(res, true)],
      ['exit 0',
        { name: 'm3', scenario: 'throw', modules: ['processHandlers'], dsn: true, overrides: { 'src/services/processHandlers.ts': exitZero } }, (res) => throwFaults(res, true)],
      ['a rejection that ends the process',
        { name: 'm4', scenario: 'reject', modules: ['processHandlers'], dsn: true, overrides: { 'src/services/processHandlers.ts': rejectExits } }, (res) => rejectFaults(res, true)],
      ['index.ts without the import',
        { name: 'm5', scenario: 'boot', dsn: true, overrides: { 'src/index.ts': indexNoImport } }, bootFaults],
    ];
    for (const [label, c, faults] of mutants) {
      const res = await run(c);
      const f = faults(res);
      check(f.length > 0, `${label}: caught${show(f)}`);
    }
  } finally {
    ingest.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { finished = true; console.error(e); process.exitCode = 1; });
