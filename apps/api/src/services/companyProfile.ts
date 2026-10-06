/**
 * Company profile (schema_v82): the fields a primary admin may edit, their
 * validation, and the error body used by routes/companyProfile.ts.
 *
 * Pure: no database and no I/O, so scripts/test-company-profile.ts can drive
 * it directly as well as through the routes.
 */

export const PROFILE_FIELDS = ['contact_email', 'phone', 'address', 'licence_number', 'website'] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];
export type ProfileValues = Partial<Record<ProfileField, string | null>>;

/** Logo upload limits: bytes, and pixels on the longest side. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIN_SIDE = 256;
export const LOGO_MAX_SIDE = 2048;

/**
 * The enum goes in `code`, the copy in both `error` and `message`. These routes
 * are web-only, so this is the PATCH /api/shifts/:id/cancel shape
 * (routes/shifts.ts): web's ApiError.message is body.error, which admin screens
 * render verbatim, so an enum in `error` would reach the screen.
 */
export function errorBody(code: string, copy: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code, error: copy, message: copy, ...extra };
}

const LABEL: Record<ProfileField, string> = {
  contact_email:  'Contact email',
  phone:          'Phone',
  address:        'Address',
  licence_number: 'Licence number',
  website:        'Website',
};

/** Upper bounds, matching the schema_v82 column widths (address is text; 500 is the API's cap). */
const MAX_CHARS: Record<ProfileField, number> = {
  contact_email:  255,
  phone:          32,
  address:        500,
  licence_number: 64,
  website:        255,
};
const PHONE_MIN_CHARS = 7;
const PHONE_MIN_DIGITS = 7;

// Code points, which is how Postgres counts varchar(n) characters; UTF-16
// .length would count an emoji twice.
const charCount = (s: string): number => Array.from(s).length;

// NUL cannot be stored in a text column at all, so every field refuses control
// characters; only the address keeps tab and line breaks.
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_LINE_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS = /^[0-9+\-() ]+$/;

export interface FieldError { code: string; message: string }
type FieldResult = { ok: true; value: string | null } | { ok: false; error: FieldError };

const fail = (code: string, message: string): FieldResult => ({ ok: false, error: { code, message } });

/** Trims; an empty string becomes null, so "not provided" has one representation. */
function validateField(field: ProfileField, raw: unknown): FieldResult {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return fail('INVALID_TYPE', `${LABEL[field]} must be text.`);
  const value = raw.trim();
  if (value === '') return { ok: true, value: null };
  if (charCount(value) > MAX_CHARS[field]) {
    return fail('TOO_LONG', `${LABEL[field]} must be ${MAX_CHARS[field]} characters or fewer.`);
  }

  switch (field) {
    case 'contact_email':
      if (CONTROL.test(value) || !EMAIL.test(value)) {
        return fail('INVALID_EMAIL', 'Enter a valid email address, like office@example.com.');
      }
      break;
    case 'phone':
      if (charCount(value) < PHONE_MIN_CHARS) {
        return fail('TOO_SHORT', `Phone must be at least ${PHONE_MIN_CHARS} characters.`);
      }
      if (!PHONE_CHARS.test(value)) {
        return fail('INVALID_PHONE', 'Phone can contain only digits, spaces and + - ( ).');
      }
      if (value.replace(/[^0-9]/g, '').length < PHONE_MIN_DIGITS) {
        return fail('INVALID_PHONE', `Phone must include at least ${PHONE_MIN_DIGITS} digits.`);
      }
      break;
    case 'address':
      if (CONTROL_EXCEPT_LINE_BREAKS.test(value)) {
        return fail('INVALID_CHARACTERS', 'Address contains characters that are not allowed.');
      }
      break;
    case 'licence_number':
      if (CONTROL.test(value)) {
        return fail('INVALID_CHARACTERS', 'Licence number must be a single line of text.');
      }
      break;
    case 'website': {
      if (/\s/.test(value) || CONTROL.test(value)) {
        return fail('INVALID_URL', 'Website cannot contain spaces.');
      }
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return fail('INVALID_URL', 'Enter the full website address, starting with https://.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return fail('INVALID_URL', 'Website must start with http:// or https://.');
      }
      // A public site has a dotted host; a login embedded in the URL would be
      // printed on every letterhead.
      if (!url.hostname.includes('.') || url.username !== '' || url.password !== '') {
        return fail('INVALID_URL', 'Enter a valid website address, like https://example.com.');
      }
      break;
    }
  }
  return { ok: true, value };
}

export type PatchParse =
  | { ok: true; values: ProfileValues }
  | { ok: false; body: Record<string, unknown> };   // always answered with 400

/**
 * Validates a PATCH /api/admin/company body. `name` is refused on its own,
 * with the copy the Settings page shows beside the read-only name (decision
 * 3a); any other key outside PROFILE_FIELDS is refused by name. Every invalid
 * field is reported at once, keyed by field, so the form can mark each input.
 */
export function parseProfilePatch(body: unknown): PatchParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, body: errorBody('INVALID_BODY', 'Send the profile fields as a JSON object.') };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  if (keys.includes('name')) {
    return { ok: false, body: errorBody('NAME_NOT_EDITABLE', 'Contact NetraOps to change your company name.') };
  }
  const allowed: readonly string[] = PROFILE_FIELDS;
  const unknown = keys.filter((k) => !allowed.includes(k)).sort();
  if (unknown.length > 0) {
    return {
      ok: false,
      body: errorBody('UNKNOWN_FIELDS', `These fields can't be changed here: ${unknown.join(', ')}.`, { fields: unknown }),
    };
  }
  if (keys.length === 0) {
    return { ok: false, body: errorBody('NO_FIELDS', 'Nothing to update.') };
  }

  const values: ProfileValues = {};
  const errors: Partial<Record<ProfileField, FieldError>> = {};
  for (const field of PROFILE_FIELDS) {
    if (!keys.includes(field)) continue;
    const r = validateField(field, input[field]);
    if (r.ok) values[field] = r.value;
    else errors[field] = r.error;
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, body: errorBody('VALIDATION_FAILED', 'Some fields need fixing.', { fields: errors }) };
  }
  return { ok: true, values };
}
