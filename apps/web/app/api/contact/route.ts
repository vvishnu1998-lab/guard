import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';

/**
 * Demo-request contact endpoint for the marketing homepage.
 *
 * Accepts JSON { name, company, email, sites, message, website } and relays
 * it to support@netraops.com via SendGrid. "website" is a honeypot — real
 * users never see the field, so a non-empty value means a bot and the
 * request is silently dropped with a 200.
 *
 * This is the only server-side code in apps/web besides middleware; it has
 * no dependency on apps/api and shares nothing with the portal auth flow.
 */

const VALID_SITES = ['1–4 sites', '5–14 sites', '15–24 sites', '25+ sites'] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Best-effort in-memory rate limit: max 5 requests per IP per hour. The Map
// lives per serverless instance, so counts reset on cold starts and are not
// shared across concurrent instances — good enough to blunt casual abuse,
// not a real quota.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body.name);
  const company = str(body.company);
  const email = str(body.email);
  const sites = str(body.sites);
  const message = str(body.message);
  const website = str(body.website);

  // Honeypot tripped: pretend success, send nothing.
  if (website !== '') {
    return NextResponse.json({ ok: true });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
  }

  if (
    !name || name.length > 200 ||
    !company || company.length > 200 ||
    !email || email.length > 200 || !EMAIL_RE.test(email) ||
    !(VALID_SITES as readonly string[]).includes(sites) ||
    message.length > 2000
  ) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    console.error(
      `[contact] Missing env: ${!apiKey ? 'SENDGRID_API_KEY ' : ''}${!fromEmail ? 'SENDGRID_FROM_EMAIL' : ''}`.trim(),
    );
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }

  const submittedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'long',
  });

  const text = [
    `Name: ${name}`,
    `Company: ${company}`,
    `Email: ${email}`,
    `Number of sites: ${sites}`,
    '',
    'Message:',
    message || '(none)',
    '',
    `Submitted: ${submittedAt} (Pacific)`,
  ].join('\n');

  try {
    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: 'support@netraops.com',
      from: fromEmail,
      replyTo: email,
      subject: `Demo request — ${company} (${sites})`,
      text,
    });
  } catch (err) {
    console.error('[contact] SendGrid send failed:', err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
