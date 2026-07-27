import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Sentry } from './sentry';
// Node 18+ has native fetch globally — no import needed

/**
 * Firebase Admin SDK — initialized once at startup.
 *
 * Credential resolution order (first match wins):
 *   1. apps/api/secrets/firebase-service-account.json  ← drop your file here
 *   2. Individual env vars: FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL
 *
 * Push delivery strategy:
 *   - Expo push tokens (ExponentPushToken[...]) → Expo Push HTTP API
 *   - Raw FCM tokens                            → Firebase Admin SDK
 */

const SERVICE_ACCOUNT_PATH = join(__dirname, '../../secrets/firebase-service-account.json');

function initFirebase() {
  if (admin.apps.length > 0) return;

  if (existsSync(SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('[firebase] Initialized from service account JSON file');
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('[firebase] Initialized from environment variables');
  } else {
    console.warn('[firebase] No credentials — Firebase FCM disabled. Expo push tokens still work.');
    // Startup-once signal (Finding #1): fires at module load, not per push.
    // In prod the SDK is credentialed so this never fires; it exists so a
    // deploy that silently loses FCM creds is visible instead of a black hole.
    Sentry.captureMessage('[firebase] Admin SDK not initialized — raw FCM pushes disabled (Expo unaffected)', {
      level: 'warning',
      tags: { channel: 'fcm', flow: 'push_notification' },
    });
  }
}

initFirebase();

/**
 * Send a push notification to a single token.
 *
 * Token routing:
 *   ExponentPushToken[...] → Expo Push HTTP API (https://exp.host/--/api/v2/push/send)
 *   Anything else          → Firebase Admin SDK messaging().send()
 *
 * The mobile app uses expo-notifications getExpoPushTokenAsync() which returns
 * Expo tokens. These are delivered via Expo's push service → APNs/FCM bridge.
 * No GoogleService-Info.plist required on the device.
 */
export async function sendPushNotification(params: {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<{ staleToken: boolean; delivered: boolean }> {
  if (!params.token) return { staleToken: false, delivered: false };

  // ── Expo push token → Expo Push API ────────────────────────────────────────
  if (params.token.startsWith('ExponentPushToken[')) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify({
          to:       params.token,
          title:    params.title,
          body:     params.body,
          data:     params.data ?? {},
          sound:    'default',
          priority: 'high',
        }),
      });
      const json = await res.json() as any;
      if (json?.data?.status === 'error') {
        const staleToken = json.data?.details?.error === 'DeviceNotRegistered';
        console.error('[expo-push] Delivery error:', json.data.message, json.data.details);
        // Non-stale delivery failures are real errors worth surfacing. Stale
        // tokens (DeviceNotRegistered) are expected app-reinstall cleanup —
        // handled by the caller's staleToken path, not a Sentry event.
        if (!staleToken) {
          Sentry.captureException(
            new Error(`Expo push delivery error: ${json.data?.details?.error ?? json.data?.message ?? 'unknown'}`),
            {
              tags: { channel: 'expo', flow: 'push_notification' },
              fingerprint: ['push_notification', 'expo', String(json.data?.details?.error ?? json.data?.message ?? 'unknown')],
              extra: { token_prefix: params.token.slice(0, 8), notification_type: params.data?.type },
            },
          );
        }
        return { staleToken, delivered: false };
      }
      console.log('[expo-push] Sent:', params.token.slice(0, 50) + '…');
      return { staleToken: false, delivered: true };
    } catch (err) {
      console.error('[expo-push] HTTP fetch error:', err);
      Sentry.captureException(err, {
        tags: { channel: 'expo', flow: 'push_notification' },
        fingerprint: ['push_notification', 'expo', 'network_error'],
        extra: { token_prefix: params.token.slice(0, 8), notification_type: params.data?.type },
      });
      return { staleToken: false, delivered: false };
    }
  }

  // ── Raw FCM token → Firebase Admin SDK ─────────────────────────────────────
  if (!admin.apps.length) {
    // Per-push no-op when the SDK is uninitialized. NOT captured per push —
    // the startup-once Sentry warning in initFirebase() covers this globally
    // (avoids one Sentry event per push while FCM is down).
    console.warn('[firebase] Admin SDK not initialized — skipping raw FCM push for token:', params.token.slice(0, 20));
    return { staleToken: false, delivered: false };
  }
  try {
    await admin.messaging().send({
      token: params.token,
      notification: { title: params.title, body: params.body },
      data: params.data,
      android: { priority: 'high' },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    console.log('[firebase] FCM push sent');
    return { staleToken: false, delivered: true };
  } catch (err) {
    const code = (err as { code?: string; errorInfo?: { code?: string } })?.code
      ?? (err as { errorInfo?: { code?: string } })?.errorInfo?.code;
    // FCM signals a permanently-unregistered token via these two codes.
    // The caller is expected to NULL out the DB row so we stop retrying.
    const staleToken =
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token';
    console.error('[firebase] FCM push failed:', code ?? err);
    // Non-stale FCM failures are real delivery errors; stale tokens are
    // expected cleanup (handled by the caller's staleToken path).
    if (!staleToken) {
      Sentry.captureException(err, {
        tags: { channel: 'fcm', flow: 'push_notification' },
        fingerprint: ['push_notification', 'fcm', String(code ?? 'unknown')],
        extra: { token_prefix: params.token.slice(0, 8), notification_type: params.data?.type },
      });
    }
    return { staleToken, delivered: false };
  }
}
