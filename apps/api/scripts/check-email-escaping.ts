/**
 * N79 — every email template escapes user text, and no template over-escapes.
 *
 * Run: npx ts-node scripts/check-email-escaping.ts
 *
 * WHY A SCRIPT AND NOT A SAMPLE. The defect is per-interpolation: 58 holes
 * across twelve HTML builders, sitting beside ~30 holes that hold MARKUP and
 * must NOT be escaped. Checking a few templates proves nothing about the rest,
 * and the failure mode of over-escaping (raw CSS and literal <tr> text in a
 * customer's inbox) is worse than the under-escaping it replaces.
 *
 * Every renderer is PURE — no database, no SendGrid — so all of this runs
 * offline with no env and no DATABASE_URL.
 *
 * THE FIVE ASSERTIONS, per template:
 *   1  the poison fixture appears ESCAPED in the HTML body
 *   2  no raw `<` or unencoded `&` survives from injected user text
 *   3  no `&amp;amp;` anywhere — the double-escape canary
 *   4  the MARKUP survived: <style>, <table>, <tr>, class="rrow" etc. are
 *      still real tags. THIS IS THE ONE THAT CATCHES OVER-ESCAPING.
 *   5  the SUBJECT is left RAW — a subject line is plain text, and `&amp;`
 *      in an inbox subject is a worse bug than the one being fixed.
 */
import * as E from '../src/services/email';

const POISON = `O'Brien & Sons <Site "A">`;
const ESCAPED = `O'Brien &amp; Sons &lt;Site &quot;A&quot;&gt;`;
const ESCAPED_TEXT = `O'Brien &amp; Sons &lt;Site "A"&gt;`;   // text nodes leave `"` alone

let failures = 0;
const fail = (t: string, m: string) => { failures++; console.log(`  FAIL  [${t}] ${m}`); };
const D = new Date('2026-03-01T16:00:00Z');

/** Tags that must still be TAGS after escaping. Per-template. */
type Case = { name: string; out: { subject: string; html: string }; markup: string[]; subjectHasPoison: boolean };

const cases: Case[] = [
  { name: 'incidentAlert', markup: ['<style>', '<div class="card"', '<span style="background:'], subjectHasPoison: true,
    out: E.renderIncidentAlert({ report_id:'r1', description:POISON, severity:'high', reported_at:D,
      site_name:POISON, site_tz:'America/Los_Angeles', client_name:POISON, company_name:POISON }) },

  { name: 'dailyShiftReport', markup: ['<style>', 'class="rrow"', '<table'], subjectHasPoison: true,
    out: E.renderDailyShiftReport({ site_name:POISON, site_tz:'America/Los_Angeles', scheduled_start:D,
      guard_name:POISON, badge_number:POISON, client_name:POISON, company_name:POISON,
      clocked_in_at:D, clocked_out_at:D, total_hours:8,
      hours:{ scheduled_hours:8, actual_hours:8, break_hours:0.5, violation_hours:0 } as any,
      reports:[{ report_type:'incident', severity:'high', description:POISON, reported_at:D }],
      tasks_completed:1, tasks_total:2, pings_submitted:3, pings_expected:4 }) },

  { name: 'missedShiftAlert', markup: ['<style>', '<tr>', '<a class="btn"'], subjectHasPoison: true,
    out: E.renderMissedShiftAlert({ id:'s1', scheduled_start:D, scheduled_end:D, site_name:POISON,
      site_tz:'America/Los_Angeles', site_address:POISON, guard_name:POISON, badge_number:POISON,
      guard_phone:POISON, last_login_at:D, upcoming_shifts_count:2 }) },

  { name: 'unstaffedPostWarning', markup: ['<style>', '<tr', '<a class="btn"'], subjectHasPoison: true,
    out: E.renderUnstaffedPostWarning([{ id:'s1', site_id:'si1', site_name:POISON, site_address:POISON,
      site_tz:'America/Los_Angeles', scheduled_start:D, scheduled_end:D }], D) },

  { name: 'geofenceBreachAlert', markup: ['<style>', '<tr>', '<code style='], subjectHasPoison: true,
    out: E.renderGeofenceBreachAlert({ id:'v1', shift_session_id:'ss1', occurred_at:D,
      violation_lat:37.1, violation_lng:-122.1, photo_url:'https://x/y.jpg', site_name:POISON,
      site_tz:'America/Los_Angeles', site_address:POISON, center_lat:37.0, center_lng:-122.0,
      guard_name:POISON, badge_number:POISON }, { kind:'ping' }) },

  { name: 'swapAcceptedFyi', markup: ['<style>', '<tr>', '<div style="background:#F3F4F6'], subjectHasPoison: true,
    out: E.renderSwapAcceptedFyi({ shift_id:'s1', scheduled_start:D, scheduled_end:D, site_name:POISON,
      site_tz:'America/Los_Angeles', from_guard_name:POISON, from_badge:POISON, to_guard_name:POISON,
      to_badge:POISON, is_same_site:true, reason:POISON }) },

  { name: 'handoffFyi(nudge)', markup: ['<style>', '<span style="background:', '<tr>'], subjectHasPoison: true,
    out: E.renderHandoffFyi({ history_id:'h1', shift_id:'s1', reason:POISON, accepted_at:D, handoff_at:D,
      duration_hours:4, from_guard_name:POISON, from_badge:POISON, to_guard_name:POISON, to_badge:POISON,
      site_name:POISON, site_tz:'America/Los_Angeles', company_id:'c1' }, 'nudge', 12) },

  { name: 'guardWelcome', markup: ['<style>', '<div class="card"', '<ul style='], subjectHasPoison: false,
    out: E.renderGuardWelcome({ guard_name:POISON, guard_email:POISON, company_name:POISON,
      primary_admin_email:POISON, temp_password:'Abc23xyz' }) },

  { name: 'primaryAdminWelcome', markup: ['<style>', '<div class="card"'], subjectHasPoison: false,
    out: E.renderPrimaryAdminWelcome({ admin_name:POISON, admin_email:POISON, company_name:POISON,
      temp_password:'Abc23xyz' } as any) },

  { name: 'secondaryAdminWelcome', markup: ['<style>', '<div class="card"'], subjectHasPoison: false,
    out: E.renderSecondaryAdminWelcome({ admin_name:POISON, admin_email:POISON, company_name:POISON,
      creator_name:POISON, primary_admin_email:POISON, temp_password:'Abc23xyz' } as any) },

  { name: 'clientWelcome', markup: ['<style>', '<div class="card"'], subjectHasPoison: false,
    out: E.renderClientWelcome({ client_name:POISON, client_email:POISON, company_name:POISON,
      site_names:POISON, primary_admin_email:POISON, temp_password:'Abc23xyz' } as any) },
];

console.log(`[check-email-escaping] ${cases.length} templates, poison = ${POISON}\n`);

for (const c of cases) {
  const { subject, html } = c.out;
  const before = failures;

  // 1 — the poison appears, escaped
  if (!html.includes(ESCAPED_TEXT) && !html.includes(ESCAPED))
    fail(c.name, 'escaped fixture not found in html — is the value escaped at all?');

  // 2 — no injected raw markup survived into the body
  if (html.includes('<Site'))     fail(c.name, 'RAW `<Site` in html — unescaped user text');
  // A bare `&` is one NOT starting a valid entity. The templates use static
  // entities beyond the escaped set — &ldquo; &rdquo; &nbsp; &#39; — so the
  // test is "is this a well-formed entity", not "is it one of five".
  // (This whitelist was the check's own bug on the first run: it flagged
  //  &ldquo; in swapAcceptedFyi as unescaped user text. The instrument was
  //  wrong, not the template.)
  if (/&(?![a-zA-Z][a-zA-Z0-9]{1,9};|#\d{1,6};|#x[0-9a-fA-F]{1,5};)/.test(html))
    fail(c.name, 'a bare `&` survived — not escaped, or escaped out of order');

  // 3 — double-escape canary
  if (html.includes('&amp;amp;'))  fail(c.name, 'DOUBLE-ESCAPED (&amp;amp;) — value escaped twice on its path');
  if (html.includes('&amp;lt;'))   fail(c.name, 'DOUBLE-ESCAPED (&amp;lt;) — `&` replaced after `<`');

  // 4 — THE OVER-ESCAPING CHECK: markup must still be markup.
  //
  // The stylesheet is compared VERBATIM rather than by looking for `<style>`.
  // BASE_STYLE currently contains no & < >, so escapeHtml(BASE_STYLE) is a
  // silent no-op and a `<style>` presence check cannot see it. One CSS child
  // selector (`.card > p`) would change that, and the mistake would ship.
  if (!html.includes(E.BASE_STYLE))
    fail(c.name, 'STYLESHEET ALTERED: the <style> block is not BASE_STYLE verbatim — it was escaped');

  for (const tag of c.markup)
    if (!html.includes(tag)) fail(c.name, `MARKUP DESTROYED: ${JSON.stringify(tag)} is no longer a tag — a markup hole was escaped`);
  if (html.includes('&lt;style&gt;') || html.includes('&lt;tr') || html.includes('&lt;div'))
    fail(c.name, 'MARKUP ESCAPED: found &lt;style&gt;/&lt;tr/&lt;div — a fragment variable was wrapped');

  // 5 — the subject stays raw
  if (/&amp;|&lt;|&gt;|&quot;/.test(subject))
    fail(c.name, `SUBJECT ESCAPED: ${JSON.stringify(subject.slice(0,80))} — a subject is plain text`);
  if (c.subjectHasPoison && !subject.includes('&'))
    fail(c.name, 'subject lost the raw `&` from the fixture');

  if (failures === before) console.log(`  ok    ${c.name.padEnd(24)} html=${String(html.length).padStart(5)}b  subject=${JSON.stringify(subject.slice(0,58))}`);
}

console.log('');
if (failures) { console.log(`[check-email-escaping] FAIL — ${failures} problem(s)`); process.exit(1); }
console.log(`[check-email-escaping] PASS — ${cases.length} templates: user text escaped, markup intact, subjects raw, no double-escape.`);
