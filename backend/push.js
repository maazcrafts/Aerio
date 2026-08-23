// Firebase Cloud Messaging (Android push notifications).
//
// This module is intentionally the ONLY place in the backend that talks to
// Firebase. Credentials are loaded once from the FIREBASE_SERVICE_ACCOUNT
// env var (a full service-account JSON, optionally base64-encoded) and never
// touch the frontend/Vite build or get logged.
//
// If the env var isn't set (or is invalid), every exported function becomes
// a safe no-op — the rest of the app (auth, chat, Socket.IO, calling) keeps
// working exactly as before push was added. A push failure or missing
// config must NEVER break message sending.
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('./database');

let firebaseApp = null;
let initError = null;
let attemptedInit = false;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;
  try {
    const trimmed = raw.trim();
    const jsonStr = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    initError = `FIREBASE_SERVICE_ACCOUNT is set but could not be parsed: ${e.message}`;
    return null;
  }
}

function getFirebaseApp() {
  if (attemptedInit) return firebaseApp;
  attemptedInit = true;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) return null;

  try {
    firebaseApp = admin.apps && admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.cert(serviceAccount) });
  } catch (e) {
    initError = `Failed to initialize Firebase Admin: ${e.message}`;
    firebaseApp = null;
  }
  return firebaseApp;
}

let warnedOnce = false;
function isConfigured() {
  const ok = !!getFirebaseApp();
  if (!ok && !warnedOnce) {
    warnedOnce = true;
    console.warn(
      '[push] Firebase Admin is not configured' +
      (initError ? ` (${initError})` : ' (FIREBASE_SERVICE_ACCOUNT env var is not set)') +
      ' — push notifications are disabled. Socket.IO real-time chat and everything else is unaffected.'
    );
  }
  return ok;
}

// Sends one push notification to every ACTIVE token belonging to userId.
// Invalid/expired tokens (app uninstalled, token revoked, etc.) are
// deactivated automatically so we stop retrying them. This function never
// throws — a push failure must never break message sending.
async function sendToUser(userId, { title, body, data = {} }) {
  try {
    if (!isConfigured()) return;
    if (!userId) return;

    const { rows } = await db.query(
      'SELECT token FROM device_tokens WHERE user_id = $1 AND active = TRUE',
      [userId]
    );
    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (!tokens.length) return;

    // FCM data payloads must be a flat map of strings.
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null) stringData[k] = String(v);
    }

    const message = {
      tokens,
      notification: { title: String(title || 'Aerio'), body: String(body || '') },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          // CRITICAL FIX: In FCM HTTP v1, when `android.notification` is
          // present it COMPLETELY OVERRIDES the top-level `notification`
          // block for Android. Previously this block only had channelId/icon/
          // color and no title/body, so Android received a notification with
          // no title or body — which is why no system notification appeared.
          // Title and body MUST be repeated here for Android to display them.
          title: String(title || 'Aerio'),
          body: String(body || ''),
          channelId: 'aerio_messages',
          icon: 'ic_stat_aerio',
          color: '#3b82f6',
          // No clickAction here on purpose: it must name an activity with a
          // matching <intent-filter>, and no such activity/action exists in
          // this app or in @capacitor/push-notifications' own manifest. An
          // unresolvable clickAction can make Android fail to build the
          // notification's PendingIntent at all (E/FirebaseMessaging:
          // "Notification pending intent canceled"), which on some Android
          // versions/OEMs suppresses the whole notification, not just the
          // tap. Leaving this unset falls back to the default launcher
          // activity, which @capacitor/push-notifications already wires up
          // natively for pushNotificationActionPerformed / cold-start tap
          // buffering — no clickAction override needed for that to work.
        },
      },
    };

    const result = await getMessaging(firebaseApp).sendEachForMulticast(message);
    console.log(
      `[push] sendToUser(${userId}): ${result.successCount}/${tokens.length} delivered to FCM` +
      (result.failureCount ? `, ${result.failureCount} failed` : '')
    );

    const deadTokens = [];
    result.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          deadTokens.push(tokens[i]);
        } else {
          console.error('[push] send failed for a token:', code || (r.error && r.error.message));
        }
      }
    });

    if (deadTokens.length) {
      await db.query(
        'UPDATE device_tokens SET active = FALSE, updated_at = NOW() WHERE token = ANY($1::text[])',
        [deadTokens]
      );
    }
  } catch (err) {
    // Never let a push failure propagate — it must never fail the actual message.
    console.error('[push] sendToUser error:', err.message);
  }
}

module.exports = { sendToUser, isConfigured };