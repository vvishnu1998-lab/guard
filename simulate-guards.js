#!/usr/bin/env node
/**
 * V-Wing 24-Hour Simulation Script
 * Guard 1 (John Smith)  — Hours  0–12
 * Guard 2 (Sarah Jones) — Hours 12–24
 *
 * Run: node simulate-guards.js
 */

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const API_BASE = 'https://guard-production-6be4.up.railway.app/api';
const LOG_FILE = path.join(__dirname, 'simulation-log.txt');

const GUARD1 = {
  name:     'John Smith',
  email:    'johnsmith@vwing.sim',
  password: 'Guard123!',
  shiftId:  'c8699b0c-2d36-4bd1-98fd-124a52f5d820',
};
const GUARD2 = {
  name:     'Sarah Jones',
  email:    'sarahjones@vwing.sim',
  password: 'Guard123!',
  shiftId:  '6813eb20-2885-479e-907a-158f94c80a4a',
};

// William Pen Hotel geofence center (lat, lng, radius 5000m)
const SITE_LAT = 37.3318;
const SITE_LNG = -122.0312;

function coords() {
  const jitter = () => (Math.random() - 0.5) * 0.008; // ~450m jitter
  return { lat: SITE_LAT + jitter(), lng: SITE_LNG + jitter() };
}

// ─── Logging ──────────────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(who, action, status, detail = '') {
  const ts  = new Date().toISOString();
  const icon = status === 'OK' ? '✅' : status === 'SKIP' ? '⏭ ' : '❌';
  const line = `[${ts}] ${icon} [${who}] ${action}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function apiRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url     = new URL(API_BASE + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const opts    = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token   ? { 'Authorization': `Bearer ${token}` }          : {}),
      },
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
        } catch {
          reject(new Error(`Parse error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Token refresh ────────────────────────────────────────────────────────────
async function refreshToken(guard) {
  try {
    const res = await apiRequest('POST', '/auth/refresh', { refresh_token: guard._refreshToken });
    const newAccess = res.token || res.access_token || res.access;
    if (!newAccess) throw new Error('No token in refresh response');
    guard._token = newAccess;
    if (res.refresh || res.refresh_token) guard._refreshToken = res.refresh || res.refresh_token;
    log(guard.name, 'Token refreshed', 'OK');
    return newAccess;
  } catch (e) {
    log(guard.name, 'Token refresh failed', 'ERR', e.message);
    return null;
  }
}

// apiRequest with auto-refresh on 401
async function apiCall(guard, method, urlPath, body) {
  try {
    return await apiRequest(method, urlPath, body, guard._token);
  } catch (e) {
    if (e.message.includes('401')) {
      const newToken = await refreshToken(guard);
      if (newToken) return await apiRequest(method, urlPath, body, newToken);
    }
    throw e;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Content pools ────────────────────────────────────────────────────────────
const ACTIVITY_REPORTS = [
  'Patrol round completed. All access points checked and secured. No suspicious activity observed.',
  'Perimeter check done. All doors and windows secured. Lobby area clear.',
  'Routine inspection of parking area and main entrance completed. No persons of concern.',
  'Checked all stairwells and emergency exits. Fire doors properly closed. All clear.',
  'Interior patrol completed. Elevators, corridors and common areas all secure.',
  'External perimeter walk done. Fencing intact. No signs of tampering observed.',
  'Night check completed. All lights functional. CCTV cameras operational.',
  'Final sweep before handover. All zones secure, no incidents to report.',
  'Mid-shift patrol: all zones checked, access control logs reviewed, no anomalies found.',
  'Guard station checks complete. Visitor log up to date. No unauthorized access detected.',
  'Community room, gym and pool area inspected and secured.',
  'Loading dock and service entrance inspected. All locked and secure.',
];

const INCIDENT_REPORTS = [
  'Suspicious individual observed loitering near the east entrance. Approached and questioned — identified as a delivery driver awaiting pickup. Situation resolved without escalation.',
  'Smoke detector alarm triggered in corridor 3B. Investigated and confirmed false alarm caused by steam from cleaning equipment. Alarm reset and maintenance notified.',
  'Vehicle parked in fire lane outside main entrance. Warning notice placed on vehicle. Owner retrieved vehicle within 10 minutes.',
  'Unauthorized access attempt at rear service gate. Gate re-secured and incident logged. Security footage reviewed and preserved.',
  'Guest reported missing personal items from lobby area. Area searched thoroughly. Item located in lost-and-found bin. Resolved and reported.',
];

const MAINTENANCE_REPORTS = [
  'Burnt-out light in stairwell B, level 2. Maintenance work order submitted. Area marked with caution tape pending repair.',
  'Water seepage detected near 3rd floor utility room. Maintenance notified. Area cordoned off to prevent slip hazard.',
  'HVAC unit on roof making unusual noise. Maintenance team notified. Unit still operational pending inspection.',
  'Elevator door sensor reported intermittent malfunction. Maintenance alerted. Elevator taken out of service pending inspection.',
  'Fire extinguisher in lobby found with low pressure indicator. Tagged and reported to facilities manager for replacement.',
];

// ─── Guard runner ─────────────────────────────────────────────────────────────
async function runGuard(guard, startDelayMs) {
  if (startDelayMs > 0) {
    const mins = Math.round(startDelayMs / 60000);
    log(guard.name, `Waiting ${mins} min for shift to start`, 'SKIP');
    await sleep(startDelayMs);
  }

  const HOUR      = 60 * 60 * 1000;
  const HALF_HOUR = 30 * 60 * 1000;
  const SHIFT_MS  = 12 * HOUR;

  // ── 1. Login ──────────────────────────────────────────────────────────────
  try {
    const res = await apiRequest('POST', '/auth/guard/login', {
      email:    guard.email,
      password: guard.password,
    });
    guard._token        = res.token || res.access_token || res.access;
    guard._refreshToken = res.refresh || res.refresh_token;
    if (!guard._token) throw new Error('No token — ' + JSON.stringify(res));
    log(guard.name, 'Login', 'OK');
  } catch (e) {
    log(guard.name, 'Login', 'ERR', e.message);
    return;
  }

  // ── 2. Clock in (or resume existing active session) ──────────────────────
  let sessionId;
  let shiftStartedAt; // actual clock-in time (for elapsed calculation)
  try {
    // Check for existing active session first
    const active = await apiCall(guard, 'GET', '/shifts/active-session', null);
    if (active && active.session && active.shift && active.shift.id === guard.shiftId) {
      sessionId      = active.session.id;
      shiftStartedAt = new Date(active.session.clocked_in_at).getTime();
      log(guard.name, 'Resumed existing session', 'OK',
        `session ${sessionId} (started ${new Date(shiftStartedAt).toISOString()})`);
    } else {
      const c = coords();
      const res = await apiCall(guard, 'POST', `/shifts/${guard.shiftId}/clock-in`, {
        clock_in_coords: `(${c.lat},${c.lng})`,
      });
      sessionId      = res.id;
      shiftStartedAt = Date.now();
      log(guard.name, 'Clock-in', 'OK', `session ${sessionId}`);
    }
  } catch (e) {
    log(guard.name, 'Clock-in', 'ERR', e.message);
    return;
  }

  // ── 3. Fetch auto-generated task instances ────────────────────────────────
  let taskIds = [];
  try {
    await sleep(3000);
    const res = await apiCall(guard, 'GET', `/tasks/instances?shift_id=${guard.shiftId}`, null);
    const pending = (Array.isArray(res) ? res : res.tasks || []).filter(t => t.status === 'pending');
    taskIds = pending.map(t => ({ id: t.id, title: t.title, requiresPhoto: t.requires_photo }));
    log(guard.name, `Task instances fetched`, 'OK', `${taskIds.length} pending`);
  } catch (e) {
    log(guard.name, 'Task fetch', 'ERR', e.message);
  }

  const shiftStart = shiftStartedAt;
  // Estimate how many pings already fired so we continue the alternating sequence
  const alreadyElapsedMs = Date.now() - shiftStart;
  let pingCount    = Math.floor(alreadyElapsedMs / (30 * 60 * 1000));
  let reportCount  = Math.floor(pingCount / 2);
  let taskIdx      = 0;

  // Random hours for one-off reports (within 12h shift)
  const incidentHour    = 1 + Math.floor(Math.random() * 5);  // h1–h5
  const maintenanceHour = 6 + Math.floor(Math.random() * 6);  // h6–h11
  const taskHours       = [2, 7];  // complete a task at h2 and h7 (if available)

  log(guard.name, 'Shift plan', 'OK',
    `incident@h${incidentHour} maintenance@h${maintenanceHour} tasks@h${taskHours.join(',h')}`);

  const done = { incident: false, maintenance: false };
  const taskCompleted = {};

  // ── Main loop — 30-min ticks ──────────────────────────────────────────────
  while (true) {
    const elapsed      = Date.now() - shiftStart;
    const elapsedHours = elapsed / HOUR;

    if (elapsed >= SHIFT_MS) break;

    // GPS ping (alternating gps_photo / gps_only)
    pingCount++;
    const pingType = pingCount % 2 === 1 ? 'gps_photo' : 'gps_only';
    try {
      const c = coords();
      await apiCall(guard, 'POST', '/locations/ping', {
        shift_session_id: sessionId,
        latitude:         c.lat,
        longitude:        c.lng,
        ping_type:        pingType,
        photo_url:        pingType === 'gps_photo' ? 'https://placehold.co/400x300.jpg' : null,
      });
      log(guard.name, `Ping #${pingCount} (${pingType})`, 'OK',
        `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`);
    } catch (e) {
      log(guard.name, `Ping #${pingCount} (${pingType})`, 'ERR', e.message);
    }

    // Activity report every 2nd ping (= every 60 min)
    if (pingCount % 2 === 0) {
      reportCount++;
      try {
        const c    = coords();
        const desc = ACTIVITY_REPORTS[(reportCount - 1) % ACTIVITY_REPORTS.length];
        const res  = await apiCall(guard, 'POST', '/reports', {
          shift_session_id: sessionId,
          report_type:      'activity',
          description:      desc,
          latitude:         c.lat,
          longitude:        c.lng,
        });
        log(guard.name, `Activity report #${reportCount}`, 'OK', `id ${res.id || '?'}`);
      } catch (e) {
        log(guard.name, `Activity report #${reportCount}`, 'ERR', e.message);
      }
    }

    // One-off: incident report
    if (!done.incident && elapsedHours >= incidentHour) {
      done.incident = true;
      try {
        const c    = coords();
        const desc = INCIDENT_REPORTS[Math.floor(Math.random() * INCIDENT_REPORTS.length)];
        const res  = await apiCall(guard, 'POST', '/reports', {
          shift_session_id: sessionId,
          report_type:      'incident',
          severity:         'low',
          description:      desc,
          latitude:         c.lat,
          longitude:        c.lng,
        });
        log(guard.name, 'Incident report', 'OK', `id ${res.id || '?'}`);
      } catch (e) {
        log(guard.name, 'Incident report', 'ERR', e.message);
      }
    }

    // One-off: maintenance report
    if (!done.maintenance && elapsedHours >= maintenanceHour) {
      done.maintenance = true;
      try {
        const c    = coords();
        const desc = MAINTENANCE_REPORTS[Math.floor(Math.random() * MAINTENANCE_REPORTS.length)];
        const res  = await apiCall(guard, 'POST', '/reports', {
          shift_session_id: sessionId,
          report_type:      'maintenance',
          description:      desc,
          latitude:         c.lat,
          longitude:        c.lng,
        });
        log(guard.name, 'Maintenance report', 'OK', `id ${res.id || '?'}`);
      } catch (e) {
        log(guard.name, 'Maintenance report', 'ERR', e.message);
      }
    }

    // Task completions at h2 and h7
    for (const tHour of taskHours) {
      if (!taskCompleted[tHour] && elapsedHours >= tHour && taskIdx < taskIds.length) {
        taskCompleted[tHour] = true;
        const task = taskIds[taskIdx++];
        try {
          const c = coords();
          await apiCall(guard, 'POST', `/tasks/instances/${task.id}/complete`, {
            shift_session_id: sessionId,
            completion_lat:   c.lat,
            completion_lng:   c.lng,
            ...(task.requiresPhoto ? { photo_url: 'https://placehold.co/400x300.jpg' } : {}),
          });
          log(guard.name, `Task complete: "${task.title}"`, 'OK');
        } catch (e) {
          log(guard.name, `Task complete: "${task.title}"`, 'ERR', e.message);
        }
      }
    }

    // Wait until next 30-min tick
    const elapsedNow = Date.now() - shiftStart;
    const nextTick   = HALF_HOUR - (elapsedNow % HALF_HOUR);
    const remaining  = SHIFT_MS - elapsedNow;
    const waitMs     = Math.min(nextTick, remaining);

    if (waitMs > 5000) {
      log(guard.name, `Sleeping ${Math.round(waitMs / 60000)} min until next action`, 'SKIP');
      await sleep(waitMs);
    }
  }

  // ── 4. Clock out ──────────────────────────────────────────────────────────
  try {
    await apiCall(guard, 'POST', `/shifts/${guard.shiftId}/clock-out`, {
      handover_notes:
        'Shift completed without major incidents. Site is secure. All access points checked. Logs up to date.',
    });
    log(guard.name, 'Clock-out', 'OK', '12-hour shift complete ✓');
  } catch (e) {
    log(guard.name, 'Clock-out', 'ERR', e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const HOUR = 60 * 60 * 1000;
  log('SIM', '24-hour V-Wing simulation starting', 'OK',
    `G1=${GUARD1.name}  G2=${GUARD2.name}`);
  log('SIM', `Log → ${LOG_FILE}`, 'OK');

  // Both guards run in parallel; Guard 2 waits 12 h before starting
  await Promise.all([
    runGuard(GUARD1, 0),
    runGuard(GUARD2, 12 * HOUR),
  ]);

  log('SIM', '24-hour simulation complete', 'OK');
  logStream.end();
}

main().catch(e => {
  log('SIM', 'Fatal', 'ERR', e.message);
  logStream.end();
  process.exit(1);
});
