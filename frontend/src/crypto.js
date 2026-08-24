// End-to-end encryption for Aerio direct messages (Phase 1).
//
// Uses NaCl "box" (X25519 for key agreement + XSalsa20-Poly1305 for
// authenticated encryption) via tweetnacl — a small, widely audited,
// dependency-free implementation of the same primitives used by Signal,
// WireGuard, and libsodium. This is NOT a custom/home-grown algorithm.
//
// THE PRIVATE KEY NEVER LEAVES THIS DEVICE. It is generated here, stored
// here (IndexedDB, never localStorage — see storePrivateKey below), and
// used here to decrypt. It is never sent to the backend in any request in
// this file or anywhere else in the app. Only the PUBLIC key is uploaded
// (via publishPublicKey), and a public key is useless for decrypting
// anything — it can only be used by others to encrypt messages TO you.
//
// Scope of Phase 1: direct messages only. Group messages are not yet
// encrypted (see the E2EE design notes) — encryptForRecipient/decryptFrom
// below are for 1:1 conversations.

import nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';
import { Capacitor } from '@capacitor/core';
import { API_URL } from './config';

const DB_NAME = 'aerio-e2ee';
const STORE_NAME = 'keys';

// ── Persistent per-installation device id (multi-device E2EE) ───────────
// This is what actually distinguishes "Web" from "Android" as two separate
// devices, even though both run the exact same Capacitor JS: each has its
// own IndexedDB origin (browser vs WebView), so a device_id generated and
// stored here is naturally scoped to one installation. Deliberately NOT
// scoped per-account — a device keeps the same identity across logout/
// login (see resetE2eeState: it never touches IndexedDB), and across
// different accounts logging into the same installation, so it can be
// used as a stable row key in the backend's device_keys table.
const DEVICE_ID_RECORD = 'installation-device-id';
let cachedDeviceId = null;

function generateDeviceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID.
  return 'dev-' + naclUtil.encodeBase64(nacl.randomBytes(16)).replace(/[^a-zA-Z0-9]/g, '');
}

// Returns this installation's persistent device id, generating one the
// very first time this app/browser runs. Never regenerated after that,
// and never cleared on logout.
//
// Concurrency guard: on a brand-new install, more than one call site can
// legitimately call this before anything is in IndexedDB yet (e.g. the
// login key-setup effect and the "is this chat encrypted" effect both run
// on mount). Without de-duplication each concurrent caller would generate
// its OWN random id and race to write it to the same IndexedDB record —
// see the identical (and more serious) version of this race in
// getOrCreateKeypair below for why that's dangerous. Fixed the same way:
// only one load-or-generate ever runs per app load; every concurrent
// caller awaits that same in-flight operation.
let deviceIdInflight = null;
export async function getOrCreateDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  if (deviceIdInflight) return deviceIdInflight;
  deviceIdInflight = (async () => {
    try {
      const stored = await idbGet(DEVICE_ID_RECORD);
      if (stored && typeof stored === 'string') {
        cachedDeviceId = stored;
        console.log(`[e2ee] device id loaded from storage len=${stored.length}`);
        return cachedDeviceId;
      }
      const id = generateDeviceId();
      await idbSet(DEVICE_ID_RECORD, id);
      cachedDeviceId = id;
      console.log(`[e2ee] new device id generated len=${id.length}`);
      return cachedDeviceId;
    } finally {
      deviceIdInflight = null;
    }
  })();
  return deviceIdInflight;
}

function currentPlatform() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? 'android' : 'web';
  } catch {
    return 'web';
  }
}

// Legacy (pre-fix) record name: a single IndexedDB key shared by every
// account that ever logged into this browser. Kept around ONLY for the
// one-time migration in getOrCreateKeypair below — never written to again,
// never deleted (see migration comment).
const LEGACY_PRIVATE_KEY_RECORD = 'device-private-key';
// Marks which user the legacy record was handed to, so a second, different
// account logging into the same browser doesn't also inherit it.
const LEGACY_MIGRATION_MARKER = 'device-private-key:migrated-to';

// Per-user record name — this is what fixes key sharing across accounts.
function privateKeyRecordName(userId) {
  return `device-private-key:${userId}`;
}

// ── IndexedDB storage for the private key ────────────────────────────────
// Deliberately not localStorage: localStorage is synchronous, trivially
// readable by any script/extension with page access, and commonly dumped
// wholesale by browser devtools/backup tools. IndexedDB isn't a hardware
// security boundary either, but it's the appropriate browser-side choice
// until a native Android Keystore-backed plugin is wired in (see the E2EE
// design notes, section K — that's a separate follow-up, not done here).
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Keypair lifecycle ─────────────────────────────────────────────────────
let cachedKeypair = null; // { publicKey: Uint8Array, secretKey: Uint8Array }
let cachedKeypairUserId = null; // which user cachedKeypair belongs to

// Loads THIS ACCOUNT's keypair from IndexedDB, generating and persisting a
// new one the first time this account is ever used on this device. Keys are
// scoped per userId so that two different accounts logging into the same
// browser never end up sharing (or overwriting) each other's private key.
//
// Call once at login with the logged-in user's id — the frontend also needs
// to publish the public key (see publishPublicKey) so other users can
// encrypt messages to this account.
//
// ── ROOT CAUSE FIX ────────────────────────────────────────────────────────
// This is the actual source of the permanent "Unable to decrypt this
// message" bug. On a brand-new device+account (empty IndexedDB), this
// function is legitimately called from more than one place at almost the
// same time on mount — e.g. ChatDashboard's login key-setup effect
// (getOrCreateDeviceId -> getOrCreateKeypair -> publishPublicKey) and its
// separate "is this chat encrypted" effect (which also calls
// getOrCreateKeypair as soon as a DM chat is open, including a chat opened
// immediately from a push notification tap). Previously, with no
// concurrency guard, each concurrent caller would independently reach step
// 3 below, each generate its OWN random nacl.box.keyPair(), and both
// idbSet() the same IndexedDB record — whichever write committed LAST
// silently won storage AND the shared `cachedKeypair` module variable.
// The problem: publishPublicKey() reads `cachedKeypair` at the moment IT
// runs and immediately POSTs that public key over the network (which
// takes real time). If a second, independent getOrCreateKeypair() call
// finishes generating and overwrites `cachedKeypair`/IndexedDB with a
// DIFFERENT keypair before that POST resolves, the server ends up with
// public key A registered for this device, while the device's actual
// stored/used private key is B — a valid-looking but permanently
// incompatible pair. Every future decrypt (of the device's own sent
// messages, and of anything encrypted to it) then fails authentication in
// nacl.box.open, forever, on this device — matching exactly what was
// reported: brand-new messages failing, unaffected by rebuilding,
// re-syncing, or redeploying, because the corruption lives in persisted
// client-side IndexedDB state, not in the build.
//
// Fix: de-duplicate concurrent callers for the same uid onto a single
// in-flight promise, so the load-or-generate logic can only ever run ONCE
// per uid at a time. Every concurrent caller (and therefore
// publishPublicKey) ends up awaiting and publishing the exact same
// keypair. No architecture change — same storage shape, same public API.
const keypairInflight = new Map(); // uid -> Promise<{secretKey, publicKey}>

export async function getOrCreateKeypair(userId) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('getOrCreateKeypair requires a userId (keys are scoped per account)');
  }
  const uid = String(userId);

  if (cachedKeypair && cachedKeypairUserId === uid) return cachedKeypair;

  const existingInflight = keypairInflight.get(uid);
  if (existingInflight) return existingInflight;

  const inflight = (async () => {
    try {
      // 1. This account already has its own scoped key on this device — use it.
      const stored = await idbGet(privateKeyRecordName(uid));
      if (stored && stored.secretKey && stored.publicKey) {
        const kp = {
          secretKey: naclUtil.decodeBase64(stored.secretKey),
          publicKey: naclUtil.decodeBase64(stored.publicKey),
        };
        cachedKeypair = kp;
        cachedKeypairUserId = uid;
        console.log(`[e2ee] keypair loaded from IndexedDB user=${uid} pubKeyLen=${kp.publicKey.length} secKeyLen=${kp.secretKey.length}`);
        return kp;
      }

      // 2. One-time migration path for browsers that already had a key under
      // the old, unscoped record (from before this fix). Hand it to the first
      // account that logs in and claims it — almost always the same person who
      // was already using this browser — so their existing private key (and
      // their ability to decrypt their existing message history) is preserved
      // instead of being silently replaced with a brand-new, unrelated key.
      // The legacy record is copied, never deleted, and a marker prevents any
      // *other* account from also claiming it later.
      const legacy = await idbGet(LEGACY_PRIVATE_KEY_RECORD);
      const migratedTo = await idbGet(LEGACY_MIGRATION_MARKER);
      if (legacy && legacy.secretKey && legacy.publicKey && !migratedTo) {
        await idbSet(privateKeyRecordName(uid), legacy);
        await idbSet(LEGACY_MIGRATION_MARKER, uid);
        const kp = {
          secretKey: naclUtil.decodeBase64(legacy.secretKey),
          publicKey: naclUtil.decodeBase64(legacy.publicKey),
        };
        cachedKeypair = kp;
        cachedKeypairUserId = uid;
        console.log(`[e2ee] keypair migrated from legacy record user=${uid} pubKeyLen=${kp.publicKey.length} secKeyLen=${kp.secretKey.length}`);
        return kp;
      }

      // 3. Brand-new account on this device (or the legacy key was already
      // claimed by someone else) — generate a fresh, isolated keypair.
      const kp = nacl.box.keyPair();
      await idbSet(privateKeyRecordName(uid), {
        secretKey: naclUtil.encodeBase64(kp.secretKey),
        publicKey: naclUtil.encodeBase64(kp.publicKey),
      });
      cachedKeypair = kp;
      cachedKeypairUserId = uid;
      console.log(`[e2ee] new keypair generated user=${uid} pubKeyLen=${kp.publicKey.length} secKeyLen=${kp.secretKey.length}`);
      return kp;
    } finally {
      // Only remove this uid's in-flight marker once settled, so any
      // caller that arrived while generation was still running shared this
      // exact result instead of starting its own.
      keypairInflight.delete(uid);
    }
  })();

  keypairInflight.set(uid, inflight);
  return inflight;
}

export function getCachedPublicKeyBase64() {
  return cachedKeypair ? naclUtil.encodeBase64(cachedKeypair.publicKey) : null;
}

// Clears in-memory E2EE state (the cached keypair and the public-key
// lookup cache). Must be called on logout so that a different account
// logging into the same browser tab doesn't reuse the previous user's
// cached keypair or stale public-key lookups. Does not touch IndexedDB —
// the private key on disk is untouched, this only resets the in-memory
// module state for the current tab's session.
export function resetE2eeState() {
  cachedKeypair = null;
  cachedKeypairUserId = null;
  deviceKeysCache.clear();
  // Deliberately does NOT touch IndexedDB — device_id and every account's
  // private key stay on disk across logout (see the requirements this
  // module implements: a new device must not lose keys on logout, and a
  // re-login on this same device must keep decrypting old history).
}

// ── Publishing / fetching device public keys (multi-device) ─────────────
// IMPORTANT: this must check the response. Previously it fired the request
// and ignored the result, so whenever the backend rejected a publish, this
// device silently kept using a private key that no longer matched what was
// published for this account — every decrypt then failed authentication,
// both for incoming messages and for the device's own sent history. Any
// failure here is re-thrown so callers can log it instead of the app
// believing publish succeeded when it didn't.
export async function publishPublicKey(token, userId) {
  const { publicKey } = await getOrCreateKeypair(userId);
  const deviceId = await getOrCreateDeviceId();
  const res = await fetch(`${API_URL}/keys/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      publicKey: naclUtil.encodeBase64(publicKey),
      deviceId,
      platform: currentPlatform(),
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch (_) { /* non-JSON error body */ }
    // Never include key material in the thrown error — status + server
    // message only.
    throw new Error(`Failed to publish public key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json().catch(() => null);
  if (body?.rotated) {
    // Safe to log: no key material or message content, just that this
    // device's key changed on the server (expected after fresh storage /
    // a reinstall / a new deployment origin).
    console.log(`[e2ee] public key rotated for this device (${deviceId})`);
  }
}

// Cache TTL for device-key directory lookups. Short-lived, not permanent —
// a plain forever-cache would mean a device that just rotated its key (or
// a brand-new second device that just published for the first time) isn't
// noticed by other sessions until a full reload. 60s balances not
// hammering the backend on every message in a chat history load against
// actually recovering when a device's key changes or a new device appears.
const DEVICE_KEYS_CACHE_TTL_MS = 60_000;
const deviceKeysCache = new Map(); // userId -> { devices, legacyPublicKey, fetchedAt }

// Fetches every device key this user has published, plus the legacy
// single-key column as a fallback for decrypting pre-migration messages.
// Returns { devices: [{deviceId, publicKey, platform}], legacyPublicKey }.
// Returns { devices: [], legacyPublicKey: null } if the user has no keys
// published anywhere yet — the caller should fall back to plaintext in
// that case (see the E2EE migration notes).
//
// Pass `forceRefresh: true` to bypass the cache entirely — used
// immediately before encrypting a new outgoing message, so the sender
// always fans out to the recipient's CURRENT set of devices rather than
// whatever was cached from an earlier lookup in this session.
export async function fetchDeviceKeys(userId, token, { forceRefresh = false } = {}) {
  const cached = deviceKeysCache.get(userId);
  const isFresh = cached && (Date.now() - cached.fetchedAt) < DEVICE_KEYS_CACHE_TTL_MS;
  if (!forceRefresh && isFresh) return cached;
  const empty = { devices: [], legacyPublicKey: null };
  try {
    const res = await fetch(`${API_URL}/keys/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Safe to log: user id + HTTP status + device count. Never key contents.
    if (!res.ok) {
      console.log(`[e2ee] fetchDeviceKeys user=${userId} status=${res.status}`);
      deviceKeysCache.set(userId, { ...empty, fetchedAt: Date.now() });
      return empty;
    }
    const data = await res.json();
    const value = {
      devices: Array.isArray(data.devices) ? data.devices : [],
      legacyPublicKey: data.legacyPublicKey || null,
      fetchedAt: Date.now(),
    };
    console.log(`[e2ee] fetchDeviceKeys user=${userId} status=${res.status} deviceCount=${value.devices.length}`);
    deviceKeysCache.set(userId, value);
    return value;
  } catch (e) {
    console.warn(`[e2ee] fetchDeviceKeys network error for user=${userId}:`, e && e.message ? e.message : e);
    // Network failure: fall back to a possibly-stale cached value rather
    // than treating the user as keyless, but only if we have one.
    return cached || empty;
  }
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────
// Encrypts `plaintext` once per target device, using THIS device's private
// key. `targetDevices` is the combined device list of both the recipient
// AND the sender's own other devices/accounts-on-this-device, so every one
// of them (including this same device, for a consistent reload experience)
// ends up able to read the message. Returns an array of
// { deviceId, ciphertext, nonce } ready to send to the backend as opaque
// blobs it cannot read — a fresh nonce is generated for every entry.
export async function encryptForDevices(plaintext, targetDevices, userId) {
  const { secretKey } = await getOrCreateKeypair(userId);
  const messageBytes = naclUtil.decodeUTF8(plaintext);
  const usable = targetDevices.filter(d => d && d.deviceId && d.publicKey);
  console.log(`[e2ee] encryptForDevices myKeyLen=${secretKey.length} targetDeviceCount=${usable.length}/${targetDevices.length}`);
  return usable.map((d) => {
    const recipientPublicKey = naclUtil.decodeBase64(d.publicKey);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(messageBytes, nonce, recipientPublicKey, secretKey);
    return {
      deviceId: d.deviceId,
      ciphertext: naclUtil.encodeBase64(box),
      nonce: naclUtil.encodeBase64(nonce),
    };
  });
}

// Picks the payload entry meant for THIS device out of a message's
// multi-device recipients array. Returns null if this device isn't in the
// list (e.g. a message sent before this device existed/published a key).
export function pickPayloadForDevice(recipientsArray, deviceId) {
  if (!Array.isArray(recipientsArray)) return null;
  return recipientsArray.find(r => r && r.deviceId === deviceId) || null;
}

// Decrypts a message that was encrypted for us by `senderPublicKeyB64`.
// Returns the plaintext string, or null if decryption/authentication
// fails (wrong key, tampered ciphertext, or corrupted data) — callers
// should show a fallback like "Unable to decrypt this message" rather
// than crash, since a failed decrypt is a real possibility (e.g. a
// message from before this device had a key, or a key change).
export async function decryptFromSenderDevice(ciphertextB64, nonceB64, senderPublicKeyB64, userId) {
  try {
    const { secretKey } = await getOrCreateKeypair(userId);
    const senderPublicKey = naclUtil.decodeBase64(senderPublicKeyB64);
    const ciphertext = naclUtil.decodeBase64(ciphertextB64);
    const nonce = naclUtil.decodeBase64(nonceB64);
    // Safe to log: byte lengths only, never the decoded key/ciphertext/nonce
    // values themselves. A wrong length here (e.g. senderPublicKey !== 32
    // bytes) points straight at a base64/Uint8Array conversion bug rather
    // than a key-mismatch, which is otherwise indistinguishable from the
    // outside (both just make nacl.box.open return null).
    console.log(`[e2ee] decryptFromSenderDevice myKeyLen=${secretKey.length} senderKeyLen=${senderPublicKey.length} ciphertextLen=${ciphertext.length} nonceLen=${nonce.length}`);
    const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, secretKey);
    if (!opened) return null; // authentication failed — tampered or wrong key
    return naclUtil.encodeUTF8(opened);
  } catch (e) {
    console.warn('[e2ee] decryptFromSenderDevice threw:', e && e.message ? e.message : e);
    return null;
  }
}