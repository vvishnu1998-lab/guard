/**
 * The "Get the NetraOps app" block in the guard welcome email (E1).
 *
 * It replaces the block that read "iOS: Coming to App Store soon - contact
 * your admin for TestFlight access / Android: Coming to Play Store soon". Both
 * stores have been live since 2026-10-12, and that email is the guard's first
 * and only path to the app.
 *
 * ONE URL (owner decision, 2026-10-13): https://www.netraops.com/app is the
 * single target for email, QR codes, in-app notices and the video. The page
 * there is static and lists both stores, so this email names neither store and
 * no platform: it cannot know which phone the guard will open it on. It is not
 * built from WEB_BASE or CLIENT_PORTAL_URL (those point at the portal host);
 * it is the one literal below. apps/web owns the page and the `src` tag
 * registry (apps/web/lib/storeLinks.ts): `welcome_email` must stay registered
 * there, and APP_PAGE_URL must stay equal to its APP_PAGE_URL. Two deployables,
 * so two literals; the check scripts assert each, and a post-deploy request for
 * WELCOME_APP_URL must return 200 before this ships.
 *
 * WHAT MAKES THIS MARKUP SAFE FOR A MAIL CLIENT
 *   - Inline styles only, no class and no <style> block (N182: Gmail drops both).
 *   - No image. A badge would vanish when images are blocked and cannot be
 *     recoloured for dark mode (both stores forbid altering it); the button and
 *     the typed link below are live HTML and survive both.
 *   - The button is padding-based (a table cell with the colour, an inline-block
 *     link with the padding), with mso-padding-alt for Outlook on Windows. No VML.
 *   - Amber #F59E0B with navy #0B1526 text (8.5:1), about 52 px tall: over the
 *     44 pt / 48 dp tap floors on a phone.
 *   - The visible link text is the short www.netraops.com/app, underlined in
 *     navy (amber on white is 2.2:1), so a reader sees the real host.
 *   - Everything here is ASCII. A non-ASCII character in this message is a
 *     documented candidate for the Gmail clip (N185).
 *   - No `&` anywhere (check-email-escaping rejects a bare one): the URL has a
 *     single query parameter.
 *   - Both anchors carry clicktracking="off". SendGrid's click tracking would
 *     otherwise rewrite them to its own host in a message that carries a
 *     password; accountMessage also sets the message-level override
 *     (NO_CLICK_TRACKING). Whether the attribute or the setting wins over the
 *     account default is not documented, so both are set.
 */

export const APP_PAGE_URL = 'https://www.netraops.com/app';
export const WELCOME_APP_URL = `${APP_PAGE_URL}?src=welcome_email`;

/** What the reader sees as the link: the host and path, no scheme, no query. */
export const APP_LINK_TEXT = 'www.netraops.com/app';

export const APP_BLOCK_HEADING = 'Get the NetraOps app';
// Conditional on purpose: RESEND WELCOME re-sends this to guards who may
// already have the app, so it must not read as a required step for them.
export const APP_BLOCK_LEAD = 'New to the app? Install it first. Skip this if you already have it.';
export const APP_BLOCK_STORE_NOTE = 'The link opens the right app store for your phone.';

/**
 * SendGrid click tracking off for the whole message: this email carries a
 * temporary password and a link whose host should read netraops.com. Set
 * together with the plain-text part and only for the guard welcome.
 */
export const NO_CLICK_TRACKING = { clickTracking: { enable: false, enableText: false } };

const AMBER = '#F59E0B';
const NAVY = '#0B1526';

/** The block's markup. Static: no argument, no escaping needed. */
export function appBlockHtml(): string {
  return `<h3 style="font-size:14px;color:#333;margin:20px 0 8px">${APP_BLOCK_HEADING}</h3>
        <p style="color:#555;font-size:13px;margin:0 0 12px">${APP_BLOCK_LEAD}</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 12px"><tr><td bgcolor="${AMBER}" style="background:${AMBER};border-radius:6px;mso-padding-alt:16px 32px"><a href="${WELCOME_APP_URL}" clicktracking="off" style="display:inline-block;padding:16px 32px;font-size:15px;font-weight:700;letter-spacing:1px;line-height:20px;color:${NAVY};text-decoration:none">GET THE APP</a></td></tr></table>
        <p style="color:#555;font-size:13px;margin:0 0 8px">Or open <a href="${WELCOME_APP_URL}" clicktracking="off" style="color:${NAVY};text-decoration:underline">${APP_LINK_TEXT}</a> in your phone's browser. ${APP_BLOCK_STORE_NOTE}</p>`;
}

/**
 * The same block for the text/plain part, one entry per line (blank string =
 * blank line). The URL sits alone on its own line so mail and chat apps link it
 * correctly, and every line is 78 characters or fewer.
 */
export function appBlockText(): string[] {
  return [
    APP_BLOCK_HEADING,
    APP_BLOCK_LEAD,
    '',
    'Open this link on your phone:',
    WELCOME_APP_URL,
    '',
    APP_BLOCK_STORE_NOTE,
  ];
}
