/**
 * Sentry wiring — error reporting for the API.
 *
 * MUST be imported before `express` in src/index.ts so @sentry/node v8's
 * auto-instrumentation can patch the Express prototype.
 *
 * Activation: gated on SENTRY_DSN being present in process.env. Local dev
 * (no DSN) is a silent no-op. Railway deploys with the env var set report.
 *
 * Tagging: per-request user_id (via setUser), role, company_id, endpoint —
 * pushed by `tagRequest()` from the auth middleware. v8 runs each request
 * inside its own isolation scope, so scope.setX is request-scoped.
 *
 * Scrubbing: beforeSend strips passwords, tokens, Authorization headers,
 * email, JWT_SECRET, S3 presigned-URL signatures. Defense-in-depth on top
 * of Sentry's built-in PII filters.
 *
 * Error handler: Sentry.setupExpressErrorHandler(app) is wired in index.ts
 * AFTER all routes. It captures the error AND calls next(err) so existing
 * Express error handling (default 500 response) continues to fire.
 */
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import type { Request } from 'express';

const SCRUB_KEYS = new Set([
  'password',
  'token',
  'secret',
  'api_key',
  'apiKey',
  'authorization',
  'Authorization',
  'access',
  'refresh',
  'access_token',
  'refresh_token',
  'email',
  'fcm_token',
  'JWT_SECRET',
  'jwt_secret',
  'AWS_SECRET_ACCESS_KEY',
  'SENDGRID_API_KEY',
]);

function scrubObject(input: unknown, depth = 0): unknown {
  if (input == null || depth > 6) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => scrubObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input as Record<string, unknown>)) {
    if (SCRUB_KEYS.has(k)) {
      out[k] = '[scrubbed]';
    } else {
      out[k] = scrubObject((input as Record<string, unknown>)[k], depth + 1);
    }
  }
  return out;
}

const S3_SIG_REGEX = /([?&])(X-Amz-[^&=]+|Signature|Policy|Credential)=[^&]+/gi;
function scrubString(s: string): string {
  return s.replace(S3_SIG_REGEX, '$1$2=[scrubbed]');
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
    sampleRate: 1.0,
    tracesSampleRate: 0.05,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
    beforeSend(event) {
      if (event.request?.headers) {
        event.request.headers = scrubObject(event.request.headers) as Record<string, string>;
      }
      if (event.request?.data) {
        event.request.data = scrubObject(event.request.data);
      }
      if (event.request?.query_string && typeof event.request.query_string === 'string') {
        event.request.query_string = scrubString(event.request.query_string);
      }
      if (event.request?.url) {
        event.request.url = scrubString(event.request.url);
      }
      if (event.extra) event.extra = scrubObject(event.extra) as Record<string, unknown>;
      if (event.contexts) event.contexts = scrubObject(event.contexts) as Record<string, Record<string, unknown>>;
      if (event.exception?.values) {
        for (const v of event.exception.values) {
          if (v.value) v.value = scrubString(v.value);
        }
      }
      return event;
    },
    beforeBreadcrumb(crumb) {
      if (crumb.data) crumb.data = scrubObject(crumb.data) as Record<string, unknown>;
      if (crumb.message) crumb.message = scrubString(crumb.message);
      return crumb;
    },
  });
}

/**
 * Push the authenticated user's context onto the current request's Sentry
 * scope. Called from `requireAuth` middleware after `req.user` is set.
 *
 * v8's Express integration creates an isolation scope per-request, so
 * setUser/setTag on the current scope are bounded to this request and won't
 * leak into the next handler.
 */
export function tagRequest(
  req: Request,
  payload: { sub: string; role: string; company_id?: string },
): void {
  if (!process.env.SENTRY_DSN) return;
  const scope = Sentry.getCurrentScope();
  scope.setUser({ id: payload.sub });
  scope.setTag('role', payload.role);
  if (payload.company_id) scope.setTag('company_id', payload.company_id);
  const endpoint = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
  scope.setTag('endpoint', endpoint);
}

export { Sentry };
