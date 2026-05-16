/**
 * Sentry wiring — crash and error reporting for the guard mobile app.
 *
 * Activation: gated on EXPO_PUBLIC_SENTRY_DSN being present. Local dev (no DSN
 * in env) is a silent no-op. EAS preview/production builds inline the DSN at
 * bundle time via `eas secret:create --name EXPO_PUBLIC_SENTRY_DSN`.
 *
 * Tagging: user_id, company_id, role pushed from authStore; shift_id pushed
 * from shiftStore when a session is active. env + device_os + app_version +
 * build_number tagged once at init.
 *
 * Scrubbing: beforeSend strips known sensitive keys (passwords, tokens,
 * Authorization headers, S3 presigned-URL signatures) before any event leaves
 * the device. Defense-in-depth on top of Sentry's built-in PII filters.
 */
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

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

// S3 presigned POST and presigned GET both carry credentials in the query
// string. Strip them so the URL is still recognizable but the signature is
// gone.
const S3_SIG_REGEX = /([?&])(X-Amz-[^&=]+|Signature|Policy|Credential)=[^&]+/gi;
function scrubString(s: string): string {
  return s.replace(S3_SIG_REGEX, '$1$2=[scrubbed]');
}

function dsn(): string | undefined {
  return process.env.EXPO_PUBLIC_SENTRY_DSN;
}

export function initSentry(): void {
  if (!dsn()) return;

  Sentry.init({
    dsn: dsn(),
    environment: process.env.EXPO_PUBLIC_SENTRY_ENV || 'development',
    sampleRate: 1.0,
    tracesSampleRate: 0.05,
    enableAutoSessionTracking: true,
    beforeSend(event) {
      if (event.request?.headers) {
        event.request.headers = scrubObject(event.request.headers) as Record<string, string>;
      }
      if (event.request?.data) {
        event.request.data = scrubObject(event.request.data);
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

  Sentry.setTag('env', process.env.EXPO_PUBLIC_SENTRY_ENV || 'development');
  Sentry.setTag('device_os', Platform.OS);
  Sentry.setTag('app_version', Constants.expoConfig?.version ?? 'unknown');
  Sentry.setTag(
    'build_number',
    String(
      Platform.OS === 'ios'
        ? Constants.expoConfig?.ios?.buildNumber ?? 'unknown'
        : Constants.expoConfig?.android?.versionCode ?? 'unknown',
    ),
  );
}

export function setUserTags(p: {
  guardId: string | null;
  companyId: string | null;
  role?: string | null;
}): void {
  if (!dsn()) return;
  if (!p.guardId) {
    Sentry.setUser(null);
    Sentry.setTag('company_id', '');
    Sentry.setTag('role', '');
    return;
  }
  Sentry.setUser({ id: p.guardId });
  Sentry.setTag('company_id', p.companyId ?? '');
  Sentry.setTag('role', p.role ?? 'guard');
}

export function setShiftTag(shiftId: string | null): void {
  if (!dsn()) return;
  Sentry.setTag('shift_id', shiftId ?? '');
}
