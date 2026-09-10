#!/usr/bin/env ts-node
/**
 * Prove that lib/respondErrorCopy.ts is BYTE-IDENTICAL to the status-only
 * version it replaced, for every response body today's API actually emits on
 * swap-response and handoff-response.
 *
 * WHY THIS EXISTS. N46 ships the mobile half FIRST, before the API emits any
 * machine code. That ordering is only safe if the new client behaves exactly
 * as the old one against the current server - otherwise the OTA is a
 * behaviour change dressed as a no-op, on a screen whose failure mode is a
 * guard retrying an invite that cannot succeed.
 *
 * "Behaves exactly as the old one" is a claim that can be run, so it is run
 * rather than argued. OLD is a verbatim copy of the function as it stood at
 * befe70d; NEW calls the shipped module. Both are fed the real bodies.
 *
 * ts-node rather than the plain-CJS style of check-break-constants.js because
 * this one has to EXECUTE TypeScript, not regex it. For the same reason it is
 * NOT wired to postinstall: ts-node is not guaranteed inside an EAS build and
 * bricking `npm install` to run a proof would be a bad trade. Run it by hand
 * or in CI via `npm run check:respond-copy`.
 */
import { ApiError, NetworkError } from '../lib/errors';
import { respondConflictCopy, respondReasonCode, RespondKind } from '../lib/respondErrorCopy';

/** Sentinel for "this version fell through to guardMessage()". */
const FALLTHROUGH = '<<FALLTHROUGH>>';

/** VERBATIM from (tabs)/notifications.tsx at befe70d, minus the guardMessage
 *  tail, which both versions reach identically. */
function OLD(err: unknown, kind: RespondKind): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return `This ${kind} was already responded to, or it expired. Pull down to refresh.`;
    }
    if (err.status === 403) {
      return `This ${kind} request isn't addressed to you.`;
    }
    if (err.status === 404) {
      return `This ${kind} request no longer exists. Pull down to refresh.`;
    }
  }
  return FALLTHROUGH;
}

function NEW(err: unknown, kind: RespondKind): string {
  return respondConflictCopy(err, kind) ?? FALLTHROUGH;
}

/** Every body these two routes emit at befe70d, read off routes/shifts.ts. */
const CASES: { label: string; kind: RespondKind; err: unknown }[] = [
  { label: 'swap :1745 400 history_id',  kind: 'swap', err: new ApiError(400, { error: 'history_id is required' }) },
  { label: 'swap :1746 400 accept',      kind: 'swap', err: new ApiError(400, { error: 'accept (boolean) is required' }) },
  { label: 'swap :1767 404 req missing', kind: 'swap', err: new ApiError(404, { error: 'Swap request not found' }) },
  { label: 'swap :1773 403 not yours',   kind: 'swap', err: new ApiError(403, { error: 'This swap request is not addressed to you.' }) },
  { label: 'swap :1777 409 expired',     kind: 'swap', err: new ApiError(409, { error: 'Swap request is already expired.' }) },
  { label: 'swap :1777 409 accepted',    kind: 'swap', err: new ApiError(409, { error: 'Swap request is already accepted.' }) },
  { label: 'swap :1777 409 declined',    kind: 'swap', err: new ApiError(409, { error: 'Swap request is already declined.' }) },
  { label: 'swap :1777 409 cancelled',   kind: 'swap', err: new ApiError(409, { error: 'Swap request is already cancelled.' }) },
  { label: 'swap :1802 404 shift',       kind: 'swap', err: new ApiError(404, { error: 'Shift not found' }) },
  { label: 'swap :1829 409 not sched',   kind: 'swap', err: new ApiError(409, { error: 'Shift is no longer scheduled (current: cancelled).' }) },
  { label: 'swap :1834 409 reassigned',  kind: 'swap', err: new ApiError(409, { error: 'Shift has been reassigned by an admin; swap is stale.' }) },
  { label: 'swap :1850 409 overlap',     kind: 'swap', err: new ApiError(409, { error: 'You now have an overlapping shift; swap is no longer possible.' }) },
  { label: 'swap :1859 422 eligibility', kind: 'swap', err: new ApiError(422, { error: 'Guard is not assigned to 375 Shopping Complex on 2026-09-20.' }) },
  { label: 'swap :1897 500',             kind: 'swap', err: new ApiError(500, { error: 'Failed to respond to swap request' }) },

  { label: 'hand :2077 400 history_id',  kind: 'handoff', err: new ApiError(400, { error: 'history_id is required' }) },
  { label: 'hand :2078 400 accept',      kind: 'handoff', err: new ApiError(400, { error: 'accept (boolean) is required' }) },
  { label: 'hand :2097 404 req missing', kind: 'handoff', err: new ApiError(404, { error: 'Handoff request not found' }) },
  { label: 'hand :2103 400 wrong route', kind: 'handoff', err: new ApiError(400, { error: 'This is not a handoff request - use /swap-response.' }) },
  { label: 'hand :2107 403 not yours',   kind: 'handoff', err: new ApiError(403, { error: 'This handoff is not addressed to you.' }) },
  { label: 'hand :2111 409 expired',     kind: 'handoff', err: new ApiError(409, { error: 'Handoff is already expired.' }) },
  { label: 'hand :2111 409 cancelled',   kind: 'handoff', err: new ApiError(409, { error: 'Handoff is already cancelled.' }) },
  { label: 'hand :2129 404 shift',       kind: 'handoff', err: new ApiError(404, { error: 'Shift not found' }) },
  { label: 'hand :2155 409 not active',  kind: 'handoff', err: new ApiError(409, { error: 'Shift is no longer active (current: completed).' }) },
  { label: 'hand :2160 409 reassigned',  kind: 'handoff', err: new ApiError(409, { error: 'Shift has been reassigned by an admin; handoff is stale.' }) },
  { label: 'hand :2170 409 clocked in',  kind: 'handoff', err: new ApiError(409, { error: 'You are already clocked in to another shift.' }) },
  { label: 'hand :2198 500',             kind: 'handoff', err: new ApiError(500, { error: 'Failed to respond to handoff' }) },

  { label: 'transport failure',          kind: 'swap',    err: new NetworkError() },
  { label: 'our own bug',                kind: 'handoff', err: new TypeError('x is not a function') },
  { label: 'non-error throw',            kind: 'swap',    err: 'a string' },
];

let mismatches = 0;
for (const c of CASES) {
  const o = OLD(c.err, c.kind);
  const n = NEW(c.err, c.kind);
  if (o !== n) {
    mismatches++;
    console.error(`  MISMATCH  ${c.label}`);
    console.error(`      old: ${JSON.stringify(o)}`);
    console.error(`      new: ${JSON.stringify(n)}`);
  }
}
console.log(`[check-respond-copy] today's API: ${CASES.length} cases, ${mismatches} mismatch(es)`);

// ── THE OTHER HALF: the eight bodies the API emits AFTER N46 Phase 3. ──────
//
// Transcribed from routes/shifts.ts at the ref this check ships with. A test
// that only proved sameness would also pass on a change that did nothing, so
// this half asserts the codes actually resolve: every one of the eight must
// be recognised as an ENUM (not fall through to the status fallback), and the
// six that were mis-messaged must now read differently from the old blanket
// sentence while the two that were already right must NOT change.
const POST_N46: { label: string; kind: RespondKind; err: ApiError; expectSameAsOld: boolean }[] = [
  { label: 'swap :1777 SWAP_NOT_PENDING', kind: 'swap', expectSameAsOld: true,
    err: new ApiError(409, { code: 'SWAP_NOT_PENDING', error: 'SWAP_NOT_PENDING',
      message: 'Swap request is already expired.', swap_status: 'expired' }) },
  { label: 'swap :1829 SHIFT_NOT_SCHEDULED', kind: 'swap', expectSameAsOld: false,
    err: new ApiError(409, { code: 'SHIFT_NOT_SCHEDULED', error: 'SHIFT_NOT_SCHEDULED',
      message: 'Shift is no longer scheduled (current: cancelled).', shift_status: 'cancelled' }) },
  { label: 'swap :1834 SWAP_STALE_REASSIGNED', kind: 'swap', expectSameAsOld: false,
    err: new ApiError(409, { code: 'SWAP_STALE_REASSIGNED', error: 'SWAP_STALE_REASSIGNED',
      message: 'Shift has been reassigned by an admin; swap is stale.' }) },
  { label: 'swap :1850 RECIPIENT_OVERLAP', kind: 'swap', expectSameAsOld: false,
    err: new ApiError(409, { code: 'RECIPIENT_OVERLAP', error: 'RECIPIENT_OVERLAP',
      message: 'You now have an overlapping shift; swap is no longer possible.',
      conflict: { shift_id: 'b2afb11f-4861-436e-a8c9-5f6ec2961082', guard_name: 'Raja',
                  site_name: '375 Shopping Complex',
                  scheduled_start: '2026-10-05T21:00:00.000Z',
                  scheduled_end: '2026-10-06T07:00:00.000Z' } }) },
  { label: 'hand :2111 HANDOFF_NOT_PENDING', kind: 'handoff', expectSameAsOld: true,
    err: new ApiError(409, { code: 'HANDOFF_NOT_PENDING', error: 'HANDOFF_NOT_PENDING',
      message: 'Handoff is already cancelled.', handoff_status: 'cancelled' }) },
  { label: 'hand :2155 SHIFT_NOT_ACTIVE', kind: 'handoff', expectSameAsOld: false,
    err: new ApiError(409, { code: 'SHIFT_NOT_ACTIVE', error: 'SHIFT_NOT_ACTIVE',
      message: 'Shift is no longer active (current: completed).', shift_status: 'completed' }) },
  { label: 'hand :2160 HANDOFF_STALE_REASSIGNED', kind: 'handoff', expectSameAsOld: false,
    err: new ApiError(409, { code: 'HANDOFF_STALE_REASSIGNED', error: 'HANDOFF_STALE_REASSIGNED',
      message: 'Shift has been reassigned by an admin; handoff is stale.' }) },
  // openSessionConflictBody spread, with `error` overridden to the enum.
  { label: 'hand :2170 OPEN_SESSION_EXISTS', kind: 'handoff', expectSameAsOld: false,
    err: new ApiError(409, { code: 'OPEN_SESSION_EXISTS', error: 'OPEN_SESSION_EXISTS',
      message: "You're already clocked in at 375 Shopping Complex since 1:57 PM PT.",
      open_session: { shift_id: 'e1707b96-1d46-41a7-a2de-b32f9a4c2e1b',
                      site_id: 'ab450901-c434-417c-b5b6-292b4d09e80c',
                      site_name: '375 Shopping Complex',
                      clocked_in_at: '2026-09-09T20:57:56.683Z' } }) },
];

let unresolved = 0;
let wrongDirection = 0;
console.log('[check-respond-copy] post-N46 API: the eight 409 bodies');
for (const c of POST_N46) {
  const code = respondReasonCode(c.err);
  const o = OLD(c.err, c.kind);
  const n = NEW(c.err, c.kind);
  const same = o === n;
  if (code === null) { unresolved++; console.error(`  UNRESOLVED  ${c.label} - fell through to the status fallback`); continue; }
  if (same !== c.expectSameAsOld) {
    wrongDirection++;
    console.error(`  WRONG       ${c.label} - expected ${c.expectSameAsOld ? 'unchanged' : 'changed'}, got ${same ? 'unchanged' : 'changed'}`);
    continue;
  }
  console.log(`  ${same ? 'same   ' : 'CHANGED'}  ${code}`);
  if (!same) console.log(`      -> ${JSON.stringify(n)}`);
}

if (mismatches > 0) {
  console.error('[check-respond-copy] FAIL - the mobile half is NOT a no-op against a pre-N46 API.');
  process.exit(1);
}
if (unresolved > 0) {
  console.error(`[check-respond-copy] FAIL - ${unresolved} of ${POST_N46.length} post-N46 bodies did not resolve to an enum.`);
  process.exit(1);
}
if (wrongDirection > 0) {
  console.error(`[check-respond-copy] FAIL - ${wrongDirection} body/bodies changed in the wrong direction.`);
  process.exit(1);
}
console.log(`[check-respond-copy] PASS - ${CASES.length}/${CASES.length} identical against a pre-N46 API; ${POST_N46.length}/${POST_N46.length} resolve by enum after it.`);
