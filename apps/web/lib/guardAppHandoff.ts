/**
 * What the admin Guards page hands an admin so a guard can install the app (W3).
 *
 * ONE URL (owner decision, 2026-10-13): https://www.netraops.com/app. The admin
 * page never names a store: the admin cannot know which phone the guard will
 * open the link on, and /app lists both. Every string here is neutral prose
 * plus that link, so it survives being pasted into a text, WhatsApp or email.
 *
 * Three surfaces, three src tags (the closed registry in lib/storeLinks.ts),
 * so the stores' consoles and our analytics can tell them apart:
 *   admin_banner  the link in the "Guard added" banner
 *   admin_copy    the link at the end of the COPY text (credentials banner)
 *   admin         the GUARD APP panel; this is also the QR code's payload
 *                 (public/qr/app-admin.svg), a short alias on purpose so the
 *                 symbol stays a 29x29 version-3 code
 *
 * Pure module: no React, no DOM. scripts/check-guard-handoff.ts runs it.
 */
import { appLink } from './storeLinks';

export const BANNER_URL = appLink('admin_banner');
export const COPY_URL = appLink('admin_copy');
export const PANEL_URL = appLink('admin');

/** What the admin reads as the link: host and path, no scheme, no query. */
export const LINK_TEXT = 'www.netraops.com/app';

/** The QR asset for PANEL_URL. Regenerate with scripts/gen-store-qr.js, never by hand. */
export const PANEL_QR_SRC = '/qr/app-admin.svg';

/** The QR image's alt text. */
export const PANEL_QR_ALT = `QR code: opens ${LINK_TEXT} to get the NetraOps guard app`;

/** The line above the link in the COPY text. The link is on the line after it. */
export const COPY_APP_LINE = 'Get the NetraOps app (open this link on your phone):';

/**
 * The text the credentials COPY button puts on the clipboard. The Email and
 * Password lines are byte-for-byte what the button copied before this change
 * (an admin may paste them into something that parses them); the install link
 * follows a blank line and is alone on the last line, so a chat app links it.
 */
export function credentialsCopyText(email: string, tempPassword: string): string {
  return `Email: ${email}\nPassword: ${tempPassword}\n\n${COPY_APP_LINE}\n${COPY_URL}`;
}

/**
 * The "Guard added" banner's install line. The create route answers 201 first
 * and sends the welcome email afterwards, without waiting, and reports a failed
 * send only to Sentry, so this must not say the email WAS sent. It says what
 * happens and what to do if the guard does not see it.
 */
export const ADDED_INSTALL_LINE =
  'The welcome email includes the link to install the app. If it does not reach them, send them this link:';

/** The Add Guard modal's helper line. Neutral: no store, no platform. */
export const MODAL_HELPER_LINE = 'The welcome email includes the link to install the app.';

/** The GUARD APP panel's one-sentence explanation. */
export const PANEL_LEAD =
  'Guards scan this code or open the link on their phone to install the app.';
