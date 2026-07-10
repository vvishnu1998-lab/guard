import crypto from 'crypto';

/**
 * Alphabet used for admin-generated temp passwords. Excludes visually
 * ambiguous characters (0/O, 1/l/I) so admins can dictate the password
 * over the phone without spelling out each character.
 */
export const TEMP_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * Cryptographically secure temp password generator.
 *
 *   length = 8  → ~46 bits of entropy (used by guard/company_admin flows —
 *                 the existing 8-char format preserved for backwards compat
 *                 with the temp-password email template).
 *   length = 12 → ~69 bits of entropy (used by the new client creation
 *                 flow — Session C spec).
 */
export function generateTempPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}
