/**
 * Email service — all outbound emails via SendGrid.
 *
 * Email types (Section 4):
 *  1. Incident Alert       — immediate, to client on incident report
 *  2. Daily Shift Report   — 9:00 AM next morning, to client + primary admin
 *  3. Retention Notice     — monthly / milestone, to client + primary admin
 *  4. Vishnu Day-140 Warn  — 10 days before hard-delete, to VISHNU_EMAIL
 */

import sgMail from '@sendgrid/mail';
import { pool } from '../db/pool';
import { haversineDistance } from './geofence';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const FROM   = process.env.SENDGRID_FROM_EMAIL ?? 'alerts@netraops.com';
const PORTAL = process.env.CLIENT_PORTAL_URL ?? '';
// Base URL for admin-portal deep links in operator alerts. CLIENT_PORTAL_URL
// historically pointed at a stale Vercel preview; this is the canonical
// production web app and is independent of the client portal path.
const WEB_BASE = process.env.WEB_PORTAL_URL ?? 'https://app.netraops.com';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function fmtDT(dt: Date | string): string {
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

// Pacific-time formatter for operator alerts (currently used only by the
// missed-shift email). Hardcoded to America/Los_Angeles — works for Starnet
// because William Pen Hotel is in SF. Multi-tenant support requires a
// per-site timezone column (logged as a separate follow-up). Output looks
// like "17 May 2026, 10:01 PM PDT" / "PST" with the abbreviation chosen by
// the runtime per DST.
function fmtDTPacific(dt: Date | string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  }).formatToParts(new Date(dt));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('day')} ${pick('month')} ${pick('year')}, ` +
         `${pick('hour')}:${pick('minute')} ${pick('dayPeriod')} ${pick('timeZoneName')}`;
}

// Coarse "X units ago" for human readability in operator alerts.
// Null → "Never" (used for guards who have never logged in).
function relTime(d: Date | string | null | undefined): string {
  if (!d) return 'Never';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 0)               return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)             return `${sec} sec ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)             return `${min} min ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)             return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30)             return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo  = Math.floor(day / 30);
  if (mo  < 12)             return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr  = Math.floor(mo / 12);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}

function typeBadgeHtml(type: string, severity?: string | null): string {
  const colors: Record<string, string> = {
    activity: '#D97706', incident: '#DC2626', maintenance: '#2563EB',
  };
  const sevColors: Record<string, string> = {
    critical: '#DC2626', high: '#EA580C', medium: '#CA8A04', low: '#6B7280',
  };
  const bg = colors[type] ?? '#6B7280';
  const sevSpan = severity
    ? ` <span style="color:${sevColors[severity] ?? '#6B7280'};font-size:11px;font-weight:bold">${severity.toUpperCase()}</span>`
    : '';
  return `<span style="background:${bg};color:#fff;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:bold">${type.toUpperCase()}</span>${sevSpan}`;
}

const BASE_STYLE = `
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:20px}
  .card{background:#fff;border-radius:8px;max-width:640px;margin:0 auto;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  .hdr{background:#0B1526;color:#F59E0B;padding:24px 28px}
  .hdr h1{margin:0;font-size:22px;letter-spacing:3px}
  .brand{font-size:11px;color:#F59E0B;letter-spacing:4px;font-weight:700;margin-bottom:6px}
  .hdr p{margin:4px 0 0;color:#888;font-size:12px;letter-spacing:2px}
  .body{padding:24px 28px}
  .meta{color:#666;font-size:13px;margin-bottom:20px;border-bottom:1px solid #eee;padding-bottom:14px}
  .kpi{display:inline-block;background:#f5f5f5;border-radius:6px;padding:10px 20px;margin:4px 8px 4px 0;text-align:center}
  .kpi .n{font-size:26px;font-weight:700;color:#0B1526}
  .kpi .l{font-size:10px;color:#999;letter-spacing:1px}
  .rrow{border-left:3px solid;padding:10px 14px;margin:8px 0;background:#fafafa;border-radius:0 6px 6px 0}
  .rrow p{margin:3px 0;font-size:13px}
  .footer{background:#f5f5f5;padding:14px 28px;font-size:11px;color:#aaa;text-align:center}
  a.btn{display:inline-block;background:#F59E0B;color:#0B1526;font-weight:700;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:1px;font-size:13px;margin-top:16px}
`;

// ── Email Type 1 — Incident Alert ─────────────────────────────────────────────

export async function sendIncidentAlert(
  report: { id: string; description: string; severity: string; reported_at: Date },
  siteId: string,
) {
  const result = await pool.query(
    `SELECT s.name AS site_name, c.email AS client_email
     FROM sites s JOIN clients c ON c.site_id = s.id
     WHERE s.id = $1 AND c.is_active = true`,
    [siteId],
  );
  // G2: log result for Railway diagnostics
  if (!result.rows[0]) {
    console.warn(`[email] sendIncidentAlert: no active client found for site_id=${siteId} — email not sent`);
    return;
  }
  const { site_name, client_email } = result.rows[0];
  console.log(`[email] sendIncidentAlert: sending to ${client_email} for site=${site_name} (report=${report.id})`);

  const sevColors: Record<string, string> = {
    critical: '#DC2626', high: '#EA580C', medium: '#CA8A04', low: '#6B7280',
  };
  const sevColor = sevColors[report.severity] ?? '#6B7280';

  try {
    await sgMail.send({
      to: client_email,
      from: FROM,
      subject: `🚨 Incident Alert — ${site_name} [${report.severity.toUpperCase()}]`,
      html: `<style>${BASE_STYLE}</style>
      <div class="card">
        <div class="hdr" style="background:#7F1D1D">
          <h1>INCIDENT ALERT</h1><p>${site_name.toUpperCase()}</p>
        </div>
        <div class="body">
          <div class="meta">
            <strong>Date/Time:</strong> ${fmtDT(report.reported_at)}<br/>
            <strong>Severity:</strong> <span style="color:${sevColor};font-weight:bold">${report.severity.toUpperCase()}</span>
          </div>
          <p style="font-size:14px;color:#333;line-height:1.6">${report.description}</p>
          <a class="btn" href="${PORTAL}">View in Client Portal</a>
        </div>
        <div class="footer">NetraOps — Confidential</div>
      </div>`,
    });
    console.log(`[email] sendIncidentAlert: SUCCESS — delivered to ${client_email}`);
  } catch (err: any) {
    console.error(`[email] sendIncidentAlert: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    throw err;
  }
}

// ── Email Type 2 — Daily Shift Report ────────────────────────────────────────

// Pacific-locked calendar date for the subject/header ("14 May 2026").
// en-GB to match fmtDTPacific's "14 May 2026, 10:01 PM PDT" — keeps subject
// and body day-month-year order consistent.
function fmtDatePacific(dt: Date | string): string {
  return new Date(dt).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

// Title-cases each whitespace-delimited word. "james vince" → "James Vince".
// Common-name edge cases (McDonald, O'Brien, hyphens) intentionally not
// handled — accepted limitation for the first pass.
function titleCase(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// First-name extractor for the greeting. "david payne" → "David".
function firstName(fullName: string | null | undefined): string {
  if (!fullName) return 'there';
  return titleCase(fullName).split(' ')[0] || 'there';
}

export async function sendDailyShiftReport(shiftId: string) {
  // company_admins is LEFT-joined (was inner) — primary admin's email is used
  // as Reply-To only, not a recipient. If no primary admin exists, the email
  // still ships to the client without a Reply-To override.
  const shiftResult = await pool.query(
    `SELECT sh.id, sh.scheduled_start,
            si.name     AS site_name,
            g.name      AS guard_name,
            g.badge_number,
            c.name      AS client_name,
            c.email     AS client_email,
            co.name     AS company_name,
            ca.email    AS admin_reply_to
     FROM shifts sh
     JOIN sites          si ON si.id = sh.site_id
     JOIN guards         g  ON g.id  = sh.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
     LEFT JOIN company_admins ca ON ca.company_id = co.id AND ca.is_primary = true
     WHERE sh.id = $1 AND sh.daily_report_email_sent = false`,
    [shiftId],
  );
  if (!shiftResult.rows[0]) return;
  const sh = shiftResult.rows[0];

  // No active client → nothing to send. Flag the row anyway so the cron does
  // not retry this shift every morning forever.
  if (!sh.client_email) {
    console.log(`[email] sendDailyShiftReport: skipped — no active client for site "${sh.site_name}" (shift ${shiftId})`);
    await pool.query(
      'UPDATE shifts SET daily_report_email_sent = true, daily_report_email_sent_at = NOW() WHERE id = $1',
      [shiftId],
    );
    return;
  }

  const sessionResult = await pool.query(
    `SELECT id, clocked_in_at, clocked_out_at,
            ROUND(CAST(total_hours AS NUMERIC), 2) AS total_hours
     FROM shift_sessions WHERE shift_id = $1 ORDER BY clocked_in_at DESC LIMIT 1`,
    [shiftId],
  );
  const session = sessionResult.rows[0];

  const [reportsResult, tasksResult, taskTotalResult] = await Promise.all([
    pool.query(
      `SELECT report_type, severity, description, reported_at
       FROM reports WHERE shift_session_id = $1 ORDER BY reported_at ASC`,
      [session?.id],
    ),
    pool.query(
      `SELECT COUNT(*) AS completed FROM task_completions WHERE shift_session_id = $1`,
      [session?.id],
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM task_instances WHERE shift_id = $1`,
      [shiftId],
    ),
  ]);

  const { subject, html } = renderDailyShiftReport({
    site_name:       sh.site_name,
    scheduled_start: sh.scheduled_start,
    guard_name:      sh.guard_name,
    badge_number:    sh.badge_number,
    client_name:     sh.client_name,
    company_name:    sh.company_name,
    clocked_in_at:   session?.clocked_in_at ?? null,
    clocked_out_at:  session?.clocked_out_at ?? null,
    total_hours:     session?.total_hours ?? null,
    reports:         reportsResult.rows,
    tasks_completed: parseInt(tasksResult.rows[0]?.completed ?? 0),
    tasks_total:     parseInt(taskTotalResult.rows[0]?.total ?? 0),
  });

  const sendOpts: sgMail.MailDataRequired = {
    to:      sh.client_email,
    from:    FROM,
    subject,
    html,
  };
  if (sh.admin_reply_to) sendOpts.replyTo = sh.admin_reply_to;

  await sgMail.send(sendOpts);

  await pool.query(
    'UPDATE shifts SET daily_report_email_sent = true, daily_report_email_sent_at = NOW() WHERE id = $1',
    [shiftId],
  );
}

/**
 * Pure renderer for the daily shift report. Exported so the test-send script
 * can render the same template against real shift data without invoking the
 * SendGrid path or writing daily_report_email_sent.
 *
 * All event timestamps render in America/Los_Angeles via fmtDTPacific (PDT in
 * summer, PST in winter — abbreviation chosen by the runtime). Multi-tenant
 * per-site timezone support is logged as a separate follow-up.
 */
export function renderDailyShiftReport(data: {
  site_name:       string;
  scheduled_start: Date | string;
  guard_name:      string;
  badge_number:    string;
  client_name:     string | null;
  company_name:    string;
  clocked_in_at:   Date | string | null;
  clocked_out_at:  Date | string | null;
  total_hours:     string | number | null;
  reports:         Array<{ report_type: string; severity: string | null; description: string; reported_at: Date | string }>;
  tasks_completed: number;
  tasks_total:     number;
}): { subject: string; html: string } {
  const dateLabel  = fmtDatePacific(data.scheduled_start);
  const totalHours = data.total_hours != null
    ? `${parseFloat(String(data.total_hours))}h`
    : '—';
  const clockIn    = data.clocked_in_at  ? fmtDTPacific(data.clocked_in_at)  : '—';
  const clockOut   = data.clocked_out_at ? fmtDTPacific(data.clocked_out_at) : 'In progress';
  const greetName  = firstName(data.client_name);

  const borderColors: Record<string, string> = {
    activity: '#D97706', incident: '#DC2626', maintenance: '#2563EB',
  };
  const reportRows = data.reports.map((r) => {
    const desc = r.description.length > 300 ? r.description.slice(0, 300) + '…' : r.description;
    return `<div class="rrow" style="border-left-color:${borderColors[r.report_type] ?? '#ccc'}">
      <p style="margin:0 0 6px 0">${typeBadgeHtml(r.report_type, r.severity)} <span style="color:#888;font-size:12px;margin-left:6px">${fmtDTPacific(r.reported_at)}</span></p>
      <p style="margin:0;color:#333;font-size:13px;line-height:1.55">${desc}</p>
    </div>`;
  }).join('');

  const incidentCount = data.reports.filter((r) => r.report_type === 'incident').length;
  const incidentNote  = incidentCount > 0
    ? `<p style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:11px 14px;color:#B91C1C;font-size:13px;margin:18px 0 6px 0">
        ⚠️ ${incidentCount} incident report${incidentCount > 1 ? 's' : ''} filed during this shift.
       </p>`
    : '';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr">
      <div class="brand">NETRAOPS</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">Shift Report</h1>
      <p style="color:#F59E0B;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${data.site_name} · ${dateLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#333;margin:0 0 4px 0">Hi ${greetName},</p>
      <p style="color:#555;font-size:14px;margin:0 0 22px 0">Here is the shift summary for your site.</p>

      <div style="text-align:center;margin-bottom:22px">
        <div class="kpi"><div class="n">${totalHours}</div><div class="l">HOURS</div></div>
        <div class="kpi"><div class="n">${data.reports.length}</div><div class="l">REPORTS</div></div>
        <div class="kpi"><div class="n">${data.tasks_completed}/${data.tasks_total}</div><div class="l">TASKS</div></div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-bottom:4px">
        <tr><td style="padding:6px 0;color:#888;width:110px">Guard</td><td style="padding:6px 0">${titleCase(data.guard_name)} <span style="color:#888">(${data.badge_number})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">Clock-in</td><td style="padding:6px 0">${clockIn}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Clock-out</td><td style="padding:6px 0">${clockOut}</td></tr>
      </table>

      ${incidentNote}

      ${data.reports.length > 0
        ? `<h3 style="margin:22px 0 10px 0;font-size:15px;color:#333;font-weight:600;letter-spacing:0">Reports</h3>${reportRows}`
        : `<p style="color:#888;font-size:14px;margin-top:22px;font-style:italic">No reports filed during this shift.</p>`}

      <div style="text-align:center;margin-top:28px">
        <a class="btn" href="${PORTAL}">View Full Report in Portal</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in Pacific Time.<br/>
      Provided by <strong style="color:#666">${data.company_name}</strong>.<br/>
      Reply to this email to contact ${data.company_name}.
    </div>
  </div>`;

  const subject = `Shift Report — ${data.site_name} — ${dateLabel}`;
  return { subject, html };
}

// ── Email Type 3 — Data Retention Notice ─────────────────────────────────────

export async function sendRetentionNotice(
  siteId: string,
  daysRemaining: number,
  milestone: 'day60' | 'day89' | 'monthly' = 'monthly',
) {
  const result = await pool.query(
    `SELECT si.name AS site_name,
            c.email AS client_email,
            ca.email AS admin_email,
            drl.data_delete_at,
            drl.client_star_access_until
     FROM sites si
     LEFT JOIN clients c    ON c.site_id = si.id
     JOIN companies co      ON co.id = si.company_id
     JOIN company_admins ca ON ca.company_id = co.id AND ca.is_primary = true
     JOIN data_retention_log drl ON drl.site_id = si.id
     WHERE si.id = $1`,
    [siteId],
  );
  if (!result.rows[0]) return;
  const { site_name, client_email, admin_email, data_delete_at, client_star_access_until } = result.rows[0];

  const accessUntil = new Date(client_star_access_until).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const deleteDate  = new Date(data_delete_at).toLocaleDateString('en-GB',          { day: '2-digit', month: 'short', year: 'numeric' });
  const isUrgent    = daysRemaining <= 30;

  const subjectPfx  = milestone === 'day89' ? '⚠️ Final Access Warning' :
                      isUrgent              ? '⚠️ Data Retention Notice' :
                                              'Data Retention Notice';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr" style="background:${isUrgent ? '#7F1D1D' : '#0B1526'}">
      <h1>DATA RETENTION NOTICE</h1><p>${site_name.toUpperCase()}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#333">
        Portal access for <strong>${site_name}</strong> will expire on
        <strong style="color:${isUrgent ? '#DC2626' : '#D97706'}">${accessUntil}</strong>.
        All site data will be permanently deleted on <strong>${deleteDate}</strong>.
      </p>
      <div style="margin:20px 0">
        <div class="kpi" style="background:${isUrgent ? '#FEF2F2' : '#FFFBEB'}">
          <div class="n" style="color:${isUrgent ? '#DC2626' : '#D97706'}">${daysRemaining}</div>
          <div class="l">DAYS REMAINING</div>
        </div>
      </div>
      <p style="color:#666;font-size:13px">
        Please download all reports you wish to keep before access is disabled.
        After the deletion date, this data cannot be recovered.
      </p>
      <a class="btn" href="${PORTAL}/download">Download Reports Now</a>
    </div>
    <div class="footer">NetraOps — Confidential</div>
  </div>`;

  const recipients = [client_email, admin_email].filter(Boolean) as string[];
  if (recipients.length === 0) return;

  await sgMail.sendMultiple({
    to: recipients,
    from: FROM,
    subject: `${subjectPfx} — ${site_name} (${daysRemaining} days)`,
    html,
  });
}

// ── Email Type 5 — Missed Shift Alert ────────────────────────────────────────

export async function sendMissedShiftAlert(shiftId: string) {
  // SELECT: kept primary-admin-only (ca.is_primary = true) per spec; client_email
  // still SELECTed but discarded (intentional — clients are not on this email).
  // New fields: sh.scheduled_end, si.address, last_login_at (from auth_events),
  // upcoming_shifts_count (count of this guard's other scheduled shifts in the
  // next 24h, excluding the current missed one).
  const result = await pool.query(
    `SELECT sh.id,
            sh.scheduled_start,
            sh.scheduled_end,
            sh.guard_id,
            si.name        AS site_name,
            si.address     AS site_address,
            g.name         AS guard_name,
            g.badge_number,
            g.phone_number AS guard_phone,
            c.email        AS client_email,
            ca.email       AS admin_email,
            (SELECT MAX(created_at) FROM auth_events
              WHERE actor_id = g.id AND event_type = 'login_success'
            ) AS last_login_at,
            (SELECT COUNT(*) FROM shifts s2
              WHERE s2.guard_id = g.id
                AND s2.id      != sh.id
                AND s2.status   = 'scheduled'
                AND s2.scheduled_start BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
            ) AS upcoming_shifts_count
     FROM shifts sh
     JOIN sites          si ON si.id = sh.site_id
     JOIN guards         g  ON g.id  = sh.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
     JOIN company_admins ca ON ca.company_id = co.id AND ca.is_primary = true
     WHERE sh.id = $1`,
    [shiftId],
  );
  if (!result.rows[0]) return;
  const {
    scheduled_start, scheduled_end, site_name, site_address,
    guard_name, badge_number, guard_phone,
    admin_email, last_login_at, upcoming_shifts_count,
  } = result.rows[0];

  if (!admin_email) return;

  const { subject, html } = renderMissedShiftAlert(result.rows[0]);

  await sgMail.send({ to: admin_email, from: FROM, subject, html });

  await pool.query(
    'UPDATE shifts SET missed_alert_sent_at = NOW() WHERE id = $1',
    [shiftId],
  );
}

/**
 * Pure renderer for the missed-shift alert. Exported so testing scripts can
 * exercise the same template against real production rows without invoking
 * the SendGrid send path or writing missed_alert_sent_at.
 *
 * Input: the row shape returned by sendMissedShiftAlert's SELECT.
 * Output: { subject, html } — the caller is responsible for the To: address.
 */
export function renderMissedShiftAlert(row: {
  id:              string;
  scheduled_start: Date | string;
  scheduled_end:   Date | string;
  site_name:       string;
  site_address:    string;
  guard_name:      string;
  badge_number:    string;
  guard_phone:     string | null;
  last_login_at:   Date | string | null;
  upcoming_shifts_count: number | string;
}): { subject: string; html: string } {
  // Minutes late computed at render time (cron fires at T+10 min minimum, but
  // actual delay can be 10–15 min depending on the */5 tick alignment).
  const minutesLate = Math.max(0, Math.floor(
    (Date.now() - new Date(row.scheduled_start).getTime()) / 60_000
  ));

  // Reassign deep link to the admin shift-detail page. WEB_BASE comes from
  // process.env.WEB_PORTAL_URL with a hardcoded fallback to the canonical
  // production web app (set in code so a missing env var doesn't break the
  // alert). Note: the /admin/shifts/:id route is planned for Improvement 2
  // and does not exist in apps/web today — until that ships the link 404s.
  const reassignUrl = `${WEB_BASE}/admin/shifts/${row.id}`;

  const upcoming = Number(row.upcoming_shifts_count) || 0;
  const upcomingText = upcoming === 0
    ? `No other upcoming shifts in the next 24h — calling may not get coverage.`
    : `${upcoming} other upcoming shift${upcoming === 1 ? '' : 's'} in the next 24h.`;

  const phoneRow = row.guard_phone
    ? `<br/><strong>Phone:</strong> <a href="tel:${row.guard_phone}" style="color:#0B1526;text-decoration:underline">${row.guard_phone}</a>`
    : '';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr" style="background:#7F1D1D">
      <h1>MISSED SHIFT ALERT</h1><p>${row.site_name.toUpperCase()} — ${minutesLate} MIN LATE</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#DC2626;font-weight:bold;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:12px 16px;margin-top:0">
        ⚠️ ${row.guard_name} has not clocked in. ${minutesLate} minutes past the scheduled start.
      </p>

      <div class="meta">
        <strong>Site:</strong> ${row.site_name}<br/>
        <strong>Address:</strong> ${row.site_address}<br/>
        <strong>Scheduled Start:</strong> ${fmtDTPacific(row.scheduled_start)}<br/>
        <strong>Scheduled End:</strong> ${fmtDTPacific(row.scheduled_end)}
      </div>

      <div class="meta">
        <strong>Guard:</strong> ${row.guard_name} (${row.badge_number})${phoneRow}<br/>
        <strong>Last opened app:</strong> ${relTime(row.last_login_at)}<br/>
        <strong>Coverage availability:</strong> ${upcomingText}
      </div>

      <p style="color:#555;font-size:13px;margin-top:14px">
        Please contact the guard immediately or reassign the shift to another guard at <strong>${row.site_name}</strong>.
      </p>
      <a class="btn" href="${reassignUrl}">Reassign Guard</a>
    </div>
    <div class="footer">NetraOps — Automated Alert</div>
  </div>`;

  const subject = `⚠️ MISSED SHIFT — ${row.site_name} — ${row.guard_name} is ${minutesLate} min late`;
  return { subject, html };
}

// ── Email Type 6b — Temporary Password (forgot-password flow) ────────────────

/**
 * Sends a one-shot temporary password to the user. The caller is responsible
 * for setting must_change_password=true and writing the hash to the user row
 * before invoking this — we just deliver the plaintext.
 */
export async function sendTempPasswordEmail(
  email: string,
  tempPassword: string,
  portal: 'admin' | 'client' | 'guard',
) {
  const portalLabels: Record<string, string> = {
    admin: 'Admin Dashboard',
    client: 'Client Portal',
    guard: 'Guard App',
  };
  const label = portalLabels[portal] ?? 'Portal';

  await sgMail.send({
    to: email,
    from: FROM,
    subject: 'NetraOps password reset',
    html: `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>PASSWORD RESET</h1>
        <p>${label.toUpperCase()}</p>
      </div>
      <div class="body">
        <p style="font-size:15px;color:#333;margin-bottom:20px">
          We received a request to reset your NetraOps <strong>${label}</strong> password.
        </p>
        <p style="color:#555;font-size:13px;margin-bottom:8px">
          Your temporary password is:
        </p>
        <div style="background:#0B1526;color:#F59E0B;font-family:'SF Mono','Menlo',monospace;font-size:22px;letter-spacing:4px;padding:14px 20px;border-radius:8px;text-align:center;margin-bottom:20px">
          ${tempPassword}
        </div>
        <p style="color:#DC2626;font-size:13px;font-weight:600;margin-bottom:20px">
          You will be required to change this on next login.
        </p>
        <p style="color:#999;font-size:12px;margin-top:16px">
          If you didn't request this, contact your administrator immediately.
        </p>
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`,
  });
}

// ── Email Type 6 — Password Reset (legacy reset-link flow, kept for back-compat) ─

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
  portal: 'admin' | 'client' | 'vishnu',
) {
  const portalLabels: Record<string, string> = {
    admin: 'Admin Dashboard',
    client: 'Client Portal',
    vishnu: 'Super Admin',
  };
  const accentColors: Record<string, string> = {
    admin: '#F59E0B',
    client: '#6699FF',
    vishnu: '#FFFFFF',
  };
  const label  = portalLabels[portal] ?? 'Portal';
  const accent = accentColors[portal] ?? '#F59E0B';

  await sgMail.send({
    to: email,
    from: FROM,
    subject: `Reset your Netra ${label} password`,
    html: `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>PASSWORD RESET</h1>
        <p>${label.toUpperCase()}</p>
      </div>
      <div class="body">
        <p style="font-size:15px;color:#333;margin-bottom:20px">
          We received a request to reset the password for your Netra <strong>${label}</strong> account.
        </p>
        <p style="color:#555;font-size:13px;margin-bottom:20px">
          Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
        </p>
        <a href="${resetUrl}" style="display:inline-block;background:${accent};color:${portal === 'vishnu' ? '#0B1526' : '#0B1526'};font-weight:700;padding:12px 28px;border-radius:6px;text-decoration:none;letter-spacing:1px;font-size:14px;margin-bottom:24px">
          RESET PASSWORD
        </a>
        <p style="color:#999;font-size:12px;margin-top:16px">
          If you didn't request this, you can safely ignore this email. Your password will not change.
        </p>
        <p style="color:#bbb;font-size:11px;margin-top:8px;word-break:break-all">
          Or copy this link: ${resetUrl}
        </p>
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`,
  });
}

// ── Email Type 4 — Vishnu Day-140 Hard-Delete Warning ────────────────────────

export async function sendVishnu140DayWarning(siteId: string, daysRemaining: number) {
  const result = await pool.query(
    `SELECT si.name AS site_name, co.name AS company_name, drl.data_delete_at
     FROM sites si
     JOIN companies co ON co.id = si.company_id
     JOIN data_retention_log drl ON drl.site_id = si.id
     WHERE si.id = $1`,
    [siteId],
  );
  if (!result.rows[0]) return;
  const { site_name, company_name, data_delete_at } = result.rows[0];
  const deleteDate = new Date(data_delete_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  await sgMail.send({
    to: process.env.VISHNU_EMAIL!,
    from: FROM,
    subject: `⚠️ Site Data Deletes in ${daysRemaining} Days — ${site_name} (${company_name})`,
    html: `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr" style="background:#7F1D1D">
        <h1>DATA DELETION WARNING</h1><p>VISHNU ADMIN ALERT</p>
      </div>
      <div class="body">
        <div class="meta">
          <strong>Company:</strong> ${company_name}<br/>
          <strong>Site:</strong> ${site_name}<br/>
          <strong>Site ID:</strong> <code style="background:#f5f5f5;padding:1px 5px;border-radius:3px">${siteId}</code><br/>
          <strong>Deletion Date:</strong> ${deleteDate}
        </div>
        <p style="font-size:15px;color:#333">
          The nightly purge will <span style="color:#DC2626;font-weight:bold">permanently hard-delete
          all data for this site in ${daysRemaining} days</span>.
        </p>
        <p style="color:#666;font-size:13px">
          Review the Vishnu admin panel to confirm no action is required before deletion proceeds.
          This warning fires once, 10 days before the scheduled deletion date.
        </p>
      </div>
      <div class="footer">NetraOps — Internal Alert</div>
    </div>`,
  });
}

// ── Email Type 5 — Geofence Breach Alert (T1-D, 2026-05-17 audit) ────────────
//
// Fires from fireBreachAlerts in routes/locations.ts when a fresh
// geofence_violations row is INSERTed. Two contexts as of T2-D:
//   kind='ping'   — guard ping fired off-post (Wave A default)
//   kind='report' — guard filed a report from off-post (T2-D)
// Subject + body branch on context.
//
// Recipient policy mirrors sendMissedShiftAlert: primary company admin
// only. client_email is SELECTed but discarded — opt-in client breach
// alerts would need a per-site flag (out of scope; logged as follow-up).
//
// Best-effort: callers wrap in .catch() to keep alert dispatch
// non-blocking on email failures.

export interface BreachAlertContext {
  kind: 'ping' | 'report';
  /** Required when kind === 'report'. e.g. 'activity', 'incident', 'maintenance'. */
  reportType?: string;
}

export async function sendGeofenceBreachAlert(
  violationId: string,
  context: BreachAlertContext = { kind: 'ping' },
): Promise<void> {
  const result = await pool.query(
    `SELECT v.id, v.violation_lat, v.violation_lng, v.occurred_at, v.photo_url,
            v.shift_session_id,
            si.name      AS site_name,
            si.address   AS site_address,
            sg.center_lat,
            sg.center_lng,
            g.name       AS guard_name,
            g.badge_number,
            c.email      AS client_email,
            ca.email     AS admin_email
     FROM geofence_violations v
     JOIN sites          si ON si.id = v.site_id
     LEFT JOIN site_geofence sg ON sg.site_id = si.id
     JOIN guards         g  ON g.id  = v.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
     JOIN company_admins ca ON ca.company_id = co.id AND ca.is_primary = true
     WHERE v.id = $1`,
    [violationId],
  );
  if (!result.rows[0]) return;
  const row = result.rows[0];
  if (!row.admin_email) return;

  const { subject, html } = renderGeofenceBreachAlert(row, context);

  await sgMail.send({ to: row.admin_email, from: FROM, subject, html });
}

/**
 * Pure renderer for the geofence-breach alert. Exported so testing scripts
 * can render against real production rows without the SendGrid send path.
 * Context switches subject + header + body framing:
 *   kind='ping'   — guard ping fired off-post (Wave A default)
 *   kind='report' — guard filed a {reportType} report from off-post (T2-D)
 */
export function renderGeofenceBreachAlert(row: {
  id:               string;
  shift_session_id: string;
  occurred_at:      Date | string;
  violation_lat:    number;
  violation_lng:    number;
  photo_url:        string | null;
  site_name:        string;
  site_address:     string;
  center_lat:       number | null;
  center_lng:       number | null;
  guard_name:       string;
  badge_number:     string;
}, context: BreachAlertContext = { kind: 'ping' }): { subject: string; html: string } {
  const distanceM =
    row.center_lat != null && row.center_lng != null
      ? Math.round(
          haversineDistance(row.violation_lat, row.violation_lng, row.center_lat, row.center_lng),
        )
      : null;

  const isReport = context.kind === 'report';
  const reportTypeLabel = context.reportType ?? 'report';

  const subject = isReport
    ? `⚠️ Off-post report — ${row.guard_name} filed ${reportTypeLabel} away from ${row.site_name}`
    : `⚠️ Geofence breach — ${row.guard_name} off-site at ${row.site_name}`;

  const headerTitle = isReport ? 'OFF-POST REPORT' : 'GEOFENCE BREACH';
  const headerSub   = isReport ? 'FILED FROM OFF-SITE' : 'GUARD OFF-SITE';

  const bodyFraming = isReport
    ? `The guard submitted a ${reportTypeLabel} report while outside the permitted boundary. The report was accepted and saved; this alert flags the off-post submission for review.`
    : `The guard was outside the permitted boundary when this alert fired. The breach auto-resolves when they return inside the post; no admin action required unless the situation persists.`;

  const distanceLine =
    distanceM != null
      ? `<strong>Distance from post:</strong> ${distanceM} meters`
      : `<strong>Distance from post:</strong> <em>(site geofence center not configured)</em>`;

  const photoBlock = row.photo_url
    ? `<p><strong>Photo at breach:</strong> <a href="${row.photo_url}">View captured photo</a></p>`
    : `<p><em>No photo captured at breach.</em></p>`;

  const deepLink = `${WEB_BASE}/admin/live-map`;

  const html = `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr" style="background:#7F1D1D">
        <h1>${headerTitle}</h1><p>${headerSub}</p>
      </div>
      <div class="body">
        <div class="meta">
          <strong>Guard:</strong> ${row.guard_name} (${row.badge_number})<br/>
          <strong>Site:</strong> ${row.site_name}<br/>
          <strong>Address:</strong> ${row.site_address}<br/>
          <strong>Time:</strong> ${fmtDTPacific(row.occurred_at)}<br/>
          ${distanceLine}<br/>
          <strong>Coords:</strong>
          <code style="background:#f5f5f5;padding:1px 5px;border-radius:3px">${row.violation_lat.toFixed(6)}, ${row.violation_lng.toFixed(6)}</code>
        </div>
        ${photoBlock}
        <a href="${deepLink}" style="display:inline-block;background:#DC2626;color:#fff;font-weight:700;padding:12px 28px;border-radius:6px;text-decoration:none;letter-spacing:1px;font-size:14px;margin-top:12px">
          VIEW LIVE STATUS
        </a>
        <p style="color:#666;font-size:13px;margin-top:20px">
          ${bodyFraming}
        </p>
      </div>
      <div class="footer">NetraOps — Operator Alert</div>
    </div>`;

  return { subject, html };
}
