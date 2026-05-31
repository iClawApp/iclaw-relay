/**
 * WebSocket upgrade router + multiplexed tunnel server.
 *
 * Two kinds of upgrades land here:
 *
 *   1. `ws://relay/tunnel`  — outbound from a local iClaw process. We
 *      accept it as a single long-lived IclawConnection and demultiplex
 *      multiple logical tunnels over it (register-tunnel / unregister-
 *      tunnel + req/res/ws-* frames each carrying `tunnelId`).
 *
 *   2. `ws(s)://<sub>.<baseDomain>/<anything>` — public client opening
 *      a WS that should reach iClaw's local /ws (or other path). We
 *      look up the tunnel by subdomain and bridge it through the
 *      owning iClaw connection's WS as a `ws-open` stream.
 *
 * Rate-limiting moved from "per WS upgrade" to "per register-tunnel
 * message". A single iClaw connection is cheap (it just sits there);
 * what we want to throttle is the *creation of new tunnels*.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

import { config } from '../config';
import {
  newConnection,
  addTunnel,
  getTunnelBySubdomain,
  getTunnelByTunnelId,
  getTunnelByTunnelIdGlobal,
  removeTunnelBySubdomain,
  detachConnAndKeepReserved,
  reassignTunnelToConn,
  type IclawConnection,
  type Tunnel,
} from './hub';
import { generateSubdomain } from './idGen';
import { extractSubdomain } from './host';
import {
  parseFrame,
  type Frame,
  type RegisterTunnelFrame,
  type TunnelRegisteredFrame,
  type TunnelRejectedFrame,
  type UnregisterTunnelFrame,
} from './protocol';
import { bridgePublicUpgrade, deliverWsData, deliverWsClose } from './publicWs';
import { checkAndCountTunnelRegistration } from './rateLimit';
import {
  isValidTokenHashFormat,
  isValidOwnerProofFormat,
  verifyOwnerSecret,
  hashOwnerSecret,
} from './accessToken';
import {
  evaluateTunnelAccessFromIncoming,
  refuseUpgradeSocket,
} from './accessGate';

/** Interval between WS-protocol-level keep-alive pings on each iClaw conn. */
const KEEP_ALIVE_MS = 30_000;

const TUNNEL_PATH = '/tunnel';

function firstHeader(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === 'string' ? raw : undefined;
}

function getClientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    // SECURITY: the left-most X-Forwarded-For entry is fully attacker-
    // controlled — a client can send `X-Forwarded-For: 127.0.0.1` and our
    // upstream (Cloudflare) merely *appends* the real client IP, so trusting
    // XFF[0] let anyone forge a loopback/arbitrary IP and bypass the per-IP
    // tunnel-registration limits (and poison logs).
    //
    // Behind Cloudflare the trustworthy value is `CF-Connecting-IP`, which the
    // edge overwrites unconditionally and the client cannot spoof. Prefer it;
    // fall back to the RIGHT-most XFF hop (the one our nearest trusted proxy
    // added) rather than the left-most.
    const cf = firstHeader(req.headers['cf-connecting-ip'])?.trim();
    if (cf) return cf;

    const xff = firstHeader(req.headers['x-forwarded-for']);
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const rightMost = parts[parts.length - 1];
      if (rightMost) return rightMost;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function isLoopbackIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.') ||
    ip.startsWith('::ffff:127.')
  );
}

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(payload);
  } catch {
    // ignore
  }
}

/**
 * Pick a subdomain that is not already taken. The namespace is ~1.5B wide so a
 * clash is astronomically unlikely, but `addTunnel` would silently overwrite an
 * existing tunnel's registry entry on a collision (hijacking its URL), so never
 * hand back one that is in use. Returns null only if we somehow can't find a
 * free name in a handful of tries.
 */
function allocateSubdomain(): string | null {
  for (let i = 0; i < 8; i++) {
    const candidate = generateSubdomain();
    if (!getTunnelBySubdomain(candidate)) return candidate;
  }
  return null;
}

export function attachTunnelWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // (1) Outbound iClaw client opening its shared WS.
    if (url.pathname === TUNNEL_PATH) {
      const ip = getClientIp(req);
      wss.handleUpgrade(req, socket, head, (ws) => handleIclawConnection(ws, ip));
      return;
    }

    // (2) Public client connecting to <sub>.<baseDomain>/*.
    const sub = extractSubdomain(req.headers.host, config.baseDomain);
    if (sub) {
      const tunnel = getTunnelBySubdomain(sub);
      if (!tunnel) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const access = evaluateTunnelAccessFromIncoming(tunnel, req);
      if (access.action === 'forbidden') {
        refuseUpgradeSocket(socket);
        return;
      }
      bridgePublicUpgrade(tunnel, req, socket, head);
      return;
    }

    socket.destroy();
  });
}

function handleIclawConnection(ws: WebSocket, ip: string): void {
  const conn = newConnection(ws, ip);
  if (config.logAccess) {
    console.log(`[tunnel] conn open ip=${ip}`);
  }

  // ── WS-protocol keep-alive ──────────────────────────────────────
  // Cloudflare (and other proxies in front of us) close idle
  // WebSocket connections after ~100s. Without this we'd reconnect
  // every couple of minutes for no reason. The `ws` library auto-
  // responds to PING with PONG, so we just need to send pings.
  // Also detects half-open peers: no pong before next interval →
  // terminate, the iClaw side will reconnect.
  conn.isAlive = true;
  ws.on('pong', () => {
    conn.isAlive = true;
  });
  conn.pingTimer = setInterval(() => {
    if (!conn.isAlive) {
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    conn.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, KEEP_ALIVE_MS);
  conn.pingTimer.unref();

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const frame = parseFrame(raw);
    if (!frame) return;
    routeFromIclaw(conn, frame, raw);
  });

  const cleanup = (): void => {
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    // Sticky subdomains: keep tunnelId → subdomain reservations alive for
    // the grace window so iClaw's reconnect lands on the same URL.
    detachConnAndKeepReserved(conn);
    if (config.logAccess) {
      console.log(`[tunnel] conn close ip=${ip}`);
    }
  };
  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`[tunnel] conn error ip=${ip} :: ${err.message}`);
    cleanup();
  });
}

function routeFromIclaw(conn: IclawConnection, frame: Frame, raw: string): void {
  switch (frame.t) {
    case 'register-tunnel':
      handleRegister(conn, frame);
      return;

    case 'unregister-tunnel':
      handleUnregister(conn, frame);
      return;

    case 'res':
    case 'err': {
      // Response to an HTTP request we forwarded. Find the matching
      // tunnel by the tunnelId on the frame, then resolve its pending.
      const tunnel = getTunnelByTunnelId(conn, frame.tunnelId);
      if (!tunnel) return;
      const reqId = frame.t === 'res' ? frame.id : frame.id;
      if (!reqId) return;
      const pending = tunnel.pending.get(reqId);
      if (!pending) return;
      tunnel.pending.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve(raw);
      return;
    }

    case 'ws-data': {
      const tunnel = getTunnelByTunnelId(conn, frame.tunnelId);
      if (!tunnel) return;
      deliverWsData(tunnel, frame);
      return;
    }
    case 'ws-close': {
      const tunnel = getTunnelByTunnelId(conn, frame.tunnelId);
      if (!tunnel) return;
      deliverWsClose(tunnel, frame);
      return;
    }

    case 'ping':
      safeSend(conn.ws, JSON.stringify({ t: 'pong' }));
      return;

    // Frames the iClaw shouldn't send; ignore silently.
    case 'pong':
    case 'tunnel-registered':
    case 'tunnel-rejected':
    case 'ws-open':
    case 'req':
      return;
  }
}

function handleRegister(conn: IclawConnection, frame: RegisterTunnelFrame): void {
  const tunnelId = frame.tunnelId;
  if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
    sendRejected(conn, tunnelId ?? '', 'invalid tunnelId');
    return;
  }

  const tokenHash = frame.tokenHash;
  if (typeof tokenHash !== 'string' || !isValidTokenHashFormat(tokenHash)) {
    sendRejected(conn, tunnelId, 'invalid tokenHash');
    return;
  }

  // Ownership proof (optional for backward compat). Validate shape up-front;
  // its hash authenticates a re-register against the stored owner hash.
  const ownerProof =
    typeof frame.ownerProof === 'string' && isValidOwnerProofFormat(frame.ownerProof)
      ? frame.ownerProof
      : null;

  // (1) Already active on this connection? Idempotent re-register, and the
  // owner is allowed to ROTATE its access token: a register with a changed
  // tokenHash updates the stored hash and drops the current access session
  // so previously-issued ?access= links and access cookies stop working.
  // This is safe because register-tunnel only ever arrives over the
  // authenticated iClaw WS that owns this tunnelId.
  const existing = getTunnelByTunnelId(conn, tunnelId);
  if (existing) {
    if (existing.tokenHash !== tokenHash) {
      existing.tokenHash = tokenHash;
      existing.accessSessions.clear();
      if (config.logAccess) {
        // Never log tunnelId — subdomain is already public and enough to trace.
        console.log(`[tunnel] rotate-token subdomain=${existing.subdomain}`);
      }
    }
    sendRegistered(conn, existing);
    return;
  }

  // (2) A tunnel with this id exists but on a DIFFERENT connection — either in
  // the reconnecting grace window or still bound to a stale socket. This is the
  // hijack-sensitive path: a stranger who only knows the tunnelId must NOT be
  // able to claim it, so require a matching ownership proof whenever the tunnel
  // carries an owner hash.
  const claimable = getTunnelByTunnelIdGlobal(tunnelId);
  if (claimable && claimable.conn !== conn) {
    if (claimable.ownerHash) {
      if (!ownerProof || !verifyOwnerSecret(ownerProof, claimable.ownerHash)) {
        // Throttle tunnelId brute-force like a fresh registration, then refuse
        // WITHOUT mutating the tunnel — the real owner keeps its subdomain.
        if (!isLoopbackIp(conn.ip)) {
          checkAndCountTunnelRegistration(conn.ip, {
            perHour: config.limits.tunnelPerIpPerHour,
            perDay: config.limits.tunnelPerIpPerDay,
          });
        }
        console.warn(`[tunnel] restore denied (ownership mismatch) ip=${conn.ip}`);
        sendRejected(conn, tunnelId, 'ownership proof required');
        return;
      }
    }
    const restored = reassignTunnelToConn(tunnelId, conn);
    if (restored) {
      if (restored.tokenHash !== tokenHash) {
        restored.accessSessions.clear();
      }
      restored.tokenHash = tokenHash;
      // Adopt an owner hash if the tunnel had none (legacy) and a proof is now
      // supplied, so subsequent restores are authenticated.
      if (!restored.ownerHash && ownerProof) {
        restored.ownerHash = hashOwnerSecret(ownerProof);
      }
      if (config.logAccess) {
        console.log(`[tunnel] restore subdomain=${restored.subdomain} ip=${conn.ip}`);
      }
      sendRegistered(conn, restored);
      return;
    }
    // Fell through (raced away) — drop to a fresh registration below.
  }

  // (3) Fresh registration. Rate-limited (loopback exempt).
  if (!isLoopbackIp(conn.ip)) {
    const limit = checkAndCountTunnelRegistration(conn.ip, {
      perHour: config.limits.tunnelPerIpPerHour,
      perDay: config.limits.tunnelPerIpPerDay,
    });
    if (!limit.ok) {
      console.warn(
        `[tunnel] rate-limited ip=${conn.ip} reason=${limit.reason} retry-after=${limit.retryAfterSec}s`,
      );
      sendRejected(conn, tunnelId, 'rate-limited', limit.retryAfterSec);
      return;
    }
  }

  const subdomain = allocateSubdomain();
  if (!subdomain) {
    sendRejected(conn, tunnelId, 'subdomain allocation failed');
    return;
  }
  const tunnel: Tunnel = {
    subdomain,
    tunnelId,
    conn,
    createdAt: Date.now(),
    pending: new Map(),
    streams: new Map(),
    reconnecting: false,
    evictTimer: null,
    tokenHash,
    ownerHash: ownerProof ? hashOwnerSecret(ownerProof) : null,
    accessSessions: new Set(),
  };
  addTunnel(tunnel);

  if (config.logAccess) {
    console.log(`[tunnel] register subdomain=${subdomain} ip=${conn.ip}`);
  }
  sendRegistered(conn, tunnel);
}

function handleUnregister(conn: IclawConnection, frame: UnregisterTunnelFrame): void {
  // Prefer the conn-scoped lookup; fall back to global so an iClaw can
  // explicitly retire a reconnecting tunnel before the grace window
  // expires (e.g. user clicks Disable on the new connection).
  const tunnel =
    getTunnelByTunnelId(conn, frame.tunnelId) ??
    getTunnelByTunnelIdGlobal(frame.tunnelId);
  if (!tunnel) return;
  removeTunnelBySubdomain(tunnel.subdomain);
  if (config.logAccess) {
    console.log(`[tunnel] unregister subdomain=${tunnel.subdomain}`);
  }
}

function sendRegistered(conn: IclawConnection, t: Tunnel): void {
  const f: TunnelRegisteredFrame = {
    t: 'tunnel-registered',
    tunnelId: t.tunnelId,
    subdomain: t.subdomain,
    baseDomain: config.baseDomain,
    publicUrl: config.publicUrlFor(t.subdomain),
  };
  safeSend(conn.ws, JSON.stringify(f));
}

function sendRejected(
  conn: IclawConnection,
  tunnelId: string,
  reason: string,
  retryAfterSec?: number,
): void {
  const f: TunnelRejectedFrame = { t: 'tunnel-rejected', tunnelId, reason };
  if (retryAfterSec !== undefined) f.retryAfterSec = retryAfterSec;
  safeSend(conn.ws, JSON.stringify(f));
}
