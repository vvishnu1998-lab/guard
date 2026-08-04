/**
 * Shared Sentry options for all three runtimes (client, server, edge).
 *
 * apps/api keeps its whole Sentry setup in one services/sentry.ts; this is
 * the web equivalent, so the client/server/edge entrypoints stay thin and
 * cannot drift apart on scrubbing rules or sample rates.
 *
 * Conventions deliberately mirrored from apps/api/src/services/sentry.ts:
 *   - environment resolves from an explicit override, then the platform's
 *     own env signal, then NODE_ENV, then 'production'
 *   - tracesSampleRate 0.05 (same as the API — the web app must not sample
 *     performance more aggressively than the service behind it)
 *   - beforeSend scrubs credentials out of request data
 *   - beforeBreadcrumb scrubs S3 presigned-URL signatures
 *
 * Session Replay is deliberately NOT enabled. It would record a paying
 * customer's admin working with guard PII, which is a separate decision.
 */
import type { ErrorEvent, EventHint, Breadcrumb } from '@sentry/nextjs';

/**
 * 'production' on Vercel production, 'preview' on any other Vercel
 * deployment (preview branches, `vercel dev`), otherwise NODE_ENV so local
 * runs land in 'development' rather than polluting preview.
 *
 * NEXT_PUBLIC_ prefixes are required because this value is read in the
 * browser bundle too; Vercel exposes NEXT_PUBLIC_VERCEL_ENV automatically.
 */
const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_SENTRY_ENV ||
  (vercelEnv ? (vercelEnv === 'production' ? 'production' : 'preview') : undefined) ||
  process.env.NODE_ENV ||
  'production';

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Matches apps/api exactly. Do not raise above the API's rate. */
export const TRACES_SAMPLE_RATE = 0.05;

/**
 * Header names redacted before send. Same intent as apps/api's SCRUB_KEYS,
 * narrowed to the headers a browser/server event actually carries.
 */
const SCRUB_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

/** Strips AWS presigned-URL signatures — copied from apps/api's S3_SIG_REGEX. */
const S3_SIG_REGEX = /([?&])(X-Amz-[^&=]+|Signature|Policy|Credential)=[^&]+/gi;
function scrubUrl(s: string): string {
  return s.replace(S3_SIG_REGEX, '$1$2=[scrubbed]');
}

/**
 * Standard noise filters. Taken from Sentry's own "decluttering" list
 * (docs/platforms/javascript/legacy-sdk/tips) rather than hand-rolled, plus
 * the two ResizeObserver loop messages, which browsers emit as uncaught
 * errors during normal layout and which are the highest-volume false
 * positive on a fresh web integration.
 */
export const IGNORE_ERRORS = [
  // Browsers report these during ordinary layout; they are not bugs.
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications.',
  // Random plugins/extensions
  'top.GLOBALS',
  'originalCreateNotification',
  'canvas.contentDocument',
  'MyApp_RemoveAllHighlights',
  'http://tt.epicplay.com',
  "Can't find variable: ZiteReader",
  'jigsaw is not defined',
  'ComboSearch is not defined',
  'http://loading.retry.widdit.com/',
  'atomicFindClose',
  // Facebook borked
  'fb_xd_fragment',
  // ISP "optimizing" proxy
  'bmi_SafeAddOnload',
  'EBCallBackMessageReceived',
  // Conduit toolbar
  'conduitPage',
  // Generic error from outside the security sandbox
  'Script error.',
  // Avast extension
  '_avast_submit',
];

export const DENY_URLS = [
  // Google Adsense
  /pagead\/js/i,
  // Facebook flakiness
  /graph\.facebook\.com/i,
  /connect\.facebook\.net\/en_US\/all\.js/i,
  // Woopra flakiness
  /eatdifferent\.com\.woopra-ns\.com/i,
  /static\.woopra\.com\/js\/woopra\.js/i,
  // Browser extensions
  /extensions\//i,
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(web-)?extension:\/\//i,
  // Other plugins
  /127\.0\.0\.1:4001\/isrunning/i,
  /webappstoolbarba\.texthelp\.com\//i,
  /metrics\.itunes\.apple\.com\.edgesuite\.net\//i,
];

/**
 * Last gate before an event leaves the process.
 *
 * This app renders a live customer's guard and client data, so the request
 * payload is treated as untrusted for reporting purposes: the body is
 * dropped wholesale rather than walked, because there is no allowlist of
 * safe fields across three portals.
 */
export function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  // Drop anything whose stack sits in an extension — denyUrls covers the
  // event's own URL, this covers frames injected into our page.
  const frames = event.exception?.values?.[0]?.stacktrace?.frames;
  if (frames?.some((f) => /^(chrome|moz|safari(-web)?)-extension:\/\//.test(f.filename || ''))) {
    return null;
  }

  if (event.request) {
    // Request body — never sent.
    delete event.request.data;
    // Cookies — session tokens for all three portals live here.
    delete event.request.cookies;

    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (SCRUB_HEADERS.has(key.toLowerCase())) {
          event.request.headers[key] = '[scrubbed]';
        }
      }
    }
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = scrubUrl(event.request.query_string);
    }
    if (event.request.url) {
      event.request.url = scrubUrl(event.request.url);
    }
  }

  return event;
}

/**
 * Breadcrumbs record every fetch/xhr the page made. Report photos are served
 * as presigned S3 URLs, so the signature is stripped here the same way
 * apps/api does it.
 */
export function beforeBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.data && typeof crumb.data.url === 'string') {
    crumb.data.url = scrubUrl(crumb.data.url);
  }
  if (typeof crumb.message === 'string') {
    crumb.message = scrubUrl(crumb.message);
  }
  return crumb;
}

/** Options every runtime shares. */
export const sharedOptions = {
  dsn: SENTRY_DSN,
  environment: SENTRY_ENVIRONMENT,
  tracesSampleRate: TRACES_SAMPLE_RATE,
  // Never attach IP addresses, cookies, or user headers automatically.
  sendDefaultPii: false,
  ignoreErrors: IGNORE_ERRORS,
  denyUrls: DENY_URLS,
  beforeSend,
  beforeBreadcrumb,
};
