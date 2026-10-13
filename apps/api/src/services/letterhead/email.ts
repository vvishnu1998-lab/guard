/**
 * The company letterhead in a client email (Phase B, stage B4): the incident
 * alert (#10, POST /api/reports) and the daily shift report (#9, the 09:00 PT
 * job). Decisions locked by Vishnu, 2026-10-12:
 *   - the company's brand leads; NetraOps appears only as "Powered by
 *     NetraOps" in the footer;
 *   - replies go to the company's contact email when it has one, and the
 *     footer says "Reply to this email to contact …" only then;
 *   - a logo that is missing, heavier than EMAIL_LOGO_MAX_BYTES, slower than
 *     EMAIL_LOGO_WAIT_MS or does not decode leaves the company name standing
 *     alone (N167); a letterhead problem never stops or holds up an email.
 *
 * THE LOGO TRAVELS INSIDE THE MESSAGE, never as a URL. The header's <img>
 * points at `cid:company-logo`, and the message carries the bytes as a
 * SendGrid attachment with disposition 'inline' and that content_id. A
 * presigned URL would expire in the inbox; a public one would publish the
 * tenant's object.
 *
 * mailLetterhead() decides once per email whether the logo goes, and the
 * header references it exactly when the attachment exists, so a message can
 * never point at an image it does not carry.
 *
 * Every value from the companies row is escaped once, here (email.ts's N79
 * rule: escape at the innermost point a raw value enters a string).
 */
import { Sentry } from '../sentry';
import { checkImageDecodes } from '../imageDecode';
import { letterheadForCompany, letterheadForSite } from './index';
import { contactLines } from './text';
import type { Letterhead } from './types';
import { ES } from '../emailStyles';

/** What the header's <img src="cid:…"> and the attachment's content_id share. */
export const LOGO_CONTENT_ID = 'company-logo';

/**
 * The heaviest logo an email carries (Vishnu, 2026-10-12, 2a). Base64 adds a
 * third, so the logo part stays under ~350 KB. A heavier logo still prints on
 * the PDFs; the email shows the company name and Sentry hears once per logo.
 */
export const EMAIL_LOGO_MAX_BYTES = 256 * 1024;

/** How long an email waits for a logo that is not cached yet (PDFs wait 5 s). */
export const EMAIL_LOGO_WAIT_MS = 2000;

/** The logo is scaled into this box (CSS px), aspect kept, never enlarged. */
export const EMAIL_LOGO_BOX = { w: 180, h: 60 } as const;

/**
 * One SendGrid attachment, keyed as the v3 API names its fields. `content_id`
 * is snake_case ON PURPOSE: @sendgrid/helpers hands attachment objects to the
 * API as they are (convertKeys skips arrays), so a camelCase `contentId`
 * would arrive under a name the API does not define and the logo would lose
 * its Content-ID. `content` is base64 we encode: given a Buffer with
 * disposition 'inline', the helper would convert it as UTF-8.
 */
export interface InlineLogo {
  content: string;
  filename: string;
  type: 'image/png' | 'image/jpeg';
  disposition: 'inline';
  content_id: string;
}

export interface MailLetterhead {
  companyName: string;
  /** contactLines(): the address; phone · email · website; "License No. …". */
  lines: string[];
  logo: { width: number; height: number; attachment: InlineLogo } | null;
  /** The company's contact email when it is an address SendGrid takes; null leaves the caller's Reply-To. */
  replyTo: string | null;
}

/**
 * The letterhead of the company that runs `siteId`, ready for an email, or
 * null (no letterhead: the caller sends today's email unchanged). Waits at
 * most EMAIL_LOGO_WAIT_MS for a logo that is not cached yet. Never throws:
 * the lookup returns null on any failure.
 */
export async function mailLetterheadForSite(siteId: string): Promise<MailLetterhead | null> {
  return mailLetterhead(await letterheadForSite(siteId, { logoWaitMs: EMAIL_LOGO_WAIT_MS }));
}

/** The same, for an email about a company itself: its admins' alerts, its account emails (B5). */
export async function mailLetterheadForCompany(companyId: string): Promise<MailLetterhead | null> {
  return mailLetterhead(await letterheadForCompany(companyId, { logoWaitMs: EMAIL_LOGO_WAIT_MS }));
}

/** null in, null out. */
export function mailLetterhead(lh: Letterhead | null): MailLetterhead | null {
  if (!lh) return null;
  return {
    companyName: lh.companyName,
    lines: contactLines(lh),
    logo: inlineLogo(lh),
    replyTo: replyAddress(lh.contactEmail),
  };
}

/**
 * The message with the letterhead's Reply-To and logo; with none, the same
 * object. `replyTo: false` leaves the message's own Reply-To alone: an admin
 * alert has none, and replies to it go nowhere new (decision D2a, B5).
 */
export function withLetterhead<T extends object>(msg: T, m: MailLetterhead | null, opts: { replyTo?: boolean } = {}): T {
  if (!m) return msg;
  return {
    ...msg,
    ...(m.replyTo && opts.replyTo !== false ? { replyTo: m.replyTo } : {}),
    ...(m.logo ? { attachments: [m.logo.attachment] } : {}),
  };
}

/**
 * The header that replaces the NetraOps band: the logo (when it goes) and the
 * company name with its contact lines beside it, then the email's title and
 * the caller's subtitle. `subtitleHtml` is markup the caller already escaped.
 * The logo carries width and height attributes, so a client that ignores CSS
 * (Outlook on Windows) cannot draw it at its native 256–2048 px.
 */
export function mailHeaderHtml(m: MailLetterhead, title: string, subtitleHtml: string): string {
  return `<div style="background:#ffffff;padding:24px 28px 18px 28px;border-bottom:1px solid #E5E7EB">
      ${companyTable(m)}
      <h1 style="margin:20px 0 0 0;font-size:22px;font-weight:700;color:#0B1526;letter-spacing:0">${esc(title)}</h1>
      <p style="margin:4px 0 0 0;font-size:13px;color:#6B7280">${subtitleHtml}</p>
    </div>`;
}

/**
 * The company block alone, white, for an admin alert to stand its own
 * coloured band under (decision D3a, B5): the company leads, and the band
 * still says at a glance whether this is an alert, a warning or a notice.
 */
export function mailCompanyHtml(m: MailLetterhead): string {
  return `<div style="background:#ffffff;padding:24px 28px">
      ${companyTable(m)}
    </div>`;
}

/** The logo (when it goes) and the company name with its contact lines beside it. */
function companyTable(m: MailLetterhead): string {
  const logoCell = m.logo
    ? `<td style="padding:0 16px 0 0;vertical-align:middle"><img src="cid:${LOGO_CONTENT_ID}" width="${m.logo.width}" height="${m.logo.height}" alt="" style="display:block;border:0;width:${m.logo.width}px;height:${m.logo.height}px"></td>`
    : '';
  const lines = m.lines
    .map((l) => `<div style="font-size:12px;color:#6B7280;line-height:1.5">${esc(l)}</div>`)
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${logoCell}<td style="vertical-align:middle"><div style="font-size:18px;font-weight:700;color:#0B1526;line-height:1.3">${esc(m.companyName)}</div>${lines}</td></tr></table>`;
}

/** The last line of every letterheaded email's footer. */
export const POWERED_BY_HTML = '<div style="margin-top:10px;font-size:10px;color:#9CA3AF;letter-spacing:1px">Powered by NetraOps</div>';

/**
 * The footer under a letterheaded email: today's lines, the reply line only
 * when replies really reach the company (1a), and "Powered by NetraOps".
 * `tz` null drops the time zone line, for an email that shows no times (an
 * account email, B5).
 */
export function mailFooterHtml(m: MailLetterhead, tz: string | null): string {
  const reply = m.replyTo ? `<br/>
      Reply to this email to contact ${esc(m.companyName)}.` : '';
  const zone = tz === null ? '' : `All times shown in the site's local time zone (${esc(tz)}).<br/>
      `;
  return `<div style="${ES.footer};text-align:left;padding:18px 28px;line-height:1.7;color:#888">
      ${zone}Provided by <strong style="color:#666">${esc(m.companyName)}</strong>.${reply}
      ${POWERED_BY_HTML}
    </div>`;
}

function inlineLogo(lh: Letterhead): MailLetterhead['logo'] {
  const bytes = lh.logo;
  if (!bytes) return null;
  if (bytes.length > EMAIL_LOGO_MAX_BYTES) {
    tooHeavy(bytes);
    return null;
  }
  // The lookup already decoded these (N167); this re-check gives the size and
  // kind, and is the backstop if a Letterhead is ever built by hand.
  const d = checkImageDecodes(bytes);
  if (!d.ok) return null;
  const scale = Math.min(EMAIL_LOGO_BOX.w / d.width, EMAIL_LOGO_BOX.h / d.height, 1);
  const png = d.kind === 'png';
  return {
    width: Math.max(1, Math.round(d.width * scale)),
    height: Math.max(1, Math.round(d.height * scale)),
    attachment: {
      content: bytes.toString('base64'),
      filename: png ? 'logo.png' : 'logo.jpg',
      type: png ? 'image/png' : 'image/jpeg',
      disposition: 'inline',
      content_id: LOGO_CONTENT_ID,
    },
  };
}

// One warning per logo, not per email: the cached logo is the same Buffer on
// every send until it changes or leaves the cache (email.ts counts SendGrid
// failures for the same reason, 2026-09-01).
const warnedHeavy = new WeakSet<Buffer>();
function tooHeavy(bytes: Buffer): void {
  if (warnedHeavy.has(bytes)) return;
  warnedHeavy.add(bytes);
  console.warn('[letterhead] logo too heavy for email; the company name stands in', { bytes: bytes.length, max: EMAIL_LOGO_MAX_BYTES });
  Sentry.captureMessage('letterhead_logo_unavailable', {
    level: 'warning',
    tags: { flow: 'letterhead', reason: 'too_heavy_for_email' },
    extra: { bytes: bytes.length, max: EMAIL_LOGO_MAX_BYTES },
  });
}

// What a browser's <input type=email> accepts (the WHATWG rule), with a dot
// required in the domain. Stricter than the profile's own check
// (companyProfile.ts), so the Reply-To is never why SendGrid refuses a
// message: an address it might not take leaves today's Reply-To in place.
const REPLY_TO_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
function replyAddress(email: string | null): string | null {
  return email !== null && email.length <= 254 && REPLY_TO_RE.test(email) ? email : null;
}

/** Text nodes and double-quoted attributes; `&` first (email.ts, N79). */
function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
