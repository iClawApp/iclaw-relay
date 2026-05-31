/**
 * Relay-side access gate — must pass before any HTTP/WS reaches local iClaw.
 *
 * Relay access token ≠ iClaw passphrase. This only proves the client was
 * given the full URL (including ?access=) once.
 */

import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';

import type { Tunnel } from './hub';
import {
  ACCESS_QUERY_PARAM,
  ACCESS_COOKIE_NAME,
  addAccessSession,
  buildAccessCookieHeader,
  verifyAccessSessionInSet,
  verifyAccessToken,
  mintAccessSessionValue,
} from './accessToken';
import { renderAccessForbiddenPage } from './accessForbiddenPage';

export type AccessDecision =
  | { action: 'allow'; setCookie?: string }
  | { action: 'redirect'; location: string; setCookie: string }
  | { action: 'forbidden' };

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    // A malformed percent-escape (e.g. `%`, `%ZZ`) makes decodeURIComponent
    // throw URIError. On the HTTP path Express would catch it, but on the WS
    // upgrade path the exception escapes the `server.on('upgrade')` listener
    // and crashes the whole process (taking every tunnel down). Decode
    // defensively per-cookie and fall back to the raw value so one attacker-
    // supplied cookie can never abort the gate.
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function stripAccessFromUrl(pathname: string, search: string): string {
  const u = new URL(pathname + search, 'http://tunnel.local');
  u.searchParams.delete(ACCESS_QUERY_PARAM);
  const q = u.search;
  return u.pathname + (q === '?' ? '' : q);
}

function requestIsSecure(req: { headers: Record<string, unknown>; protocol?: string }): boolean {
  const xf = req.headers['x-forwarded-proto'];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  if (typeof raw === 'string' && raw.toLowerCase() === 'https') return true;
  if (req.protocol === 'https') return true;
  return false;
}

/**
 * Evaluate whether a public request may reach the tunnel backend.
 * Adds to `tunnel.accessSessions` when a valid ?access= token is presented.
 */
export function evaluateTunnelAccess(
  tunnel: Tunnel,
  opts: {
    path: string;
    search: string;
    cookieHeader: string | undefined;
    secure: boolean;
    /** HTTP: redirect to URL without ?access=. WS: allow upgrade and Set-Cookie only. */
    redirectOnToken?: boolean;
  },
): AccessDecision {
  if (!tunnel.tokenHash) {
    return { action: 'forbidden' };
  }

  const cookies = parseCookies(opts.cookieHeader);
  const session = cookies[ACCESS_COOKIE_NAME];
  if (session && verifyAccessSessionInSet(session, tunnel.accessSessions)) {
    return { action: 'allow' };
  }

  const u = new URL(opts.path + opts.search, 'http://tunnel.local');
  const queryToken = u.searchParams.get(ACCESS_QUERY_PARAM);
  if (queryToken) {
    if (!verifyAccessToken(queryToken, tunnel.tokenHash)) {
      return { action: 'forbidden' };
    }
    const sessionValue = mintAccessSessionValue();
    addAccessSession(tunnel.accessSessions, sessionValue);
    const setCookie = buildAccessCookieHeader(sessionValue, opts.secure);
    if (opts.redirectOnToken !== false) {
      const clean = stripAccessFromUrl(opts.path, opts.search);
      return {
        action: 'redirect',
        location: clean || '/',
        setCookie,
      };
    }
    return { action: 'allow', setCookie };
  }

  return { action: 'forbidden' };
}

export function evaluateTunnelAccessFromIncoming(
  tunnel: Tunnel,
  req: IncomingMessage,
): AccessDecision {
  // Runs inside the raw `server.on('upgrade')` listener, where a thrown
  // exception is an unhandled process crash rather than a 500. A hostile
  // client controls req.url and the Cookie header, so treat any parse failure
  // (malformed percent-escape, bad URL) as fail-closed → forbidden.
  try {
    const url = new URL(req.url ?? '/', 'http://tunnel.local');
    return evaluateTunnelAccess(tunnel, {
      path: url.pathname,
      search: url.search,
      cookieHeader: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      secure: requestIsSecure({
        headers: req.headers as Record<string, unknown>,
      }),
      redirectOnToken: false,
    });
  } catch {
    return { action: 'forbidden' };
  }
}

/** Apply gate to an Express HTTP request (before tunnel proxy forward). */
export function applyHttpAccessGate(
  tunnel: Tunnel,
  req: Request,
  res: Response,
): boolean {
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  let decision: AccessDecision;
  try {
    decision = evaluateTunnelAccess(tunnel, {
      path: req.path,
      search: q,
      cookieHeader: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      secure: requestIsSecure(req),
      redirectOnToken: true,
    });
  } catch {
    // Malformed URL/cookie → fail closed with a clean 403 rather than bubbling
    // a 500 through the error handler.
    decision = { action: 'forbidden' };
  }

  if (decision.action === 'allow') {
    if (decision.setCookie) res.setHeader('Set-Cookie', decision.setCookie);
    return true;
  }

  if (decision.action === 'redirect') {
    res.setHeader('Set-Cookie', decision.setCookie);
    res.redirect(302, decision.location);
    return false;
  }

  res.status(403).type('html').send(renderAccessForbiddenPage());
  return false;
}

/** Refuse a raw upgrade socket when access is invalid. */
export function refuseUpgradeSocket(socket: import('node:stream').Duplex): void {
  socket.write(
    'HTTP/1.1 403 Forbidden\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      'Connection: close\r\n\r\n' +
      renderAccessForbiddenPage(),
  );
  socket.destroy();
}
