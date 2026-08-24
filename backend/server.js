const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('./database');
const jwt = require('jsonwebtoken');
const push = require('./push');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-1234';
const ADMIN_USERNAME = 'maaz_khan';

// Tracks live socket connections per user (userId -> number of open sockets),
// so we can know in real time who is actually online (supports multiple tabs/devices).
const onlineSocketCounts = new Map();
const isUserOnline = (userId) => onlineSocketCounts.has(Number(userId));

// Tracks which conversation (if any) each live socket currently has open in
// the foreground, reported by the client via the 'active_chat' event (see
// io.on('connection') below). Used only to decide whether a push
// notification is redundant — if the recipient already has that exact
// conversation open, Socket.IO already delivered the message to them live,
// so we skip the extra system notification. socketId -> { isGroup, targetId }
const activeChatBySocket = new Map();

// ── Voice/Video call signaling state ────────────────────────────────────
// Calls are tracked in memory only (never persisted mid-call — only the
// final outcome becomes an optional call-history chat message, see
// endCall()). Reusing the existing `user_${id}` Socket.IO rooms and the
// same JWT-verified `socket.user` identity as the rest of the app, so
// there is no second auth/signaling system: this is just a few more
// event types on the same authenticated socket connection.
//
// activeCalls: callId -> { callId, callerId, calleeId, callType, state, createdAt, connectedAt }
// userActiveCallId: userId -> callId  (lets us detect "busy" and clean up on disconnect)
const activeCalls = new Map();
const userActiveCallId = new Map();
const CALL_RING_TIMEOUT_MS = 45_000;

// Treats `userActiveCallId` as a cache of the truth in `activeCalls`, not the
// truth itself: if a user is pointed at a callId that no longer exists (the
// call already ended some other way, or the entry was left behind by a bug),
// self-heal by dropping the stale pointer instead of reporting them busy
// forever. This is what makes a false "user is on another call" impossible
// to get permanently stuck on, even if some other code path leaks an entry.
const isUserBusy = (userId) => {
  const callId = userActiveCallId.get(userId);
  if (!callId) return false;
  if (!activeCalls.has(callId)) {
    userActiveCallId.delete(userId);
    return false;
  }
  return true;
};

const formatCallDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const app = express();

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());

// Rate limiter for Auth routes
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 auth requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/auth/', authRateLimiter);

let systemUser = null;

// Configure Brevo Transactional Email API (HTTPS, not SMTP)
const https = require('https');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'maazsabirkhan@gmail.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Aerio';

console.log("[BREVO API ENV]", {
  apiKeyExists: !!BREVO_API_KEY,
  senderEmail: BREVO_SENDER_EMAIL,
});

if (!BREVO_API_KEY) {
  console.warn('BREVO_API_KEY is not set. Real email delivery is disabled until BREVO_API_KEY is configured in environment.');
}

// Sends a single transactional email via Brevo's HTTPS API (api.brevo.com).
// This bypasses SMTP entirely, so it is not affected by outbound SMTP port
// blocking on the hosting platform.
const sendBrevoEmail = (payload) => {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': BREVO_API_KEY,
          'content-length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(`Brevo API error: ${res.statusCode} ${parsed.message || data}`);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Brevo API request timed out'));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
};

// Helper function to send Email OTP and throw on failure
const sendEmailOTP = async (email, otpCode, type = 'signup') => {
  // Subjects
  const subject = type === 'signup' ? 'Verify your Aerio account' : 'Reset your Aerio password';
  const plainText = type === 'signup'
    ? `Verify your Aerio account\n\nThanks for creating an Aerio account. Enter the verification code below to confirm your email address and continue setting up your account.\n\nVerification code: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you didn't create an Aerio account, you can safely ignore this email.\n\n— Aerio`
    : `Reset your Aerio password\n\nWe received a request to reset the password for your Aerio account. Enter the code below to continue.\n\nReset code: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this password reset, you can safely ignore this email — your account remains secure.\n\n— Aerio`;

  console.log(`\n========================================`);
  console.log(`📧 [EMAIL OTP LOG] (${type.toUpperCase()})`);
  console.log(`========================================\n`);

  if (!BREVO_API_KEY) {
    const msg = 'Brevo API is not configured. Set BREVO_API_KEY to enable email sending.';
    console.error(msg);
    throw new Error(msg);
  }

  // Responsive, email-client-safe HTML template (table-based layout, inline
  // styles, safe system fonts, no JS/external assets) matching Aerio's dark
  // navy / blue-purple brand. Built to degrade gracefully in Outlook, which
  // ignores CSS gradients/border-radius — every important value (the OTP
  // digits especially) keeps a solid `bgcolor`/color fallback so nothing
  // depends on gradient rendering to stay readable.
  const htmlTemplate = ({ title, heading, intro, otp, otpLabel, expiryNote, securityNote }) => {
    const digitCells = otp.split('').map(digit => `
              <td width="44" height="56" align="center" valign="middle" bgcolor="#18243A" style="background-color:#18243A; border:1px solid #26344d; border-radius:8px; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:28px; font-weight:700; color:#F5F7FB;">
                ${digit}
              </td>
              <td width="8" style="font-size:0; line-height:0;">&nbsp;</td>`).join('');

    return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="color-scheme" content="dark">
    <title>${title}</title>
    <!--[if mso]>
    <style type="text/css">
      table { border-collapse: collapse; }
      .fallback-font { font-family: Arial, sans-serif !important; }
    </style>
    <![endif]-->
  </head>
  <body style="margin:0; padding:0; background-color:#070B17; -webkit-text-size-adjust:100%; text-size-adjust:100%;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#070B17" style="background-color:#070B17;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <!--[if mso]>
          <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>
          <![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:0 auto;">
            <tr>
              <td align="center" bgcolor="#111A2B" style="background-color:#111A2B; border:1px solid #1e2a40; border-radius:16px; padding:40px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

                  <!-- Logo -->
                  <tr>
                    <td align="center" style="padding-bottom:28px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td width="40" height="40" align="center" valign="middle" bgcolor="#1687FF" style="background-color:#1687FF; background-image:linear-gradient(135deg,#1687FF,#635BFF); border-radius:10px; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:18px; font-weight:800; color:#ffffff;">
                            A
                          </td>
                          <td width="10" style="font-size:0; line-height:0;">&nbsp;</td>
                          <td valign="middle" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:20px; font-weight:700; color:#F5F7FB; letter-spacing:0.3px;">
                            Aerio
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Heading -->
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:24px; line-height:30px; font-weight:700; color:#F5F7FB; padding-bottom:12px;">
                      ${heading}
                    </td>
                  </tr>

                  <!-- Intro -->
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:15px; line-height:23px; color:#9AA8BD; padding-bottom:28px;">
                      ${intro}
                    </td>
                  </tr>

                  <!-- OTP card -->
                  <tr>
                    <td align="center" bgcolor="#0D1526" style="background-color:#0D1526; border:1px solid #26344d; border-radius:14px; padding:24px 20px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:12px; font-weight:700; letter-spacing:2px; color:#9AA8BD; padding-bottom:14px;">
                            ${otpLabel}
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                              <tr>${digitCells}
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:13px; color:#9AA8BD; padding-top:16px;">
                            ${expiryNote}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Security note -->
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:13px; line-height:20px; color:#9AA8BD; padding-top:24px;">
                      ${securityNote}
                    </td>
                  </tr>

                  <!-- Divider -->
                  <tr>
                    <td style="padding:28px 0 20px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr><td height="1" bgcolor="#1e2a40" style="background-color:#1e2a40; font-size:0; line-height:0;">&nbsp;</td></tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:13px; font-weight:700; color:#F5F7FB; padding-bottom:4px;">
                      Aerio
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:12px; color:#6b7f9e; padding-bottom:10px;">
                      Modern messaging, made simple.
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:11px; color:#4d5c74;">
                      This is an automated message. Please do not reply to this email.
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
          <!--[if mso]>
          </td></tr></table>
          <![endif]-->
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
  };

  const html = (type === 'signup')
    ? htmlTemplate({
      title: 'Verify your Aerio account',
      heading: 'Verify your Aerio account',
      intro: 'Thanks for creating an Aerio account. Enter the verification code below to confirm your email address and continue setting up your account.',
      otp: otpCode,
      otpLabel: 'VERIFICATION CODE',
      expiryNote: 'This code expires in 10 minutes.',
      securityNote: "If you didn't create an Aerio account, you can safely ignore this email."
    })
    : htmlTemplate({
      title: 'Reset your Aerio password',
      heading: 'Reset your Aerio password',
      intro: 'We received a request to reset the password for your Aerio account. Enter the code below to continue.',
      otp: otpCode,
      otpLabel: 'RESET CODE',
      expiryNote: 'This code expires in 10 minutes.',
      securityNote: "If you didn't request this password reset, you can safely ignore this email — your account remains secure."
    });

  try {
    console.log("[BREVO API] Sending via Brevo API", {
      senderEmail: BREVO_SENDER_EMAIL,
      apiKeyExists: !!BREVO_API_KEY,
      to: email,
      subject,
    });
    const info = await sendBrevoEmail({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject,
      textContent: plainText,
      htmlContent: html,
    });
    console.log('[BREVO API] send result:', info && (info.messageId || JSON.stringify(info)));
    // Persist a short delivery record for debugging
    try {
      const logLine = `${new Date().toISOString()}\tTO=${email}\tMSGID=${info.messageId || ''}\tINFO=${JSON.stringify(info)}\n`;
      const logPath = path.join(__dirname, 'email-sends.log');
      fs.appendFileSync(logPath, logLine, { encoding: 'utf8' });
      console.log('[BREVO API] Appended send record to', logPath);
    } catch (fileErr) {
      console.error('[BREVO API] Failed to write email-sends.log:', fileErr && fileErr.message ? fileErr.message : fileErr);
    }
    return info;
  } catch (err) {
    console.error('[BREVO API] Failed to send mail via Brevo API:', err && err.message ? err.message : err, err);
    throw err;
  }
};

// Settings helpers
const getSettingAsync = async (key, fallback) => {
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    const v = rows[0]?.value;
    if (v === null || v === undefined) return fallback;
    return v;
  } catch (_) {
    return fallback;
  }
};

const setSettingAsync = async (key, value) => {
  await db.query(
    'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
};

const DEFAULT_USER_SETTINGS = Object.freeze({
  theme: 'dark',
  accent_color: '#3b82f6',
  notification_sounds: true,
  wallpaper: 'default',
  privacy_last_seen: 'everyone',
  privacy_profile_visibility: 'everyone',
  read_receipts: true,
  typing_indicator: true,
  online_status_visibility: true,
  // Notification preferences. These gate whether push.sendToUser() is ever
  // called for a given recipient/event — see their use in the send_message
  // handler and POST /api/contacts/add below.
  message_notifications: true,
  group_notifications: true,
  friend_request_notifications: true,
  notification_preview: 'show', // 'show' | 'hide' | 'hide_completely'
  vibration: true,
  // Appearance fields that are safe/useful to sync across devices (unlike
  // a custom wallpaper image, which stays device-local).
  font_size: 'medium',
  chat_density: 'comfortable',
  message_animations: true,
  ui_animations: true,
});

const USER_SETTINGS_COLUMNS = Object.keys(DEFAULT_USER_SETTINGS);

const ensureUserSettings = async (userId) => {
  // Create a row if missing then return the full settings row
  await db.query('INSERT INTO user_settings (user_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM user_settings WHERE user_id = $1)', [userId]);
  const { rows } = await db.query(
    `SELECT ${USER_SETTINGS_COLUMNS.join(', ')} FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0] || {};
  const out = {};
  for (const key of USER_SETTINGS_COLUMNS) {
    out[key] = row[key] ?? DEFAULT_USER_SETTINGS[key];
  }
  return out;
};

// Fetch just the fields push dispatch needs for one recipient, with safe
// defaults if the row doesn't exist yet (new user who never opened Settings).
const getNotificationPrefs = async (userId) => {
  try {
    const { rows } = await db.query(
      `SELECT message_notifications, group_notifications, friend_request_notifications,
              notification_preview, notification_sounds, vibration
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    const row = rows[0];
    return {
      message_notifications: row?.message_notifications ?? true,
      group_notifications: row?.group_notifications ?? true,
      friend_request_notifications: row?.friend_request_notifications ?? true,
      notification_preview: row?.notification_preview ?? 'show',
      notification_sounds: row?.notification_sounds ?? true,
      vibration: row?.vibration ?? true,
    };
  } catch (err) {
    console.error('[push] getNotificationPrefs error:', err.message);
    return { message_notifications: true, group_notifications: true, friend_request_notifications: true, notification_preview: 'show', notification_sounds: true, vibration: true };
  }
};

// Applies the recipient's notification_preview preference to a title/body
// pair before it's handed to push.sendToUser(). 'show' leaves it untouched,
// 'hide' keeps the sender/group name but masks the content, and
// 'hide_completely' masks both so nothing about the message leaks into the
// notification shade (e.g. on a lock screen).
const applyPreviewPreference = (preview, title, body) => {
  if (preview === 'hide_completely') return { title: 'Aerio', body: 'New notification' };
  if (preview === 'hide') return { title, body: 'New message' };
  return { title, body };
};

const ensureSystemUserAsync = async () => {
  try {
    const existing = await db.query('SELECT id, username, role FROM users WHERE username = $1', ['__system__']);
    if (existing.rows[0]) return existing.rows[0];
    const hash = await bcrypt.hash('system', 10);
    const created = await db.query(
      "INSERT INTO users (username, password_hash, role, banned, email, email_verified, display_name) VALUES ($1, $2, 'system', FALSE, 'system@aerio.internal', TRUE, 'System') RETURNING id, username, role",
      ['__system__', hash]
    );
    return created.rows[0] || null;
  } catch (err) {
    console.error('Failed to ensure system user:', err.message);
    return null;
  }
};

// The Announcements channel name, and its single official welcome message.
const ANNOUNCEMENTS_GROUP_NAME = 'Announcements';
const WELCOME_ANNOUNCEMENT_CONTENT = `👋 Welcome to Aerio!\n\nWe're excited to have you here.\n\nAerio is currently under active development, and you're one of our early users helping shape the platform.\n\n🚀 Features available today:\n• Secure account system with email verification\n• Real-time messaging\n• Friend requests\n• User search\n• Profile pictures\n• Message reactions\n• Reply to messages\n• Custom themes and personalization\n\n🛠 Coming soon:\n• Group chats\n• Voice & Video calls\n• File sharing improvements\n• Desktop apps (Windows, macOS & Linux)\n• Mobile apps\n• End-to-end encryption\n• Better notifications\n• More customization options\n\nIf you discover a bug or have a feature suggestion, we'd love to hear from you.\n\nThank you for being part of the Aerio community.\n\n— Team Aerio 💙`;
const DEV_UPDATE_ANNOUNCEMENT_CONTENT = `📢 Development Update\n\nToday we completed:\n- Fixed Android push notifications — you'll now get notified for new messages even when the app is closed or in the background.\n- Chats now automatically move to the top of your sidebar when a new message arrives, just like WhatsApp.\n- Various backend stability fixes.\n\nMore features and improvements are coming soon. Thank you for testing Aerio! 🚀`;

// In-memory cache of the canonical Announcements group id, once resolved.
let announcementsGroupIdCache = null;

// Atomically get the single Announcements group, creating it only if it doesn't exist.
// The partial unique index on groups(name) WHERE name = 'Announcements' guarantees only
// one such group can ever exist, even under concurrent calls.
const getOrCreateAnnouncementsGroupId = async () => {
  if (announcementsGroupIdCache) return announcementsGroupIdCache;
  if (!systemUser) systemUser = await ensureSystemUserAsync();

  const ins = await db.query(
    `INSERT INTO groups (name, created_by, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) WHERE name = 'Announcements' DO NOTHING
     RETURNING id`,
    [ANNOUNCEMENTS_GROUP_NAME, systemUser ? systemUser.id : null, 'Official Aerio announcements']
  );

  let groupId;
  if (ins.rows[0]) {
    groupId = ins.rows[0].id;
  } else {
    const sel = await db.query('SELECT id FROM groups WHERE name = $1 ORDER BY id ASC LIMIT 1', [ANNOUNCEMENTS_GROUP_NAME]);
    groupId = sel.rows[0] ? sel.rows[0].id : null;
  }
  if (groupId) announcementsGroupIdCache = groupId;
  return groupId;
};
// Ensure the single official welcome message exists in the Announcements group; never creates a duplicate.
const ensureWelcomeAnnouncementMessageId = async (announcementsGroupId) => {
  const existing = await db.query(
    "SELECT id FROM messages WHERE group_id = $1 AND type = 'system' ORDER BY id ASC LIMIT 1",
    [announcementsGroupId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const msgRes = await db.query(
    'INSERT INTO messages (sender_id, group_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id',
    [systemUser ? systemUser.id : null, announcementsGroupId, WELCOME_ANNOUNCEMENT_CONTENT, 'system']
  );
  return msgRes.rows[0].id;
};
// Ensure today's dev-update announcement exists in the Announcements group; never creates a duplicate.
const ensureDevUpdateAnnouncementMessageId = async (announcementsGroupId) => {
  const existing = await db.query(
    "SELECT id FROM messages WHERE group_id = $1 AND type = 'system' AND content = $2 LIMIT 1",
    [announcementsGroupId, DEV_UPDATE_ANNOUNCEMENT_CONTENT]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const msgRes = await db.query(
    'INSERT INTO messages (sender_id, group_id, content, type) VALUES ($1, $2, $3, $4) RETURNING id',
    [systemUser ? systemUser.id : null, announcementsGroupId, DEV_UPDATE_ANNOUNCEMENT_CONTENT, 'system']
  );
  return msgRes.rows[0].id;
};
// Ensure the Announcements group exists, add the user as a member, and make sure the single
// official welcome announcement is present. Returns { groupId, messageId } only the first time
// this user should have their client auto-open the channel (sign up / first login), or null after that.
const ensureAnnouncementForUser = async (userId) => {
  if (!userId) return null;
  try {
    const announcementsGroupId = await getOrCreateAnnouncementsGroupId();
    if (!announcementsGroupId) return null;

    // Ensure the user is a member of the Announcements group
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [announcementsGroupId, userId]);

    // Make sure the single welcome message exists (never creates a second copy)
    const messageId = await ensureWelcomeAnnouncementMessageId(announcementsGroupId);

    // Only signal the client to auto-open the channel the first time for this user
    const seen = await db.query('SELECT 1 FROM announcements_shown WHERE user_id = $1 AND group_id = $2', [userId, announcementsGroupId]);
    if (seen.rows[0]) return null;

    await db.query(
      'INSERT INTO announcements_shown (user_id, group_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, group_id) DO NOTHING',
      [userId, announcementsGroupId, messageId]
    );

    return { groupId: announcementsGroupId, messageId };
  } catch (e) {
    console.error('Failed to ensure announcement for user:', e && e.message ? e.message : e);
    return null;
  }
};

// One-time startup cleanup: merge any pre-existing duplicate "Announcements" groups into a single
// canonical one (the oldest), and strip out any non-official messages so only the welcome
// announcement remains. Safe to run every startup — it's a no-op once the data is clean.
const dedupeAndCleanAnnouncementsGroup = async () => {
  try {
    const groupsRes = await db.query('SELECT id FROM groups WHERE name = $1 ORDER BY id ASC', [ANNOUNCEMENTS_GROUP_NAME]);
    const groupRows = groupsRes.rows || [];
    if (!groupRows.length) return;

    const canonicalId = groupRows[0].id;
    const duplicateIds = groupRows.slice(1).map(r => r.id);

    for (const dupId of duplicateIds) {
      await db.query('INSERT INTO group_members (group_id, user_id) SELECT $1, user_id FROM group_members WHERE group_id = $2 ON CONFLICT DO NOTHING', [canonicalId, dupId]);
      await db.query('UPDATE messages SET group_id = $1 WHERE group_id = $2', [canonicalId, dupId]);
      await db.query('DELETE FROM groups WHERE id = $1', [dupId]);
    }

    announcementsGroupIdCache = canonicalId;

    // Keep only the oldest official (system) message; delete every other message,
    // including any duplicate welcome messages and any messages sent by regular users.
    const officialRes = await db.query(
      "SELECT id FROM messages WHERE group_id = $1 AND type = 'system' ORDER BY id ASC LIMIT 1",
      [canonicalId]
    );
    const officialId = officialRes.rows[0] ? officialRes.rows[0].id : null;

    if (officialId) {
      await db.query('DELETE FROM messages WHERE group_id = $1 AND id != $2', [canonicalId, officialId]);
    } else {
      // No official message survived somehow; delete stray messages and recreate it.
      await db.query('DELETE FROM messages WHERE group_id = $1', [canonicalId]);
      await ensureWelcomeAnnouncementMessageId(canonicalId);
    }
  } catch (e) {
    console.error('Failed to dedupe/clean Announcements group:', e && e.message ? e.message : e);
  }
};

// Initialize DB schema & system user
db.initDb()
  .then(async () => {
    console.log('Postgres schema initialized.');
    systemUser = await ensureSystemUserAsync();
    if (systemUser) {
      console.log('System user ready.');
    }
    await getOrCreateAnnouncementsGroupId();
    await dedupeAndCleanAnnouncementsGroup();
    const announcementsGroupId = await getOrCreateAnnouncementsGroupId();
    if (announcementsGroupId) await ensureDevUpdateAnnouncementMessageId(announcementsGroupId);
  })
  .catch((err) => {
    console.error('Failed to initialize Postgres schema:', err);
  });

// JWT Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    try {
      const bannedRes = await db.query('SELECT banned FROM users WHERE id = $1', [user.id]);
      if (!bannedRes.rows[0]) return res.status(403).json({ error: 'Invalid or expired token' });
      if (bannedRes.rows[0].banned) return res.status(403).json({ error: 'Account is banned' });
      req.user = user;
      next();
    } catch (_) {
      return res.status(500).json({ error: 'Authentication error' });
    }
  });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Access denied' });
  if (req.user.username === ADMIN_USERNAME || req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// Health checks
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve uploaded files (avatars, group avatars, chat images/audio) from the
// database, since the local /uploads disk is ephemeral on Render and gets
// wiped on restarts/redeploys — that was causing avatars and chat images to
// randomly "disappear". Older files that still happen to exist on local disk
// are served as a fallback for backward compatibility.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.get('/uploads/:filename', async (req, res) => {
  const { filename } = req.params;
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const { rows } = await db.query('SELECT mime_type, data FROM uploaded_files WHERE filename = $1', [filename]);
    if (rows[0]) {
      res.set('Content-Type', rows[0].mime_type || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(rows[0].data);
    }
  } catch (err) {
    console.error('Fetch uploaded file error:', err);
  }
  // Fallback for legacy files that may still be on local disk
  const diskPath = path.join(uploadsDir, filename);
  if (fs.existsSync(diskPath)) return res.sendFile(diskPath);
  return res.status(404).json({ error: 'File not found' });
});

// Forces a real file download (rather than inline display) with the
// original filename restored where we have it, so "Download" controls in
// the chat UI work with a plain navigation/anchor click and don't hit CORS
// restrictions the way a fetch()+blob approach would for cross-origin files.
app.get('/uploads/:filename/download', async (req, res) => {
  const { filename } = req.params;
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const { rows } = await db.query('SELECT mime_type, data, original_name FROM uploaded_files WHERE filename = $1', [filename]);
    if (rows[0]) {
      const downloadName = rows[0].original_name || filename;
      res.set('Content-Type', rows[0].mime_type || 'application/octet-stream');
      res.set('Content-Disposition', contentDispositionFor(downloadName));
      return res.send(rows[0].data);
    }
  } catch (err) {
    console.error('Fetch uploaded file for download error:', err);
  }
  const diskPath = path.join(uploadsDir, filename);
  if (fs.existsSync(diskPath)) {
    return res.download(diskPath, filename);
  }
  return res.status(404).json({ error: 'File not found' });
});

// Multer Storage for file & avatar uploads — kept in memory, then persisted
// to the database (see saveUploadedFile) instead of the ephemeral local disk.
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// Persists an uploaded (in-memory) file to the database and returns its
// generated filename, to be used when building the public /uploads URL.
async function saveUploadedFile(file) {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const filename = uniqueSuffix + path.extname(file.originalname);
  await db.query(
    'INSERT INTO uploaded_files (filename, mime_type, data, original_name) VALUES ($1, $2, $3, $4)',
    [filename, file.mimetype, file.buffer, file.originalname || null]
  );
  return filename;
}

// Builds a safe Content-Disposition header value for a given filename,
// falling back gracefully for names with non-ASCII characters.
function contentDispositionFor(filename) {
  const safeAscii = String(filename || 'download').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename || 'download');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

// Multer / upload error handler used by upload routes
function handleUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 15MB)' });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
  return next(err);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Optional call-history chat message (Feature 10) — only for direct calls,
// reusing the existing `messages` table/`type` column (a free-form TEXT
// column already used for 'text' | 'image' | 'audio' | 'gif'), so no
// schema change was needed. We never store any audio/video, just the
// outcome/duration. Shared by endCall() (for calls that actually rang) and
// the callee-offline path in call:invite (which never creates a call record
// at all, so it used to log nothing — the callee would come back online
// with zero indication anyone tried to reach them).
const logCallHistoryMessage = async (callerId, calleeId, content) => {
  try {
    const inserted = await db.query(
      `INSERT INTO messages (sender_id, receiver_id, content, type, status)
       VALUES ($1, $2, $3, 'call', 'sent') RETURNING id, timestamp`,
      [callerId, calleeId, content]
    );
    const row = inserted.rows[0];
    const messageObj = {
      id: Number(row.id),
      sender_id: callerId,
      receiver_id: calleeId,
      group_id: null,
      content,
      type: 'call',
      reactions: [],
      status: 'sent',
      timestamp: row.timestamp
    };
    io.to(`user_${callerId}`).emit('receive_message', messageObj);
    io.to(`user_${calleeId}`).emit('receive_message', messageObj);
  } catch (err) {
    console.error('Failed to save call-history message:', err.message);
  }
};

// Ends/cleans up a call on the server side and notifies both participants.
// `reason` is one of: 'ended' | 'declined' | 'busy' | 'timeout' | 'failed' | 'disconnected'.
// `endedByUserId` is who actively ended it (null for timeout/disconnect), used so we don't
// echo the 'call:ended' event back to the person who just clicked "End".
const endCall = async (callId, reason, endedByUserId = null) => {
  const call = activeCalls.get(callId);
  if (!call) return;

  activeCalls.delete(callId);
  if (userActiveCallId.get(call.callerId) === callId) userActiveCallId.delete(call.callerId);
  if (userActiveCallId.get(call.calleeId) === callId) userActiveCallId.delete(call.calleeId);
  if (call.ringTimeout) clearTimeout(call.ringTimeout);

  const payload = { callId, reason, callType: call.callType };
  [call.callerId, call.calleeId].forEach((uid) => {
    if (uid === endedByUserId) return; // the ender already knows locally
    io.to(`user_${uid}`).emit('call:ended', payload);
  });

  let content;
  if (reason === 'declined') content = `Declined ${call.callType} call`;
  else if (reason === 'timeout' && !call.connectedAt) content = `Missed ${call.callType} call`;
  else if (reason === 'busy') return; // caller already knows synchronously, nothing to log
  else if (call.connectedAt) content = `${call.callType === 'video' ? 'Video' : 'Voice'} call — ${formatCallDuration(Date.now() - call.connectedAt)}`;
  else content = `Missed ${call.callType} call`;

  await logCallHistoryMessage(call.callerId, call.calleeId, content);
};

// ==================================================
// AUTHENTICATION APIs (Gmail Step-by-Step + Email OTP)
// ==================================================

// Check Email (Step 1 of Login / Signup)
app.post('/api/auth/check-email', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const deviceToken = req.body?.deviceToken;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const { rows } = await db.query('SELECT id, username, email, email_verified, banned FROM users WHERE email = $1', [email]);
    const user = rows[0];

    if (!user) {
      return res.json({ exists: false });
    }

    if (user.banned) {
      return res.status(403).json({ error: 'Account is banned' });
    }

    let isDeviceTrusted = false;
    if (deviceToken) {
      const devRes = await db.query(
        'SELECT 1 FROM remembered_devices WHERE user_id = $1 AND device_token = $2',
        [user.id, deviceToken]
      );
      if (devRes.rows[0]) {
        isDeviceTrusted = true;
        await db.query(
          'UPDATE remembered_devices SET last_used = NOW() WHERE user_id = $1 AND device_token = $2',
          [user.id, deviceToken]
        );
      }
    }

    return res.json({
      exists: true,
      email_verified: user.email_verified,
      username: user.username,
      isDeviceTrusted
    });
  } catch (err) {
    console.error('Check email error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Send OTP (Step 1 of Signup or Resend)
app.post('/api/auth/send-otp', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const type = req.body?.type || 'signup';
  console.log('[OTP] Incoming send-otp request', { email, type });
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    if (type === 'signup') {
      const existingUser = await db.query('SELECT id FROM users WHERE email = $1 AND email_verified = TRUE', [email]);
      if (existingUser.rows[0]) return res.status(400).json({ error: 'Email is already registered. Please sign in.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    console.log('[OTP] Generated code for', email, '(code redacted from logs)');

    // Invalidate any previous unused OTPs for this email/type
    const upd = await db.query(
      'UPDATE otps SET used = TRUE WHERE email = $1 AND type = $2 AND used = FALSE RETURNING id',
      [email, type]
    );
    console.log('[OTP] Invalidated previous OTPs count=', upd.rowCount || 0);

    const insertRes = await db.query(
      'INSERT INTO otps (email, otp_code, type, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [email, otpCode, type, expiresAt]
    );
    console.log('[OTP] Inserted OTP record id=', insertRes.rows[0]?.id);

    try {
      console.log('[OTP] Calling sendEmailOTP for', email);
      const info = await sendEmailOTP(email, otpCode, type);
      console.log('[OTP] sendEmailOTP succeeded, info=', info && (info.messageId || JSON.stringify(info)));
    } catch (sendErr) {
      console.error('SendEmailOTP failed after DB insert:', sendErr && sendErr.message ? sendErr.message : sendErr);
      // Remove the OTP record to avoid unusable / undelivered OTPs lingering
      try {
        await db.query('DELETE FROM otps WHERE email = $1 AND otp_code = $2 AND type = $3', [email, otpCode, type]);
        console.log('[OTP] Cleaned up OTP record after send failure');
      } catch (cleanupErr) {
        console.error('Failed to cleanup OTP after send failure:', cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
      }
      console.log('[OTP] Responding with error to client');
      return res.status(500).json({ error: 'Failed to send OTP email. ' + (sendErr.message || '') });
    }

    console.log('[OTP] Responding OK to client for', email);
    res.json({ ok: true, message: 'OTP sent to email. Code is valid for 10 minutes.' });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP (Step 2 of Signup)
app.post('/api/auth/verify-otp', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const otpCode = String(req.body?.otpCode || '').trim();
  const type = req.body?.type || 'signup';
  if (!email || !otpCode) return res.status(400).json({ error: 'Email and OTP code required' });

  try {
    const { rows } = await db.query(
      'SELECT id, expires_at, used FROM otps WHERE email = $1 AND otp_code = $2 AND type = $3 ORDER BY id DESC LIMIT 1',
      [email, otpCode, type]
    );
    const record = rows[0];

    if (!record) return res.status(400).json({ error: 'Invalid OTP code' });
    if (record.used) return res.status(400).json({ error: 'OTP code already used' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'OTP code has expired' });

    await db.query('UPDATE otps SET used = TRUE, verified_at = NOW() WHERE id = $1', [record.id]);
    res.json({ ok: true, verified: true });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Complete Registration (Step 3 of Signup)
app.post('/api/auth/register-complete', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const rememberDevice = !!req.body?.rememberDevice;
  const userAgent = req.headers['user-agent'] || '';

  if (!email || !username || !password) {
    return res.status(400).json({ error: 'Email, username, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const inviteOnly = (await getSettingAsync('invite_only', 'false')) === 'true';
    if (inviteOnly && username !== ADMIN_USERNAME) {
      return res.status(403).json({ error: 'Registrations are currently invite-only' });
    }

    // Require a recently verified signup OTP before creating the account
    const otpCheck = await db.query(
      `SELECT id FROM otps
       WHERE email = $1 AND type = 'signup' AND verified_at IS NOT NULL
         AND verified_at > NOW() - INTERVAL '30 minutes'
       ORDER BY id DESC LIMIT 1`,
      [email]
    );
    if (!otpCheck.rows[0]) {
      return res.status(403).json({ error: 'Please verify your email OTP before creating an account' });
    }

    const checkName = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (checkName.rows[0]) return res.status(400).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const role = username === ADMIN_USERNAME ? 'admin' : 'user';

    const created = await db.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified, display_name)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       RETURNING id, username, email, role, display_name, avatar_url, bio, created_at`,
      [username, hash, role, email, username]
    );
    const user = created.rows[0];
    await ensureUserSettings(user.id);

    let deviceToken = null;
    if (rememberDevice) {
      deviceToken = crypto.randomBytes(32).toString('hex');
      await db.query(
        'INSERT INTO remembered_devices (user_id, device_token, user_agent) VALUES ($1, $2, $3)',
        [user.id, deviceToken, userAgent]
      );
    }

    // Consume remaining unused signup OTPs for this email
    await db.query(
      `UPDATE otps SET used = TRUE WHERE email = $1 AND type = 'signup' AND used = FALSE`,
      [email]
    );

    const token = jwt.sign({ id: Number(user.id), username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    // After creating account, ensure Announcements and possibly return an openAnnouncement hint
    let openAnnouncement = null;
    try {
      openAnnouncement = await ensureAnnouncementForUser(Number(user.id));
    } catch (e) {
      console.error('Failed to ensure announcement after register-complete:', e && e.message ? e.message : e);
    }

    res.json({ ...user, id: Number(user.id), token, deviceToken, openAnnouncement });
  } catch (err) {
    console.error('Register complete error:', err);
    if (err.code === '23505') return res.status(400).json({ error: 'Account already exists for this email/username' });
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Login with Password / Device Token
app.post('/api/auth/login', async (req, res) => {
  const emailOrUsername = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const rememberDevice = !!req.body?.rememberDevice;
  const userAgent = req.headers['user-agent'] || '';
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  // ── TEMP DIAGNOSTIC LOGGING — remove once the "Invalid credentials on one
  // device only" issue is confirmed fixed. Never logs the password. This is
  // what lets us tell, from Render's logs, whether a given login attempt
  // ever reached the backend at all, and if so, exactly why it was accepted
  // or rejected.
  console.log('[LOGIN DEBUG] Incoming attempt', { emailOrUsername, hasPassword: !!password, rememberDevice, userAgent, clientIp, at: new Date().toISOString() });

  if (!emailOrUsername || !password) {
    console.log('[LOGIN DEBUG] Rejected: missing email/username or password');
    return res.status(400).json({ error: 'Email/username and password required' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE LOWER(COALESCE(email, \'\')) = $1 OR LOWER(username) = $1',
      [emailOrUsername]
    );
    const user = rows[0];
    if (!user) {
      console.log('[LOGIN DEBUG] Rejected: no user found for', emailOrUsername);
      return res.status(400).json({ error: 'No account found' });
    }
    if (user.banned) {
      console.log('[LOGIN DEBUG] Rejected: account banned, user id', user.id);
      return res.status(403).json({ error: 'Account is banned' });
    }
    if (!user.email_verified && user.email) {
      console.log('[LOGIN DEBUG] Rejected: email not verified, user id', user.id);
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      console.log('[LOGIN DEBUG] Rejected: password mismatch, user id', user.id);
      return res.status(400).json({ error: 'Invalid password' });
    }

    console.log('[LOGIN DEBUG] Accepted, user id', user.id);

    let deviceToken = req.body?.deviceToken || null;
    if (rememberDevice) {
      deviceToken = crypto.randomBytes(32).toString('hex');
      await db.query(
        'INSERT INTO remembered_devices (user_id, device_token, user_agent) VALUES ($1, $2, $3)',
        [user.id, deviceToken, userAgent]
      );
    }

    await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    const role = user.username === ADMIN_USERNAME ? 'admin' : (user.role || 'user');
    const token = jwt.sign({ id: Number(user.id), username: user.username, role }, JWT_SECRET, { expiresIn: '30d' });

    // Ensure Announcements and maybe create the welcome announcement for first-time login
    let openAnnouncement = null;
    try {
      openAnnouncement = await ensureAnnouncementForUser(Number(user.id));
    } catch (e) {
      console.error('Failed to ensure announcement for login:', e && e.message ? e.message : e);
    }

    res.json({
      id: Number(user.id),
      username: user.username,
      display_name: user.display_name || user.username,
      email: user.email,
      bio: user.bio || '',
      avatar_url: user.avatar_url || null,
      role,
      token,
      deviceToken,
      openAnnouncement
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Forgot Password - Send Reset OTP
app.post('/api/auth/forgot-password/send-otp', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // Lookup user but DO NOT reveal existence to the client. We'll always return a generic success message.
    const userRes = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    const userExists = !!userRes.rows[0];

    // Rate-limit per-email: allow at most 5 OTPs per hour
    const recentCountRes = await db.query("SELECT COUNT(*)::int AS cnt FROM otps WHERE email = $1 AND type = 'reset_password' AND created_at > NOW() - INTERVAL '1 hour'", [email]);
    const recentCount = recentCountRes.rows[0]?.cnt || 0;
    if (recentCount >= 5) {
      // Respond generically without revealing whether the email exists
      return res.json({ ok: true, message: 'If an account exists, a reset OTP has been sent. Please try again later.' });
    }

    // Check last OTP to enforce 30s resend window
    const lastOtpRes = await db.query("SELECT created_at FROM otps WHERE email = $1 AND type = 'reset_password' ORDER BY id DESC LIMIT 1", [email]);
    const lastRow = lastOtpRes.rows[0];
    if (lastRow) {
      const lastCreated = new Date(lastRow.created_at);
      if (Date.now() - lastCreated.getTime() < 30 * 1000) {
        return res.json({ ok: true, message: 'If an account exists, a reset OTP has been sent. Please wait before requesting another.' });
      }
    }

    // If user exists, create and send OTP. If not, respond generically (no DB insert/send to avoid account enumeration).
    if (userExists) {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.query(
        "UPDATE otps SET used = TRUE WHERE email = $1 AND type = 'reset_password' AND used = FALSE",
        [email]
      );

      await db.query(
        'INSERT INTO otps (email, otp_code, type, expires_at) VALUES ($1, $2, $3, $4)',
        [email, otpCode, 'reset_password', expiresAt]
      );

      try {
        await sendEmailOTP(email, otpCode, 'reset_password');
      } catch (sendErr) {
        console.error('SendEmailOTP (reset) failed after DB insert:', sendErr && sendErr.message ? sendErr.message : sendErr);
        try {
          await db.query("DELETE FROM otps WHERE email = $1 AND otp_code = $2 AND type = 'reset_password'", [email, otpCode]);
        } catch (cleanupErr) {
          console.error('Failed to cleanup reset OTP after send failure:', cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
        }
        // Still return a generic message to the client
        return res.json({ ok: true, message: 'If an account exists, a reset OTP has been sent.' });
      }
    }

    // Generic response to avoid revealing whether the email exists
    res.json({ ok: true, message: 'If an account exists, a reset OTP has been sent.' });
  } catch (err) {
    console.error('Forgot password send OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot Password - Reset Password
app.post('/api/auth/forgot-password/reset', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const otpCode = String(req.body?.otpCode || '').trim();
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !otpCode || !newPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const { rows } = await db.query(
      'SELECT id, expires_at, used FROM otps WHERE email = $1 AND otp_code = $2 AND type = $3 ORDER BY id DESC LIMIT 1',
      [email, otpCode, 'reset_password']
    );
    const record = rows[0];

    if (!record) return res.status(400).json({ error: 'Invalid OTP code' });
    if (record.used) return res.status(400).json({ error: 'OTP code already used' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'OTP code has expired' });

    // Mark OTP used immediately to prevent reuse
    await db.query('UPDATE otps SET used = TRUE, verified_at = NOW() WHERE id = $1', [record.id]);

    // Hash and update password
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE LOWER(email) = $2', [hash, email]);

    // Invalidate any remaining reset OTPs for this email just in case
    await db.query("UPDATE otps SET used = TRUE WHERE email = $1 AND type = 'reset_password' AND used = FALSE", [email]);

    res.json({ ok: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Cleanup expired OTPs periodically
setInterval(async () => {
  try {
    const r = await db.query("DELETE FROM otps WHERE expires_at < NOW() - INTERVAL '1 minute'");
    if (r && r.rowCount) console.log('[OTP CLEANUP] Deleted expired OTPs:', r.rowCount);
  } catch (e) {
    console.error('[OTP CLEANUP] Failed:', e && e.message ? e.message : e);
  }
}, 10 * 60 * 1000); // run every 10 minutes

// ==================================================
// PROFILE SYSTEM & AVATARS
// ==================================================

// Get Profile Data
app.get('/api/profile/:userId', authenticateToken, async (req, res) => {
  const userId = req.params.userId;
  try {
    const { rows } = await db.query(
      'SELECT id, username, display_name, email, bio, avatar_url, role, created_at, last_seen FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const settingResult = await db.query('SELECT privacy_last_seen FROM user_settings WHERE user_id = $1', [user.id]);
    const privacy = settingResult.rows[0]?.privacy_last_seen || DEFAULT_USER_SETTINGS.privacy_last_seen;
    const isContact = Number(user.id) === Number(req.user.id) || !!(await db.query(
      'SELECT 1 FROM contacts WHERE user_id = $1 AND friend_id = $2', [user.id, req.user.id]
    )).rows[0];
    if (privacy === 'nobody' || (privacy === 'contacts' && !isContact)) user.last_seen = null;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Update Profile Details
app.put('/api/profile/update', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { username, display_name, bio, oldPassword, newPassword } = req.body || {};

  try {
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const currentUser = userRes.rows[0];
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    let updatedHash = currentUser.password_hash;
    if (newPassword) {
      if (!oldPassword) return res.status(400).json({ error: 'Current password is required to change password' });
      const valid = await bcrypt.compare(oldPassword, currentUser.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      updatedHash = await bcrypt.hash(newPassword, 10);
    }

    if (username && username !== currentUser.username) {
      const nameCheck = await db.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, userId]);
      if (nameCheck.rows[0]) return res.status(400).json({ error: 'Username already taken' });
    }

    const nextUsername = username ? username.trim() : currentUser.username;
    const nextDisplayName = display_name ? display_name.trim() : (currentUser.display_name || currentUser.username);
    const nextBio = bio !== undefined ? bio.trim() : (currentUser.bio || '');

    const updated = await db.query(
      `UPDATE users
       SET username = $1, display_name = $2, bio = $3, password_hash = $4
       WHERE id = $5
       RETURNING id, username, display_name, email, bio, avatar_url, role, created_at`,
      [nextUsername, nextDisplayName, nextBio, updatedHash, userId]
    );

    const row = updated.rows[0];
    const newToken = jwt.sign({ id: Number(row.id), username: row.username, role: row.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ...row, id: Number(row.id), token: newToken });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Upload Profile Picture
app.post('/api/profile/avatar', authenticateToken, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return handleUploadErrors(err, req, res, next);
    return next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const filename = await saveUploadedFile(req.file);
    const avatarUrl = `${baseUrl}/uploads/${filename}`;
    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user.id]);
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    console.error('Save avatar error:', err);
    res.status(500).json({ error: 'Failed to save avatar' });
  }
});

// Delete Profile Picture
app.delete('/api/profile/avatar', authenticateToken, async (req, res) => {
  try {
    await db.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// ==================================================
// CHAT FEATURES & MESSAGE OPTIONS
// ==================================================

// Edit Message Content
app.put('/api/messages/:id/edit', authenticateToken, async (req, res) => {
  const messageId = Number(req.params.id);
  const newContent = String(req.body?.content || '').trim();
  if (!newContent) return res.status(400).json({ error: 'Content required' });

  try {
    const msgRes = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const msg = msgRes.rows[0];
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (Number(msg.sender_id) !== Number(req.user.id)) return res.status(403).json({ error: 'You can only edit your own messages' });

    await db.query('UPDATE messages SET content = $1, edited = TRUE WHERE id = $2', [newContent, messageId]);

    const payload = { messageId, content: newContent, edited: true };
    if (msg.group_id) {
      io.to(`group_${msg.group_id}`).emit('message_edited', payload);
    } else {
      io.to(`user_${msg.sender_id}`).emit('message_edited', payload);
      io.to(`user_${msg.receiver_id}`).emit('message_edited', payload);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete Message (Delete for me / Delete for everyone)
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  const messageId = Number(req.params.id);
  const forEveryone = req.query.forEveryone === 'true';
  const userId = req.user.id;

  try {
    const msgRes = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const msg = msgRes.rows[0];
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    if (forEveryone) {
      if (Number(msg.sender_id) !== Number(userId)) return res.status(403).json({ error: 'Only sender can delete for everyone' });
      await db.query("UPDATE messages SET content = 'This message was deleted', deleted_for_everyone = TRUE, image_url = NULL WHERE id = $1", [messageId]);

      const payload = { messageId, deletedForEveryone: true };
      if (msg.group_id) {
        io.to(`group_${msg.group_id}`).emit('message_deleted', payload);
      } else {
        io.to(`user_${msg.sender_id}`).emit('message_deleted', payload);
        io.to(`user_${msg.receiver_id}`).emit('message_deleted', payload);
      }
    } else {
      await db.query(
        "UPDATE messages SET deleted_by_users = array_append(deleted_by_users, $1) WHERE id = $2 AND NOT ($1 = ANY(deleted_by_users))",
        [userId, messageId]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Star / Unstar Message
app.post('/api/messages/:id/star', authenticateToken, async (req, res) => {
  const messageId = Number(req.params.id);
  const userId = req.user.id;

  try {
    const existing = await db.query('SELECT 1 FROM starred_messages WHERE user_id = $1 AND message_id = $2', [userId, messageId]);
    if (existing.rows[0]) {
      await db.query('DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2', [userId, messageId]);
      res.json({ ok: true, starred: false });
    } else {
      await db.query('INSERT INTO starred_messages (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, messageId]);
      res.json({ ok: true, starred: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to star message' });
  }
});

// Get Starred Messages
app.get('/api/messages/starred/:userId', authenticateToken, async (req, res) => {
  const userId = Number(req.params.userId);
  if (Number(req.user.id) !== userId) {
    return res.status(403).json({ error: 'Cannot view another user\'s starred messages' });
  }
  try {
    const { rows } = await db.query(
      `SELECT m.*, sm.starred_at, su.username as sender_username
       FROM starred_messages sm
       JOIN messages m ON sm.message_id = m.id
       LEFT JOIN users su ON su.id = m.sender_id
       WHERE sm.user_id = $1
       ORDER BY sm.starred_at DESC`,
      [userId]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch starred messages' });
  }
});

// Pin / Unpin Message
app.post('/api/messages/:id/pin', authenticateToken, async (req, res) => {
  const messageId = Number(req.params.id);
  let { chatType, chatTargetId } = req.body; // chatType: 'direct' | 'group'
  if (!chatType || !chatTargetId) return res.status(400).json({ error: 'chatType and chatTargetId required' });

  try {
    const msgRes = await db.query('SELECT sender_id, receiver_id, group_id FROM messages WHERE id = $1', [messageId]);
    const msg = msgRes.rows[0];
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    // Canonicalize direct chat target so both participants share the same pin row
    let notifyUserIds = [];
    if (chatType === 'direct') {
      const a = Number(req.user.id);
      const b = Number(chatTargetId);
      chatTargetId = Math.min(a, b);
      notifyUserIds = [a, b];
    } else {
      chatTargetId = Number(chatTargetId);
    }

    const existing = await db.query(
      'SELECT id FROM pinned_messages WHERE chat_type = $1 AND chat_target_id = $2 AND message_id = $3',
      [chatType, chatTargetId, messageId]
    );

    if (existing.rows[0]) {
      await db.query('DELETE FROM pinned_messages WHERE id = $1', [existing.rows[0].id]);
      const payload = { chatType, chatTargetId, messageId, pinned: false };
      if (chatType === 'group') io.to(`group_${chatTargetId}`).emit('pin_updated', payload);
      else notifyUserIds.forEach((uid) => io.to(`user_${uid}`).emit('pin_updated', payload));
      res.json({ ok: true, pinned: false });
    } else {
      await db.query(
        'INSERT INTO pinned_messages (chat_type, chat_target_id, message_id, pinned_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [chatType, chatTargetId, messageId, req.user.id]
      );
      const payload = { chatType, chatTargetId, messageId, pinned: true };
      if (chatType === 'group') io.to(`group_${chatTargetId}`).emit('pin_updated', payload);
      else notifyUserIds.forEach((uid) => io.to(`user_${uid}`).emit('pin_updated', payload));
      res.json({ ok: true, pinned: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

// Get Pinned Messages
app.get('/api/messages/pinned/:chatType/:chatTargetId', authenticateToken, async (req, res) => {
  const { chatType } = req.params;
  let chatTargetId = Number(req.params.chatTargetId);
  try {
    // For DMs, canonicalize to min(self, peer) so both sides see the same pins
    if (chatType === 'direct') {
      chatTargetId = Math.min(Number(req.user.id), chatTargetId);
    }
    const { rows } = await db.query(
      `SELECT m.*, pm.pinned_at, su.username as sender_username
       FROM pinned_messages pm
       JOIN messages m ON pm.message_id = m.id
       LEFT JOIN users su ON su.id = m.sender_id
       WHERE pm.chat_type = $1 AND pm.chat_target_id = $2
       ORDER BY pm.pinned_at DESC`,
      [chatType, chatTargetId]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pinned messages' });
  }
});

// ==================================================
// GROUP CHAT MANAGEMENT
// ==================================================

// Update Group Details (Name, Description, Avatar)
app.put('/api/groups/:groupId', authenticateToken, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) return handleUploadErrors(err, req, res, next);
    return next();
  });
}, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const { name, description } = req.body || {};

  try {
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );
    if (!memberCheck.rows[0]) return res.status(403).json({ error: 'Not a group member' });

    let avatarUrl = null;
    if (req.file) {
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const filename = await saveUploadedFile(req.file);
      avatarUrl = `${baseUrl}/uploads/${filename}`;
    }

    const { rows } = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const g = rows[0];
    if (!g) return res.status(404).json({ error: 'Group not found' });

    const newName = name ? name.trim() : g.name;
    const newDesc = description !== undefined ? description.trim() : (g.description || '');
    const newAvatar = avatarUrl || g.avatar_url;

    const updated = await db.query(
      'UPDATE groups SET name = $1, description = $2, avatar_url = $3 WHERE id = $4 RETURNING *',
      [newName, newDesc, newAvatar, groupId]
    );

    const groupPayload = { ...updated.rows[0], is_group: true };
    io.to(`group_${groupId}`).emit('group_updated', groupPayload);
    res.json(groupPayload);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Add Member to Group
app.post('/api/groups/:groupId/members', authenticateToken, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );
    if (!memberCheck.rows[0]) return res.status(403).json({ error: 'Not a group member' });

    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, userId]);

    const groupRes = await db.query('SELECT id, name, description, avatar_url FROM groups WHERE id = $1', [groupId]);
    const group = groupRes.rows[0];
    if (group) {
      io.to(`user_${userId}`).emit('added_to_group', {
        groupId,
        group: { ...group, is_group: true }
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Remove Member / Leave Group
app.delete('/api/groups/:groupId/members/:userId', authenticateToken, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const userId = Number(req.params.userId);

  try {
    // Users may leave themselves, or a member may remove others if they are the creator
    if (Number(req.user.id) !== userId) {
      const g = await db.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
      if (!g.rows[0] || Number(g.rows[0].created_by) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Only the group creator can remove other members' });
      }
    }
    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    io.to(`user_${userId}`).emit('removed_from_group', { groupId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Delete Group
app.delete('/api/groups/:groupId', authenticateToken, async (req, res) => {
  const groupId = Number(req.params.groupId);
  try {
    const g = await db.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Group not found' });
    if (Number(g.rows[0].created_by) !== Number(req.user.id) && req.user.role !== 'admin' && req.user.username !== ADMIN_USERNAME) {
      return res.status(403).json({ error: 'Only the group creator can delete the group' });
    }

    const members = await db.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
    await db.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
    await db.query('DELETE FROM messages WHERE group_id = $1', [groupId]);
    await db.query('DELETE FROM groups WHERE id = $1', [groupId]);
    (members.rows || []).forEach((m) => {
      io.to(`user_${m.user_id}`).emit('removed_from_group', { groupId });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// Get Group Members
app.get('/api/groups/:groupId/members', authenticateToken, async (req, res) => {
  const groupId = Number(req.params.groupId);
  try {
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );
    if (!memberCheck.rows[0]) return res.status(403).json({ error: 'Not a group member' });

    const { rows } = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.username ASC`,
      [groupId]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// ==================================================
// USER SETTINGS
// ==================================================

app.get('/api/settings/user', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    res.json(await ensureUserSettings(userId));
  } catch (err) {
    console.error('Get user settings error:', err);
    res.status(500).json({ error: 'Unable to load settings. Please try again.' });
  }
});

app.put('/api/settings/user', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const {
    theme, accent_color, notification_sounds, wallpaper, privacy_last_seen,
    privacy_profile_visibility, read_receipts, typing_indicator, online_status_visibility,
    message_notifications, group_notifications, friend_request_notifications,
    notification_preview, vibration, font_size, chat_density, message_animations, ui_animations,
  } = req.body || {};

  const validThemes = new Set(['dark', 'light', 'system']);
  const validWallpapers = new Set(['default', 'minimal', 'soft', 'custom']);
  const validPrivacy = new Set(['everyone', 'contacts', 'nobody']);
  const validPreview = new Set(['show', 'hide', 'hide_completely']);
  const validFontSize = new Set(['small', 'medium', 'large']);
  const validDensity = new Set(['compact', 'comfortable']);

  if (theme !== undefined && !validThemes.has(theme)) return res.status(400).json({ error: 'Theme must be dark, light, or system.' });
  if (accent_color !== undefined && (typeof accent_color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(accent_color))) return res.status(400).json({ error: 'Accent color must be a six-digit hex color.' });
  if (notification_sounds !== undefined && typeof notification_sounds !== 'boolean') return res.status(400).json({ error: 'Notification sounds must be true or false.' });
  if (wallpaper !== undefined && !validWallpapers.has(wallpaper)) return res.status(400).json({ error: 'Wallpaper selection is invalid.' });
  if (privacy_last_seen !== undefined && !validPrivacy.has(privacy_last_seen)) return res.status(400).json({ error: 'Last seen privacy selection is invalid.' });
  if (privacy_profile_visibility !== undefined && !validPrivacy.has(privacy_profile_visibility)) return res.status(400).json({ error: 'Profile privacy selection is invalid.' });
  if (read_receipts !== undefined && typeof read_receipts !== 'boolean') return res.status(400).json({ error: 'Read receipts must be true or false.' });
  if (typing_indicator !== undefined && typeof typing_indicator !== 'boolean') return res.status(400).json({ error: 'Typing indicator must be true or false.' });
  if (online_status_visibility !== undefined && typeof online_status_visibility !== 'boolean') return res.status(400).json({ error: 'Online status visibility must be true or false.' });
  if (message_notifications !== undefined && typeof message_notifications !== 'boolean') return res.status(400).json({ error: 'Message notifications must be true or false.' });
  if (group_notifications !== undefined && typeof group_notifications !== 'boolean') return res.status(400).json({ error: 'Group notifications must be true or false.' });
  if (friend_request_notifications !== undefined && typeof friend_request_notifications !== 'boolean') return res.status(400).json({ error: 'Friend request notifications must be true or false.' });
  if (notification_preview !== undefined && !validPreview.has(notification_preview)) return res.status(400).json({ error: 'Notification preview selection is invalid.' });
  if (vibration !== undefined && typeof vibration !== 'boolean') return res.status(400).json({ error: 'Vibration must be true or false.' });
  if (font_size !== undefined && !validFontSize.has(font_size)) return res.status(400).json({ error: 'Font size must be small, medium, or large.' });
  if (chat_density !== undefined && !validDensity.has(chat_density)) return res.status(400).json({ error: 'Chat density must be compact or comfortable.' });
  if (message_animations !== undefined && typeof message_animations !== 'boolean') return res.status(400).json({ error: 'Message animations must be true or false.' });
  if (ui_animations !== undefined && typeof ui_animations !== 'boolean') return res.status(400).json({ error: 'UI animations must be true or false.' });

  try {
    const { rows } = await db.query(
      `INSERT INTO user_settings (
         user_id, theme, accent_color, notification_sounds, wallpaper, privacy_last_seen,
         privacy_profile_visibility, read_receipts, typing_indicator, online_status_visibility,
         message_notifications, group_notifications, friend_request_notifications,
         notification_preview, vibration, font_size, chat_density, message_animations, ui_animations
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (user_id) DO UPDATE SET
         theme = COALESCE($2, user_settings.theme),
         accent_color = COALESCE($3, user_settings.accent_color),
         notification_sounds = COALESCE($4, user_settings.notification_sounds),
         wallpaper = COALESCE($5, user_settings.wallpaper),
         privacy_last_seen = COALESCE($6, user_settings.privacy_last_seen),
         privacy_profile_visibility = COALESCE($7, user_settings.privacy_profile_visibility),
         read_receipts = COALESCE($8, user_settings.read_receipts),
         typing_indicator = COALESCE($9, user_settings.typing_indicator),
         online_status_visibility = COALESCE($10, user_settings.online_status_visibility),
         message_notifications = COALESCE($11, user_settings.message_notifications),
         group_notifications = COALESCE($12, user_settings.group_notifications),
         friend_request_notifications = COALESCE($13, user_settings.friend_request_notifications),
         notification_preview = COALESCE($14, user_settings.notification_preview),
         vibration = COALESCE($15, user_settings.vibration),
         font_size = COALESCE($16, user_settings.font_size),
         chat_density = COALESCE($17, user_settings.chat_density),
         message_animations = COALESCE($18, user_settings.message_animations),
         ui_animations = COALESCE($19, user_settings.ui_animations)
       RETURNING ${USER_SETTINGS_COLUMNS.join(', ')}`,
      [
        userId, theme, accent_color, notification_sounds, wallpaper, privacy_last_seen,
        privacy_profile_visibility, read_receipts, typing_indicator, online_status_visibility,
        message_notifications, group_notifications, friend_request_notifications,
        notification_preview, vibration, font_size, chat_density, message_animations, ui_animations,
      ]
    );
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error('Save user settings error:', err);
    res.status(500).json({ error: 'Unable to save settings. Please try again.' });
  }
});

// ==================================================
// PUSH NOTIFICATION DEVICE TOKENS (FCM)
// ==================================================

// Registers or refreshes this device's FCM token for the current user.
// A user can have multiple devices; the token itself is unique per
// app-install, so re-registering the same token (app restart, token
// refresh, or a different account signing into the same physical device)
// simply reassigns/reactivates the existing row instead of duplicating it.
app.post('/api/devices/register', authenticateToken, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    const plat = (platform === 'ios' || platform === 'web') ? platform : 'android';
    // Safe diagnostic: was there already a DIFFERENT active token on file
    // for this user (e.g. a stale pre-reinstall token)? Token values
    // themselves are never logged — only counts/ages.
    const existing = await db.query(
      "SELECT token, created_at FROM device_tokens WHERE user_id = $1 AND platform = $2 AND active = TRUE",
      [req.user.id, plat]
    );
    const isNewToken = !existing.rows.some(r => r.token === token);
    await db.query(
      `INSERT INTO device_tokens (user_id, token, platform, active, updated_at)
       VALUES ($1, $2, $3, TRUE, NOW())
       ON CONFLICT (token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform,
         active = TRUE,
         updated_at = NOW()`,
      [req.user.id, token, plat]
    );
    console.log(`[push] POST /devices/register user=${req.user.id} platform=${plat} status=200 newToken=${isNewToken} priorActiveTokensForUser=${existing.rows.length}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[push] Device register error user=${req.user?.id}:`, err.message);
    console.log(`[push] POST /devices/register user=${req.user?.id} status=500`);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Unregisters this device's token, e.g. on logout — so a shared/borrowed
// device stops receiving push notifications for an account nobody is
// signed into anymore. Scoped to the current user so one account can never
// remove another account's token for the same device.
app.post('/api/devices/unregister', authenticateToken, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    await db.query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
    console.log(`[push] POST /devices/unregister user=${req.user.id} status=200`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[push] Device unregister error user=${req.user?.id}:`, err.message);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

// Sends a real FCM push to the calling user's own registered devices,
// through the exact same push.sendToUser() code path as a real message —
// this is what the "Test Notification" button in Settings calls, so a
// success here means the whole pipeline (permission, token, backend,
// Firebase, device channel, sound, vibration) is actually working end to
// end, not just that the button was clicked. Intentionally bypasses the
// message/group/friend-request toggles (this is an explicit request to be
// notified right now) but still honors sound/vibration/preview so those
// specific settings can be verified too.
app.post('/api/devices/test-push', authenticateToken, async (req, res) => {
  try {
    const prefs = await getNotificationPrefs(req.user.id);
    const preview = applyPreviewPreference(prefs.notification_preview, 'Aerio', 'Test notification — this is what your pushes look like.');
    await push.sendToUser(req.user.id, {
      title: preview.title,
      body: preview.body,
      sound: prefs.notification_sounds,
      vibration: prefs.vibration,
      data: { type: 'test' },
    });
    res.json({ ok: true, configured: push.isConfigured() });
  } catch (err) {
    console.error('[push] test-push error:', err.message);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Public Settings & Info
app.get('/api/settings/public', async (req, res) => {
  try {
    res.json({
      maintenance_mode: (await getSettingAsync('maintenance_mode', 'false')) === 'true',
      invite_only: (await getSettingAsync('invite_only', 'false')) === 'true',
      welcome_message: await getSettingAsync('welcome_message', 'Welcome to Aerio')
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.get('/api/system/info', authenticateToken, (req, res) => {
  if (!systemUser) return res.status(500).json({ error: 'System user not available' });
  res.json({ id: Number(systemUser.id), username: systemUser.username });
});

// Get Contacts
// ── E2EE: public key directory (Phase 1 — direct messages) ──────────────
// Publishing/reading a PUBLIC key here is safe by design: it's only useful
// for encrypting a message TO this user, never for decrypting messages
// FROM this user or anyone else. The matching private key never reaches
// this server in any request handler, anywhere in this file.
// Publish/republish THIS device's key. Requires a persistent, per-
// installation `deviceId` from the client (see crypto.js getOrCreateDeviceId).
// Upserts by (device_id, user_id) — this is the actual multi-device fix:
// a second device for the same account gets its OWN row and can never
// overwrite the first device's row.
app.post('/api/keys/publish', authenticateToken, async (req, res) => {
  const { publicKey, deviceId, platform } = req.body || {};
  if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 200) {
    return res.status(400).json({ error: 'A valid publicKey is required' });
  }
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 200) {
    return res.status(400).json({ error: 'A valid deviceId is required' });
  }
  const safePlatform = (typeof platform === 'string' && ['web', 'android'].includes(platform)) ? platform : 'web';
  try {
    const { rows } = await db.query(
      'SELECT public_key FROM device_keys WHERE device_id = $1 AND user_id = $2',
      [deviceId, req.user.id]
    );
    const existing = rows[0] ? rows[0].public_key : null;
    const rotated = !!existing && existing !== publicKey;

    await db.query(
      `INSERT INTO device_keys (device_id, user_id, public_key, platform, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (device_id, user_id)
       DO UPDATE SET public_key = EXCLUDED.public_key, platform = EXCLUDED.platform, updated_at = NOW()`,
      [deviceId, req.user.id, publicKey, safePlatform]
    );

    // Also keep the legacy single-key column loosely in sync so any client
    // still on the old contract (pre-multi-device) has *something* to read
    // during a staged rollout. Never treated as authoritative by new code.
    await db.query('UPDATE users SET public_key = $1 WHERE id = $2', [publicKey, req.user.id]).catch(() => {});

    // Safe to log: user id, device id, rotated flag. Never key material.
    if (rotated) console.log(`[e2ee] public key rotated for user=${req.user.id} device=${deviceId}`);
    console.log(`[e2ee] POST /keys/publish user=${req.user.id} device=${deviceId} platform=${safePlatform} status=200 rotated=${rotated}`);
    return res.json({ ok: true, deviceId, rotated });
  } catch (err) {
    console.error(`[e2ee] Failed to publish key for user=${req.user.id} device=${deviceId}:`, err.message);
    console.log(`[e2ee] POST /keys/publish user=${req.user.id} device=${deviceId} status=500`);
    return res.status(500).json({ error: 'Failed to publish key' });
  }
});

// Returns every device this user has published a key from — the client
// fans out encryption to all of them. `legacyPublicKey` is included only
// as a fallback for decrypting pre-migration messages that still carry
// the old single ciphertext/nonce shape.
app.get('/api/keys/:userId', authenticateToken, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid userId' });
  try {
    const [userRow, deviceRows] = await Promise.all([
      db.query('SELECT public_key FROM users WHERE id = $1', [userId]),
      db.query('SELECT device_id, public_key, platform FROM device_keys WHERE user_id = $1 ORDER BY updated_at DESC', [userId]),
    ]);
    if (!userRow.rows[0]) {
      console.log(`[e2ee] GET /keys/${userId} requestedBy=${req.user.id} status=404`);
      return res.status(404).json({ error: 'User not found' });
    }
    const devices = (deviceRows.rows || []).map(r => ({
      deviceId: r.device_id,
      publicKey: r.public_key,
      platform: r.platform,
    }));
    console.log(`[e2ee] GET /keys/${userId} requestedBy=${req.user.id} status=200 deviceCount=${devices.length}`);
    res.json({
      userId,
      devices,
      legacyPublicKey: userRow.rows[0].public_key || null,
    });
  } catch (err) {
    console.log(`[e2ee] GET /keys/${userId} requestedBy=${req.user.id} status=500`);
    return res.status(500).json({ error: 'Failed to fetch key' });
  }
});

app.get('/api/contacts/:userId', authenticateToken, async (req, res) => {
  const userId = Number(req.params.userId);
  if (Number(req.user.id) !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const query = `
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio,
      CASE WHEN COALESCE(s.privacy_last_seen, 'everyone') IN ('everyone', 'contacts')
        THEN u.last_seen ELSE NULL END AS last_seen,
      (
        SELECT MAX(m.timestamp) FROM messages m
        WHERE (m.sender_id = $1 AND m.receiver_id = u.id)
           OR (m.sender_id = u.id AND m.receiver_id = $1)
      ) AS last_message_at
    FROM contacts c
    JOIN users u ON c.friend_id = u.id
    LEFT JOIN user_settings s ON s.user_id = u.id
    WHERE c.user_id = $1
    ORDER BY last_message_at DESC NULLS LAST, u.username ASC
  `;
  try {
    const { rows } = await db.query(query, [userId]);
    const withOnline = (rows || []).map(r => ({ ...r, online: isUserOnline(r.id) }));
    res.json(withOnline);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Search users to add as contacts
app.get('/api/users/search', authenticateToken, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json([]);

  try {
    const { rows } = await db.query(
      `SELECT id, username, display_name, avatar_url
       FROM users
       WHERE id <> $1
         AND username <> '__system__'
         AND (username ILIKE $2 OR COALESCE(display_name, '') ILIKE $2)
       ORDER BY CASE WHEN LOWER(username) = LOWER($3) THEN 0 ELSE 1 END, username ASC
       LIMIT 20`,
      [req.user.id, `%${query}%`, query]
    );
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Add Friend Request
app.post('/api/contacts/add', authenticateToken, async (req, res) => {
  const userId = Number(req.user.id);
  const friendUsername = String(req.body?.friendUsername || '').trim();
  if (!friendUsername) return res.status(400).json({ error: 'friendUsername required' });
  try {
    const friendRes = await db.query('SELECT id, username FROM users WHERE username = $1', [friendUsername]);
    const friend = friendRes.rows[0];
    if (!friend) return res.status(404).json({ error: 'User not found' });
    if (Number(friend.id) === userId) return res.status(400).json({ error: 'Cannot add yourself' });

    const isFriend = await db.query('SELECT 1 FROM contacts WHERE user_id = $1 AND friend_id = $2', [userId, friend.id]);
    if (isFriend.rows[0]) return res.status(400).json({ error: 'Already friends' });

    try {
      await db.query('INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2)', [userId, friend.id]);
    } catch (e) {
      if (String(e?.code) === '23505') return res.status(400).json({ error: 'Request already sent' });
      throw e;
    }

    io.to(`user_${friend.id}`).emit('new_friend_request', { sender_id: userId });
    res.json({ message: 'Friend request sent' });

    // FCM push (Android background/closed) — fires after the response is
    // already sent, same fire-and-forget pattern as message push dispatch
    // above. A push failure here can never fail the friend request itself.
    (async () => {
      try {
        const prefs = await getNotificationPrefs(friend.id);
        if (!prefs.friend_request_notifications) return;
        const senderRow = await db.query('SELECT username, display_name FROM users WHERE id = $1', [userId]);
        const senderName = senderRow.rows[0]?.display_name || senderRow.rows[0]?.username || 'Someone';
        const preview = applyPreviewPreference(prefs.notification_preview, 'Aerio', `${senderName} sent you a friend request`);
        await push.sendToUser(friend.id, {
          title: preview.title,
          body: preview.body,
          sound: prefs.notification_sounds,
          vibration: prefs.vibration,
          data: { type: 'friend_request', senderId: String(userId) },
        });
      } catch (err) {
        console.error('Friend request push dispatch failed:', err.message);
      }
    })();
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get Friend Requests
app.get('/api/contacts/requests/:userId', authenticateToken, async (req, res) => {
  const userId = Number(req.params.userId);
  if (Number(req.user.id) !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await db.query(`
      SELECT fr.id as request_id, u.id as sender_id, u.username as sender_username, u.display_name, u.avatar_url 
      FROM friend_requests fr 
      JOIN users u ON fr.sender_id = u.id 
      WHERE fr.receiver_id = $1 AND fr.status = 'pending'
    `, [userId]);
    res.json(rows || []);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Respond to Request
app.post('/api/contacts/requests/respond', authenticateToken, async (req, res) => {
  const { requestId, status } = req.body;
  const client = await db.pool.connect();
  try {
    const reqRes = await client.query('SELECT * FROM friend_requests WHERE id = $1', [requestId]);
    const reqRow = reqRes.rows[0];
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    if (Number(reqRow.receiver_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Not authorized to respond to this request' });
    }

    if (status === 'accepted') {
      await client.query('BEGIN');
      await client.query('INSERT INTO contacts (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reqRow.sender_id, reqRow.receiver_id]);
      await client.query('INSERT INTO contacts (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reqRow.receiver_id, reqRow.sender_id]);
      await client.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['accepted', requestId]);
      // Clear any reciprocal pending request between the same pair
      await client.query(
        `UPDATE friend_requests SET status = 'accepted'
         WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
           AND status = 'pending'`,
        [reqRow.sender_id, reqRow.receiver_id]
      );
      await client.query('COMMIT');

      io.to(`user_${reqRow.sender_id}`).emit('friend_request_accepted', { new_friend_id: reqRow.receiver_id });
      const friendRes = await client.query('SELECT id, username, display_name, avatar_url FROM users WHERE id = $1', [reqRow.sender_id]);
      res.json({ success: true, newContact: friendRes.rows[0] });
    } else {
      await client.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['rejected', requestId]);
      res.json({ success: true });
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    return res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Create Group
app.post('/api/groups/create', authenticateToken, async (req, res) => {
  const { name, memberIds, description } = req.body;
  const creatorId = Number(req.user.id);
  if (!name || !memberIds || !memberIds.length) {
    return res.status(400).json({ error: 'Missing required group fields' });
  }
  if (String(name).trim().toLowerCase() === ANNOUNCEMENTS_GROUP_NAME.toLowerCase()) {
    return res.status(400).json({ error: '"Announcements" is a reserved channel name.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO groups (name, created_by, description) VALUES ($1, $2, $3) RETURNING id, name, description, avatar_url',
      [name, creatorId, description || '']
    );
    const groupId = Number(created.rows[0].id);

    const allMembers = Array.from(new Set([...(memberIds || []).map(Number), creatorId]));
    for (const uid of allMembers) {
      await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, uid]);
    }

    await client.query('COMMIT');

    // Notify newly added members so they join the socket room / refresh groups
    for (const uid of allMembers) {
      if (uid === creatorId) continue;
      io.to(`user_${uid}`).emit('added_to_group', { groupId, group: { id: groupId, name, description: description || '', avatar_url: null, is_group: true } });
    }

    res.json({ id: groupId, name, description: description || '', avatar_url: null, is_group: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    return res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
});

// Get Groups
app.get('/api/groups/:userId', authenticateToken, async (req, res) => {
  const userId = Number(req.params.userId);
  if (Number(req.user.id) !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const query = `
    SELECT g.id, g.name, g.description, g.avatar_url, g.created_by,
      (SELECT MAX(m.timestamp) FROM messages m WHERE m.group_id = g.id) AS last_message_at
    FROM group_members gm
    JOIN groups g ON gm.group_id = g.id
    WHERE gm.user_id = $1
    ORDER BY last_message_at DESC NULLS LAST, g.name ASC
  `;
  try {
    const { rows } = await db.query(query, [userId]);
    const mapped = (rows || []).map(r => ({ ...r, is_group: true }));
    res.json(mapped);
  } catch (err) {
    return res.status(500).json({ error: 'Database error fetch groups' });
  }
});

// Upload Generic Chat File
// ==================================================
// GIF SEARCH (Klipy — Tenor-compatible proxy)
// ==================================================
// Google fully shut down the Tenor API on June 30, 2026 (it stopped taking
// new sign-ups back in January 2026), so this uses Klipy instead — Klipy
// built a Tenor-compatible endpoint specifically for this migration, so the
// request/response shape below is unchanged from the original Tenor
// integration; only the host and the key env var name changed.
// Get a free key at https://partner.klipy.com (sign up -> API Keys ->
// "Add Platform"), then set KLIPY_API_KEY in backend/.env.
const KLIPY_API_KEY = process.env.KLIPY_API_KEY;
const KLIPY_CLIENT_KEY = 'aerio_chat';
const KLIPY_BASE_URL = 'https://api.klipy.com/v2';

function gifNotConfigured(res) {
  return res.status(501).json({
    error: 'GIF search is not configured on this server. Set KLIPY_API_KEY in backend/.env to enable it (free key at partner.klipy.com).'
  });
}

function mapTenorResults(results) {
  return (results || []).map(r => {
    const media = r.media_formats || {};
    return {
      id: r.id,
      title: r.content_description || r.title || '',
      url: media.gif?.url || media.mediumgif?.url || media.tinygif?.url || '',
      preview_url: media.tinygif?.url || media.nanogif?.url || media.gif?.url || '',
      width: media.gif?.dims?.[0] || media.tinygif?.dims?.[0] || null,
      height: media.gif?.dims?.[1] || media.tinygif?.dims?.[1] || null,
    };
  }).filter(g => g.url);
}

app.get('/api/gif/search', authenticateToken, async (req, res) => {
  if (!KLIPY_API_KEY) return gifNotConfigured(res);
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const pos = req.query.pos ? String(req.query.pos) : '';

  try {
    const url = `${KLIPY_BASE_URL}/search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(KLIPY_API_KEY)}&client_key=${KLIPY_CLIENT_KEY}&limit=${limit}&media_filter=gif,tinygif,mediumgif,nanogif&contentfilter=medium${pos ? `&pos=${encodeURIComponent(pos)}` : ''}`;
    const gifRes = await fetch(url);
    if (!gifRes.ok) throw new Error(`Klipy responded with ${gifRes.status}`);
    const data = await gifRes.json();
    res.json({ results: mapTenorResults(data.results), next: data.next || null });
  } catch (err) {
    console.error('GIF search error:', err.message);
    res.status(502).json({ error: 'Failed to reach GIF provider' });
  }
});

app.get('/api/gif/trending', authenticateToken, async (req, res) => {
  if (!KLIPY_API_KEY) return gifNotConfigured(res);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const pos = req.query.pos ? String(req.query.pos) : '';

  try {
    const url = `${KLIPY_BASE_URL}/featured?key=${encodeURIComponent(KLIPY_API_KEY)}&client_key=${KLIPY_CLIENT_KEY}&limit=${limit}&media_filter=gif,tinygif,mediumgif,nanogif&contentfilter=medium${pos ? `&pos=${encodeURIComponent(pos)}` : ''}`;
    const gifRes = await fetch(url);
    if (!gifRes.ok) throw new Error(`Klipy responded with ${gifRes.status}`);
    const data = await gifRes.json();
    res.json({ results: mapTenorResults(data.results), next: data.next || null });
  } catch (err) {
    console.error('GIF trending error:', err.message);
    res.status(502).json({ error: 'Failed to reach GIF provider' });
  }
});

app.post('/api/upload', authenticateToken, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return handleUploadErrors(err, req, res, next);
    return next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const filename = await saveUploadedFile(req.file);
    res.json({ url: `${baseUrl}/uploads/${filename}` });
  } catch (err) {
    console.error('Save uploaded file error:', err);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

// Get Messages
app.get('/api/messages/:userId/:friendOrGroupId', authenticateToken, async (req, res) => {
  const { userId, friendOrGroupId } = req.params;
  const isGroup = req.query.isGroup === 'true';

  if (Number(req.user.id) !== Number(userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  let query, params;
  if (isGroup) {
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [friendOrGroupId, userId]
    );
    if (!memberCheck.rows[0]) return res.status(403).json({ error: 'Not a group member' });

    query = `SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
             FROM messages m
             LEFT JOIN users u ON m.sender_id = u.id
             WHERE m.group_id = $1 AND NOT ($2 = ANY(COALESCE(m.deleted_by_users, '{}')))
             ORDER BY m.timestamp ASC`;
    params = [friendOrGroupId, userId];
  } else {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    query = `SELECT * FROM (
               SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
               FROM messages m
               LEFT JOIN users u ON m.sender_id = u.id
               WHERE ((m.sender_id = $1 AND m.receiver_id = $2 AND m.group_id IS NULL) OR (m.sender_id = $3 AND m.receiver_id = $4 AND m.group_id IS NULL))
                 AND NOT ($5 = ANY(COALESCE(m.deleted_by_users, '{}')))
               ORDER BY m.timestamp DESC
               LIMIT ${limit}
             ) sub ORDER BY sub.timestamp ASC`;
    params = [userId, friendOrGroupId, friendOrGroupId, userId, userId];
  }

  try {
    const { rows } = await db.query(query, params);
    // Safe diagnostic log: counts only — never ciphertext, nonce, or
    // plaintext content. Confirms e2ee_recipients survive the round trip
    // through the DB unchanged (non-null in, non-null out). Also counts
    // legacy single-key rows (pre multi-device) separately.
    const e2eeCount = (rows || []).filter(r => r.e2ee_recipients).length;
    const legacyE2eeCount = (rows || []).filter(r => !r.e2ee_recipients && r.ciphertext && r.nonce).length;
    console.log(`[e2ee] GET /messages/${userId}/${friendOrGroupId} isGroup=${isGroup} returned=${(rows || []).length} withE2eeRecipients=${e2eeCount} legacySingleKey=${legacyE2eeCount}`);
    const ids = (rows || []).map(r => r.id).filter(Boolean);
    const reactionsByMessageId = {};
    if (ids.length) {
      const reactionRows = await db.query(
        `SELECT message_id, emoji, COUNT(*)::int as count
         FROM message_reactions
         WHERE message_id = ANY($1::bigint[])
         GROUP BY message_id, emoji`,
        [ids]
      );
      for (const rr of reactionRows.rows) {
        if (!reactionsByMessageId[rr.message_id]) reactionsByMessageId[rr.message_id] = [];
        reactionsByMessageId[rr.message_id].push({ emoji: rr.emoji, count: rr.count });
      }
    }
    const enriched = (rows || []).map(r => {
      const withReactions = { ...r, reactions: reactionsByMessageId[r.id] || [] };
      // Never hand out the real image_url for a view-once message over the
      // regular history endpoint — it can only be retrieved once, via the
      // dedicated /view-once/open endpoint, and never again after that.
      if (withReactions.view_once) {
        withReactions.image_url = null;
      }
      return withReactions;
    });
    res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// One-time reveal for a view-once image. Only the recipient (not the
// sender) can open it, and only before it has already been opened by
// anyone — the opened state is persisted in the DB so it can never be
// revealed again, including after a refresh or reopening the chat.
app.post('/api/messages/:id/view-once/open', authenticateToken, async (req, res) => {
  const messageId = Number(req.params.id);
  try {
    const msgRes = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const msg = msgRes.rows[0];
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (!msg.view_once) return res.status(400).json({ error: 'This message is not a view-once photo' });
    if (Number(msg.sender_id) === Number(req.user.id)) {
      return res.status(403).json({ error: 'You cannot reopen a view-once photo you sent' });
    }

    // Authorization: for DMs the requester must be the receiver; for groups
    // the requester must be a member.
    if (msg.group_id) {
      const member = await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [msg.group_id, req.user.id]);
      if (!member.rows[0]) return res.status(403).json({ error: 'Access denied' });
    } else if (Number(msg.receiver_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (msg.view_once_opened_at) {
      return res.status(410).json({ error: 'This view-once photo has already been viewed and is no longer available.' });
    }

    const updated = await db.query(
      `UPDATE messages SET view_once_opened_at = NOW(), view_once_opened_by = $1
       WHERE id = $2 AND view_once_opened_at IS NULL
       RETURNING view_once_opened_at`,
      [req.user.id, messageId]
    );
    if (!updated.rows[0]) {
      // Lost a race with a concurrent open (e.g. two tabs) — treat as expired.
      return res.status(410).json({ error: 'This view-once photo has already been viewed and is no longer available.' });
    }

    const payload = {
      messageId,
      opened_by: Number(req.user.id),
      opened_at: updated.rows[0].view_once_opened_at
    };
    if (msg.group_id) {
      io.to(`group_${msg.group_id}`).emit('view_once_consumed', payload);
    } else {
      io.to(`user_${msg.sender_id}`).emit('view_once_consumed', payload);
      io.to(`user_${msg.receiver_id}`).emit('view_once_consumed', payload);
    }

    res.json({ image_url: msg.image_url, opened_at: payload.opened_at });
  } catch (err) {
    console.error('View-once open error:', err);
    res.status(500).json({ error: 'Failed to open photo' });
  }
});

// Admin Panel APIs
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT username, created_at FROM users ORDER BY created_at DESC, id DESC');
    res.json(rows || []);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/dashboard/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = Number((await db.query('SELECT COUNT(*)::int as c FROM users WHERE username != $1', ['__system__'])).rows[0]?.c || 0);
    const totalMessages = Number((await db.query('SELECT COUNT(*)::int as c FROM messages')).rows[0]?.c || 0);
    const totalGroups = Number((await db.query('SELECT COUNT(*)::int as c FROM groups')).rows[0]?.c || 0);
    const activeUsersToday = Number((await db.query(
      "SELECT COUNT(DISTINCT id)::int as c FROM users WHERE last_seen >= (NOW() - INTERVAL '1 day') AND username != $1",
      ['__system__']
    )).rows[0]?.c || 0);

    const days = 14;
    const messagesPerDay = (await db.query(`
      SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day, COUNT(*)::int as count
      FROM messages
      WHERE timestamp >= (NOW() - ($1 || ' days')::interval)
      GROUP BY date_trunc('day', timestamp)
      ORDER BY day ASC
    `, [String(days)])).rows;

    const signupsPerDay = (await db.query(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, COUNT(*)::int as count
      FROM users
      WHERE created_at >= (NOW() - ($1 || ' days')::interval) AND username != $2
      GROUP BY date_trunc('day', created_at)
      ORDER BY day ASC
    `, [String(days), '__system__'])).rows;

    res.json({
      totals: { users: totalUsers, messages: totalMessages, groups: totalGroups, activeUsersToday },
      series: { messagesPerDay, signupsPerDay }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/admin/dashboard/settings', authenticateToken, requireAdmin, async (req, res) => {
  res.json({
    maintenance_mode: (await getSettingAsync('maintenance_mode', 'false')) === 'true',
    invite_only: (await getSettingAsync('invite_only', 'false')) === 'true',
    welcome_message: await getSettingAsync('welcome_message', 'Welcome to Aerio')
  });
});

app.put('/api/admin/dashboard/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { maintenance_mode, invite_only, welcome_message } = req.body || {};
    if (typeof maintenance_mode === 'boolean') await setSettingAsync('maintenance_mode', maintenance_mode ? 'true' : 'false');
    if (typeof invite_only === 'boolean') await setSettingAsync('invite_only', invite_only ? 'true' : 'false');
    if (typeof welcome_message === 'string') await setSettingAsync('welcome_message', welcome_message.slice(0, 200));
    res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.get('/api/admin/dashboard/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, display_name, email, role, banned, created_at, last_seen, avatar_url
       FROM users
       WHERE username != $1
       ORDER BY created_at DESC, id DESC`,
      ['__system__']
    );

    const enriched = (rows || []).map(u => ({ ...u, online: isUserOnline(u.id) }));

    res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/dashboard/users/:id/ban', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const banned = !!req.body?.banned;
    await db.query('UPDATE users SET banned = $1 WHERE id = $2 AND username != $3', [banned, id, ADMIN_USERNAME]);
    res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/admin/dashboard/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const client = await db.pool.connect();
  try {
    const userRes = await client.query('SELECT id, username FROM users WHERE id = $1', [id]);
    const userRow = userRes.rows[0];
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    if (userRow.username === ADMIN_USERNAME || userRow.username === '__system__') return res.status(400).json({ error: 'Cannot delete this user' });

    await client.query('BEGIN');
    await client.query('DELETE FROM message_reactions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM starred_messages WHERE user_id = $1', [id]);
    await client.query('DELETE FROM pinned_messages WHERE pinned_by = $1', [id]);
    await client.query('DELETE FROM remembered_devices WHERE user_id = $1', [id]);
    await client.query('DELETE FROM user_settings WHERE user_id = $1', [id]);
    await client.query('DELETE FROM contacts WHERE user_id = $1 OR friend_id = $1', [id]);
    await client.query('DELETE FROM friend_requests WHERE sender_id = $1 OR receiver_id = $1', [id]);
    await client.query('DELETE FROM group_members WHERE user_id = $1', [id]);
    await client.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete user' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/dashboard/messages', authenticateToken, requireAdmin, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
  try {
    const { rows } = await db.query(
      `SELECT m.id, m.sender_id, su.username as sender_username,
              m.receiver_id, ru.username as receiver_username,
              m.group_id, g.name as group_name,
              m.type, m.content, m.image_url, m.timestamp
       FROM messages m
       LEFT JOIN users su ON su.id = m.sender_id
       LEFT JOIN users ru ON ru.id = m.receiver_id
       LEFT JOIN groups g ON g.id = m.group_id
       ORDER BY m.timestamp DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows || []);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/dashboard/messages/:id', authenticateToken, requireAdmin, async (req, res) => {
  const messageId = Number(req.params.id);
  try {
    await db.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
    res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.post('/api/admin/dashboard/broadcast', authenticateToken, requireAdmin, async (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message required' });
  if (!systemUser) return res.status(500).json({ error: 'System user not available' });

  const client = await db.pool.connect();
  try {
    const usersRes = await client.query('SELECT id FROM users WHERE username != $1', ['__system__']);
    const users = usersRes.rows || [];

    await client.query('BEGIN');
    const insertText = "INSERT INTO messages (sender_id, receiver_id, group_id, content, type, status) VALUES ($1, $2, NULL, $3, 'system', 'sent')";
    for (const u of users) {
      if (Number(u.id) === Number(systemUser.id)) continue;
      await client.query(insertText, [systemUser.id, u.id, content]);
    }
    await client.query('COMMIT');

    for (const u of users) {
      if (Number(u.id) === Number(systemUser.id)) continue;
      const room = io.sockets.adapter.rooms.get(`user_${u.id}`);
      const online = room && room.size > 0;
      if (online) {
        io.to(`user_${u.id}`).emit('receive_message', {
          id: null,
          sender_id: systemUser.id,
          sender_username: systemUser.username,
          receiver_id: u.id,
          group_id: null,
          content,
          image_url: null,
          type: 'system',
          status: 'sent',
          timestamp: new Date().toISOString(),
          reactions: []
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    console.error(err);
    return res.status(500).json({ error: 'Failed to broadcast' });
  } finally {
    client.release();
  }
});

// Socket.IO Handshake Authentication & Realtime Handlers
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return next(new Error('Authentication error'));
    try {
      const bannedRes = await db.query('SELECT banned FROM users WHERE id = $1', [user.id]);
      if (!bannedRes.rows[0] || bannedRes.rows[0].banned) {
        return next(new Error('Authentication error'));
      }
      socket.user = user;
      next();
    } catch (_) {
      return next(new Error('Authentication error'));
    }
  });
});

// True if userId has at least one live socket currently viewing the exact
// conversation (isGroup + targetId). Used to skip a redundant push
// notification for someone who is already looking at the chat live via
// Socket.IO — see the 'active_chat' socket event and its use in
// 'send_message' below.
function isViewingChat(userId, isGroup, targetId) {
  const room = io.sockets.adapter.rooms.get(`user_${userId}`);
  if (!room) return false;
  for (const sid of room) {
    const ac = activeChatBySocket.get(sid);
    if (ac && ac.isGroup === !!isGroup && Number(ac.targetId) === Number(targetId)) return true;
  }
  return false;
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id, 'User ID:', socket.user?.id);

  // Mark the user online the moment their socket connects (real connection, not the 'join' event),
  // and broadcast the change only when this is their first active connection (supports multi-tab).
  (() => {
    const uid = Number(socket.user?.id);
    if (!uid) return;
    const prevCount = onlineSocketCounts.get(uid) || 0;
    onlineSocketCounts.set(uid, prevCount + 1);
    if (prevCount === 0) {
      io.emit('user_status', { userId: uid, online: true });
    }
  })();

  socket.on('join', () => {
    const targetId = Number(socket.user.id);
    socket.join(`user_${targetId}`);

    (async () => {
      try {
        await db.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [targetId]);
      } catch (_) { }
    })();

    (async () => {
      try {
        const { rows } = await db.query('SELECT group_id FROM group_members WHERE user_id = $1', [targetId]);
        (rows || []).forEach(r => socket.join(`group_${r.group_id}`));
      } catch (err) {
        console.error('Error fetching group members:', err.message);
      }
    })();
  });

  socket.on('join_new_group', async (groupId) => {
    if (!groupId) return;
    try {
      const member = await db.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, socket.user.id]
      );
      if (!member.rows[0]) return;
      socket.join(`group_${groupId}`);
    } catch (err) {
      console.error('join_new_group error:', err.message);
    }
  });

  socket.on('typing', (payload = {}) => {
    try {
      const targetId = payload?.targetId;
      const isGroup = !!payload?.isGroup;
      if (!targetId) return;
      const senderId = socket.user.id;
      const room = isGroup ? `group_${targetId}` : `user_${targetId}`;
      socket.to(room).emit('user_typing', { senderId, isGroup, targetId });
    } catch (err) {
      console.error('typing error:', err.message);
    }
  });

  socket.on('stop_typing', (payload = {}) => {
    try {
      const targetId = payload?.targetId;
      const isGroup = !!payload?.isGroup;
      if (!targetId) return;
      const senderId = socket.user.id;
      const room = isGroup ? `group_${targetId}` : `user_${targetId}`;
      socket.to(room).emit('user_stop_typing', { senderId, isGroup, targetId });
    } catch (err) {
      console.error('stop_typing error:', err.message);
    }
  });

  // Client reports which conversation (if any) is currently open in the
  // foreground. Reuses this already-authenticated socket instead of a
  // second realtime channel — see isViewingChat() and its use below.
  socket.on('active_chat', (payload = {}) => {
    try {
      const targetId = payload && payload.targetId != null ? Number(payload.targetId) : null;
      const isGroup = !!(payload && payload.isGroup);
      if (targetId) {
        activeChatBySocket.set(socket.id, { isGroup, targetId });
      } else {
        activeChatBySocket.delete(socket.id);
      }
    } catch (err) {
      console.error('active_chat error:', err.message);
    }
  });

  socket.on('send_message', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      const senderId = socket.user.id;
      const { receiverId, groupId, content, imageUrl, type, reply, viewOnce, recipients, senderDeviceId } = data;

      let msgType = type || 'text';
      let valReceiverId = groupId ? null : receiverId;
      // E2EE multi-device (direct messages only): the client fans out
      // encryption client-side to every device of both parties, so
      // `recipients` is an array of { deviceId, ciphertext, nonce } and
      // `senderDeviceId` names which device did the encrypting (so a
      // reader knows whose public key to use). `content` is intentionally
      // absent for these — the server stores only ciphertext and never
      // sees plaintext. Falls back to plaintext `content` for group chats
      // (Phase 2, not yet encrypted) or if either side hasn't published any
      // device key yet — see the E2EE migration notes.
      const validRecipients = Array.isArray(recipients)
        ? recipients.filter(r => r && typeof r.deviceId === 'string' && typeof r.ciphertext === 'string' && typeof r.nonce === 'string')
        : [];
      const isE2ee = !groupId && validRecipients.length > 0 && typeof senderDeviceId === 'string' && !!senderDeviceId;
      const text = content == null ? '' : String(content);
      const media = imageUrl || null;
      const isViewOnce = !!viewOnce && msgType === 'image' && !!media;

      // Safe diagnostic log: ids + counts/booleans only — never ciphertext,
      // nonce, or plaintext content.
      console.log(`[e2ee] send_message sender=${senderId} receiver=${valReceiverId || 'null'} group=${groupId || 'null'} isE2ee=${isE2ee} senderDevice=${isE2ee ? senderDeviceId : 'null'} recipientDeviceCount=${validRecipients.length}`);

      if (!groupId && !valReceiverId) return;
      if (!isE2ee && !text.trim() && !media) return;

      const replyToId = reply?.id || null;
      const replyToType = reply?.type || null;
      // Never store a plaintext reply preview for an E2EE message — even
      // though the referenced message is likely encrypted too, don't take
      // the client's word for it here. The client re-derives the reply
      // preview locally by decrypting the referenced message itself.
      const replyToContent = isE2ee ? null : (reply?.content || null);
      const replyToImageUrl = reply?.imageUrl || null;
      const replyToSenderUsername = reply?.senderUsername || null;

      (async () => {
        try {
          if (groupId) {
            const member = await db.query(
              'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
              [groupId, senderId]
            );
            if (!member.rows[0]) return;

            // Announcements is read-only for everyone except admins.
            const isSenderAdmin = socket.user.username === ADMIN_USERNAME || socket.user.role === 'admin';
            if (!isSenderAdmin) {
              const announcementsGroupId = await getOrCreateAnnouncementsGroupId();
              if (announcementsGroupId && Number(groupId) === Number(announcementsGroupId)) {
                socket.emit('message_error', { error: 'Only admins can send messages in Announcements.' });
                return;
              }
            }
          }

          const inserted = await db.query(
            `INSERT INTO messages (
                sender_id, receiver_id, group_id,
                content, image_url, type,
                reply_to_id, reply_to_type, reply_to_content, reply_to_image_url, reply_to_sender_username,
                status, view_once, e2ee_recipients, sender_device_id
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id, timestamp`,
            [
              senderId, valReceiverId, groupId || null,
              isE2ee ? null : text, media, msgType,
              replyToId, replyToType, replyToContent, replyToImageUrl, replyToSenderUsername,
              'sent', isViewOnce,
              isE2ee ? JSON.stringify(validRecipients.map(r => ({ deviceId: r.deviceId, ciphertext: r.ciphertext, nonce: r.nonce }))) : null,
              isE2ee ? senderDeviceId : null
            ]
          );
          const row = inserted.rows[0];
          console.log(`[e2ee] message stored id=${row.id} sender=${senderId} receiver=${valReceiverId || 'null'} isE2ee=${isE2ee} recipientDeviceCount=${isE2ee ? validRecipients.length : 0}`);

          const senderRow = await db.query('SELECT username, display_name, avatar_url FROM users WHERE id = $1', [senderId]);
          const senderInfo = senderRow.rows[0] || {};
          const senderUsername = senderInfo.display_name || senderInfo.username || socket.user.username || 'Unknown';

          const messageObj = {
            id: Number(row.id),
            sender_id: senderId,
            receiver_id: valReceiverId,
            group_id: groupId || null,
            content: isE2ee ? null : text,
            e2ee_recipients: isE2ee ? validRecipients : null,
            sender_device_id: isE2ee ? senderDeviceId : null,
            // View-once images are never broadcast with their real URL —
            // recipients must fetch it exactly once via the dedicated
            // /api/messages/:id/view-once/open endpoint.
            image_url: isViewOnce ? null : media,
            type: msgType,
            view_once: isViewOnce,
            view_once_opened_at: null,
            view_once_opened_by: null,
            reply_to_id: replyToId,
            reply_to_type: replyToType,
            reply_to_content: replyToContent,
            reply_to_image_url: replyToImageUrl,
            reply_to_sender_username: replyToSenderUsername,
            reactions: [],
            status: 'sent',
            timestamp: row.timestamp,
            sender_username: senderUsername,
            sender_avatar: senderInfo.avatar_url || null
          };

          if (groupId) {
            io.to(`group_${groupId}`).emit('receive_message', messageObj);
          } else {
            io.to(`user_${receiverId}`).emit('receive_message', messageObj);
            socket.emit('message_sent', messageObj);
            // E2EE multi-device: the sender may be logged in on other
            // devices too (e.g. sent from Android, also open on Web).
            // Those other sessions didn't send this message and won't get
            // 'message_sent', so give them a live copy the same way the
            // receiver gets one. `socket.to()` (not `io.to()`) deliberately
            // excludes the sending socket itself, which already has the
            // plaintext locally and got 'message_sent' above.
            socket.to(`user_${senderId}`).emit('receive_message', messageObj);

            const receiverRoom = io.sockets.adapter.rooms.get(`user_${receiverId}`);
            const receiverOnline = receiverRoom && receiverRoom.size > 0;
            if (receiverOnline) {
              await db.query("UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'", [row.id]);
              socket.emit('message_delivered', { messageId: Number(row.id) });
            }
          }

          // ── FCM push notifications (Android background/closed) ──────────
          // Fires after Socket.IO has already handled the live/in-app case.
          // Never awaited by anything above, and every failure is caught
          // internally in push.sendToUser() — a push problem can never fail
          // the message that was already saved and delivered via sockets.
          (async () => {
            try {
              const previewText =
                isE2ee ? 'New message' :
                  msgType === 'image' ? '📷 Photo' :
                    msgType === 'audio' ? '🎤 Voice message' :
                      msgType === 'gif' ? 'GIF' :
                        (text || '').slice(0, 120);

              if (groupId) {
                const [membersRes, groupRes] = await Promise.all([
                  db.query('SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2', [groupId, senderId]),
                  db.query('SELECT name FROM groups WHERE id = $1', [groupId]),
                ]);
                const groupName = (groupRes.rows[0] && groupRes.rows[0].name) || 'Group';
                const recipients = (membersRes.rows || []).map((r) => Number(r.user_id));

                await Promise.all(recipients.map(async (uid) => {
                  // Already looking at this exact group live — Socket.IO already showed it, skip the push.
                  if (isViewingChat(uid, true, Number(groupId))) return;
                  const prefs = await getNotificationPrefs(uid);
                  if (!prefs.group_notifications) return;
                  const preview = applyPreviewPreference(prefs.notification_preview, groupName, `${senderUsername}: ${previewText}`);
                  await push.sendToUser(uid, {
                    title: preview.title,
                    body: preview.body,
                    sound: prefs.notification_sounds,
                    vibration: prefs.vibration,
                    data: {
                      type: 'group_message',
                      conversationType: 'group',
                      conversationId: String(groupId),
                      messageId: String(row.id),
                      senderId: String(senderId),
                    },
                  });
                }));
              } else {
                const receiverIdNum = Number(valReceiverId);
                if (receiverIdNum && !isViewingChat(receiverIdNum, false, senderId)) {
                  const prefs = await getNotificationPrefs(receiverIdNum);
                  if (!prefs.message_notifications) return;
                  const preview = applyPreviewPreference(prefs.notification_preview, senderUsername, previewText);
                  await push.sendToUser(receiverIdNum, {
                    title: preview.title,
                    body: preview.body,
                    sound: prefs.notification_sounds,
                    vibration: prefs.vibration,
                    data: {
                      type: 'direct_message',
                      conversationType: 'direct',
                      // From the receiver's perspective the conversation partner is the sender.
                      conversationId: String(senderId),
                      messageId: String(row.id),
                      senderId: String(senderId),
                    },
                  });
                }
              }
            } catch (err) {
              console.error('Push notification dispatch failed:', err.message);
            }
          })();
        } catch (err) {
          console.error('Error saving message:', err.message);
        }
      })();
    } catch (err) {
      console.error('send_message error:', err.message);
    }
  });

  socket.on('toggle_reaction', (payload = {}) => {
    try {
      const messageId = payload?.messageId;
      const emoji = payload?.emoji;
      if (!messageId || !emoji) return;
      const currentUserId = socket.user.id;
      (async () => {
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          const existing = await client.query(
            'SELECT 1 FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
            [messageId, currentUserId, emoji]
          );
          if (existing.rows[0]) {
            await client.query(
              'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
              [messageId, currentUserId, emoji]
            );
          } else {
            await client.query(
              'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [messageId, currentUserId, emoji]
            );
          }

          const reactionRows = await client.query(
            `SELECT emoji, COUNT(*)::int as count
             FROM message_reactions
             WHERE message_id = $1
             GROUP BY emoji`,
            [messageId]
          );
          const reactions = reactionRows.rows.map(r => ({ emoji: r.emoji, count: r.count }));

          const msg = await client.query('SELECT id, group_id, sender_id, receiver_id FROM messages WHERE id = $1', [messageId]);
          await client.query('COMMIT');

          const m = msg.rows[0];
          if (!m) return;
          const reactPayload = { messageId: Number(messageId), reactions };

          if (m.group_id) {
            io.to(`group_${m.group_id}`).emit('reaction_updated', reactPayload);
          } else {
            io.to(`user_${m.sender_id}`).emit('reaction_updated', reactPayload);
            io.to(`user_${m.receiver_id}`).emit('reaction_updated', reactPayload);
          }
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) { }
          console.error('Error toggling reaction:', err.message);
        } finally {
          client.release();
        }
      })();
    } catch (err) {
      console.error('toggle_reaction error:', err.message);
    }
  });

  socket.on('mark_read', (payload = {}) => {
    try {
      const friendId = payload?.friendId;
      if (!friendId) return;
      const currentUserId = socket.user.id;
      (async () => {
        try {
          await db.query(
            "UPDATE messages SET status = 'seen' WHERE sender_id = $1 AND receiver_id = $2 AND status IN ('sent','delivered') AND group_id IS NULL",
            [friendId, currentUserId]
          );
          io.to(`user_${friendId}`).emit('messages_read', { by_user_id: currentUserId, friend_id: friendId, user_id: currentUserId });
        } catch (err) {
          console.error('Error marking read:', err.message);
        }
      })();
    } catch (err) {
      console.error('mark_read error:', err.message);
    }
  });

  // ── Call signaling (Voice/Video calls) ──────────────────────────────
  // WebRTC media (audio/video) never touches this server — only the
  // handshake (offer/answer/ICE) and call-state events are relayed, using
  // the same authenticated `user_${id}` rooms as everything else. The
  // caller/callee identity always comes from `socket.user.id` (verified by
  // the JWT in the io.use() middleware above), never from client-supplied
  // IDs, so a user can only initiate or accept calls as themselves.

  socket.on('call:invite', async (payload = {}) => {
    let callId = null; // only set once we're committed — lets the catch block roll back safely
    try {
      const callerId = Number(socket.user.id);
      const calleeId = Number(payload?.targetUserId);
      const callType = payload?.callType === 'video' ? 'video' : 'voice';
      if (!calleeId || calleeId === callerId) return;

      // Caller already on a call
      if (isUserBusy(callerId)) {
        socket.emit('call:error', { error: 'You are already in a call.' });
        return;
      }
      // Callee unreachable vs. callee genuinely mid-call are different
      // situations and must never be reported to the caller as the same
      // thing — "offline" is not "busy". Checked as two independent
      // conditions, each with its own event, so a WebRTC/ICE failure or a
      // timeout elsewhere in the flow can never get relabeled as either.
      if (!isUserOnline(calleeId)) {
        socket.emit('call:offline', { targetUserId: calleeId });
        // The callee never got the chance to see this happened — without
        // this, "call:offline" only tells the caller in the moment, and
        // the callee comes back online with zero record anyone tried to
        // reach them (endCall()'s missed-call logging never runs here,
        // since we never create a call record for an offline callee).
        await logCallHistoryMessage(callerId, calleeId, `Missed ${callType} call`);
        return;
      }
      if (isUserBusy(calleeId)) {
        socket.emit('call:busy', { targetUserId: calleeId });
        return;
      }

      // Do every DB/async step BEFORE marking either user as "in a call" —
      // if any of this throws, we haven't touched userActiveCallId yet, so
      // there's nothing to roll back and neither user can get stuck busy.
      const calleeCheck = await db.query('SELECT banned FROM users WHERE id = $1', [calleeId]);
      if (!calleeCheck.rows[0] || calleeCheck.rows[0].banned) {
        socket.emit('call:error', { error: 'User unavailable.' });
        return;
      }
      const callerRow = await db.query('SELECT username, display_name, avatar_url FROM users WHERE id = $1', [callerId]);
      const caller = callerRow.rows[0] || {};

      // Re-check after the awaits above — it's possible another
      // invite/disconnect changed things while we were waiting on the DB.
      // Same offline-vs-busy separation as the pre-check.
      if (isUserBusy(callerId)) {
        socket.emit('call:error', { error: 'You are already in a call.' });
        return;
      }
      if (!isUserOnline(calleeId)) {
        socket.emit('call:offline', { targetUserId: calleeId });
        await logCallHistoryMessage(callerId, calleeId, `Missed ${callType} call`);
        return;
      }
      if (isUserBusy(calleeId)) {
        socket.emit('call:busy', { targetUserId: calleeId });
        return;
      }

      callId = crypto.randomUUID();
      const call = { callId, callerId, calleeId, callType, state: 'ringing', createdAt: Date.now(), connectedAt: null, ringTimeout: null };
      call.ringTimeout = setTimeout(() => { endCall(callId, 'timeout'); }, CALL_RING_TIMEOUT_MS);

      activeCalls.set(callId, call);
      userActiveCallId.set(callerId, callId);
      userActiveCallId.set(calleeId, callId);

      socket.emit('call:ringing', { callId, callType, targetUserId: calleeId });
      io.to(`user_${calleeId}`).emit('call:incoming', {
        callId,
        callType,
        from: { id: callerId, username: caller.username, display_name: caller.display_name, avatar_url: caller.avatar_url }
      });
    } catch (err) {
      console.error('call:invite error:', err.message);
      // Roll back — if we'd already registered the call before this threw,
      // undo it so neither participant is left stuck marked "busy".
      if (callId) {
        const call = activeCalls.get(callId);
        if (call?.ringTimeout) clearTimeout(call.ringTimeout);
        activeCalls.delete(callId);
        if (call) {
          if (userActiveCallId.get(call.callerId) === callId) userActiveCallId.delete(call.callerId);
          if (userActiveCallId.get(call.calleeId) === callId) userActiveCallId.delete(call.calleeId);
        }
      }
      socket.emit('call:error', { error: 'Failed to start call.' });
    }
  });

  socket.on('call:accept', (payload = {}) => {
    try {
      const userId = Number(socket.user.id);
      const call = activeCalls.get(payload?.callId);
      if (!call || call.calleeId !== userId || call.state !== 'ringing') return;
      if (call.ringTimeout) { clearTimeout(call.ringTimeout); call.ringTimeout = null; }
      call.state = 'connecting';
      io.to(`user_${call.callerId}`).emit('call:accepted', { callId: call.callId });
    } catch (err) {
      console.error('call:accept error:', err.message);
    }
  });

  socket.on('call:decline', (payload = {}) => {
    try {
      const userId = Number(socket.user.id);
      let call = activeCalls.get(payload?.callId);
      if (!call) {
        // Fallback: resolve via this user's tracked active call instead of
        // trusting the (possibly missing/stale) client-supplied callId.
        const fallbackId = userActiveCallId.get(userId);
        call = fallbackId ? activeCalls.get(fallbackId) : null;
      }
      if (!call || call.calleeId !== userId) {
        isUserBusy(userId); // no-op unless this user's pointer was stale — then it self-heals
        return;
      }
      endCall(call.callId, 'declined', userId);
    } catch (err) {
      console.error('call:decline error:', err.message);
    }
  });

  socket.on('call:end', (payload = {}) => {
    try {
      const userId = Number(socket.user.id);
      let call = activeCalls.get(payload?.callId);
      if (!call) {
        // Same fallback as call:decline — a client that cancelled before it
        // ever learned the real callId (still null locally) would otherwise
        // never be able to clean up its own busy marker server-side.
        const fallbackId = userActiveCallId.get(userId);
        call = fallbackId ? activeCalls.get(fallbackId) : null;
      }
      if (!call || (call.callerId !== userId && call.calleeId !== userId)) {
        isUserBusy(userId); // no-op unless this user's pointer was stale — then it self-heals
        return;
      }
      endCall(call.callId, 'ended', userId);
    } catch (err) {
      console.error('call:end error:', err.message);
    }
  });

  // Relayed WebRTC handshake — server never inspects/stores the SDP/ICE payloads,
  // it only validates the sender is a real participant of this call before relaying.
  const relayToOtherParticipant = (eventName) => (payload = {}) => {
    try {
      const userId = Number(socket.user.id);
      const call = activeCalls.get(payload?.callId);
      if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
      const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
      if (eventName === 'call:offer' || eventName === 'call:answer') call.state = 'connecting';
      io.to(`user_${otherUserId}`).emit(eventName, { callId: call.callId, ...payload, from: userId });
    } catch (err) {
      console.error(`${eventName} relay error:`, err.message);
    }
  };

  socket.on('call:offer', relayToOtherParticipant('call:offer'));
  socket.on('call:answer', relayToOtherParticipant('call:answer'));
  socket.on('call:ice-candidate', relayToOtherParticipant('call:ice-candidate'));

  socket.on('call:connected', (payload = {}) => {
    try {
      const userId = Number(socket.user.id);
      const call = activeCalls.get(payload?.callId);
      if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
      if (!call.connectedAt) call.connectedAt = Date.now();
      call.state = 'connected';
    } catch (err) {
      console.error('call:connected error:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    activeChatBySocket.delete(socket.id);
    const uid = Number(socket.user?.id);
    if (!uid) return;

    // If this user was on a call, end it for the other participant too —
    // covers the tab closing, network drop, backgrounding, etc.
    const callId = userActiveCallId.get(uid);
    if (callId) endCall(callId, 'disconnected', uid);

    const prevCount = onlineSocketCounts.get(uid) || 0;
    const newCount = Math.max(0, prevCount - 1);
    if (newCount === 0) {
      onlineSocketCounts.delete(uid);
      (async () => {
        try {
          await db.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [uid]);
        } catch (err) {
          console.error('Failed to update last_seen on disconnect:', err.message);
        }
        // Only broadcast offline if the user hasn't reconnected with a new socket in the meantime.
        if (!onlineSocketCounts.has(uid)) {
          io.emit('user_status', { userId: uid, online: false, lastSeen: new Date().toISOString() });
        }
      })();
    } else {
      onlineSocketCounts.set(uid, newCount);
    }
  });
});

// Prevent unhandled socket/async crashes from taking down the process
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});