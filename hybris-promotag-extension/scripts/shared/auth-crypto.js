/*
 * Portal login crypto: PBKDF2-SHA256 credential hashes and session tokens (WebCrypto).
 * Shared by the service worker, the history page, the credential-hasher tool and the tests.
 * This is a client-side gate only; Hybris SSO remains the real access control.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  const DEFAULT_ITERATIONS = 600000;
  const enc = new TextEncoder();

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(String(b64 || ''));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }

  async function pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    return new Uint8Array(bits);
  }

  function normalizeUserId(userId) {
    return String(userId || '').trim().toLowerCase();
  }

  function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /** Creates a storable credential record: { userId, salt, hash, iterations, algo }. */
  async function hashCredential(userId, password, opts = {}) {
    const iterations = opts.iterations || DEFAULT_ITERATIONS;
    const salt = opts.salt ? fromB64(opts.salt) : randomBytes(16);
    const hash = await pbkdf2(password, salt, iterations);
    return { userId: String(userId).trim(), salt: toB64(salt), hash: toB64(hash), iterations, algo: 'PBKDF2-SHA256' };
  }

  async function verifyCredential(record, userId, password) {
    if (!record || normalizeUserId(record.userId) !== normalizeUserId(userId)) return false;
    const hash = await pbkdf2(password, fromB64(record.salt), record.iterations || DEFAULT_ITERATIONS);
    return constantTimeEqual(hash, fromB64(record.hash));
  }

  /** Returns the matching record or null. Unknown users still cost one hash, so timing doesn't reveal them. */
  async function findAndVerify(records, userId, password) {
    const record = (records || []).find((r) => r && normalizeUserId(r.userId) === normalizeUserId(userId));
    if (!record) {
      await pbkdf2(password, randomBytes(16), DEFAULT_ITERATIONS);
      return null;
    }
    return (await verifyCredential(record, userId, password)) ? record : null;
  }

  function newSessionToken() {
    return toB64(randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function createSession(userId, ttlMinutes, now = Date.now()) {
    return { token: newSessionToken(), userId: String(userId), issuedAt: now, expiresAt: now + ttlMinutes * 60000 };
  }

  function isSessionValid(session, now = Date.now()) {
    return !!(
      session &&
      typeof session.token === 'string' &&
      session.token.length >= 20 &&
      typeof session.expiresAt === 'number' &&
      session.expiresAt > now
    );
  }

  PTAE.authCrypto = {
    DEFAULT_ITERATIONS,
    hashCredential,
    verifyCredential,
    findAndVerify,
    createSession,
    isSessionValid,
    normalizeUserId,
  };
})(globalThis);
