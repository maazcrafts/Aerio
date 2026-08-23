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
import { API_URL } from './config';

const DB_NAME = 'aerio-e2ee';
const STORE_NAME = 'keys';

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
export async function getOrCreateKeypair(userId) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('getOrCreateKeypair requires a userId (keys are scoped per account)');
  }
  const uid = String(userId);

  if (cachedKeypair && cachedKeypairUserId === uid) return cachedKeypair;

  // 1. This account already has its own scoped key on this device — use it.
  const stored = await idbGet(privateKeyRecordName(uid));
  if (stored && stored.secretKey && stored.publicKey) {
    cachedKeypair = {
      secretKey: naclUtil.decodeBase64(stored.secretKey),
      publicKey: naclUtil.decodeBase64(stored.publicKey),
    };
    cachedKeypairUserId = uid;
    return cachedKeypair;
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
    cachedKeypair = {
      secretKey: naclUtil.decodeBase64(legacy.secretKey),
      publicKey: naclUtil.decodeBase64(legacy.publicKey),
    };
    cachedKeypairUserId = uid;
    return cachedKeypair;
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
  return cachedKeypair;
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
  publicKeyCache.clear();
}

// ── Publishing / fetching public keys ────────────────────────────────────
export async function publishPublicKey(token, userId) {
  const { publicKey } = await getOrCreateKeypair(userId);
  await fetch(`${API_URL}/keys/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ publicKey: naclUtil.encodeBase64(publicKey) }),
  });
}

const publicKeyCache = new Map(); // userId -> base64 public key | null

// Fetches (and caches) another user's public key. Returns null if that
// user hasn't published one yet — the caller should fall back to sending
// plaintext in that case (see the E2EE migration notes: not every account
// will have a key immediately after rollout).
export async function fetchPublicKey(userId, token) {
  if (publicKeyCache.has(userId)) return publicKeyCache.get(userId);
  try {
    const res = await fetch(`${API_URL}/keys/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { publicKeyCache.set(userId, null); return null; }
    const data = await res.json();
    publicKeyCache.set(userId, data.publicKey || null);
    return data.publicKey || null;
  } catch {
    return null;
  }
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────
// Encrypts `plaintext` for `recipientPublicKeyB64` using this device's
// private key. Returns { ciphertext, nonce } both base64, ready to send to
// the backend as opaque blobs it cannot read.
export async function encryptForRecipient(plaintext, recipientPublicKeyB64, userId) {
  const { secretKey } = await getOrCreateKeypair(userId);
  const recipientPublicKey = naclUtil.decodeBase64(recipientPublicKeyB64);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = naclUtil.decodeUTF8(plaintext);
  const box = nacl.box(messageBytes, nonce, recipientPublicKey, secretKey);
  return {
    ciphertext: naclUtil.encodeBase64(box),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

// Decrypts a message that was encrypted for us by `senderPublicKeyB64`.
// Returns the plaintext string, or null if decryption/authentication
// fails (wrong key, tampered ciphertext, or corrupted data) — callers
// should show a fallback like "Unable to decrypt this message" rather
// than crash, since a failed decrypt is a real possibility (e.g. a
// message from before this device had a key, or a key change).
export async function decryptFromSender(ciphertextB64, nonceB64, senderPublicKeyB64, userId) {
  try {
    const { secretKey } = await getOrCreateKeypair(userId);
    const senderPublicKey = naclUtil.decodeBase64(senderPublicKeyB64);
    const ciphertext = naclUtil.decodeBase64(ciphertextB64);
    const nonce = naclUtil.decodeBase64(nonceB64);
    const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, secretKey);
    if (!opened) return null; // authentication failed — tampered or wrong key
    return naclUtil.encodeUTF8(opened);
  } catch {
    return null;
  }
}