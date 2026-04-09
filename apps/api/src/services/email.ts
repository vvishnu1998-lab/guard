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

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const FROM   = process.env.SENDGRID_FROM_EMAIL!;
const PORTAL = process.env.CLIENT_PORTAL_URL ?? '';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function fmtDT(dt: Date | string): string {
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
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
  .hdr{background:#1A1A2E;color:#F59E0B;padding:24px 28px}
  .hdr h1{margin:0;font-size:22px;letter-spacing:3px}
  .brand{font-size:11px;color:#F59E0B;letter-spacing:4px;font-weight:700;margin-bottom:6px}
  .hdr p{margin:4px 0 0;color:#888;font-size:12px;letter-spacing:2px}
  .body{padding:24px 28px}
  .meta{color:#666;font-size:13px;margin-bottom:20px;border-bottom:1px solid #eee;padding-bottom:14px}
  .kpi{display:inline-block;background:#f5f5f5;border-radius:6px;padding:10px 20px;margin:4px 8px 4px 0;text-align:center}
  .kpi .n{font-size:26px;font-weight:700;color:#1A1A2E}
  .kpi .l{font-size:10px;color:#999;letter-spacing:1px}
  .rrow{border-left:3px solid;padding:10px 14px;margin:8px 0;background:#fafafa;border-radius:0 6px 6px 0}
  .rrow p{margin:3px 0;font-size:13px}
  .footer{background:#f5f5f5;padding:14px 28px;font-size:11px;color:#aaa;text-align:center}
  a.btn{display:inline-block;background:#F59E0B;color:#1A1A2E;font-weight:700;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:1px;font-size:13px;margin-top:16px}
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
  if (!result.rows[0]) return;
  const { site_name, client_email } = result.rows[0];

  const sevColors: Record<string, string> = {
    critical: '#DC2626', high: '#EA580C', medium: '#CA8A04', low: '#6B7280',
  };
  const sevColor = sevColors[report.severity] ?? '#6B7280';

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
      <div class="footer">V-Wing Security Management Platform — Confidential</div>
    </div>`,
  });
}

// ── Email Type 2 — Daily Shift Report ────────────────────────────────────────

export async function sendDailyShiftReport(shiftId: string) {
  const shiftResult = await pool.query(
    `SELECT sh.id, sh.scheduled_start,
            si.name     AS site_name,
            g.name      AS guard_name,
            g.badge_number,
            c.email     AS client_email,
            ca.email    AS admin_email
     FROM shifts sh
     JOIN sites          si ON si.id = sh.site_id
     JOIN guards         g  ON g.id  = sh.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
     JOIN company_admins ca ON ca.company_id = co.id AND ca.is_primary = true
     WHERE sh.id = $1 AND sh.daily_report_email_sent = false`,
    [shiftId],
  );
  if (!shiftResult.rows[0]) return;
  const sh = shiftResult.rows[0];

  const sessionResult = await pool.query(
    `SELECT id, clocked_in_at, clocked_out_at,
            ROUND(CAST(total_hours AS NUMERIC), 2) AS total_hours
     FROM shift_sessions WHERE shift_id = $1 ORDER BY clocked_in_at DESC LIMIT 1`,
    [shiftId],
  );
  const session      = sessionResult.rows[0];
  const totalHours   = session?.total_hours ? `${session.total_hours}h` : '—';
  const clockIn      = session ? fmtDT(session.clocked_in_at)  : '—';
  const clockOut     = session?.clocked_out_at ? fmtDT(session.clocked_out_at) : 'In progress';

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

  const reports       = reportsResult.rows;
  const tasksCompleted = parseInt(tasksResult.rows[0]?.completed  ?? 0);
  const tasksTotal     = parseInt(taskTotalResult.rows[0]?.total  ?? 0);

  const borderColors: Record<string, string> = {
    activity: '#D97706', incident: '#DC2626', maintenance: '#2563EB',
  };
  const reportRows = reports.map((r) =>
    `<div class="rrow" style="border-left-color:${borderColors[r.report_type] ?? '#ccc'}">
      <p>${typeBadgeHtml(r.report_type, r.severity)} &nbsp;
         <span style="color:#999;font-size:12px">${fmtDT(r.reported_at)}</span></p>
      <p style="color:#333">${r.description.slice(0, 300)}${r.description.length > 300 ? '…' : ''}</p>
    </div>`,
  ).join('');

  const incidentCount = reports.filter((r) => r.report_type === 'incident').length;
  const incidentNote  = incidentCount > 0
    ? `<p style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:10px 14px;color:#DC2626;font-size:13px;margin-top:16px">
        ⚠️ ${incidentCount} incident report${incidentCount > 1 ? 's' : ''} filed during this shift.
       </p>`
    : '';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr">
      <h1>DAILY SHIFT REPORT</h1><p>${sh.site_name.toUpperCase()}</p>
    </div>
    <div class="body">
      <div class="meta">
        <strong>Guard:</strong> ${sh.guard_name} (${sh.badge_number})<br/>
        <strong>Clock-in:</strong> ${clockIn} &nbsp;&nbsp; <strong>Clock-out:</strong> ${clockOut}
      </div>
      <div>
        <div class="kpi"><div class="n">${totalHours}</div><div class="l">HOURS WORKED</div></div>
        <div class="kpi"><div class="n">${reports.length}</div><div class="l">REPORTS FILED</div></div>
        <div class="kpi"><div class="n">${tasksCompleted}/${tasksTotal}</div><div class="l">TASKS DONE</div></div>
      </div>
      ${incidentNote}
      ${reports.length > 0
        ? `<h3 style="margin:20px 0 8px;font-size:13px;color:#666;letter-spacing:1px">REPORTS</h3>${reportRows}`
        : '<p style="color:#aaa;font-size:13px;margin-top:20px">No reports filed during this shift.</p>'}
      <a class="btn" href="${PORTAL}">View Full Report in Portal</a>
    </div>
    <div class="footer">V-Wing Security Management Platform — Confidential</div>
  </div>`;

  const recipients = [sh.client_email, sh.admin_email].filter(Boolean) as string[];
  if (recipients.length === 0) return;

  await sgMail.sendMultiple({
    to: recipients,
    from: FROM,
    subject: `Daily Shift Report — ${sh.site_name} — ${new Date(sh.scheduled_start).toLocaleDateString('en-GB')}`,
    html,
  });

  await pool.query(
    'UPDATE shifts SET daily_report_email_sent = true, daily_report_email_sent_at = NOW() WHERE id = $1',
    [shiftId],
  );
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
    <div class="hdr" style="background:${isUrgent ? '#7F1D1D' : '#1A1A2E'}">
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
    <div class="footer">V-Wing Security Management Platform — Confidential</div>
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
  const result = await pool.query(
    `SELECT sh.scheduled_start,
            si.name     AS site_name,
            g.name      AS guard_name,
            g.badge_number,
            g.phone     AS guard_phone,
            c.email     AS client_email,
            ca.email    AS admin_email
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
  const { scheduled_start, site_name, guard_name, badge_number, guard_phone, client_email, admin_email } = result.rows[0];

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr" style="background:#7F1D1D">
      <h1>MISSED SHIFT ALERT</h1><p>${site_name.toUpperCase()}</p>
    </div>
    <div class="body">
      <div class="meta">
        <strong>Scheduled Start:</strong> ${fmtDT(scheduled_start)}<br/>
        <strong>Guard:</strong> ${guard_name} (${badge_number})${guard_phone ? `<br/><strong>Guard Phone:</strong> ${guard_phone}` : ''}
      </div>
      <p style="font-size:15px;color:#DC2626;font-weight:bold;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:12px 16px">
        ⚠️ No guard has clocked in for this shift. It is now 15 minutes past the scheduled start time.
      </p>
      <p style="color:#555;font-size:13px;margin-top:14px">
        Please contact the assigned guard immediately or arrange cover for <strong>${site_name}</strong>.
      </p>
      <a class="btn" href="${PORTAL}">View Shift in Portal</a>
    </div>
    <div class="footer">V-Wing Security Management Platform — Automated Alert</div>
  </div>`;

  const recipients = [process.env.VISHNU_EMAIL, client_email, admin_email].filter(Boolean) as string[];
  if (recipients.length === 0) return;

  await sgMail.sendMultiple({
    to: recipients,
    from: FROM,
    subject: `⚠️ Missed Shift Alert — ${site_name} — Guard not clocked in`,
    html,
  });

  await pool.query(
    'UPDATE shifts SET missed_alert_sent_at = NOW() WHERE id = $1',
    [shiftId],
  );
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
      <div class="footer">V-Wing Security Management Platform — Internal Alert</div>
    </div>`,
  });
}
