const { Pool, types } = require('pg');

// Parse BIGINT (oid 20) as integer in JS to avoid string comparison bugs
types.setTypeParser(20, (val) => parseInt(val, 10));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Configure it in backend/.env before starting the server.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create / update users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        banned BOOLEAN DEFAULT FALSE,
        last_seen TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Alter users table to add new columns if they do not exist
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
    // E2EE (legacy, single-key model): kept ONLY for backward compatibility
    // with clients that predate multi-device support and for reading old
    // rows. No longer written to by current clients — see device_keys
    // below, which is what fixed "same account, different device
    // overwrites the other device's key" (multi-device E2EE fix).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key TEXT;`);

    // E2EE multi-device key directory. One row PER (device, account) pair,
    // never per account alone — this is the actual fix for devices
    // overwriting each other's public key. A device keeps a persistent
    // `device_id` (generated once per installation, survives logout) and
    // publishes/re-publishes its OWN row here on every login. Composite
    // primary key means:
    //   - the same device publishing again just updates its own row
    //   - a second device for the same user gets its OWN row, and can never
    //     overwrite the first device's row
    //   - the same device_id later used by a different account also gets
    //     its own row (rare, but harmless: shared/borrowed device case)
    // The matching PRIVATE key never leaves the originating device — this
    // table only ever holds public keys, useless for decrypting anything.
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_keys (
        device_id TEXT NOT NULL,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        platform TEXT DEFAULT 'web',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (device_id, user_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id);
    `);

    // OTP Table for Signup and Password Reset
    await client.query(`
      CREATE TABLE IF NOT EXISTS otps (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        otp_code TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'signup',
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // An OTP invalidated by a resend is also marked used; retain whether it
    // was actually verified before allowing account creation.
    await client.query(`ALTER TABLE otps ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`);

    // Remembered Devices Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS remembered_devices (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_token TEXT UNIQUE NOT NULL,
        user_agent TEXT,
        last_used TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, friend_id)
      );
    `);

    // Groups table
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        avatar_url TEXT,
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS description TEXT;`);
    await client.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
    // Ensure only a single "Announcements" group can ever exist, at the DB level.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_unique_announcements
      ON groups (name) WHERE name = 'Announcements';
    `);

    // Group members table
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, user_id)
      );
    `);

    // Messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        receiver_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL,
        content TEXT,
        image_url TEXT,
        type TEXT DEFAULT 'text',
        reply_to_id BIGINT,
        reply_to_type TEXT,
        reply_to_content TEXT,
        reply_to_image_url TEXT,
        reply_to_sender_username TEXT,
        status TEXT DEFAULT 'sent',
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by_users BIGINT[] DEFAULT '{}';`);
    // View-once media support: the image is only ever handed to a client once,
    // and the "opened" state is persisted here so refreshing/reopening the
    // chat cannot reveal it again — see /api/messages/:id/view-once/open.
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once_opened_at TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS view_once_opened_by BIGINT REFERENCES users(id) ON DELETE SET NULL;`);
    // E2EE (direct messages only, Phase 1): when a message was encrypted
    // client-side, `content` is left NULL and the ciphertext lives here
    // instead. `nonce` is the per-message random nonce required to decrypt
    // it — it is not secret, only `content`/plaintext ever is. Group
    // messages and messages sent before E2EE rollout still use `content`
    // as before — see the E2EE design notes for the migration/fallback
    // strategy (not every recipient may have published a key yet).
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ciphertext TEXT;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS nonce TEXT;`);
    // E2EE (Phase 1.1 — multi-device): a message is now encrypted once per
    // recipient DEVICE, not once per recipient ACCOUNT. `e2ee_recipients`
    // holds a JSON array of { deviceId, ciphertext, nonce } — one entry for
    // every device belonging to EITHER party (so the sender's other
    // devices can also decrypt their own sent message on reload/live).
    // `sender_device_id` records which device did the encrypting, so a
    // reader knows whose public key to use to derive the shared secret.
    // Legacy single-key `ciphertext`/`nonce` above are left as-is for old
    // rows — never migrated, and may become permanently undecryptable if
    // the key that produced them is gone. That's expected, not a bug.
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS e2ee_recipients JSONB;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_device_id TEXT;`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, timestamp);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_dm_ts ON messages(sender_id, receiver_id, timestamp);
    `);

    // Message Reactions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `);

    // Pinned Messages Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_type TEXT NOT NULL,
        chat_target_id BIGINT NOT NULL,
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        pinned_by BIGINT REFERENCES users(id) ON DELETE CASCADE,
        pinned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(chat_type, chat_target_id, message_id)
      );
    `);

    // Starred Messages Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS starred_messages (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        starred_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, message_id)
      );
    `);

    // Friend Requests Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(sender_id, receiver_id)
      );
    `);

    // Uploaded Files Table (avatars, group avatars, chat images/audio) stored
    // directly in Postgres so they survive backend restarts/redeploys — the
    // local /uploads disk on Render is ephemeral and gets wiped on every
    // restart, which was causing avatars and chat images to "disappear".
    await client.query(`
      CREATE TABLE IF NOT EXISTS uploaded_files (
        filename TEXT PRIMARY KEY,
        mime_type TEXT,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Original filename, kept so downloads can restore the name the user
    // uploaded with instead of the generated on-disk filename.
    await client.query(`ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS original_name TEXT;`);

    // App Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Announcements shown tracking: which users have received the default welcome announcement
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements_shown (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        shown_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, group_id)
      );
    `);

    // User Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT DEFAULT 'dark',
        accent_color TEXT DEFAULT '#3b82f6',
        notification_sounds BOOLEAN DEFAULT TRUE,
        wallpaper TEXT DEFAULT 'default',
        privacy_last_seen TEXT DEFAULT 'everyone',
        privacy_profile_visibility TEXT DEFAULT 'everyone',
        read_receipts BOOLEAN DEFAULT TRUE,
        typing_indicator BOOLEAN DEFAULT TRUE,
        online_status_visibility BOOLEAN DEFAULT TRUE
      );
    `);
    // Existing installations may predate one or more settings columns.
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'dark';`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT '#3b82f6';`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notification_sounds BOOLEAN DEFAULT TRUE;`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS wallpaper TEXT DEFAULT 'default';`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS privacy_last_seen TEXT DEFAULT 'everyone';`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS privacy_profile_visibility TEXT DEFAULT 'everyone';`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN DEFAULT TRUE;`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS typing_indicator BOOLEAN DEFAULT TRUE;`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS online_status_visibility BOOLEAN DEFAULT TRUE;`);
    await client.query(`UPDATE user_settings SET
      theme = COALESCE(theme, 'dark'), accent_color = COALESCE(accent_color, '#3b82f6'),
      notification_sounds = COALESCE(notification_sounds, TRUE), wallpaper = COALESCE(wallpaper, 'default'),
      privacy_last_seen = COALESCE(privacy_last_seen, 'everyone'),
      privacy_profile_visibility = COALESCE(privacy_profile_visibility, 'everyone'),
      read_receipts = COALESCE(read_receipts, TRUE),
      typing_indicator = COALESCE(typing_indicator, TRUE),
      online_status_visibility = COALESCE(online_status_visibility, TRUE);
    `);
    await client.query(`INSERT INTO user_settings (user_id) SELECT id FROM users ON CONFLICT (user_id) DO NOTHING;`);

    // Device Push Tokens (FCM) — a user can have multiple devices (phone,
    // tablet, several installs). The token itself is naturally unique per
    // app-install (FCM issues one token per install), so re-registering the
    // same token just reassigns/reactivates the existing row instead of
    // creating a duplicate — this is exactly what should happen when a
    // different account logs into the same physical device.
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        platform TEXT NOT NULL DEFAULT 'android',
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active ON device_tokens(user_id) WHERE active = TRUE;
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, initDb };