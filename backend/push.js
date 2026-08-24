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
    // Safe to log: the project_id is not a secret (it's also visible in
    // the Android app's committed google-services.json) — logging it once
    // at startup lets you directly compare "is the backend using the same
    // Firebase project as the app was built against?" without needing to
    // decode any credentials.
    console.log(`[push] Firebase Admin initialized for project_id=${serviceAccount.project_id || 'unknown'}`);
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

// ── Notification channels ───────────────────────────────────────────────
// Android 8+ (API 26+) locks a notification's sound AND vibration to
// whatever its *channel* was created with the first time that channel ID
// was ever seen on the device — an individual FCM message's `sound`/
// `vibrate` fields are ignored once the channel exists. So "Notification
// Sounds: off" / "Vibration: off" can't be implemented by changing the
// payload alone; the device needs a genuinely different channel per
// sound/vibration combination, and the backend picks the right one per
// recipient. All four are created client-side on app start (see
// frontend/src/push.js, registerPushNotifications()) with the exact same
// IDs used here — if you rename one side, rename both.
const CHANNELS = {
  sound_vibrate: 'aerio_messages_sv',
  sound_only: 'aerio_messages_s',
  vibrate_only: 'aerio_messages_v',
  silent: 'aerio_messages_n',
};

function pickChannelId(sound, vibration) {
  if (sound && vibration) return CHANNELS.sound_vibrate;
  if (sound && !vibration) return CHANNELS.sound_only;
  if (!sound && vibration) return CHANNELS.vibrate_only;
  return CHANNELS.silent;
}

// Sends one push notification to every ACTIVE token belonging to userId.
// Invalid/expired tokens (app uninstalled, token revoked, etc.) are
// deactivated automatically so we stop retrying them. This function never
// throws — a push failure must never break message sending.
//
// `sound` / `vibration` select which of the four channels above is used
// (see CHANNELS) — callers pass the recipient's own notification_sounds /
// vibration settings here, already resolved from user_settings.
async function sendToUser(userId, { title, body, data = {}, sound = true, vibration = true }) {
  try {
    if (!isConfigured()) {
      console.log(`[push] sendToUser(${userId}): skipped — Firebase not configured (${initError || 'FIREBASE_SERVICE_ACCOUNT not set'})`);
      return;
    }
    if (!userId) return;

    const { rows } = await db.query(
      'SELECT token, created_at FROM device_tokens WHERE user_id = $1 AND active = TRUE',
      [userId]
    );
    const tokens = rows.map((r) => r.token).filter(Boolean);
    const newestTokenAgeSec = rows.length
      ? Math.round((Date.now() - new Date(Math.max(...rows.map(r => new Date(r.created_at).getTime())))) / 1000)
      : null;
    console.log(`[push] sendToUser(${userId}): activeTokens=${tokens.length}${newestTokenAgeSec !== null ? ` newestTokenAgeSec=${newestTokenAgeSec}` : ''} sound=${sound} vibration=${vibration}`);
    if (!tokens.length) return;

    // FCM data payloads must be a flat map of strings.
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null) stringData[k] = String(v);
    }

    const channelId = pickChannelId(sound, vibration);

    const message = {
      tokens,
      notification: { title: String(title || 'Aerio'), body: String(body || '') },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          // In FCM HTTP v1, `android.notification` completely overrides the
          // top-level `notification` block for Android, so title/body must
          // be repeated here or the system notification shows blank text.
          title: String(title || 'Aerio'),
          body: String(body || ''),
          channelId,
          icon: 'ic_stat_aerio',
          color: '#3b82f6',
          // No clickAction here on purpose: it must name an activity with a
          // matching <intent-filter>, and no such activity/action exists in
          // this app or in @capacitor/push-notifications' own manifest.
          // Leaving this unset falls back to the default launcher activity,
          // which @capacitor/push-notifications already wires up natively.
        },
      },
    };

    const result = await getMessaging(firebaseApp).sendEachForMulticast(message);
    console.log(
      `[push] sendToUser(${userId}): ${result.successCount}/${tokens.length} delivered to FCM via ${channelId}` +
      (result.failureCount ? `, ${result.failureCount} failed` : '')
    );

    const deadTokens = [];
    let mismatchedCredentialCount = 0;
    result.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === 'messaging/mismatched-credential' || code === 'messaging/sender-id-mismatch') {
          mismatchedCredentialCount++;
        } else if (
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

    if (mismatchedCredentialCount) {
      console.error(
        `[push] sendToUser(${userId}): ${mismatchedCredentialCount} token(s) rejected as mismatched-credential — ` +
        `these tokens belong to a different Firebase project than FIREBASE_SERVICE_ACCOUNT authenticates as.`
      );
    }

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

module.exports = { sendToUser, isConfigured, CHANNELS };