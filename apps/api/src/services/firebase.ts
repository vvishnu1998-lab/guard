import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Firebase Admin SDK — initialized once at startup.
 *
 * Credential resolution order (first match wins):
 *   1. apps/api/secrets/firebase-service-account.json  ← drop your file here
 *   2. Individual env vars: FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL
 *
 * In production (e.g. Railway, Render, Fly.io) use the env var approach.
 * In local dev, drop the JSON file into apps/api/secrets/.
 */

const SERVICE_ACCOUNT_PATH = join(__dirname, '../../secrets/firebase-service-account.json');

function initFirebase() {
  if (admin.apps.length > 0) return; // already initialized

  if (existsSync(SERVICE_ACCOUNT_PATH)) {
    // Local dev: load from JSON file
    const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[firebase] Initialized from service account JSON file');
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    // Production: load from env vars
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('[firebase] Initialized from environment variables');
  } else {
    console.warn('[firebase] No credentials found — FCM push notifications will not work');
  }
}

initFirebase();

/** Send a push notification to a single FCM token */
export async function sendPushNotification(params: {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}) {
  if (!admin.apps.length) return;
  try {
    await admin.messaging().send({
      token: params.token,
      notification: { title: params.title, body: params.body },
      data: params.data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
  } catch (err) {
    console.error('[firebase] Push failed:', err);
  }
}

/** Send a geofence violation alert to Star admin devices */
export async function sendGeofenceViolationAlert(params: {
  adminFcmTokens: string[];
  guardName: string;
  siteName: string;
  sessionId: string;
}) {
  if (!admin.apps.length || !params.adminFcmTokens.length) return;
  const message = {
    notification: {
      title: `⚠️ Geofence Violation — ${params.siteName}`,
      body: `${params.guardName} has left the boundary.`,
    },
    data: {
      type: 'geofence_violation',
      session_id: params.sessionId,
    },
    android: { priority: 'high' as const },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  };

  await Promise.allSettled(
    params.adminFcmTokens.map((token) => admin.messaging().send({ ...message, token }))
  );
}

/** Send a ping alert to Star admin devices */
export async function sendPingAlert(params: {
  adminFcmTokens: string[];
  guardName: string;
  siteName: string;
}) {
  if (!admin.apps.length || !params.adminFcmTokens.length) return;
  const message = {
    notification: {
      title: `Location Ping — ${params.siteName}`,
      body: `${params.guardName} has submitted a 30-minute ping.`,
    },
    data: { type: 'ping' },
    android: { priority: 'normal' as const },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  };

  await Promise.allSettled(
    params.adminFcmTokens.map((token) => admin.messaging().send({ ...message, token }))
  );
}
