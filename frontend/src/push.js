// Client-side Android push notifications (Capacitor @capacitor/push-notifications).
//
// This is the ONLY file that talks to @capacitor/push-notifications. It:
//   1. requests the POST_NOTIFICATIONS permission (Android 13+) with a
//      rationale shown first if the OS would otherwise show a bare prompt,
//   2. creates the four notification channels the backend's push.js picks
//      between (sound+vibrate / sound only / vibrate only / silent) —
//      channel IDs MUST match backend/push.js's CHANNELS exactly,
//   3. registers the resulting FCM token with the backend,
//   4. hands off a tapped notification's data to the caller so it can open
//      the right conversation, including a "cold start" tap (app was fully
//      closed) via consumePendingNotification().
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { NativeSettings, AndroidSettings } from 'capacitor-native-settings';
import axios from 'axios';
import { API_URL } from './config';

const PENDING_KEY = 'aerio_pending_notification';
let currentToken = null;
let listenersRegistered = false;

const isNative = () => Capacitor.isNativePlatform();

// Must exactly match backend/push.js's CHANNELS map.
const CHANNEL_SOUND_VIBRATE = 'aerio_messages_sv';
const CHANNEL_SOUND_ONLY = 'aerio_messages_s';
const CHANNEL_VIBRATE_ONLY = 'aerio_messages_v';
const CHANNEL_SILENT = 'aerio_messages_n';

async function createChannels() {
  if (!isNative() || Capacitor.getPlatform() !== 'android') return;
  const base = {
    importance: 4, // IMPORTANCE_HIGH — required for heads-up/pop-over notifications
    visibility: 1, // VISIBILITY_PRIVATE
    lights: true,
    lightColor: '#3b82f6',
  };
  const channels = [
    { id: CHANNEL_SOUND_VIBRATE, name: 'Messages (sound & vibration)', sound: 'aerio_notification.wav', vibration: true, ...base },
    { id: CHANNEL_SOUND_ONLY, name: 'Messages (sound only)', sound: 'aerio_notification.wav', vibration: false, ...base },
    { id: CHANNEL_VIBRATE_ONLY, name: 'Messages (vibration only)', vibration: true, ...base },
    { id: CHANNEL_SILENT, name: 'Messages (silent)', vibration: false, ...base },
  ];
  for (const ch of channels) {
    try {
      await PushNotifications.createChannel(ch);
    } catch (e) {
      console.error(`[push] createChannel(${ch.id}) failed:`, e?.message || e);
    }
  }
}

// ---- Permission -----------------------------------------------------------

// Returns 'granted' | 'denied' | 'prompt' | 'unsupported'.
// 'unsupported' covers the web/browser dev-preview, where there's no native
// permission concept to check via this plugin.
export async function checkNotificationPermission() {
  if (!isNative()) return 'unsupported';
  try {
    const { receive } = await PushNotifications.checkPermissions();
    return receive; // already one of granted/denied/prompt on this plugin
  } catch (e) {
    console.error('[push] checkPermissions failed:', e?.message || e);
    return 'unsupported';
  }
}

// Requests the permission. On Android 13+, a *second* request after a prior
// denial doesn't re-prompt the OS dialog — Android sends you straight back
// to 'denied'. In that case we send the user to the app's notification
// settings screen instead, since that's the only place they can actually
// change it.
export async function requestNotificationPermission() {
  if (!isNative()) return 'unsupported';
  try {
    const before = await PushNotifications.checkPermissions();
    if (before.receive === 'denied') {
      await openAppNotificationSettings();
      // Re-check after the user (potentially) comes back from Settings.
      const after = await PushNotifications.checkPermissions();
      return after.receive;
    }
    const { receive } = await PushNotifications.requestPermissions();
    return receive;
  } catch (e) {
    console.error('[push] requestPermissions failed:', e?.message || e);
    return 'unsupported';
  }
}

async function openAppNotificationSettings() {
  try {
    await NativeSettings.openAndroid({ option: AndroidSettings.AppNotification });
  } catch (e) {
    console.warn('[push] Could not open native notification settings:', e?.message || e);
  }
}

// ---- Registration -----------------------------------------------------------

// Call once per login, after the user object (with .token) is available.
// onNotificationTap(target) is called with { conversationType, conversationId,
// messageId, senderId } whenever the user taps a notification while the app
// is already running (foreground or background-but-alive). A tap that
// *cold-starts* the app is handled separately via consumePendingNotification().
export async function registerPushNotifications({ onNotificationTap } = {}) {
  if (!isNative()) return; // web dev preview — no-op, chat still works via Socket.IO
  if (listenersRegistered) return;
  listenersRegistered = true;

  await createChannels();

  PushNotifications.addListener('registration', async (token) => {
    currentToken = token.value;
    try {
      await axios.post(`${API_URL}/devices/register`, {
        token: token.value,
        platform: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
      });
    } catch (e) {
      console.error('[push] Failed to register device token with backend:', e?.message || e);
    }
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.error('[push] FCM registration error:', err?.error || err);
  });

  // App was already open (foreground) when the push arrived. Android still
  // shows the system notification (we don't suppress it), so nothing to do
  // here beyond optional in-app logging/badging.
  PushNotifications.addListener('pushNotificationReceived', (notification) => {
    console.log('[push] received while foregrounded:', notification?.data?.type);
  });

  // User tapped a notification.
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const data = action?.notification?.data || {};
    const target = { conversationType: data.conversationType, conversationId: data.conversationId, messageId: data.messageId, senderId: data.senderId };
    if (!target.conversationId) return;
    if (onNotificationTap) {
      onNotificationTap(target);
    } else {
      // App was cold-started by this tap and the dashboard hasn't mounted
      // its handler yet — stash it for consumePendingNotification() to pick
      // up once it has.
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(target)); } catch (_) { /* ignore */ }
    }
  });

  const perm = await checkNotificationPermission();
  if (perm === 'granted') {
    await PushNotifications.register();
  }
  // If not granted yet, registration happens after requestNotificationPermission()
  // succeeds — see the Settings screen's "Enable Notifications" button, and
  // the initial-permission prompt wired into ChatDashboard's bootstrap.
}

// If notifications aren't enabled yet, this both asks for permission AND
// (on success) completes registration — the combined "make it actually
// work" call the Settings screen's Enable button and first-login prompt use.
export async function ensurePushRegistered() {
  if (!isNative()) return 'unsupported';
  const state = await requestNotificationPermission();
  if (state === 'granted') {
    try { await PushNotifications.register(); } catch (e) { console.error('[push] register() failed:', e?.message || e); }
  }
  return state;
}

export function consumePendingNotification() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Call on logout so a shared/borrowed device stops receiving push for an
// account nobody is signed into anymore.
export async function unregisterPushNotifications() {
  if (!isNative()) return;
  try {
    if (currentToken) {
      await axios.post(`${API_URL}/devices/unregister`, { token: currentToken });
    }
  } catch (e) {
    console.error('[push] Failed to unregister device token:', e?.message || e);
  } finally {
    try { await PushNotifications.removeAllDeliveredNotifications(); } catch (_) { /* ignore */ }
    currentToken = null;
  }
}

// Sends a real FCM push to this account's own devices via the backend,
// through the exact same code path a real message uses — used by the
// dev-only "Test Notification" button in Settings.
export async function sendTestNotification() {
  const { data } = await axios.post(`${API_URL}/devices/test-push`);
  return data;
}