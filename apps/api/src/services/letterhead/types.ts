/**
 * The company letterhead every report surface draws from (Phase B). Built by
 * services/letterhead (index.ts) from the companies row Phase A added.
 *
 * Text fields are trimmed; an empty value is null. `logo` is either bytes that
 * checkImageDecodes() accepted or null, never anything a renderer must guard:
 * a logo that is missing, too large, unreachable or does not decode becomes
 * null, and every surface then shows the company name in its place (N167).
 */
export interface Letterhead {
  companyName: string;
  contactEmail: string | null;
  phone: string | null;
  address: string | null;
  /** companies.licence_number. Rendered as "License No." (US spelling). */
  licenceNumber: string | null;
  website: string | null;
  /** PNG or JPEG bytes that decode, or null. */
  logo: Buffer | null;
}
