// Android push notifications (Firebase Cloud Messaging via the official
// @capacitor/push-notifications plugin).
//
// Every function here is a no-op on the web build — Capacitor.isNativePlatform()
// is false in the browser, so none of this ever touches native APIs there.
// This keeps the existing browser app (and its own Notification-API-based
// in-app alerts in ChatDashboard.jsx) completely unchanged.
import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { API_URL } from './config';
const FCM_TOKEN_STORAGE_KEY = 'chat_fcm_token';
const PENDING_NOTIFICATION_STORAGE_KEY = 'chat_pending_notification';

const isNativeAndroid = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

// Turns the raw data payload Android hands back (all-string map, plus some
// "google.*" bookkeeping keys we don't care about) into the shape the rest
// of the app understands: which conversation to open.
function extractConversationTarget(data) {
  if (!data || !data.conversationType || !data.conversationId) return null;
  return {
    conversationType: data.conversationType, // 'direct' | 'group'
    conversationId: data.conversationId,
    senderId: data.senderId || null,
    messageId: data.messageId || null,
  };
}

function savePendingNotification(target) {
  try {
    localStorage.setItem(PENDING_NOTIFICATION_STORAGE_KEY, JSON.stringify(target));
  } catch (_) { /* ignore storage errors */ }
}

// Reads and CONSUMES (clears) the pending notification target, if any.
// Call this once contacts/groups have loaded, exactly like the app's
// existing openAnnouncement-on-login pattern — this is what lets a tap on a
// notification open the right conversation even from a fully cold start,
// where the app has to finish auth + data loading before it can navigate.
export function consumePendingNotification() {
  try {
    const raw = localStorage.getItem(PENDING_NOTIFICATION_STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_NOTIFICATION_STORAGE_KEY);
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

let listenersRegistered = false;

// Sets up FCM: requests notification permission (Android 13+ shows the
// system prompt; on refusal we simply stop here and the app continues
// working normally with Socket.IO-only realtime updates), registers for a
// token, creates the notification channel, sends the token to the backend,
// and wires up tap handling for foreground/background/cold-start.
//
// onNotificationTap(target) is called immediately if the app is already
// running when a notification is tapped (background→foreground case) so
// the UI can navigate right away, in addition to the target being stashed
// for consumePendingNotification() to pick up on a cold start.
export async function registerPushNotifications({ onNotificationTap } = {}) {
  console.log('[PUSH] registerPushNotifications() STARTED');
  if (!isNativeAndroid()) return; // web build: nothing to do
  try {
    // Import lazily so the plugin's JS is only ever touched on native Android.
    const { PushNotifications } = await import('@capacitor/push-notifications');

    if (!listenersRegistered) {
      listenersRegistered = true;

      PushNotifications.addListener('registration', async (token) => {
        try {
          // TEMP DIAGNOSTIC — never logs the full token, only a masked prefix.
          const masked = token?.value ? `${String(token.value).slice(0, 8)}…(${String(token.value).length} chars)` : '(empty)';
          console.log(`[PUSH] registration token received: ${masked}`);
          localStorage.setItem(FCM_TOKEN_STORAGE_KEY, token.value);
          await axios.post(`${API_URL}/devices/register`, { token: token.value, platform: 'android' });
          console.log('[PUSH] /devices/register succeeded — token stored on backend');
        } catch (err) {
          // A failed registration must never break the app — chat keeps
          // working over Socket.IO regardless.
          console.error('[PUSH] Failed to register push token with backend:', err?.message || err);
        }
      });

      PushNotifications.addListener('registrationError', (err) => {
        console.warn('[PUSH] registration error (notifications will be unavailable):', err);
      });

      // App open/foreground: Android (via the plugin) already shows the
      // system notification per capacitor.config.json's presentationOptions,
      // so there's nothing extra to render here.
      PushNotifications.addListener('pushNotificationReceived', () => {});

      // Notification tapped — covers background AND cold start (the plugin
      // buffers the launch notification until this listener exists).
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        try {
          const data = action?.notification?.data || {};
          const target = extractConversationTarget(data);
          if (!target) return;
          savePendingNotification(target);
          if (typeof onNotificationTap === 'function') onNotificationTap(target);
        } catch (err) {
          console.error('Failed to handle notification tap:', err?.message || err);
        }
      });
    }

    let permStatus = await PushNotifications.checkPermissions();
    console.log('[PUSH] Permission status:', permStatus);
    if (permStatus.receive === 'prompt' || permStatus.receive === 'prompt-with-rationale') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') {
  console.log('[PUSH] Permission NOT granted:', permStatus.receive);
  return;
}

console.log('[PUSH] Permission granted');
    // Heads-up delivery requires a channel with high importance to exist on
    // the device before a message referencing it arrives.
    await PushNotifications.createChannel({
      id: 'aerio_messages',
      name: 'Messages',
      description: 'New chat messages',
      importance: 5,
      visibility: 1,
      vibration: true,
    });
  console.log('[PUSH] Calling PushNotifications.register()');

    await PushNotifications.register();
    console.log('[PUSH] PushNotifications.register() completed');
  } catch (err) {
    // Never let push setup break the rest of the app.
    console.error('registerPushNotifications failed:', err?.message || err);
  }
}

// Call on logout so a shared/borrowed device stops receiving notifications
// for an account nobody is signed into anymore.
export async function unregisterPushNotifications() {
  if (!isNativeAndroid()) return;
  try {
    const token = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
    if (token) {
      await axios.post(`${API_URL}/devices/unregister`, { token }).catch(() => {});
    }
    localStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners();
    listenersRegistered = false;
  } catch (err) {
    console.error('unregisterPushNotifications failed:', err?.message || err);
  }
}