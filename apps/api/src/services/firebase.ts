import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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
}) {
  if (!params.token) return;

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
        console.error('[expo-push] Delivery error:', json.data.message, json.data.details);
      } else {
        console.log('[expo-push] Sent:', params.token.slice(0, 50) + '…');
      }
    } catch (err) {
      console.error('[expo-push] HTTP fetch error:', err);
    }
    return;
  }

  // ── Raw FCM token → Firebase Admin SDK ─────────────────────────────────────
  if (!admin.apps.length) {
    console.warn('[firebase] Admin SDK not initialized — skipping raw FCM push for token:', params.token.slice(0, 20));
    return;
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
  } catch (err) {
    console.error('[firebase] FCM push failed:', err);
  }
}

/** Send a geofence violation alert to Star admin devices */
export async function sendGeofenceViolationAlert(params: {
  adminFcmTokens: string[];
  guardName: string;
  siteName: string;
  sessionId: string;
}) {
  if (!params.adminFcmTokens.length) return;

  await Promise.allSettled(
    params.adminFcmTokens.map((token) =>
      sendPushNotification({
        token,
        title: `⚠️ Geofence Violation — ${params.siteName}`,
        body:  `${params.guardName} has left the boundary.`,
        data:  { type: 'geofence_violation', session_id: params.sessionId },
      })
    )
  );
}
