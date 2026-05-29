/**
 * Relay-side access token hashing and verification.
 *
 * iClaw sends only SHA-256(token) at registration; the relay never stores
 * or logs the plaintext token from `?access=`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Query param carrying the one-time access secret. */
export const ACCESS_QUERY_PARAM = 'access';

/** HttpOnly cookie issued after a successful access check. */
export const ACCESS_COOKIE_NAME = 'iclaw_tunnel_access';

/** Cookie lifetime after successful ?access= verification. */
export const ACCESS_COOKIE_MAX_AGE_SEC = 24 * 60 * 60;

const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function isValidAccessTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function isValidTokenHashFormat(hash: string): boolean {
  return HASH_RE.test(hash);
}

/** Constant-time compare of two base64url SHA-256 digests. */
export function verifyAccessToken(token: string, storedHash: string): boolean {
  if (!isValidAccessTokenFormat(token) || !isValidTokenHashFormat(storedHash)) {
    return false;
  }
  const computed = hashAccessToken(token);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function mintAccessSessionValue(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Upper bound on concurrent access sessions per tunnel. Generous enough for a
 * person's devices/tabs while capping memory if a link is shared widely. When
 * exceeded, the oldest session is evicted (insertion order).
 */
export const MAX_ACCESS_SESSIONS = 64;

/** Record a freshly-minted access session, evicting the oldest past the cap. */
export function addAccessSession(sessions: Set<string>, value: string): void {
  sessions.add(value);
  while (sessions.size > MAX_ACCESS_SESSIONS) {
    const oldest = sessions.values().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function verifyAccessSession(provided: string, expected: string | null): boolean {
  if (!expected || !TOKEN_RE.test(provided)) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Constant-time-ish membership check of a presented cookie session against the
 * tunnel's set of valid sessions. Iterates the whole set (no early return) so
 * timing does not reveal which session matched.
 */
export function verifyAccessSessionInSet(provided: string, sessions: Set<string>): boolean {
  if (!TOKEN_RE.test(provided)) return false;
  const a = Buffer.from(provided, 'utf8');
  let matched = false;
  for (const expected of sessions) {
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

export function buildAccessCookieHeader(sessionValue: string, secure: boolean): string {
  const parts = [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`,
    'Path=/',
    `Max-Age=${ACCESS_COOKIE_MAX_AGE_SEC}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
