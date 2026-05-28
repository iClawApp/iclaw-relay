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
  removeTunnelBySubdomain,
  removeAllTunnelsForConn,
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

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const frame = parseFrame(raw);
    if (!frame) return;
    routeFromIclaw(conn, frame, raw);
  });

  const cleanup = (): void => {
    removeAllTunnelsForConn(conn);
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

  // If this tunnelId is already registered on this connection, treat as
  // idempotent — return the existing subdomain.
  const existing = getTunnelByTunnelId(conn, tunnelId);
  if (existing) {
    sendRegistered(conn, existing);
    return;
  }

  // Per-IP rate limit (loopback exempt).
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
  };
  addTunnel(tunnel);

  if (config.logAccess) {
    console.log(`[tunnel] register tunnelId=${tunnelId} subdomain=${subdomain} ip=${conn.ip}`);
  }
  sendRegistered(conn, tunnel);
}

function handleUnregister(conn: IclawConnection, frame: UnregisterTunnelFrame): void {
  const tunnel = getTunnelByTunnelId(conn, frame.tunnelId);
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
