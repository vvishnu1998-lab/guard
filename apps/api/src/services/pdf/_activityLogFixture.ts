/**
 * Synthetic ActivityRow fixture for the activity-log PDF renderer.
 *
 * Lives in src/ (not scripts/) deliberately: tsconfig.json is
 * `include: ["src/**\/*"]`, so `check:types` compiles this against the real
 * `ActivityRow`. A fixture that drifts from the interface is then a CI
 * failure rather than a test that quietly stops covering a field.
 *
 * Nothing in the running service imports this — it is reachable only from
 * `_activityLog.test.ts` and the one-shot baseline capture.
 *
 * WHY THE TIMESTAMPS ARE REAL. The 2026-09-08 block below is transcribed
 * from production (guard_id bdc24374-29e0-48fe-9b25-e76bc155e875, session
 * 77cc32e7-3827-4c8f-a08c-06751c34e919) because that sequence is the one
 * the audit got WRONG: it queried location_pings and missed_pings only,
 * found no 13:03 event, and called the reported ordering a transposition.
 * The 13:03 ACTIVITY and 13:07 INCIDENT are `reports` rows. Re-queried
 * 2026-09-23 via postgres-readonly.
 *
 * The property that block pins, and which no synthetic row would have
 * produced: "15:17" is printed TWICE in one day section, four rows apart —
 * once by the merged missed row (sorted at its 13:00 window, displaying the
 * 15:17:34 ping that answered it) and once by the unrelated activity report
 * at 15:17:07. Two events, one printed time, nothing to tell them apart.
 *
 * Pacific is UTC-7 in September 2026 (PDT). Every PT time named in a
 * comment below is the UTC literal minus 7h.
 */
import type { ActivityRow } from '../../routes/activityLog';

/** Every member of ActivityRow['status_kind'], so the renderer's label and
 *  colour maps can be asserted exhaustive without importing the union. */
export const ALL_STATUS_KINDS: ActivityRow['status_kind'][] = [
  'on_time',
  'late',
  'missed',
  'missed_answered_late',
  'activity_report',
  'incident_report',
  'maintenance_report',
  'clocked_in_on_time',
  'clocked_in_late',
  'missed_clock_in',
  'missed_report',
  'task_completed',
  'checkpoint_round_complete',
  'checkpoint_round_partial',
];

const SITE_ID  = '53c71c64-1973-4f82-be9c-98e4800beece';
const SITE     = 'Bethel AME Church';
const GUARD_ID = 'bdc24374-29e0-48fe-9b25-e76bc155e875';
const GUARD    = 'Fixture Guard A';
const SHIFT_ID = '0278a689-6d15-4f6d-97ba-ef43a2dfceb5';
const SCHED_START = '2026-09-08T19:00:00.000Z';
const SCHED_END   = '2026-09-09T01:00:00.000Z';

/** Deterministic filler of an exact character length — no Math.random, so
 *  two runs of the baseline and the new renderer compare byte-for-byte. */
function text(n: number): string {
  const word = 'perimeter checked gate secured lobby clear stairwell swept ';
  let s = '';
  while (s.length < n) s += word;
  return s.slice(0, n);
}

export const DESC_60  = text(60);
export const DESC_170 = text(170);
export const DESC_400 = text(400);

/** Production description lengths from the 2026-09-08 session. */
export const DESC_101 = text(101);
export const DESC_337 = text(337);
export const DESC_94  = text(94);

function row(p: Partial<ActivityRow> & Pick<ActivityRow, 'id' | 'status' | 'status_kind' | 'event_time'>): ActivityRow {
  return {
    kind:            'ping',
    guard_id:        GUARD_ID,
    guard_name:      GUARD,
    site_id:         SITE_ID,
    site_name:       SITE,
    log_time:        p.event_time,
    log_media_url:   null,
    log_media_urls:  [],
    detail_id:       null,
    shift_id:        SHIFT_ID,
    scheduled_start: SCHED_START,
    scheduled_end:   SCHED_END,
    report_type:     null,
    severity:        null,
    description:     null,
    legal_hold:      false,
    latitude:        null,
    longitude:       null,
    accuracy_m:      null,
    is_within_geofence: null,
    ping_type:       null,
    round_window:    null,
    timezone:        null,
    checkpoints:     null,
    scanned_count:   null,
    expected_count:  null,
    ...p,
  };
}

// ── Block 1 — the 2026-09-08 production sequence (see docblock) ─────────────
const SEQ_0908: ActivityRow[] = [
  // 12:31 PT ping, submitted for the 12:30 window.
  row({
    id: 'c6bbf3eb-4a9f-488d-92b3-8ad834abfd91',
    status: 'Ping (1 minute)', status_kind: 'on_time',
    event_time: '2026-09-08T19:31:37.095Z',
    detail_id: 'c6bbf3eb-4a9f-488d-92b3-8ad834abfd91',
    ping_type: 'gps_photo',
    log_media_url: 's3://fixture/ping-1231.jpg',
    log_media_urls: ['s3://fixture/ping-1231.jpg'],
  }),
  // THE MISPLACED ROW. Sorts at its 13:00 PT window; the only time the
  // renderer currently prints is log_time, 15:17:34 PT.
  // Lateness is measured from window END (20:30Z): 107.58 min -> 108.
  row({
    id: 'missed-77cc32e7-1757361600000',
    status: 'Missed — answered 108 minutes late',
    status_kind: 'missed_answered_late',
    event_time: '2026-09-08T20:00:00.000Z',   // 13:00 PT — window start
    log_time:   '2026-09-08T22:17:34.750Z',   // 15:17 PT — resolving ping
    detail_id: '5b854648-d266-4b54-9e4a-9cfea02a2a86',
    ping_type: 'gps_photo',
    log_media_url: 's3://fixture/ping-1517.jpg',
    log_media_urls: ['s3://fixture/ping-1517.jpg'],
  }),
  // 13:03 PT — the row the audit missed.
  row({
    id: 'af7b3690-ff4a-42fb-9086-e4561f9b789b',
    kind: 'report',
    status: 'Activity Report', status_kind: 'activity_report',
    event_time: '2026-09-08T20:03:03.700Z',
    detail_id: 'af7b3690-ff4a-42fb-9086-e4561f9b789b',
    report_type: 'activity', description: DESC_101,
    log_media_urls: ['a', 'b', 'c', 'd', 'e'], log_media_url: 'a',
  }),
  // 13:07 PT — incident with severity NULL and a 337-char description.
  // severity is NULL on 13 of 13 production incidents (see PR #74).
  row({
    id: '223cf7e2-fde3-4044-a196-cabacc01b9a5',
    kind: 'report',
    status: 'Incident Report', status_kind: 'incident_report',
    event_time: '2026-09-08T20:07:39.667Z',
    detail_id: '223cf7e2-fde3-4044-a196-cabacc01b9a5',
    report_type: 'incident', severity: null, description: DESC_337,
    legal_hold: true,
    log_media_urls: ['a', 'b'], log_media_url: 'a',
  }),
  // 13:30 PT ping — the row that follows the misplaced one.
  row({
    id: '223a9089-2554-4ce3-a2d2-2d5a6aa7caac',
    status: 'Ping (0 minutes)', status_kind: 'on_time',
    event_time: '2026-09-08T20:30:37.977Z',
    detail_id: '223a9089-2554-4ce3-a2d2-2d5a6aa7caac',
    ping_type: 'gps_photo',
  }),
  // 15:17:07 PT — the OTHER row that prints "15:17".
  row({
    id: '1fca70a7-9c49-4663-8f16-da9c37cbdc75',
    kind: 'report',
    status: 'Activity Report', status_kind: 'activity_report',
    event_time: '2026-09-08T22:17:07.466Z',
    detail_id: '1fca70a7-9c49-4663-8f16-da9c37cbdc75',
    report_type: 'activity', description: DESC_94,
    log_media_urls: ['a', 'b', 'c', 'd', 'e'], log_media_url: 'a',
  }),
];

// ── Block 2 — two pings 12.7s apart, same printed minute, different windows ─
// Transcribed from session 0fc16fe7-7ee4-4065-9dfb-ba6149030f20 (2026-09-03).
// Both print "16:32". One is a backfill of the 16:00 window (+32 min, LATE),
// the other is the 16:30 window's own ping (+2 min, on time).
const SAME_MINUTE: ActivityRow[] = [
  row({
    id: '7cc9d481-7f9c-43f5-ab07-afdf6ec57273',
    status: 'Late Ping (32 minutes)', status_kind: 'late',
    event_time: '2026-09-03T23:32:10.873Z',
    detail_id: '7cc9d481-7f9c-43f5-ab07-afdf6ec57273',
    scheduled_start: '2026-09-03T19:00:00.000Z',
    scheduled_end:   '2026-09-04T01:00:00.000Z',
    ping_type: 'gps_photo',
  }),
  row({
    id: '21ed9297-c1d1-4f2a-a716-7d5594ba1780',
    status: 'Ping (2 minutes)', status_kind: 'on_time',
    event_time: '2026-09-03T23:32:23.559Z',
    detail_id: '21ed9297-c1d1-4f2a-a716-7d5594ba1780',
    scheduled_start: '2026-09-03T19:00:00.000Z',
    scheduled_end:   '2026-09-04T01:00:00.000Z',
    ping_type: 'gps_photo',
  }),
];

// ── Block 3 — one row per remaining StatusKind, plus the description sizes ──
// Dated 2026-09-05 so they form their own day section, away from blocks 1-2.
const D = (hhmmss: string) => `2026-09-05T${hhmmss}.000Z`;

const KINDS: ActivityRow[] = [
  row({ id: 'k-clockin-ontime', status: 'Clocked In', status_kind: 'clocked_in_on_time',
        event_time: D('17:00:11'),
        log_media_urls: ['selfie', 'site'], log_media_url: 'selfie' }),
  // Same `status` string as the row above — the ONLY thing separating an
  // on-time clock-in from a late one is status_kind.
  row({ id: 'k-clockin-late', status: 'Clocked In', status_kind: 'clocked_in_late',
        event_time: D('17:18:42') }),
  row({ id: 'k-missed-clockin', status: 'Missed Clock In', status_kind: 'missed_clock_in',
        event_time: D('17:30:00'), log_time: null }),
  row({ id: 'k-missed', status: 'Missed Ping', status_kind: 'missed',
        event_time: D('18:00:00'), log_time: null }),
  row({ id: 'k-missed-report', status: 'Missed Report', status_kind: 'missed_report',
        kind: 'report', event_time: D('19:00:00'), log_time: null }),
  row({ id: 'k-maintenance', status: 'Maintenance Report', status_kind: 'maintenance_report',
        kind: 'report', event_time: D('19:20:00'),
        report_type: 'maintenance', severity: 'low', description: DESC_60 }),
  row({ id: 'k-activity-170', status: 'Activity Report', status_kind: 'activity_report',
        kind: 'report', event_time: D('19:40:00'),
        report_type: 'activity', description: DESC_170 }),
  row({ id: 'k-incident-400', status: 'Incident Report', status_kind: 'incident_report',
        kind: 'report', event_time: D('20:00:00'),
        report_type: 'incident', severity: 'critical', description: DESC_400,
        log_media_urls: ['a', 'b', 'c'], log_media_url: 'a' }),
  row({ id: 'k-task', status: 'Task Completed', status_kind: 'task_completed',
        kind: 'task_completion', event_time: D('20:20:00'),
        description: 'Check fire extinguisher tags' }),
  row({ id: 'k-round-complete', status: 'Patrol Round Complete',
        status_kind: 'checkpoint_round_complete', kind: 'checkpoint_round',
        event_time: D('21:00:00'), shift_id: null,
        scheduled_start: null, scheduled_end: null,
        round_window: D('21:00:00'), timezone: 'America/Los_Angeles',
        checkpoints: [], scanned_count: 5, expected_count: 5 }),
  row({ id: 'k-round-partial', status: 'Patrol Round Partial',
        status_kind: 'checkpoint_round_partial', kind: 'checkpoint_round',
        event_time: D('22:00:00'), shift_id: null,
        scheduled_start: null, scheduled_end: null,
        round_window: D('22:00:00'), timezone: 'America/Los_Angeles',
        checkpoints: [], scanned_count: 3, expected_count: 5 }),
];

// ── Block 4 — bulk filler so the document runs past three pages ─────────────
// 18pt rows, ~35/page, so 120 rows is 3+ body pages on their own. Dated
// across four earlier days so several day headers are exercised too.
const FILLER: ActivityRow[] = Array.from({ length: 120 }, (_, i) => {
  const day  = 1 + (i % 4);                 // 2026-09-01 .. 2026-09-04
  const mins = i * 7;
  const hh   = String(17 + Math.floor(mins / 60) % 6).padStart(2, '0');
  const mm   = String(mins % 60).padStart(2, '0');
  return row({
    id: `filler-${i}`,
    status: 'Ping (3 minutes)', status_kind: 'on_time',
    event_time: `2026-09-0${day}T${hh}:${mm}:00.000Z`,
    detail_id: `filler-${i}`,
    ping_type: 'gps_photo',
  });
});

/** Unsorted on purpose — the renderer owns "newest first". */
export const FIXTURE_ROWS: ActivityRow[] = [
  ...FILLER, ...KINDS, ...SAME_MINUTE, ...SEQ_0908,
];

/**
 * Just the 2026-09-08 block — short enough to fit on one page.
 *
 * The page-total estimate it replaces was `1 + max(1, ceil(n/20))`, whose
 * floor is TWO. A single-page document is therefore the case that estimate
 * could never get right no matter how the constant was tuned, which is why
 * it is a fixture and not an afterthought.
 */
export const FIXTURE_ROWS_ONE_PAGE: ActivityRow[] = [...SEQ_0908];

/**
 * Meta as the route builds it. `to` is what the web actually sends for a
 * picker end of 2026-09-08: localDayEnd() parses "T23:59:59.999" in the
 * BROWSER's zone (PT), so the wire value is the next UTC day —
 * 2026-09-09T06:59:59.999Z. That is the whole of D2.
 */
export const FIXTURE_META = {
  siteLabel:  SITE,
  guardLabel: 'All guards',
  fromIso:    '2026-09-01T07:00:00.000Z',
  toIso:      '2026-09-09T06:59:59.999Z',
};

/**
 * The range PDF-1 was actually exported with: picker 2026-08-24 → 2026-09-22,
 * at the STARNET Bethel site. The end bound is what localDayEnd() puts on the
 * wire for a PT browser — 06:59:59.999Z the NEXT UTC day — which is why a
 * zone-less toLocaleDateString on a UTC server prints 23/09 while the filename
 * the same click produced says 09-22.
 *
 * The start bound needs no fix and must not acquire one: 07:00Z on 24/08 is
 * still 24/08 in UTC, so only the END date was ever visibly wrong. An
 * assertion that checked only the end could be satisfied by a change that
 * broke the start, so both are pinned.
 */
export const FIXTURE_META_PROD_RANGE = {
  siteLabel:  SITE,
  guardLabel: 'All guards',
  fromIso:    '2026-08-24T07:00:00.000Z',  // localDayStart('2026-08-24') from PT
  toIso:      '2026-09-23T06:59:59.999Z',  // localDayEnd('2026-09-22')   from PT
};

/** session_id is set, and nothing in the current header says so — D1. */
export const FIXTURE_SESSION_ID = '77cc32e7-3827-4c8f-a08c-06751c34e919';
