import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE_MAX_AGE_SEC,
  ACCESS_COOKIE_NAME,
  buildAccessCookieHeader,
  hashAccessToken,
  hashOwnerSecret,
  isValidAccessTokenFormat,
  isValidOwnerProofFormat,
  isValidTokenHashFormat,
  mintAccessSessionValue,
  ownershipClaimAccepted,
  verifyAccessSession,
  verifyAccessToken,
  verifyOwnerSecret,
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

describe('tunnel ownership proof (H1)', () => {
  const proof = randomBytes(32).toString('base64url');
  const proofHash = createHash('sha256').update(proof, 'utf8').digest('base64url');

  it('hashes a proof the same way the client does', () => {
    expect(hashOwnerSecret(proof)).toBe(proofHash);
  });

  it('verifies a matching proof and rejects a wrong one', () => {
    expect(verifyOwnerSecret(proof, proofHash)).toBe(true);
    const wrong = randomBytes(32).toString('base64url');
    expect(verifyOwnerSecret(wrong, proofHash)).toBe(false);
  });

  it('validates proof format (base64url, 43–128 chars)', () => {
    expect(isValidOwnerProofFormat(proof)).toBe(true);
    expect(isValidOwnerProofFormat('short')).toBe(false);
    expect(isValidOwnerProofFormat('has+slash/and=pad')).toBe(false);
  });

  describe('ownershipClaimAccepted', () => {
    it('accepts any claim on a legacy tunnel with no owner hash', () => {
      expect(ownershipClaimAccepted(null, null)).toBe(true);
      expect(ownershipClaimAccepted(null, proof)).toBe(true);
    });

    it('requires a matching proof once an owner hash is set', () => {
      expect(ownershipClaimAccepted(proofHash, proof)).toBe(true);
    });

    it('rejects a missing proof against an owned tunnel', () => {
      expect(ownershipClaimAccepted(proofHash, null)).toBe(false);
    });

    it('rejects a wrong proof against an owned tunnel', () => {
      const wrong = randomBytes(32).toString('base64url');
      expect(ownershipClaimAccepted(proofHash, wrong)).toBe(false);
    });
  });
});
