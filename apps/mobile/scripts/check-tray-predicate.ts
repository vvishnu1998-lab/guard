#!/usr/bin/env ts-node
/**
 * Exercise lib/notificationSync.ts's dismissal predicate against fixture
 * payloads, in both payload regimes.
 *
 * WHY THIS EXISTS. `shouldDismiss` decides whether a notification the guard
 * has already been shown gets cleared from their tray. Both failure
 * directions are real and neither is visible in a typecheck:
 *
 *   over-clearing  — a shift-cancelled or off-post banner vanishes before
 *                    the guard reads it. Silent; nothing logs a notification
 *                    that was wrongly removed.
 *   under-clearing — Bug 1 again, which is what this whole change set is for.
 *
 * The dangerous cases are the ones where the two regimes disagree, and the
 * push-only types (`shift_cancelled`, `shifts_assigned`, ...) that can NEVER
 * appear in the live list because the API writes no row for them. A naive
 * "type not live -> dismiss" rule passes a typecheck and clears every one of
 * them on the guard's next foreground.
 *
 * ts-node, matching scripts/check-respond-copy.ts, because this has to
 * EXECUTE the shipped module rather than regex it. Deliberately NOT wired to
 * postinstall — ts-node is not guaranteed inside an EAS build and bricking
 * `npm install` to run a proof would be a bad trade. Run by hand or in CI via
 * `npm run check:tray-predicate`.
 */
import {
  shouldDismiss,
  buildLiveIndex,
  windowOf,
  PING_TYPES,
  ROW_BACKED_TYPES,
  LiveNotificationRow,
  PresentedLike,
} from '../lib/notificationTray';
import { visibleNotifications } from '../lib/notificationSections';

function row(
  id: string,
  type: string,
  data: unknown = {},
  read_at: string | null = null,
): LiveNotificationRow {
  return { id, type, data, read_at, created_at: '2026-09-12T10:00:00Z' };
}

function tray(data: Record<string, unknown> | undefined, identifier = 'n1'): PresentedLike {
  return { identifier, data };
}

interface Case {
  label:  string;
  live:   LiveNotificationRow[];
  item:   PresentedLike;
  expect: boolean;   // true = should be dismissed
  why:    string;
}

const CASES: Case[] = [
  // ── Regime 1: data.notificationId present (Dispatch 1 payloads) ──────────
  {
    label:  'R1 id still live -> keep',
    live:   [row('abc', 'task_reminder')],
    item:   tray({ type: 'task_reminder', notificationId: 'abc' }),
    expect: false,
    why:    'the exact row is still outstanding',
  },
  {
    label:  'R1 id gone -> dismiss',
    live:   [row('other', 'task_reminder')],
    item:   tray({ type: 'task_reminder', notificationId: 'abc' }),
    expect: true,
    why:    'this row was auto-erased or dismissed; a SIBLING of the same type is live',
  },
  {
    label:  'R1 empty live list -> dismiss',
    live:   [],
    item:   tray({ type: 'geofence_breach', notificationId: 'abc' }),
    expect: true,
    why:    'nothing outstanding at all',
  },
  {
    label:  'R1 beats the type rule for an unrecognised type',
    live:   [],
    item:   tray({ type: 'shift_cancelled', notificationId: 'abc' }),
    expect: true,
    why:    'an explicit id is authoritative even for a type the legacy path would not touch',
  },
  {
    label:  'R1 id present but empty string -> falls back to regime 2',
    live:   [row('x', 'task_reminder')],
    item:   tray({ type: 'task_reminder', notificationId: '' }),
    expect: false,
    why:    'empty id is not an id; type is live so keep',
  },

  // ── Regime 2: legacy payloads (everything in the field at 3148286) ───────
  {
    label:  'R2 type still live -> keep',
    live:   [row('1', 'activity_report_reminder')],
    item:   tray({ type: 'activity_report_reminder' }),
    expect: false,
    why:    'a report is still owed',
  },
  {
    label:  'R2 type no longer live -> dismiss',
    live:   [row('1', 'chat')],
    item:   tray({ type: 'activity_report_reminder' }),
    expect: true,
    why:    'the report was submitted; server auto-erased the row',
  },
  {
    label:  'R2 guard-dismissed row (read_at set) -> dismiss',
    live:   visibleNotifications([row('1', 'off_post_report', {}, '2026-09-12T11:00:00Z')]),
    item:   tray({ type: 'off_post_report' }),
    expect: true,
    why:    'read_at means DISMISSED; visibleNotifications drops it, so the banner goes too',
  },
  {
    label:  'R2 un-dismissed row of the same type -> keep',
    live:   visibleNotifications([row('1', 'off_post_report', {}, null)]),
    item:   tray({ type: 'off_post_report' }),
    expect: false,
    why:    'control for the case above — proves the read_at filter is what moved it, not the type',
  },

  // ── Ping family: window-scoped, not just type-scoped ─────────────────────
  {
    label:  'PING same type, different window -> dismiss',
    live:   [row('1', 'ping_reminder', { window_label: '18:00' })],
    item:   tray({ type: 'ping_reminder', window_label: '17:30' }),
    expect: true,
    why:    'THE case type-only matching gets wrong: 17:30 answered, 18:00 still due',
  },
  {
    label:  'PING same window -> keep',
    live:   [row('1', 'ping_reminder', { window_label: '17:30' })],
    item:   tray({ type: 'ping_reminder', window_label: '17:30' }),
    expect: false,
    why:    'still outstanding',
  },
  {
    label:  'PING camelCase on the wire matches snake_case in the payload',
    live:   [row('1', 'missed_ping', { windowLabel: '17:30' })],
    item:   tray({ type: 'missed_ping', window_label: '17:30' }),
    expect: false,
    why:    'pingReminder.ts writes snake_case, missedPingCron.ts camelCase; both are the same window',
  },
  {
    label:  'PING no window on the payload -> falls back to the type test',
    live:   [row('1', 'ping_reminder', { window_label: '18:00' })],
    item:   tray({ type: 'ping_reminder' }),
    expect: false,
    why:    'cannot tell which window; under-clear rather than guess',
  },

  // ── Safety gates ─────────────────────────────────────────────────────────
  {
    label:  'CHAT is never dismissed by the reconcile',
    live:   [],
    item:   tray({ type: 'chat', roomId: 'r1' }),
    expect: false,
    why:    'an unread message is not a completed action; dismissChatRoom owns it',
  },
  {
    label:  'PUSH-ONLY shift_cancelled survives an empty live list',
    live:   [],
    item:   tray({ type: 'shift_cancelled', shift_id: 's1' }),
    expect: false,
    why:    'the API writes no row for it, so it can never be live — clearing it would lose the notice',
  },
  {
    label:  'PUSH-ONLY shifts_assigned survives its own row-type mismatch',
    live:   [row('1', 'shift_assigned')],
    item:   tray({ type: 'shifts_assigned', count: '3' }),
    expect: false,
    why:    'shiftPush.ts sends data.type=shifts_assigned while writing a shift_assigned row',
  },
  {
    label:  'PUSH-ONLY task_assigned survives',
    live:   [row('1', 'task_reminder')],
    item:   tray({ type: 'task_assigned', site_id: 'x' }),
    expect: false,
    why:    'routes/tasks.ts:252 pushes it and writes no row',
  },
  {
    label:  'missing type -> keep',
    live:   [],
    item:   tray({ shift_id: 's1' }),
    expect: false,
    why:    'breakExpiryCron.ts sends no type key at all — nothing to reason from',
  },
  {
    label:  'undefined data -> keep',
    live:   [],
    item:   tray(undefined),
    expect: false,
    why:    'a local notification with no data payload',
  },
];

let failures = 0;
console.log('[check-tray-predicate] shouldDismiss over fixture payloads');
for (const c of CASES) {
  const got = shouldDismiss(c.item, buildLiveIndex(c.live));
  if (got !== c.expect) {
    failures++;
    console.error(
      `  FAIL  ${c.label}\n        expected ${c.expect ? 'DISMISS' : 'KEEP'}, got ${got ? 'DISMISS' : 'KEEP'}\n        ${c.why}`,
    );
    continue;
  }
  console.log(`  ok    ${got ? 'DISMISS' : 'KEEP   '}  ${c.label}`);
}

// Invariants the cases above depend on — assert rather than assume.
let invariantFailures = 0;
if (!ROW_BACKED_TYPES.has('ping_reminder') || !ROW_BACKED_TYPES.has('chat')) {
  console.error('  FAIL  ROW_BACKED_TYPES is missing a type the fixtures rely on');
  invariantFailures++;
}
for (const pushOnly of ['shift_cancelled', 'shifts_assigned', 'task_assigned', 'site_deactivated', 'shift_schedule_edited', 'shift_reassigned_away']) {
  if (ROW_BACKED_TYPES.has(pushOnly)) {
    console.error(`  FAIL  ${pushOnly} is push-only and must NOT be in ROW_BACKED_TYPES`);
    invariantFailures++;
  }
}
if (ROW_BACKED_TYPES.size !== 29) {
  console.error(`  FAIL  ROW_BACKED_TYPES has ${ROW_BACKED_TYPES.size} entries, expected 29 (the NotificationType union at 3148286)`);
  invariantFailures++;
}
for (const t of PING_TYPES) {
  if (!ROW_BACKED_TYPES.has(t)) {
    console.error(`  FAIL  ping type ${t} is not row-backed, so the window rule is unreachable`);
    invariantFailures++;
  }
}
if (windowOf({ window_label: 'a' }) !== 'a' || windowOf({ windowLabel: 'b' }) !== 'b' || windowOf(null) !== null || windowOf({ window_label: '' }) !== null) {
  console.error('  FAIL  windowOf does not handle both casings plus the empty/null cases');
  invariantFailures++;
}

if (failures || invariantFailures) {
  console.error(`[check-tray-predicate] FAIL — ${failures} case(s), ${invariantFailures} invariant(s).`);
  process.exit(1);
}
console.log(`[check-tray-predicate] PASS — ${CASES.length}/${CASES.length} cases, all invariants hold.`);
