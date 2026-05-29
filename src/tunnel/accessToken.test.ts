import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE_MAX_AGE_SEC,
  ACCESS_COOKIE_NAME,
  buildAccessCookieHeader,
  hashAccessToken,
  isValidAccessTokenFormat,
  isValidTokenHashFormat,
  mintAccessSessionValue,
  verifyAccessSession,
  verifyAccessToken,
} from './accessToken';

/** Stable 32-byte token for deterministic assertions. */
const FIXTURE_TOKEN = randomBytes(32).toString('base64url');
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_TOKEN, 'utf8').digest('base64url');

describe('accessToken', () => {
  it('hashes fixture token to expected base64url digest', () => {
    expect(hashAccessToken(FIXTURE_TOKEN)).toBe(FIXTURE_HASH);
    expect(FIXTURE_HASH).toHaveLength(43);
  });

  it('validates token and hash formats', () => {
    expect(isValidAccessTokenFormat(FIXTURE_TOKEN)).toBe(true);
    expect(isValidAccessTokenFormat('short')).toBe(false);
    expect(isValidAccessTokenFormat('bad+chars')).toBe(false);
    expect(isValidTokenHashFormat(FIXTURE_HASH)).toBe(true);
    expect(isValidTokenHashFormat('x')).toBe(false);
  });

  it('verifyAccessToken accepts matching hash only', () => {
    expect(verifyAccessToken(FIXTURE_TOKEN, FIXTURE_HASH)).toBe(true);
    expect(verifyAccessToken(FIXTURE_TOKEN, FIXTURE_HASH.slice(0, -1) + 'x')).toBe(false);
    expect(verifyAccessToken(FIXTURE_TOKEN + 'z', FIXTURE_HASH)).toBe(false);
    expect(verifyAccessToken('not-a-token', FIXTURE_HASH)).toBe(false);
  });

  it('verifyAccessSession uses constant-time shape checks', () => {
    const session = mintAccessSessionValue();
    expect(verifyAccessSession(session, session)).toBe(true);
    expect(verifyAccessSession(session, 'wrong-session-value-xxxxxxxxxxxxxxxxxxx')).toBe(false);
    expect(verifyAccessSession(session, null)).toBe(false);
    expect(verifyAccessSession('short', session)).toBe(false);
  });

  it('buildAccessCookieHeader sets HttpOnly, Lax, Max-Age, optional Secure', () => {
    const session = mintAccessSessionValue();
    const plain = buildAccessCookieHeader(session, false);
    expect(plain).toContain(`${ACCESS_COOKIE_NAME}=`);
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).toContain(`Max-Age=${ACCESS_COOKIE_MAX_AGE_SEC}`);
    expect(plain).not.toContain('Secure');

    const secure = buildAccessCookieHeader(session, true);
    expect(secure).toContain('Secure');
  });
});
