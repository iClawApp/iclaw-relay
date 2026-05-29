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
  tryRestoreTunnel,
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
import { isValidTokenHashFormat } from './accessToken';
import {
  evaluateTunnelAccessFromIncoming,
  refuseUpgradeSocket,
} from './accessGate';

/** Interval between WS-protocol-level keep-alive pings on each iClaw conn. */
const KEEP_ALIVE_MS = 30_000;

const TUNNEL_PATH = '/tunnel';

function getClientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string') {
      const first = raw.split(',')[0]?.trim();
      if (first) return first;
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
        console.log(`[tunnel] rotate-token tunnelId=${tunnelId} subdomain=${existing.subdomain}`);
      }
    }
    sendRegistered(conn, existing);
    return;
  }

  // (2) Sticky subdomain: tunnel currently in the reconnecting grace
  // window with the same tunnelId? Attach it to this new connection so
  // the URL is preserved. Doesn't count against the rate limit. A changed
  // tokenHash here is also treated as a rotation (kills old access).
  const restored = tryRestoreTunnel(tunnelId, conn);
  if (restored) {
    if (restored.tokenHash !== tokenHash) {
      restored.accessSessions.clear();
    }
    restored.tokenHash = tokenHash;
    if (config.logAccess) {
      console.log(
        `[tunnel] restore tunnelId=${tunnelId} subdomain=${restored.subdomain} ip=${conn.ip}`,
      );
    }
    sendRegistered(conn, restored);
    return;
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

  const subdomain = generateSubdomain();
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
    accessSessions: new Set(),
  };
  addTunnel(tunnel);

  if (config.logAccess) {
    console.log(`[tunnel] register tunnelId=${tunnelId} subdomain=${subdomain} ip=${conn.ip}`);
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
    console.log(`[tunnel] unregister tunnelId=${frame.tunnelId} subdomain=${tunnel.subdomain}`);
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
