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
  buildAccessCookieHeader,
  verifyAccessSession,
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
    if (name) out[name] = decodeURIComponent(value);
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
 * Mutates `tunnel.accessSession` when a valid ?access= token is presented.
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
  if (session && verifyAccessSession(session, tunnel.accessSession)) {
    return { action: 'allow' };
  }

  const u = new URL(opts.path + opts.search, 'http://tunnel.local');
  const queryToken = u.searchParams.get(ACCESS_QUERY_PARAM);
  if (queryToken) {
    if (!verifyAccessToken(queryToken, tunnel.tokenHash)) {
      return { action: 'forbidden' };
    }
    const sessionValue = mintAccessSessionValue();
    tunnel.accessSession = sessionValue;
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
}

/** Apply gate to an Express HTTP request (before tunnel proxy forward). */
export function applyHttpAccessGate(
  tunnel: Tunnel,
  req: Request,
  res: Response,
): boolean {
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const decision = evaluateTunnelAccess(tunnel, {
    path: req.path,
    search: q,
    cookieHeader: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
    secure: requestIsSecure(req),
    redirectOnToken: true,
  });

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
