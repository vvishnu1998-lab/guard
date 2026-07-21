/**
 * Email service — all outbound emails via SendGrid.
 *
 * Flows implemented in this file:
 *  - Incident Alert          — to active client on incident report
 *  - Daily Shift Report      — 9:00 AM Pacific cron, to active client
 *  - Missed Shift Alert      — all active company admins, T+10 and T+30 rungs
 *  - Geofence Breach Alert   — all active company admins, per fresh violation
 *  - Temporary Password      — forgot-password recipient's own email
 *  - Swap / Handoff FYIs     — all active company admins, fire-and-forget
 *
 * Admin-alert recipient policy: sendToAdmins() fans out to every
 * company_admins row where is_active = true. Primary+secondaries both
 * receive; deactivated admins do not (fixes the pre-existing gap where
 * a deactivated primary would still receive alerts).
 */

import sgMail from '@sendgrid/mail';
import { pool } from '../db/pool';
import { haversineDistance } from './geofence';
import { Sentry } from './sentry';
import { SHIFT_HOURS_SQL_FIELDS, formatHoursHHMM, formatOffPostHours, formatScheduledHours, type ShiftHours } from './shiftHours';

// Central SendGrid error tag helper. Called from every sgMail.send catch
// site so a Sentry.setTag('service','sendgrid') + flow tag lets us slice
// the issues list by workflow when triaging delivery failures.
function reportSendgridFailure(flow: string, err: any, extra?: Record<string, unknown>): void {
  Sentry.captureException(err, {
    tags: { service: 'sendgrid', flow },
    extra: { ...(extra ?? {}), response_body: err?.response?.body },
  });
}

// Recipient resolver for all admin-alert flows. Fans out to every active
// admin on the tenant, ordered primary-first so log ordering matches the
// old single-recipient trace when a tenant only has one admin.
async function getActiveAdminEmails(companyId: string): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM company_admins
      WHERE company_id = $1 AND is_active = true
      ORDER BY is_primary DESC, email`,
    [companyId],
  );
  return rows.map((r) => r.email);
}

// Per-recipient send via Promise.allSettled so one bad address doesn't
// stop delivery to the rest. Each failure is Sentry-tagged with the
// recipient in `extra` so the issues list shows per-recipient bounces.
async function sendToAdmins(
  adminEmails: string[],
  msg: Omit<sgMail.MailDataRequired, 'to'>,
  flow: string,
  extra: Record<string, unknown>,
): Promise<{ succeeded: number; failed: number }> {
  const results = await Promise.allSettled(
    adminEmails.map((email) =>
      sgMail.send({ ...msg, to: email } as sgMail.MailDataRequired),
    ),
  );
  let succeeded = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { succeeded += 1; return; }
    failed += 1;
    const err: any = r.reason;
    console.error(
      `[email] ${flow}: SENDGRID ERROR for ${adminEmails[i]} — ${err?.message ?? err}`,
      err?.response?.body,
    );
    reportSendgridFailure(flow, err, { ...extra, recipient: adminEmails[i] });
  });
  return { succeeded, failed };
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const _sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL;
if (!_sendgridFromEmail) {
  throw new Error(
    'SENDGRID_FROM_EMAIL env var is required — no fallback allowed (fallback sender would not be domain-authenticated and SendGrid would reject sends silently)',
  );
}
const FROM: string = _sendgridFromEmail;
// Customer-facing Reply-To. Kept hardcoded on purpose — the address must
// track an authenticated support inbox, not a per-tenant admin address.
// Applied to welcome + temp-password + daily-shift + incident emails.
// Admin-only alerts (missed-shift, breach, swap/handoff FYIs) omit it —
// those already land on the admin's own inbox; a "support" Reply-To would
// misdirect their replies.
const REPLY_TO = 'support@netraops.com';
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
const PACIFIC = 'America/Los_Angeles';

function fmtDTSite(dt: Date | string, tz: string = PACIFIC): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz,
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

const INCIDENT_SEVERITY_COLORS: Record<string, string> = {
  critical: '#DC2626', high: '#EA580C', medium: '#CA8A04', low: '#6B7280',
};

export async function sendIncidentAlert(
  report: { id: string; description: string; severity: string; reported_at: Date },
  siteId: string,
) {
  // Fan out to EVERY active client linked to this site via the v36
  // client_sites junction — not just clients.site_id, which misses multi-site
  // secondary sites (Finding #2). Reply-To is the shared support address —
  // client replies route to NetraOps support rather than the per-tenant admin.
  const result = await pool.query(
    `SELECT s.name AS site_name,
            s.timezone AS site_tz,
            c.name AS client_name,
            c.email AS client_email,
            co.name AS company_name
     FROM sites s
     JOIN client_sites cs ON cs.site_id = s.id
     JOIN clients c ON c.id = cs.client_id
     JOIN companies co ON co.id = s.company_id
     WHERE s.id = $1 AND c.is_active = true
     ORDER BY c.email`,
    [siteId],
  );
  if (result.rows.length === 0) {
    console.warn(`[email] sendIncidentAlert: no active client found for site_id=${siteId} — email not sent`);
    Sentry.captureMessage('sendIncidentAlert: no active clients for site', {
      level: 'warning',
      tags: { flow: 'incident_alert' },
      extra: { site_id: siteId, report_id: report.id },
    });
    return;
  }

  // site_name / site_tz / company_name are identical across rows.
  const { site_name, site_tz, company_name } = result.rows[0];

  // Render per-recipient (personalized greeting) and send in parallel. One bad
  // recipient must not suppress the others, so we don't throw — each failure is
  // Sentry-captured individually via reportSendgridFailure (sendToAdmins pattern).
  const outcomes = await Promise.allSettled(
    result.rows.map((row) => {
      const { subject, html } = renderIncidentAlert({
        report_id:    report.id,
        description:  report.description,
        severity:     report.severity,
        reported_at:  report.reported_at,
        site_name,
        site_tz,
        client_name:  row.client_name,
        company_name,
      });
      return sgMail.send({ to: row.client_email, from: FROM, replyTo: REPLY_TO, subject, html });
    }),
  );

  outcomes.forEach((o, i) => {
    const email = result.rows[i].client_email;
    if (o.status === 'fulfilled') {
      console.log(`[email] sendIncidentAlert: SUCCESS — delivered to ${email} (report=${report.id})`);
    } else {
      const err: any = o.reason;
      console.error(`[email] sendIncidentAlert: SENDGRID ERROR for ${email} — ${err?.message ?? err}`, err?.response?.body);
      reportSendgridFailure('incident_alert', err, { report_id: report.id, site_id: siteId, recipient: email });
    }
  });
}

/**
 * Pure renderer for the incident alert email. Exported for testability —
 * mirrors the renderDailyShiftReport / renderMissedShiftAlert pattern.
 * Client-property tone: NetraOps-branded header, personalized greeting via
 * firstName(client_name), full description (no truncation), Pacific-time
 * timestamp, branded footer with company attribution + reply-to-company.
 */
export function renderIncidentAlert(data: {
  report_id:   string;
  description: string;
  severity:    string;
  reported_at: Date | string;
  site_name:   string;
  /** IANA tz string, e.g. 'America/Los_Angeles'. Falls back to Pacific if unset. */
  site_tz?:    string | null;
  client_name: string | null;
  company_name: string;
}): { subject: string; html: string } {
  const tz         = data.site_tz ?? PACIFIC;
  const dateLabel  = fmtDateSite(data.reported_at, tz);
  const greetName  = firstName(data.client_name);
  const sevColor   = INCIDENT_SEVERITY_COLORS[data.severity] ?? '#6B7280';
  const sevLabel   = data.severity.toUpperCase();

  // Per-report deep link — client lands on their portal home with
  // ?report=<id>, and the ActivityLogTable there scrolls the row into view
  // and flashes a ring highlight (same pattern as breach → live-map).
  // Trim a trailing slash defensively so a PORTAL env of ".../client/" +
  // "?report=…" doesn't produce a "//?…" URL.
  const portalBase = PORTAL.replace(/\/$/, '');
  const incidentUrl = `${portalBase}?report=${encodeURIComponent(data.report_id)}`;

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr">
      <div class="brand">NETRAOPS</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">Incident Reported</h1>
      <p style="color:#F59E0B;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${data.site_name} · ${dateLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#333;margin:0 0 4px 0">Hi ${greetName},</p>
      <p style="color:#555;font-size:14px;margin:0 0 22px 0">An incident was reported at your site.</p>

      <div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:14px 16px;margin-bottom:22px">
        <span style="background:${sevColor};color:#fff;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:bold;letter-spacing:1px">${sevLabel}</span>
        <span style="color:#666;font-size:13px;margin-left:12px">${fmtDTSite(data.reported_at, tz)}</span>
      </div>

      <h3 style="margin:0 0 8px 0;font-size:15px;color:#333;font-weight:600;letter-spacing:0">Description</h3>
      <p style="margin:0;color:#333;font-size:14px;line-height:1.6;white-space:pre-wrap">${data.description}</p>

      <div style="text-align:center;margin-top:28px">
        <a class="btn" href="${incidentUrl}">View Incident in Portal</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in the site's local time zone (${tz}).<br/>
      Provided by <strong style="color:#666">${data.company_name}</strong>.<br/>
      Reply to this email to contact ${data.company_name}.
    </div>
  </div>`;

  const subject = `Incident Reported — ${data.site_name} — ${sevLabel} — ${dateLabel}`;
  return { subject, html };
}

// ── Email Type 2 — Daily Shift Report ────────────────────────────────────────

// Site-scoped calendar date for the subject/header ("14 May 2026").
// en-GB to match fmtDTSite's "14 May 2026, 10:01 PM PDT" — keeps subject
// and body day-month-year order consistent. Falls back to Pacific when the
// caller hasn't yet been threaded through with a site tz.
function fmtDateSite(dt: Date | string, tz: string = PACIFIC): string {
  return new Date(dt).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: tz,
  });
}

// Site-scoped time-only ("10:01 PM PDT"). Used for the same-day collapse
// on schedule ranges where the date appears once on the start side and only
// the time is needed on the end side.
function fmtTimeSite(dt: Date | string, tz: string = PACIFIC): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(new Date(dt));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('hour')}:${pick('minute')} ${pick('dayPeriod')} ${pick('timeZoneName')}`;
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
  // Reply-To is the shared support address — client replies route to
  // NetraOps support rather than the per-tenant primary admin.
  const shiftResult = await pool.query(
    `SELECT sh.id, sh.scheduled_start,
            si.name     AS site_name,
            si.timezone AS site_tz,
            g.name      AS guard_name,
            g.badge_number,
            c.name      AS client_name,
            c.email     AS client_email,
            co.name     AS company_name
     FROM shifts sh
     JOIN sites          si ON si.id = sh.site_id
     JOIN guards         g  ON g.id  = sh.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
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
    `SELECT ss.id, ss.clocked_in_at, ss.clocked_out_at,
            ROUND(CAST(ss.total_hours AS NUMERIC), 2) AS total_hours,
            ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')}
     FROM shift_sessions ss
     JOIN shifts sh ON sh.id = ss.shift_id
     WHERE ss.shift_id = $1
     ORDER BY ss.clocked_in_at DESC LIMIT 1`,
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
    site_tz:         sh.site_tz,
    scheduled_start: sh.scheduled_start,
    guard_name:      sh.guard_name,
    badge_number:    sh.badge_number,
    client_name:     sh.client_name,
    company_name:    sh.company_name,
    clocked_in_at:   session?.clocked_in_at ?? null,
    clocked_out_at:  session?.clocked_out_at ?? null,
    total_hours:     session?.total_hours ?? null,
    hours: session
      ? {
          scheduled_hours: Number(session.scheduled_hours) || 0,
          actual_hours:    Number(session.actual_hours)    || 0,
          break_hours:     Number(session.break_hours)     || 0,
          violation_hours: Number(session.violation_hours) || 0,
        }
      : null,
    reports:         reportsResult.rows,
    tasks_completed: parseInt(tasksResult.rows[0]?.completed ?? 0),
    tasks_total:     parseInt(taskTotalResult.rows[0]?.total ?? 0),
  });

  const sendOpts: sgMail.MailDataRequired = {
    to:      sh.client_email,
    from:    FROM,
    replyTo: REPLY_TO,
    subject,
    html,
  };

  try {
    await sgMail.send(sendOpts);
  } catch (err: any) {
    console.error(`[email] sendDailyShiftReport: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('daily_shift_report', err, { shift_id: shiftId });
    throw err;
  }

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
 * All event timestamps render in America/Los_Angeles via fmtDTSite (PDT in
 * summer, PST in winter — abbreviation chosen by the runtime). Multi-tenant
 * per-site timezone support is logged as a separate follow-up.
 */
export function renderDailyShiftReport(data: {
  site_name:       string;
  site_tz?:        string | null;
  scheduled_start: Date | string;
  guard_name:      string;
  badge_number:    string;
  client_name:     string | null;
  company_name:    string;
  clocked_in_at:   Date | string | null;
  clocked_out_at:  Date | string | null;
  total_hours:     string | number | null;
  hours?:          ShiftHours | null;
  reports:         Array<{ report_type: string; severity: string | null; description: string; reported_at: Date | string }>;
  tasks_completed: number;
  tasks_total:     number;
}): { subject: string; html: string } {
  const tz         = data.site_tz ?? PACIFIC;
  const dateLabel  = fmtDateSite(data.scheduled_start, tz);
  const totalHours = data.hours
    ? formatHoursHHMM(data.hours.actual_hours)
    : (data.total_hours != null ? `${parseFloat(String(data.total_hours))}h` : '—');
  const clockIn    = data.clocked_in_at  ? fmtDTSite(data.clocked_in_at,  tz) : '—';
  const clockOut   = data.clocked_out_at ? fmtDTSite(data.clocked_out_at, tz) : 'In progress';
  const greetName  = firstName(data.client_name);

  const borderColors: Record<string, string> = {
    activity: '#D97706', incident: '#DC2626', maintenance: '#2563EB',
  };
  const reportRows = data.reports.map((r) => {
    const desc = r.description.length > 300 ? r.description.slice(0, 300) + '…' : r.description;
    return `<div class="rrow" style="border-left-color:${borderColors[r.report_type] ?? '#ccc'}">
      <p style="margin:0 0 6px 0">${typeBadgeHtml(r.report_type, r.severity)} <span style="color:#888;font-size:12px;margin-left:6px">${fmtDTSite(r.reported_at, tz)}</span></p>
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

      ${data.hours ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#333;margin:0 0 18px 0;background:#F9FAFB;border-radius:6px;overflow:hidden">
        <tr style="background:#F3F4F6">
          <th style="text-align:left;padding:8px 12px;color:#6B7280;font-weight:600;font-size:11px;letter-spacing:0.5px">SCHEDULED</th>
          <th style="text-align:left;padding:8px 12px;color:#6B7280;font-weight:600;font-size:11px;letter-spacing:0.5px">ON DUTY</th>
          <th style="text-align:left;padding:8px 12px;color:#6B7280;font-weight:600;font-size:11px;letter-spacing:0.5px">BREAK</th>
          <th style="text-align:left;padding:8px 12px;color:#6B7280;font-weight:600;font-size:11px;letter-spacing:0.5px">OFF-POST</th>
        </tr>
        <tr>
          <td style="padding:8px 12px">${formatScheduledHours(data.hours.scheduled_hours)}</td>
          <td style="padding:8px 12px">${formatHoursHHMM(data.hours.actual_hours)}</td>
          <td style="padding:8px 12px">${formatHoursHHMM(data.hours.break_hours)}</td>
          <td style="padding:8px 12px">${formatOffPostHours(data.hours.violation_hours)}</td>
        </tr>
      </table>` : ''}

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
      All times shown in the site's local time zone (${tz}).<br/>
      Provided by <strong style="color:#666">${data.company_name}</strong>.<br/>
      Reply to this email to contact ${data.company_name}.
    </div>
  </div>`;

  const subject = `Shift Report — ${data.site_name} — ${dateLabel}`;
  return { subject, html };
}

// ── Email Type 5 — Missed Shift Alert ────────────────────────────────────────

export async function sendMissedShiftAlert(shiftId: string) {
  // SELECT: fans out to every active company_admin via getActiveAdminEmails
  // below; client_email still SELECTed but discarded (intentional — clients
  // are not on this email). company_id is projected for the admin lookup.
  const result = await pool.query(
    `SELECT sh.id,
            sh.scheduled_start,
            sh.scheduled_end,
            sh.guard_id,
            si.name        AS site_name,
            si.timezone    AS site_tz,
            si.address     AS site_address,
            g.name         AS guard_name,
            g.badge_number,
            g.phone_number AS guard_phone,
            c.email        AS client_email,
            co.id          AS company_id,
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
     WHERE sh.id = $1`,
    [shiftId],
  );
  if (!result.rows[0]) return;
  const row = result.rows[0];

  const admins = await getActiveAdminEmails(row.company_id);
  if (admins.length === 0) {
    Sentry.captureMessage('sendMissedShiftAlert: no active admins for tenant', {
      level: 'warning',
      tags: { service: 'sendgrid', flow: 'missed_shift_alert' },
      extra: { company_id: row.company_id, shift_id: shiftId },
    });
    return;
  }

  const { subject, html } = renderMissedShiftAlert(row);

  const { succeeded, failed } = await sendToAdmins(
    admins,
    { from: FROM, subject, html },
    'missed_shift_alert',
    { shift_id: shiftId },
  );

  // Throw when every recipient failed so the caller (missedShiftAlert cron
  // OR lateClockInReminder's T+30 rung) skips its own follow-on stamp and
  // the shift stays eligible for the next tick's retry.
  if (succeeded === 0) {
    throw new Error(`sendMissedShiftAlert: all ${failed} recipients failed for shift ${shiftId}`);
  }

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
  site_tz?:        string | null;
  site_address:    string;
  guard_name:      string;
  badge_number:    string;
  guard_phone:     string | null;
  last_login_at:   Date | string | null;
  upcoming_shifts_count: number | string;
}): { subject: string; html: string } {
  const tz = row.site_tz ?? PACIFIC;

  // Minutes late computed at render time (cron fires at T+10 min minimum, but
  // actual delay can be 10–15 min depending on the */5 tick alignment).
  const minutesLate = Math.max(0, Math.floor(
    (Date.now() - new Date(row.scheduled_start).getTime()) / 60_000
  ));

  // Deep link to the admin shift-detail / reassign page
  // (apps/web/app/admin/shifts/[shiftId]/page.tsx, shipped in f130d6b).
  // WEB_BASE has a hardcoded fallback so a missing env var doesn't break the
  // alert.
  const dashboardUrl = `${WEB_BASE}/admin/shifts/${row.id}`;

  const guardTitle = titleCase(row.guard_name);

  // Same-day collapse: if scheduled_start and scheduled_end fall on the
  // same site-local calendar day, drop the redundant end-date prefix.
  // "14 May 2026, 6:29 AM PDT → 10:29 AM PDT" vs cross-midnight
  // "14 May 2026, 11:25 PM PDT → 15 May 2026, 8:00 AM PDT".
  // Comparison is on the site-local date string so DST and UTC offset don't
  // cause edge-case mis-grouping.
  const sameDay = fmtDateSite(row.scheduled_start, tz) === fmtDateSite(row.scheduled_end, tz);
  const scheduledLabel = sameDay
    ? `${fmtDTSite(row.scheduled_start, tz)} → ${fmtTimeSite(row.scheduled_end, tz)}`
    : `${fmtDTSite(row.scheduled_start, tz)} → ${fmtDTSite(row.scheduled_end, tz)}`;

  const upcoming = Number(row.upcoming_shifts_count) || 0;
  const upcomingText = upcoming === 0
    ? `No other upcoming shifts in the next 24h — calling may not get coverage.`
    : `${upcoming} other upcoming shift${upcoming === 1 ? '' : 's'} in the next 24h.`;

  const phoneRow = row.guard_phone
    ? `<tr><td style="padding:6px 0;color:#888;width:120px">Phone</td><td style="padding:6px 0"><a href="tel:${row.guard_phone}" style="color:#0B1526;text-decoration:underline">${row.guard_phone}</a></td></tr>`
    : '';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr" style="background:#7F1D1D">
      <div class="brand" style="color:#FCA5A5">NETRAOPS · ALERT</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">Missed Shift</h1>
      <p style="color:#FCA5A5;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${row.site_name} · ${guardTitle} is ${minutesLate} min late</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#B91C1C;font-weight:600;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:12px 16px;margin:0 0 22px 0">
        ⚠️ ${guardTitle} did not clock in. ${minutesLate} minutes past the scheduled start.
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-bottom:4px">
        <tr><td style="padding:6px 0;color:#888;width:120px">Guard</td><td style="padding:6px 0">${guardTitle} <span style="color:#888">(${row.badge_number})</span></td></tr>
        ${phoneRow}
        <tr><td style="padding:6px 0;color:#888">Site</td><td style="padding:6px 0">${row.site_name}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Address</td><td style="padding:6px 0">${row.site_address}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Scheduled</td><td style="padding:6px 0">${scheduledLabel}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Last app login</td><td style="padding:6px 0">${relTime(row.last_login_at)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;vertical-align:top">Coverage</td><td style="padding:6px 0">${upcomingText}</td></tr>
      </table>

      <p style="color:#555;font-size:13px;margin:22px 0 0 0">
        Please contact the guard immediately or reassign the shift to another guard at <strong>${row.site_name}</strong>.
      </p>

      <div style="text-align:center;margin-top:24px">
        <a class="btn" href="${dashboardUrl}">Open in Admin Dashboard</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in the site's local time zone (${tz}).<br/>
      NetraOps · Automated alert
    </div>
  </div>`;

  const subject = `⚠️ MISSED SHIFT — ${row.site_name} — ${guardTitle} is ${minutesLate} min late`;
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

  try {
    await sgMail.send({
    to: email,
    from: FROM,
    replyTo: REPLY_TO,
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
  } catch (err: any) {
    console.error(`[email] sendTempPasswordEmail: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('temp_password', err, { portal });
    throw err;
  }
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
            si.timezone  AS site_tz,
            si.address   AS site_address,
            sg.center_lat,
            sg.center_lng,
            g.name       AS guard_name,
            g.badge_number,
            c.email      AS client_email,
            co.id        AS company_id
     FROM geofence_violations v
     JOIN sites          si ON si.id = v.site_id
     LEFT JOIN site_geofence sg ON sg.site_id = si.id
     JOIN guards         g  ON g.id  = v.guard_id
     LEFT JOIN clients   c  ON c.site_id = si.id AND c.is_active = true
     JOIN companies      co ON co.id = si.company_id
     WHERE v.id = $1`,
    [violationId],
  );
  if (!result.rows[0]) return;
  const row = result.rows[0];

  const admins = await getActiveAdminEmails(row.company_id);
  if (admins.length === 0) {
    Sentry.captureMessage('sendGeofenceBreachAlert: no active admins for tenant', {
      level: 'warning',
      tags: { service: 'sendgrid', flow: 'geofence_breach_alert' },
      extra: { company_id: row.company_id, violation_id: violationId, kind: context.kind },
    });
    return;
  }

  const { subject, html } = renderGeofenceBreachAlert(row, context);

  const { succeeded, failed } = await sendToAdmins(
    admins,
    { from: FROM, subject, html },
    'geofence_breach_alert',
    { violation_id: violationId, kind: context.kind },
  );

  if (succeeded === 0) {
    throw new Error(`sendGeofenceBreachAlert: all ${failed} recipients failed for violation ${violationId}`);
  }
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
  site_tz?:         string | null;
  site_address:     string;
  center_lat:       number | null;
  center_lng:       number | null;
  guard_name:       string;
  badge_number:     string;
}, context: BreachAlertContext = { kind: 'ping' }): { subject: string; html: string } {
  const tz = row.site_tz ?? PACIFIC;
  const distanceM =
    row.center_lat != null && row.center_lng != null
      ? Math.round(
          haversineDistance(row.violation_lat, row.violation_lng, row.center_lat, row.center_lng),
        )
      : null;

  const isReport = context.kind === 'report';
  const reportTypeLabel = context.reportType ?? 'report';
  const guardTitle = titleCase(row.guard_name);
  const article = /^[aeiouAEIOU]/.test(reportTypeLabel) ? 'an' : 'a';
  const distanceFragment = distanceM != null ? `${distanceM}m` : 'off-site';

  // Subject mirrors the missed-shift pattern: "⚠️ ALERT — Site — detail".
  const subject = isReport
    ? `⚠️ OFF-POST REPORT — ${row.site_name} — ${guardTitle} filed ${reportTypeLabel} ${distanceFragment} off-post`
    : `⚠️ GEOFENCE BREACH — ${row.site_name} — ${guardTitle} ${distanceFragment} off-site`;

  // Header
  const headerTitle = isReport ? 'Off-post Report' : 'Geofence Breach';
  const headerSub   = isReport
    ? `${row.site_name} · ${reportTypeLabel} report filed off-post`
    : `${row.site_name} · ${guardTitle} ${distanceFragment} off-site`;

  // Headline banner (the red-on-pink stripe inside the body)
  const distanceClause = distanceM != null
    ? ` — ${distanceM}m outside the geofence.`
    : ' — outside the permitted boundary.';
  const headlineText = isReport
    ? `⚠️ ${guardTitle} filed ${article} ${reportTypeLabel} report${distanceM != null ? ` ${distanceM}m off-post` : ' off-post'} at ${row.site_name}.`
    : `⚠️ ${guardTitle} left the post at ${row.site_name}${distanceClause}`;

  // Body framing paragraph — explanatory copy under the meta table
  const bodyFraming = isReport
    ? `The guard submitted ${article} ${reportTypeLabel} report while outside the permitted boundary. The report was accepted and saved; this alert flags the off-post submission for review.`
    : `The guard was outside the permitted boundary when this alert fired. The breach auto-resolves when they return inside the post; no admin action required unless the situation persists.`;

  // Meta table rows
  const distanceRow = distanceM != null
    ? `<tr><td style="padding:6px 0;color:#888">Distance from post</td><td style="padding:6px 0">${distanceM} m</td></tr>`
    : `<tr><td style="padding:6px 0;color:#888">Distance from post</td><td style="padding:6px 0;color:#888"><em>(site geofence center not configured)</em></td></tr>`;
  const reportTypeRow = isReport
    ? `<tr><td style="padding:6px 0;color:#888">Report type</td><td style="padding:6px 0">${reportTypeLabel}</td></tr>`
    : '';
  const coordsRow = `<tr><td style="padding:6px 0;color:#888;vertical-align:top">Coords</td><td style="padding:6px 0"><code style="background:#f5f5f5;padding:1px 6px;border-radius:3px;font-size:12px">${row.violation_lat.toFixed(6)}, ${row.violation_lng.toFixed(6)}</code></td></tr>`;

  // Photo block — links to the breach row in the admin dashboard, NOT the
  // raw S3 URL. (Pre-launch security punchlist #1, PR3: as the bucket
  // flips private the inbox-resident link would have stopped resolving;
  // the dashboard deep-link auth-gates the photo + re-mints a signed URL
  // on view.)
  // /admin/live-status is the current URL; the page used to live at
  // /admin/live-map (task #5 route rename, 2026-07-08). Old breach
  // emails already in inboxes still resolve via the permanent 301 in
  // apps/web/next.config.js.
  const deepLink = `${WEB_BASE}/admin/live-status`;
  const breachDeepLink = `${deepLink}?breach=${encodeURIComponent(row.id)}`;
  const photoBlock = row.photo_url
    ? `<p style="margin:16px 0 0 0;font-size:13px;color:#555"><strong style="color:#333">Photo at breach:</strong> <a href="${breachDeepLink}" style="color:#0B1526;text-decoration:underline">View in dashboard →</a></p>`
    : '';

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr" style="background:#7F1D1D">
      <div class="brand" style="color:#FCA5A5">NETRAOPS · ALERT</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">${headerTitle}</h1>
      <p style="color:#FCA5A5;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${headerSub}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#B91C1C;font-weight:600;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:12px 16px;margin:0 0 22px 0">
        ${headlineText}
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-bottom:4px">
        <tr><td style="padding:6px 0;color:#888;width:140px">Guard</td><td style="padding:6px 0">${guardTitle} <span style="color:#888">(${row.badge_number})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">Site</td><td style="padding:6px 0">${row.site_name}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Address</td><td style="padding:6px 0">${row.site_address}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Time</td><td style="padding:6px 0">${fmtDTSite(row.occurred_at, tz)}</td></tr>
        ${distanceRow}
        ${reportTypeRow}
        ${coordsRow}
      </table>

      ${photoBlock}

      <p style="color:#555;font-size:13px;margin:22px 0 0 0">
        ${bodyFraming}
      </p>

      <div style="text-align:center;margin-top:24px">
        <a class="btn" href="${deepLink}">Open Live Map</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in the site's local time zone (${tz}).<br/>
      NetraOps · Automated alert
    </div>
  </div>`;

  return { subject, html };
}

// ── Email Type 8 — Coverage swap FYI (admin) ────────────────────────────────
//
// Fires from POST /api/shifts/:id/swap-response when a guard-initiated
// swap is accepted. Recipient policy: all active company admins on the
// tenant (via getActiveAdminEmails). No client-facing email — this is an
// internal FYI so admins can audit "did I know Deepak's shift got
// covered by James".

/**
 * Send the accepted-swap FYI email. Called from the swap-response
 * endpoint after the txn commits. Best-effort — callers should
 * `.catch()` on the returned promise; email failure must not roll back
 * the committed swap.
 */
export async function sendSwapAcceptedFyi(historyId: string): Promise<void> {
  const result = await pool.query(
    `SELECT ssr.id,
            ssr.shift_id,
            ssr.reason,
            sh.scheduled_start,
            sh.scheduled_end,
            si.name              AS site_name,
            si.timezone          AS site_tz,
            fg.name              AS from_guard_name,
            fg.badge_number      AS from_badge,
            tg.name              AS to_guard_name,
            tg.badge_number      AS to_badge,
            co.id                AS company_id,
            EXISTS (
              SELECT 1 FROM guard_site_assignments gsa
              WHERE gsa.guard_id = ssr.to_guard_id
                AND gsa.site_id  = sh.site_id
                AND gsa.assigned_from <= (sh.scheduled_start AT TIME ZONE si.timezone)::date
                AND (gsa.assigned_until IS NULL
                     OR gsa.assigned_until >= (sh.scheduled_start AT TIME ZONE si.timezone)::date)
            ) AS is_same_site
       FROM shift_swap_requests ssr
       JOIN shifts sh ON sh.id = ssr.shift_id
       JOIN sites  si ON si.id = sh.site_id
       JOIN guards fg ON fg.id = ssr.from_guard_id
       JOIN guards tg ON tg.id = ssr.to_guard_id
       JOIN companies      co ON co.id = si.company_id
      WHERE ssr.id = $1`,
    [historyId],
  );
  if (!result.rows[0]) return;
  const row = result.rows[0];

  const admins = await getActiveAdminEmails(row.company_id);
  if (admins.length === 0) {
    Sentry.captureMessage('sendSwapAcceptedFyi: no active admins for tenant', {
      level: 'warning',
      tags: { service: 'sendgrid', flow: 'swap_accepted_fyi' },
      extra: { company_id: row.company_id, history_id: historyId },
    });
    return;
  }

  const { subject, html } = renderSwapAcceptedFyi(row);
  await sendToAdmins(
    admins,
    { from: FROM, subject, html },
    'swap_accepted_fyi',
    { history_id: historyId },
  );
}

export function renderSwapAcceptedFyi(row: {
  shift_id:         string;
  scheduled_start:  Date | string;
  scheduled_end:    Date | string;
  site_name:        string;
  site_tz:          string | null;
  from_guard_name:  string;
  from_badge:       string;
  to_guard_name:    string;
  to_badge:         string;
  is_same_site:     boolean;
  reason:           string | null;
}): { subject: string; html: string } {
  const tz = row.site_tz ?? PACIFIC;
  const fromName = titleCase(row.from_guard_name);
  const toName   = titleCase(row.to_guard_name);
  const dayLabel = fmtDateSite(row.scheduled_start, tz);
  const timeRange = `${fmtTimeSite(row.scheduled_start, tz)} → ${fmtTimeSite(row.scheduled_end, tz)}`;
  const sameSiteBadge = row.is_same_site
    ? '<span style="background:#DCFCE7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;letter-spacing:1px">SAME SITE</span>'
    : '<span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;letter-spacing:1px">CROSS SITE</span>';
  const reasonBlock = row.reason
    ? `<div style="background:#F3F4F6;border-left:3px solid #9CA3AF;padding:10px 14px;margin-top:16px"><p style="margin:0;color:#374151;font-size:13px;font-style:italic">Reason: &ldquo;${row.reason}&rdquo;</p></div>`
    : '';

  const dashboardUrl = `${WEB_BASE}/admin/shifts/${row.shift_id}`;

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr">
      <div class="brand">NETRAOPS</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">Coverage Swap</h1>
      <p style="color:#F59E0B;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${row.site_name} · ${dayLabel}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#333;margin:0 0 4px 0">FYI —</p>
      <p style="color:#555;font-size:14px;margin:0 0 18px 0">
        A guard-initiated shift swap was accepted. No action required.
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-bottom:6px">
        <tr><td style="padding:6px 0;color:#888;width:130px">From</td><td style="padding:6px 0">${fromName} <span style="color:#888">(${row.from_badge})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">To</td><td style="padding:6px 0">${toName} <span style="color:#888">(${row.to_badge})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">Site</td><td style="padding:6px 0">${row.site_name}</td></tr>
        <tr><td style="padding:6px 0;color:#888">When</td><td style="padding:6px 0">${dayLabel} · ${timeRange}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Coverage</td><td style="padding:6px 0">${sameSiteBadge}</td></tr>
      </table>

      ${reasonBlock}

      <div style="text-align:center;margin-top:24px">
        <a class="btn" href="${dashboardUrl}">Open Shift in Admin Dashboard</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in the site's local time zone (${tz}).<br/>
      NetraOps · Automated alert
    </div>
  </div>`;

  const subject = `Coverage swap: ${fromName} → ${toName}`;
  return { subject, html };
}

// ── Phase 2: mid-shift handoff FYI emails ────────────────────────────────
// Three moments the admin gets notified for a handoff:
//   accepted  — B agreed; travel in progress; A still on shift.
//   completed — B physically clocked in; A auto-clocked out.
//   nudge     — accepted >= 30 min ago, still not clocked in.
//
// One helper per moment; all three re-use loadHandoffFyiRow and
// renderHandoffFyi. Best-effort — the caller `.catch()`es on the returned
// promise so email failure never rolls back the committed handoff.

interface HandoffFyiRow {
  history_id:       string;
  shift_id:         string;
  reason:           string | null;
  accepted_at:      Date | string | null;
  handoff_at:       Date | string | null;
  duration_hours:   number | null;
  from_guard_name:  string;
  from_badge:       string;
  to_guard_name:    string;
  to_badge:         string;
  site_name:        string;
  site_tz:          string | null;
  company_id:       string;
}

async function loadHandoffFyiRow(historyId: string): Promise<HandoffFyiRow | null> {
  // Phase 1 — duration_hours now derived from the canonical actual_hours on
  // the outgoing session (raw clock_out − clock_in), matching the daily-report
  // "HOURS" tile. Falls back to stored total_hours only when the join misses.
  const result = await pool.query<HandoffFyiRow>(
    `SELECT ssr.id           AS history_id,
            ssr.shift_id,
            ssr.reason,
            ssr.accepted_at,
            ts.clocked_in_at   AS handoff_at,
            COALESCE(
              ROUND(CAST(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(fs.clocked_out_at, NOW()) - fs.clocked_in_at))/3600.0) AS NUMERIC), 2),
              fs.total_hours
            )                  AS duration_hours,
            fg.name            AS from_guard_name,
            fg.badge_number    AS from_badge,
            tg.name            AS to_guard_name,
            tg.badge_number    AS to_badge,
            si.name            AS site_name,
            si.timezone        AS site_tz,
            co.id              AS company_id
       FROM shift_swap_requests ssr
       JOIN shifts sh ON sh.id = ssr.shift_id
       JOIN sites  si ON si.id = sh.site_id
       JOIN guards fg ON fg.id = ssr.from_guard_id
       JOIN guards tg ON tg.id = ssr.to_guard_id
       JOIN companies      co ON co.id = si.company_id
       LEFT JOIN shift_sessions fs ON fs.id = ssr.from_session_id
       LEFT JOIN shift_sessions ts ON ts.id = ssr.to_session_id
      WHERE ssr.id = $1`,
    [historyId],
  );
  return result.rows[0] ?? null;
}

function renderHandoffFyi(
  row: HandoffFyiRow,
  kind: 'accepted' | 'completed' | 'nudge',
  nudgeMinutes = 0,
): { subject: string; html: string } {
  const tz = row.site_tz ?? PACIFIC;
  const fromName = titleCase(row.from_guard_name);
  const toName   = titleCase(row.to_guard_name);
  const reasonBlock = row.reason
    ? `<div style="background:#F3F4F6;border-left:3px solid #9CA3AF;padding:10px 14px;margin-top:16px"><p style="margin:0;color:#374151;font-size:13px;font-style:italic">Reason: &ldquo;${row.reason}&rdquo;</p></div>`
    : '';
  const dashboardUrl = `${WEB_BASE}/admin/shifts/${row.shift_id}`;

  let headline: string, pill: string, primaryLine: string, extraRow: string;
  if (kind === 'accepted') {
    headline    = 'Handoff accepted';
    pill        = '<span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;letter-spacing:1px">WAITING FOR ARRIVAL</span>';
    primaryLine = `${toName} accepted the mid-shift handoff. ${fromName} remains on shift until ${toName} arrives and clocks in on-site.`;
    extraRow    = row.accepted_at ? `<tr><td style="padding:6px 0;color:#888">Accepted at</td><td style="padding:6px 0">${fmtTimeSite(row.accepted_at, tz)} ${tz}</td></tr>` : '';
  } else if (kind === 'completed') {
    const worked = row.duration_hours != null ? `${Number(row.duration_hours).toFixed(2)}h` : '—';
    headline    = 'Handoff complete';
    pill        = '<span style="background:#DCFCE7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;letter-spacing:1px">GUARD SWAPPED</span>';
    primaryLine = `${toName} clocked in on-site. ${fromName} is now clocked out (worked ${worked} on this shift).`;
    extraRow    = row.handoff_at ? `<tr><td style="padding:6px 0;color:#888">Handoff at</td><td style="padding:6px 0">${fmtTimeSite(row.handoff_at, tz)} ${tz}</td></tr>` : '';
  } else {
    headline    = 'Handoff still pending arrival';
    pill        = `<span style="background:#FEE2E2;color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;letter-spacing:1px">${nudgeMinutes} MIN LATE</span>`;
    primaryLine = `${toName} accepted a handoff for ${row.site_name} ${nudgeMinutes} minutes ago but has not clocked in yet. ${fromName} remains on shift.`;
    extraRow    = row.accepted_at ? `<tr><td style="padding:6px 0;color:#888">Accepted at</td><td style="padding:6px 0">${fmtTimeSite(row.accepted_at, tz)} ${tz}</td></tr>` : '';
  }

  const html = `<style>${BASE_STYLE}</style>
  <div class="card">
    <div class="hdr">
      <div class="brand">NETRAOPS</div>
      <h1 style="letter-spacing:0;font-size:24px;color:#fff;margin-top:6px">${headline}</h1>
      <p style="color:#F59E0B;letter-spacing:0;font-size:13px;margin:6px 0 0 0">${row.site_name}</p>
    </div>
    <div class="body">
      <p style="font-size:15px;color:#333;margin:0 0 4px 0">FYI —</p>
      <p style="color:#555;font-size:14px;margin:0 0 18px 0">${primaryLine}</p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-bottom:6px">
        <tr><td style="padding:6px 0;color:#888;width:130px">From</td><td style="padding:6px 0">${fromName} <span style="color:#888">(${row.from_badge})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">To</td><td style="padding:6px 0">${toName} <span style="color:#888">(${row.to_badge})</span></td></tr>
        <tr><td style="padding:6px 0;color:#888">Site</td><td style="padding:6px 0">${row.site_name}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Status</td><td style="padding:6px 0">${pill}</td></tr>
        ${extraRow}
      </table>

      ${reasonBlock}

      <div style="text-align:center;margin-top:24px">
        <a class="btn" href="${dashboardUrl}">Open Shift in Admin Dashboard</a>
      </div>
    </div>
    <div class="footer" style="text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      All times shown in the site's local time zone (${tz}).<br/>
      NetraOps · Automated alert
    </div>
  </div>`;

  const subject = kind === 'accepted'
    ? `Handoff accepted: ${fromName} → ${toName}`
    : kind === 'completed'
      ? `Handoff complete: ${fromName} → ${toName}`
      : `Handoff ${nudgeMinutes} min late: ${fromName} → ${toName}`;
  return { subject, html };
}

async function fanoutHandoffFyi(
  historyId: string,
  kind: 'accepted' | 'completed' | 'nudge',
  flow: 'handoff_accepted_fyi' | 'handoff_completed_fyi' | 'handoff_nudge',
  extra: Record<string, unknown>,
  nudgeMinutes = 0,
): Promise<void> {
  const row = await loadHandoffFyiRow(historyId);
  if (!row) return;
  const admins = await getActiveAdminEmails(row.company_id);
  if (admins.length === 0) {
    Sentry.captureMessage(`${flow}: no active admins for tenant`, {
      level: 'warning',
      tags: { service: 'sendgrid', flow },
      extra: { company_id: row.company_id, history_id: historyId },
    });
    return;
  }
  const { subject, html } = renderHandoffFyi(row, kind, nudgeMinutes);
  await sendToAdmins(admins, { from: FROM, subject, html }, flow, extra);
}

export async function sendHandoffAcceptedFyi(historyId: string): Promise<void> {
  await fanoutHandoffFyi(historyId, 'accepted', 'handoff_accepted_fyi', { history_id: historyId });
}

export async function sendHandoffCompletedFyi(historyId: string): Promise<void> {
  await fanoutHandoffFyi(historyId, 'completed', 'handoff_completed_fyi', { history_id: historyId });
}

export async function sendHandoffNudgeFyi(historyId: string, minutesLate: number): Promise<void> {
  await fanoutHandoffFyi(historyId, 'nudge', 'handoff_nudge', { history_id: historyId, minutes_late: minutesLate }, minutesLate);
}

// ── Welcome emails ───────────────────────────────────────────────────────────
//
// Fired from the four account-creation route handlers on new-account INSERT.
// Customer-facing: Reply-To is REPLY_TO (support inbox) on all four.
// Send fns catch internally, Sentry-tag, and re-throw so the caller's fire-
// and-forget .catch() can capture at the route site (matches the pattern
// used by sendTempPasswordEmail and sendIncidentAlert).

export function renderGuardWelcome(data: {
  guard_name: string;
  guard_email: string;
  company_name: string;
  primary_admin_email: string | null;
  temp_password: string;
}) {
  const contact = data.primary_admin_email
    ? `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact your Company Admin: <a href="mailto:${data.primary_admin_email}" style="color:#F59E0B">${data.primary_admin_email}</a></p>`
    : `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact NetraOps Support: <a href="mailto:${REPLY_TO}" style="color:#F59E0B">${REPLY_TO}</a></p>`;
  const html = `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>WELCOME</h1>
        <p>GUARD ACCOUNT</p>
      </div>
      <div class="body">
        <h2 style="font-size:18px;color:#333;margin:0 0 12px">Welcome to NetraOps</h2>
        <p style="color:#333;margin-bottom:16px">Hi ${data.guard_name},</p>
        <p style="color:#555;font-size:14px;margin-bottom:20px">
          An account has been created for you on NetraOps by <strong>${data.company_name}</strong>.
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Login credentials</h3>
        <ul style="color:#555;font-size:13px;margin:0 0 8px;padding-left:20px">
          <li>Email: ${data.guard_email}</li>
          <li>Temporary password: <strong style="font-family:'SF Mono','Menlo',monospace">${data.temp_password}</strong></li>
        </ul>
        <p style="color:#DC2626;font-size:13px;font-weight:600;margin:0 0 24px">
          <em>You'll be required to change this password on first login.</em>
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Download the NetraOps app</h3>
        <p style="color:#555;font-size:13px;margin:0 0 4px">iOS: Coming to App Store soon — contact your admin for TestFlight access</p>
        <p style="color:#555;font-size:13px;margin:0 0 8px">Android: Coming to Play Store soon</p>
        ${contact}
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`;
  return { subject: '[NetraOps] Welcome — Your Guard Account', html };
}

export async function sendGuardWelcomeEmail(args: {
  guard_id: string;
  guard_name: string;
  guard_email: string;
  company_id: string;
  temp_password: string;
}): Promise<void> {
  const result = await pool.query<{
    company_name: string | null;
    primary_admin_email: string | null;
  }>(
    `SELECT co.name AS company_name,
            ca.email AS primary_admin_email
       FROM companies co
       LEFT JOIN company_admins ca
         ON ca.company_id = co.id AND ca.is_primary = true AND ca.is_active = true
      WHERE co.id = $1`,
    [args.company_id],
  );
  const row = result.rows[0];
  if (!row) {
    console.warn(`[email] sendGuardWelcomeEmail: no company found for company_id=${args.company_id}`);
    return;
  }
  const { subject, html } = renderGuardWelcome({
    guard_name:          args.guard_name,
    guard_email:         args.guard_email,
    company_name:        row.company_name ?? 'NetraOps',
    primary_admin_email: row.primary_admin_email,
    temp_password:       args.temp_password,
  });
  try {
    await sgMail.send({ to: args.guard_email, from: FROM, replyTo: REPLY_TO, subject, html });
    console.log(`[email] sendGuardWelcomeEmail: SUCCESS — delivered to ${args.guard_email}`);
  } catch (err: any) {
    console.error(`[email] sendGuardWelcomeEmail: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('welcome_guard', err, { guard_id: args.guard_id });
    throw err;
  }
}

export function renderPrimaryAdminWelcome(data: {
  admin_name: string;
  admin_email: string;
  company_name: string;
  temp_password: string;
}) {
  const html = `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>WELCOME</h1>
        <p>ADMIN ACCOUNT</p>
      </div>
      <div class="body">
        <h2 style="font-size:18px;color:#333;margin:0 0 12px">Welcome to NetraOps</h2>
        <p style="color:#333;margin-bottom:16px">Hi ${data.admin_name},</p>
        <p style="color:#555;font-size:14px;margin-bottom:20px">
          An admin account has been created for you on NetraOps for <strong>${data.company_name}</strong>.
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Login credentials</h3>
        <ul style="color:#555;font-size:13px;margin:0 0 8px;padding-left:20px">
          <li>Email: ${data.admin_email}</li>
          <li>Temporary password: <strong style="font-family:'SF Mono','Menlo',monospace">${data.temp_password}</strong></li>
        </ul>
        <p style="color:#DC2626;font-size:13px;font-weight:600;margin:0 0 24px">
          <em>You'll be required to change this password on first login.</em>
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Access the admin portal</h3>
        <p style="margin:0 0 16px"><a href="https://app.netraops.com/admin" style="color:#F59E0B;text-decoration:none">app.netraops.com/admin</a></p>
        <p style="color:#555;font-size:13px;margin:0 0 24px">You can manage guards, sites, shifts, monitor real-time activity, and review reports.</p>
        <p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact NetraOps Support: <a href="mailto:${REPLY_TO}" style="color:#F59E0B">${REPLY_TO}</a></p>
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`;
  return { subject: '[NetraOps] Welcome — Your Admin Account', html };
}

export async function sendPrimaryAdminWelcomeEmail(args: {
  admin_id: string;
  admin_name: string;
  admin_email: string;
  company_id: string;
  temp_password: string;
}): Promise<void> {
  const result = await pool.query<{ company_name: string | null }>(
    `SELECT name AS company_name FROM companies WHERE id = $1`,
    [args.company_id],
  );
  const companyName = result.rows[0]?.company_name ?? 'NetraOps';
  const { subject, html } = renderPrimaryAdminWelcome({
    admin_name:    args.admin_name,
    admin_email:   args.admin_email,
    company_name:  companyName,
    temp_password: args.temp_password,
  });
  try {
    await sgMail.send({ to: args.admin_email, from: FROM, replyTo: REPLY_TO, subject, html });
    console.log(`[email] sendPrimaryAdminWelcomeEmail: SUCCESS — delivered to ${args.admin_email}`);
  } catch (err: any) {
    console.error(`[email] sendPrimaryAdminWelcomeEmail: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('welcome_admin_primary', err, { admin_id: args.admin_id });
    throw err;
  }
}

export function renderSecondaryAdminWelcome(data: {
  admin_name: string;
  admin_email: string;
  company_name: string;
  creator_name: string;
  primary_admin_email: string | null;
  temp_password: string;
}) {
  const contact = data.primary_admin_email
    ? `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact your Company Admin: <a href="mailto:${data.primary_admin_email}" style="color:#F59E0B">${data.primary_admin_email}</a></p>`
    : `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact NetraOps Support: <a href="mailto:${REPLY_TO}" style="color:#F59E0B">${REPLY_TO}</a></p>`;
  const html = `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>WELCOME</h1>
        <p>ADMIN ACCOUNT</p>
      </div>
      <div class="body">
        <h2 style="font-size:18px;color:#333;margin:0 0 12px">Welcome to NetraOps</h2>
        <p style="color:#333;margin-bottom:16px">Hi ${data.admin_name},</p>
        <p style="color:#555;font-size:14px;margin-bottom:20px">
          <strong>${data.creator_name}</strong> has created an admin account for you on NetraOps for <strong>${data.company_name}</strong>.
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Login credentials</h3>
        <ul style="color:#555;font-size:13px;margin:0 0 8px;padding-left:20px">
          <li>Email: ${data.admin_email}</li>
          <li>Temporary password: <strong style="font-family:'SF Mono','Menlo',monospace">${data.temp_password}</strong></li>
        </ul>
        <p style="color:#DC2626;font-size:13px;font-weight:600;margin:0 0 24px">
          <em>You'll be required to change this password on first login.</em>
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Access the admin portal</h3>
        <p style="margin:0 0 16px"><a href="https://app.netraops.com/admin" style="color:#F59E0B;text-decoration:none">app.netraops.com/admin</a></p>
        ${contact}
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`;
  return { subject: '[NetraOps] Welcome — Your Admin Account', html };
}

export async function sendSecondaryAdminWelcomeEmail(args: {
  admin_id: string;
  admin_name: string;
  admin_email: string;
  company_id: string;
  creator_admin_id: string;
  temp_password: string;
}): Promise<void> {
  const result = await pool.query<{
    company_name: string | null;
    creator_name: string | null;
    primary_admin_email: string | null;
  }>(
    `SELECT co.name AS company_name,
            creator.name AS creator_name,
            pa.email AS primary_admin_email
       FROM companies co
       LEFT JOIN company_admins creator ON creator.id = $2
       LEFT JOIN company_admins pa
         ON pa.company_id = co.id AND pa.is_primary = true AND pa.is_active = true
      WHERE co.id = $1`,
    [args.company_id, args.creator_admin_id],
  );
  const row = result.rows[0];
  if (!row) {
    console.warn(`[email] sendSecondaryAdminWelcomeEmail: no company found for company_id=${args.company_id}`);
    return;
  }
  const { subject, html } = renderSecondaryAdminWelcome({
    admin_name:          args.admin_name,
    admin_email:         args.admin_email,
    company_name:        row.company_name ?? 'NetraOps',
    creator_name:        row.creator_name ?? 'A NetraOps admin',
    primary_admin_email: row.primary_admin_email,
    temp_password:       args.temp_password,
  });
  try {
    await sgMail.send({ to: args.admin_email, from: FROM, replyTo: REPLY_TO, subject, html });
    console.log(`[email] sendSecondaryAdminWelcomeEmail: SUCCESS — delivered to ${args.admin_email}`);
  } catch (err: any) {
    console.error(`[email] sendSecondaryAdminWelcomeEmail: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('welcome_admin_secondary', err, { admin_id: args.admin_id });
    throw err;
  }
}

export function renderClientWelcome(data: {
  client_name: string;
  client_email: string;
  company_name: string;
  site_names: string;
  primary_admin_email: string | null;
  temp_password: string;
}) {
  const contact = data.primary_admin_email
    ? `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact your Company Admin: <a href="mailto:${data.primary_admin_email}" style="color:#F59E0B">${data.primary_admin_email}</a></p>`
    : `<p style="color:#555;font-size:13px;margin-top:20px">Questions? Contact NetraOps Support: <a href="mailto:${REPLY_TO}" style="color:#F59E0B">${REPLY_TO}</a></p>`;
  const html = `<style>${BASE_STYLE}</style>
    <div class="card">
      <div class="hdr">
        <div class="brand">NetraOps</div>
        <h1>WELCOME</h1>
        <p>CLIENT PORTAL</p>
      </div>
      <div class="body">
        <h2 style="font-size:18px;color:#333;margin:0 0 12px">Welcome to NetraOps</h2>
        <p style="color:#333;margin-bottom:16px">Hi ${data.client_name},</p>
        <p style="color:#555;font-size:14px;margin-bottom:12px">
          A client portal account has been created for you by <strong>${data.company_name}</strong> to review security operations.
        </p>
        ${data.site_names
          ? `<p style="color:#555;font-size:13px;margin:0 0 20px">Assigned site(s): <strong>${data.site_names}</strong></p>`
          : ''}
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Login credentials</h3>
        <ul style="color:#555;font-size:13px;margin:0 0 8px;padding-left:20px">
          <li>Email: ${data.client_email}</li>
          <li>Temporary password: <strong style="font-family:'SF Mono','Menlo',monospace">${data.temp_password}</strong></li>
        </ul>
        <p style="color:#DC2626;font-size:13px;font-weight:600;margin:0 0 24px">
          <em>You'll be required to change this password on first login.</em>
        </p>
        <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Access your client portal</h3>
        <p style="margin:0 0 16px"><a href="https://app.netraops.com/client" style="color:#6699FF;text-decoration:none">app.netraops.com/client</a></p>
        <p style="color:#555;font-size:13px;margin:0 0 24px">You can view live guard activity, daily shift reports, incident reports, and geofence alerts.</p>
        ${contact}
      </div>
      <div class="footer">NetraOps — Do not reply to this email</div>
    </div>`;
  return { subject: '[NetraOps] Welcome — Your Client Portal Access', html };
}

export async function sendClientWelcomeEmail(args: {
  client_id: string;
  client_name: string;
  client_email: string;
  company_id: string;
  site_ids: string[];
  temp_password: string;
}): Promise<void> {
  const [companyResult, sitesResult] = await Promise.all([
    pool.query<{
      company_name: string | null;
      primary_admin_email: string | null;
    }>(
      `SELECT co.name AS company_name,
              ca.email AS primary_admin_email
         FROM companies co
         LEFT JOIN company_admins ca
           ON ca.company_id = co.id AND ca.is_primary = true AND ca.is_active = true
        WHERE co.id = $1`,
      [args.company_id],
    ),
    pool.query<{ name: string }>(
      `SELECT name FROM sites WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [args.site_ids],
    ),
  ]);
  const co = companyResult.rows[0];
  if (!co) {
    console.warn(`[email] sendClientWelcomeEmail: no company found for company_id=${args.company_id}`);
    return;
  }
  const siteNames = sitesResult.rows.map((r) => r.name).join(', ');
  const { subject, html } = renderClientWelcome({
    client_name:         args.client_name,
    client_email:        args.client_email,
    company_name:        co.company_name ?? 'NetraOps',
    site_names:          siteNames,
    primary_admin_email: co.primary_admin_email,
    temp_password:       args.temp_password,
  });
  try {
    await sgMail.send({ to: args.client_email, from: FROM, replyTo: REPLY_TO, subject, html });
    console.log(`[email] sendClientWelcomeEmail: SUCCESS — delivered to ${args.client_email}`);
  } catch (err: any) {
    console.error(`[email] sendClientWelcomeEmail: SENDGRID ERROR — ${err?.message ?? err}`, err?.response?.body);
    reportSendgridFailure('welcome_client', err, { client_id: args.client_id });
    throw err;
  }
}
