/**
 * The company letterhead, looked up from whatever a report is about: the
 * company itself, a site, or a guard (Phase B, stage B0).
 *
 *   letterheadForCompany(companyId)   letterheadForSite(siteId)   letterheadForGuard(guardId)
 *
 * Each returns a Letterhead (./types.ts) or null. NOTHING HERE THROWS, and a
 * letterhead problem never fails a document:
 *   - an id that is not a UUID, or matches no row: null, and the caller
 *     renders today's NetraOps header (Vishnu, 2026-10-06);
 *   - a database error: null, logged and sent to Sentry as a warning;
 *   - a logo that is not in our bucket, missing, too large, slow or does not
 *     decode: the letterhead comes back with logo null (the company name takes
 *     its place, N167), logged and sent to Sentry as a warning.
 *
 * The text fields are read on every call; only logo bytes are cached
 * (./cache.ts), keyed by company and logo_updated_at.
 */
import { pool } from '../../db/pool';
import { Sentry } from '../sentry';
import { getS3ObjectBuffer, s3KeyFromPublicUrl, S3ObjectTooLargeError } from '../s3';
import { checkImageDecodes } from '../imageDecode';
import { LOGO_MAX_BYTES } from '../companyProfile';
import { LogoCache } from './cache';
import type { Letterhead } from './types';

export type { Letterhead } from './types';

/** A report waits at most this long for a logo before rendering without it. */
export const LOGO_FETCH_TIMEOUT_MS = 5000;

export const logoCache = new LogoCache({
  maxEntries: 32,
  maxBytes: 16 * 1024 * 1024,
  hitTtlMs: 6 * 60 * 60 * 1000,
  missTtlMs: 10 * 60 * 1000,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = `
  SELECT c.id, c.name, c.contact_email, c.phone, c.address, c.licence_number, c.website,
         c.logo_url, c.logo_updated_at
    FROM companies c`;

export function letterheadForCompany(companyId: string): Promise<Letterhead | null> {
  return lookup('company', companyId, `${SELECT} WHERE c.id = $1`);
}

export function letterheadForSite(siteId: string): Promise<Letterhead | null> {
  return lookup('site', siteId, `${SELECT} JOIN sites s ON s.company_id = c.id WHERE s.id = $1`);
}

export function letterheadForGuard(guardId: string): Promise<Letterhead | null> {
  return lookup('guard', guardId, `${SELECT} JOIN guards g ON g.company_id = c.id WHERE g.id = $1`);
}

interface CompanyRow {
  id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  address: string | null;
  licence_number: string | null;
  website: string | null;
  logo_url: string | null;
  logo_updated_at: Date | string | null;
}

async function lookup(via: 'company' | 'site' | 'guard', id: string, sql: string): Promise<Letterhead | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  let row: CompanyRow | undefined;
  try {
    row = (await pool.query<CompanyRow>(sql, [id])).rows[0];
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[letterhead] lookup failed; rendering without a letterhead', { via, detail });
    Sentry.captureMessage('letterhead_lookup_failed', { level: 'warning', tags: { flow: 'letterhead', via }, extra: { detail } });
    return null;
  }
  if (!row) return null;
  return {
    companyName: row.name,
    contactEmail: text(row.contact_email),
    phone: text(row.phone),
    address: text(row.address),
    licenceNumber: text(row.licence_number),
    website: text(row.website),
    logo: row.logo_url ? await logoFor(row.id, row.logo_url, row.logo_updated_at) : null,
  };
}

const text = (v: string | null): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function logoFor(companyId: string, logoUrl: string, updatedAt: Date | string | null): Promise<Buffer | null> {
  let stamp = 'unset';
  if (updatedAt !== null) {
    const t = new Date(updatedAt).getTime();
    stamp = Number.isNaN(t) ? String(updatedAt) : new Date(t).toISOString();
  }
  return logoCache.get(`${companyId}:${stamp}`, () => fetchLogo(companyId, logoUrl));
}

async function fetchLogo(companyId: string, logoUrl: string): Promise<Buffer | null> {
  // The strict parser: a URL on any other host is not ours to fetch.
  const key = s3KeyFromPublicUrl(logoUrl);
  if (!key) return unavailable(companyId, 'not_our_bucket', 'logo_url is not an object in the configured bucket');
  let buf: Buffer;
  try {
    buf = await getS3ObjectBuffer(key, { maxBytes: LOGO_MAX_BYTES, timeoutMs: LOGO_FETCH_TIMEOUT_MS });
  } catch (err) {
    return unavailable(companyId, s3Reason(err), err instanceof Error ? err.message : String(err));
  }
  const decoded = checkImageDecodes(buf);
  if (!decoded.ok) return unavailable(companyId, 'does_not_decode', decoded.reason);
  return buf;
}

function s3Reason(err: unknown): string {
  if (err instanceof S3ObjectTooLargeError) return 'too_large';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'NoSuchKey' || code === 'NotFound') return 'missing';
  if (code === 'RequestAbortedError') return 'timeout';
  return 's3_error';
}

function unavailable(companyId: string, reason: string, detail: string): null {
  console.warn('[letterhead] logo unavailable; the company name stands in', { company_id: companyId, reason, detail });
  Sentry.captureMessage('letterhead_logo_unavailable', {
    level: 'warning',
    tags: { flow: 'letterhead', reason },
    extra: { company_id: companyId, detail },
  });
  return null;
}
