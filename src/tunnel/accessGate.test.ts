import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

import type { Tunnel } from './hub';
import { ACCESS_COOKIE_NAME, ACCESS_QUERY_PARAM, MAX_ACCESS_SESSIONS } from './accessToken';
import {
  applyHttpAccessGate,
  evaluateTunnelAccess,
  evaluateTunnelAccessFromIncoming,
  refuseUpgradeSocket,
} from './accessGate';

const FIXTURE_TOKEN = randomBytes(32).toString('base64url');
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_TOKEN, 'utf8').digest('base64url');

function stubTunnel(overrides: Partial<Tunnel> = {}): Tunnel {
  return {
    subdomain: 'demo',
    tunnelId: 't-demo',
    conn: null,
    createdAt: Date.now(),
    pending: new Map(),
    streams: new Map(),
    reconnecting: false,
    evictTimer: null,
    tokenHash: FIXTURE_HASH,
    ownerHash: null,
    accessSessions: new Set(),
    ...overrides,
  };
}

function cookieHeader(session: string): string {
  return `${ACCESS_COOKIE_NAME}=${encodeURIComponent(session)}`;
}

describe('access token rotation (C2 regression)', () => {
  it('old token + old cookie stop working after rotation; new token works', () => {
    const t = stubTunnel();

    // Visitor activates with the original token → gets an access session.
    const first = evaluateTunnelAccess(t, {
      path: '/',
      search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: false,
    });
    expect(first.action).toBe('allow');
    const oldSession = [...t.accessSessions][0];
    expect(oldSession).toBeTruthy();

    // The cookie works while the session is current.
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(oldSession as string),
        secure: true,
      }),
    ).toEqual({ action: 'allow' });

    // --- iClaw rotates the access token (what handleRegister now does) ---
    const newToken = randomBytes(32).toString('base64url');
    t.tokenHash = createHash('sha256').update(newToken, 'utf8').digest('base64url');
    t.accessSessions.clear();

    // Old ?access= token → forbidden.
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
        cookieHeader: undefined,
        secure: true,
      }),
    ).toEqual({ action: 'forbidden' });

    // Old access cookie → forbidden.
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(oldSession as string),
        secure: true,
      }),
    ).toEqual({ action: 'forbidden' });

    // New token → works.
    const after = evaluateTunnelAccess(t, {
      path: '/',
      search: `?${ACCESS_QUERY_PARAM}=${newToken}`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: false,
    });
    expect(after.action).toBe('allow');
  });
});

describe('concurrent access sessions (M1)', () => {
  it('two visitors activating the same link both keep working', () => {
    const t = stubTunnel();

    // Visitor A activates the link → session A.
    const a = evaluateTunnelAccess(t, {
      path: '/',
      search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: false,
    });
    expect(a.action).toBe('allow');
    const sessionA = [...t.accessSessions].at(-1) as string;

    // Visitor B activates the same link → session B (does NOT evict A).
    const b = evaluateTunnelAccess(t, {
      path: '/',
      search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: false,
    });
    expect(b.action).toBe('allow');
    const sessionB = [...t.accessSessions].at(-1) as string;
    expect(sessionB).not.toBe(sessionA);
    expect(t.accessSessions.size).toBe(2);

    // Both cookies remain valid concurrently.
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(sessionA),
        secure: true,
      }),
    ).toEqual({ action: 'allow' });
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(sessionB),
        secure: true,
      }),
    ).toEqual({ action: 'allow' });
  });

  it('bounds the number of stored sessions (oldest evicted past the cap)', () => {
    const t = stubTunnel();
    for (let i = 0; i < MAX_ACCESS_SESSIONS + 5; i++) {
      evaluateTunnelAccess(t, {
        path: '/',
        search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
        cookieHeader: undefined,
        secure: true,
        redirectOnToken: false,
      });
    }
    expect(t.accessSessions.size).toBe(MAX_ACCESS_SESSIONS);
  });
});

describe('evaluateTunnelAccess', () => {
  it('forbids when tunnel has no tokenHash', () => {
    const t = stubTunnel({ tokenHash: null });
    expect(
      evaluateTunnelAccess(t, { path: '/', search: '', cookieHeader: undefined, secure: true }),
    ).toEqual({ action: 'forbidden' });
  });

  it('forbids missing token and cookie', () => {
    const t = stubTunnel();
    expect(
      evaluateTunnelAccess(t, { path: '/login', search: '', cookieHeader: undefined, secure: true }),
    ).toEqual({ action: 'forbidden' });
  });

  it('forbids wrong query token', () => {
    const t = stubTunnel();
    const wrongToken = randomBytes(32).toString('base64url');
    expect(wrongToken).not.toBe(FIXTURE_TOKEN);
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: `?${ACCESS_QUERY_PARAM}=${wrongToken}`,
        cookieHeader: undefined,
        secure: true,
      }),
    ).toEqual({ action: 'forbidden' });
  });

  it('redirects and mints session on valid query token (HTTP)', () => {
    const t = stubTunnel();
    const decision = evaluateTunnelAccess(t, {
      path: '/chat',
      search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}&foo=1`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: true,
    });
    expect(decision.action).toBe('redirect');
    if (decision.action !== 'redirect') return;
    expect(decision.location).toBe('/chat?foo=1');
    expect(t.accessSessions.size).toBeGreaterThan(0);
    expect(decision.setCookie).toContain(ACCESS_COOKIE_NAME);
  });

  it('allows WS upgrade with valid query token without redirect', () => {
    const t = stubTunnel();
    const decision = evaluateTunnelAccess(t, {
      path: '/ws',
      search: `?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      cookieHeader: undefined,
      secure: true,
      redirectOnToken: false,
    });
    expect(decision).toMatchObject({ action: 'allow' });
    if (decision.action !== 'allow') return;
    expect(decision.setCookie).toContain(ACCESS_COOKIE_NAME);
    expect(t.accessSessions.size).toBeGreaterThan(0);
  });

  it('allows subsequent requests with valid access cookie', () => {
    const session = randomBytes(32).toString('base64url');
    const t = stubTunnel({ accessSessions: new Set([session]) });
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(session),
        secure: false,
      }),
    ).toEqual({ action: 'allow' });
  });

  it('forbids stale or wrong session cookie', () => {
    const t = stubTunnel({ accessSessions: new Set([randomBytes(32).toString('base64url')]) });
    expect(
      evaluateTunnelAccess(t, {
        path: '/',
        search: '',
        cookieHeader: cookieHeader(randomBytes(32).toString('base64url')),
        secure: false,
      }),
    ).toEqual({ action: 'forbidden' });
  });
});

describe('evaluateTunnelAccessFromIncoming', () => {
  it('reads path and query from upgrade request URL', () => {
    const t = stubTunnel();
    const req = {
      url: `/ws?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      headers: {},
    } as IncomingMessage;
    const decision = evaluateTunnelAccessFromIncoming(t, req);
    expect(decision.action).toBe('allow');
  });

  // H2 regression: on the WS-upgrade path a thrown URIError escapes the raw
  // server.on('upgrade') listener and crashes the whole process. A malformed
  // percent-escape in the Cookie (or URL) must fail closed, never throw.
  it('fails closed (no throw) on a malformed cookie percent-escape', () => {
    const t = stubTunnel();
    const req = {
      url: '/ws',
      headers: { cookie: `${ACCESS_COOKIE_NAME}=%` },
    } as unknown as IncomingMessage;
    let decision!: ReturnType<typeof evaluateTunnelAccessFromIncoming>;
    expect(() => {
      decision = evaluateTunnelAccessFromIncoming(t, req);
    }).not.toThrow();
    expect(decision.action).toBe('forbidden');
  });

  it('fails closed (no throw) on a malformed request URL', () => {
    const t = stubTunnel();
    const req = { url: '/%E0%A4%A', headers: {} } as unknown as IncomingMessage;
    expect(() => evaluateTunnelAccessFromIncoming(t, req)).not.toThrow();
  });

  it('still honours a valid token when an unrelated cookie is malformed', () => {
    // A broken cookie must not block a legitimate ?access= token: parseCookies
    // recovers per-cookie rather than discarding the whole header.
    const t = stubTunnel();
    const req = {
      url: `/ws?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      headers: { cookie: `junk=%ZZ; other=ok` },
    } as unknown as IncomingMessage;
    const decision = evaluateTunnelAccessFromIncoming(t, req);
    expect(decision.action).toBe('allow');
  });
});

describe('applyHttpAccessGate', () => {
  function mockRes(): Response & {
    headers: Record<string, string | number | string[]>;
    statusCode: number;
    body: unknown;
  } {
    const state = {
      headers: {} as Record<string, string | number | string[]>,
      statusCode: 200,
      body: undefined as unknown,
    };
    const res = {
      get headers() {
        return state.headers;
      },
      get statusCode() {
        return state.statusCode;
      },
      get body() {
        return state.body;
      },
      setHeader(name: string, value: string | number | string[]) {
        state.headers[name] = value;
      },
      redirect: vi.fn((code: number, location: string) => {
        state.statusCode = code;
        state.headers.Location = location;
      }),
      status(code: number) {
        state.statusCode = code;
        return res as Response;
      },
      type(_mime: string) {
        return res as Response;
      },
      send(payload: unknown) {
        state.body = payload;
        return res as Response;
      },
    };
    return res as Response & {
      headers: Record<string, string | number | string[]>;
      statusCode: number;
      body: unknown;
    };
  }

  it('returns false and sends 403 when access denied', () => {
    const tunnel = stubTunnel();
    const req = {
      path: '/',
      originalUrl: '/',
      headers: {},
      protocol: 'http',
    } as Request;
    const res = mockRes();
    expect(applyHttpAccessGate(tunnel, req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(String(res.body)).toContain('Access denied');
  });

  it('returns false and redirects on valid ?access=', () => {
    const tunnel = stubTunnel();
    const req = {
      path: '/',
      originalUrl: `/?${ACCESS_QUERY_PARAM}=${FIXTURE_TOKEN}`,
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
    } as Request;
    const res = mockRes();
    expect(applyHttpAccessGate(tunnel, req, res)).toBe(false);
    expect(res.redirect).toHaveBeenCalledWith(302, '/');
    expect(res.headers['Set-Cookie']).toContain(ACCESS_COOKIE_NAME);
    expect(String(res.headers['Set-Cookie'])).toContain('Secure');
  });

  it('returns true when session cookie is valid', () => {
    const session = randomBytes(32).toString('base64url');
    const tunnel = stubTunnel({ accessSessions: new Set([session]) });
    const req = {
      path: '/login',
      originalUrl: '/login',
      headers: { cookie: cookieHeader(session) },
      protocol: 'https',
    } as Request;
    const res = mockRes();
    expect(applyHttpAccessGate(tunnel, req, res)).toBe(true);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  // H2 regression on the HTTP path: malformed cookie → fail closed with a 403,
  // never bubble a 500 out of the handler.
  it('fails closed with 403 (no throw) on a malformed cookie', () => {
    const tunnel = stubTunnel();
    const req = {
      path: '/',
      originalUrl: '/',
      headers: { cookie: `${ACCESS_COOKIE_NAME}=%E0%A4%A` },
      protocol: 'https',
    } as unknown as Request;
    const res = mockRes();
    let result!: boolean;
    expect(() => {
      result = applyHttpAccessGate(tunnel, req, res);
    }).not.toThrow();
    expect(result).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('refuseUpgradeSocket', () => {
  it('writes 403 and destroys the socket', () => {
    const chunks: Buffer[] = [];
    const socket = {
      write: vi.fn((chunk: string) => chunks.push(Buffer.from(chunk))),
      destroy: vi.fn(),
    };
    refuseUpgradeSocket(socket as never);
    expect(socket.write).toHaveBeenCalled();
    expect(String(Buffer.concat(chunks))).toContain('403 Forbidden');
    expect(String(Buffer.concat(chunks))).toContain('Access denied');
    expect(socket.destroy).toHaveBeenCalled();
  });
});
