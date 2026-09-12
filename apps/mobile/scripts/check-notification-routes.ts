#!/usr/bin/env ts-node
/**
 * Prove every NotificationType has a tap destination, that the default arm
 * exists, and that no case routes at a screen which would bounce the guard
 * straight back to home.
 *
 * WHY THIS EXISTS. A missing case is invisible three ways over. The switch
 * had no default, so an unknown type fell out of it and the function
 * returned having navigated nowhere — no error, no log, and on a killed app
 * the root guard had already landed the guard on home, so the tap looked
 * like it had "worked". EIGHT of the 34 types were in that state
 * simultaneously (break_ended, break_return_overdue, clock_out_reminder,
 * shift_assigned, shift_reassigned_away, shift_schedule_edited,
 * site_deactivated, task_assigned) and the only way it surfaced was a guard
 * reporting that a push "did nothing".
 *
 * It is also how a fix regresses: apps/api b9579bc corrected shiftPush's
 * payload from 'shifts_assigned' to the singular 'shift_assigned' that
 * matches the row it writes — and silently removed that push's route,
 * because only the plural had a case.
 *
 * SOURCE-PARSED, NOT IMPORTED. navigateForNotification.ts pulls in
 * expo-router and the zustand store, which ts-node cannot load (the
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING wall that split
 * notificationTray out of notificationSync). So this reads the file and the
 * API's NotificationType union as text. That is a real limitation: it proves
 * a case EXISTS and what it targets, not that the case behaves correctly.
 *
 * Run:
 *   cd apps/mobile && npm run check:notification-routes
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const MOBILE = join(__dirname, '..');
const REPO   = join(MOBILE, '..', '..');

const navSrc = readFileSync(join(MOBILE, 'lib', 'navigateForNotification.ts'), 'utf8');

/** Strip comments so prose that mentions a case label is not read as one.
 *  This file's own docblock names all eight previously-missing types. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const nav = codeOnly(navSrc);

/** The API's NotificationType union — the authority on what can arrive. */
function unionTypes(): string[] {
  const src = readFileSync(join(REPO, 'apps', 'api', 'src', 'services', 'notifications.ts'), 'utf8');
  const start = src.indexOf('export type NotificationType');
  const end   = src.indexOf(';', src.indexOf("| 'shift_schedule_edited'"));
  if (start < 0 || end < 0) throw new Error('could not locate the NotificationType union');
  const body = codeOnly(src.slice(start, end + 1));
  return Array.from(new Set(
    Array.from(body.matchAll(/\|\s*'([a-z_]+)'/g)).map((m) => m[1]),
  )).sort();
}

const TYPES = unionTypes();
const CASES = new Set(Array.from(nav.matchAll(/case '([a-z_]+)'/g)).map((m) => m[1]));

/**
 * Screens a case may target that would immediately redirect the guard to
 * home, defeating the route. ping/index.tsx was exactly this: it read
 * activeSession on an empty-deps effect and replaced to home when null,
 * which on a cold start is ALWAYS. Verified by reading each target below.
 */
const TARGETS_WITH_MOUNT_REDIRECT: string[] = [
  // (empty — batch/mobile-17 removed ping/index.tsx's unconditional bounce.
  //  Any screen added here must stop being a routing target.)
];

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('navigateForNotification — tap route coverage\n');

test(`all ${TYPES.length} NotificationTypes have a case`, () => {
  const missing = TYPES.filter((t) => !CASES.has(t));
  if (missing.length) {
    throw new Error(
      `${missing.length} type(s) would fall to the default and navigate NOWHERE:\n` +
      missing.map((t) => `          - ${t}`).join('\n'),
    );
  }
});

test('the union really was read (sanity: 34 types, includes the five late additions)', () => {
  if (TYPES.length !== 34) throw new Error(`expected 34 union types, parsed ${TYPES.length}`);
  for (const t of ['site_deactivated', 'task_assigned', 'shift_reassigned_away',
                   'shift_cancelled', 'shift_schedule_edited']) {
    if (!TYPES.includes(t)) throw new Error(`${t} missing from the parsed union`);
  }
});

test('the legacy plural shifts_assigned still has a case', () => {
  // Banners delivered before apps/api b9579bc carry the plural. Dropping it
  // would un-route every one of them.
  if (!CASES.has('shifts_assigned')) {
    throw new Error('shifts_assigned lost its case — pre-b9579bc banners would navigate nowhere');
  }
  if (!CASES.has('shift_assigned')) {
    throw new Error('shift_assigned (singular, what the API sends now) has no case');
  }
});

test('a default arm exists and only breadcrumbs', () => {
  if (!/\bdefault:/.test(nav)) throw new Error('no default arm — an unknown type leaves no trace');
  const tail = nav.slice(nav.indexOf('default:'));
  if (/router\.(push|replace)/.test(tail)) {
    throw new Error('the default arm navigates — an unknown destination must not guess a screen');
  }
  if (!/addBreadcrumb/.test(tail)) throw new Error('the default arm does not record anything');
});

test('no case targets a screen with a mount-time home redirect', () => {
  for (const bad of TARGETS_WITH_MOUNT_REDIRECT) {
    if (nav.includes(`'${bad}'`)) {
      throw new Error(`a case routes to ${bad}, which redirects to home on mount`);
    }
  }
});

test('every routed target is a real file', () => {
  const { existsSync } = require('fs') as typeof import('fs');
  const targets = new Set(
    Array.from(nav.matchAll(/router\.(?:push|replace)\('(\/[^'${}]+)'\)/g)).map((m) => m[1]),
  );
  const resolve = (t: string): string[] => {
    const clean = t.replace(/^\//, '');
    return [
      join(MOBILE, 'app', `${clean}.tsx`),
      join(MOBILE, 'app', clean, 'index.tsx'),
    ];
  };
  for (const t of targets) {
    if (!resolve(t).some(existsSync)) {
      throw new Error(`route target ${t} resolves to no screen file`);
    }
  }
  if (targets.size === 0) throw new Error('parsed no static route targets — the regex has drifted');
  console.log(`        (${targets.size} static targets checked)`);
});

test('the conditional targets exist too', () => {
  const { existsSync } = require('fs') as typeof import('fs');
  // Built by ternaries, so the static regex above cannot see them.
  for (const t of ['clock-out', 'break', 'active-shift']) {
    if (!existsSync(join(MOBILE, 'app', t, 'index.tsx'))) {
      throw new Error(`conditional route target /${t} resolves to no screen file`);
    }
  }
});

test('clock_out_reminder and the break family gate on store state, not blindly', () => {
  // Routing to /clock-out with no session strands the guard on a screen
  // whose only working control is Back.
  const seg = nav.slice(nav.indexOf("case 'clock_out_reminder'"));
  if (!/activeSession/.test(seg.slice(0, 400))) {
    throw new Error('clock_out_reminder no longer checks activeSession before routing to /clock-out');
  }
  const brk = nav.slice(nav.indexOf("case 'break_ended'"));
  if (!/currentBreak/.test(brk.slice(0, 500))) {
    throw new Error('the break family no longer checks currentBreak before routing to /break');
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
