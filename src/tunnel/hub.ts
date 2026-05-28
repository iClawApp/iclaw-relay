/**
 * In-memory registries for the relay.
 *
 * The relay has two parallel views of the world:
 *
 * - **Connections** — one per active iClaw process. Each carries the
 *   underlying WS and a set of subdomains it currently owns.
 * - **Tunnels** — one per logical tunnel (one per public subdomain).
 *   Each holds the pending HTTP requests + open public WS streams for
 *   that subdomain and a back-reference to its connection.
 *
 * Both maps are intentionally process-local; relay restart wipes
 * everything (iClaw clients will re-register on reconnect).
 */

import type { WebSocket } from 'ws';

export interface PendingRequest {
  resolve(headFrameJson: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface IclawConnection {
  ws: WebSocket;
  ip: string;
  createdAt: number;
  /** Subdomains that belong to this iClaw process. */
  subdomains: Set<string>;
  /** tunnelId → subdomain, so frames from this WS can be routed back to a tunnel. */
  tunnelIdToSubdomain: Map<string, string>;
}

export interface Tunnel {
  subdomain: string;
  /** iClaw-side stable identifier (survives reconnects on iClaw). */
  tunnelId: string;
  conn: IclawConnection;
  createdAt: number;
  /** Open HTTP requests waiting for their matching `res` frame. */
  pending: Map<string, PendingRequest>;
  /** Open public-side WebSocket streams, keyed by stream id. */
  streams: Map<string, WebSocket>;
}

const tunnelsBySubdomain = new Map<string, Tunnel>();

/* ───────────────────────────────────── connections ───── */

export function newConnection(ws: WebSocket, ip: string): IclawConnection {
  return {
    ws,
    ip,
    createdAt: Date.now(),
    subdomains: new Set(),
    tunnelIdToSubdomain: new Map(),
  };
}

/* ────────────────────────────────────────── tunnels ───── */

export function addTunnel(t: Tunnel): void {
  tunnelsBySubdomain.set(t.subdomain, t);
  t.conn.subdomains.add(t.subdomain);
  t.conn.tunnelIdToSubdomain.set(t.tunnelId, t.subdomain);
}

export function getTunnelBySubdomain(subdomain: string): Tunnel | undefined {
  return tunnelsBySubdomain.get(subdomain);
}

export function getTunnelByTunnelId(
  conn: IclawConnection,
  tunnelId: string,
): Tunnel | undefined {
  const sub = conn.tunnelIdToSubdomain.get(tunnelId);
  return sub ? tunnelsBySubdomain.get(sub) : undefined;
}

function tearDownTunnel(t: Tunnel): void {
  for (const p of t.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('tunnel closed'));
  }
  t.pending.clear();
  for (const ws of t.streams.values()) {
    try {
      ws.close(1011, 'tunnel closed');
    } catch {
      // ignore
    }
  }
  t.streams.clear();
}

/** Remove one tunnel (e.g. iClaw sent unregister-tunnel). */
export function removeTunnelBySubdomain(subdomain: string): void {
  const t = tunnelsBySubdomain.get(subdomain);
  if (!t) return;
  tearDownTunnel(t);
  t.conn.subdomains.delete(subdomain);
  t.conn.tunnelIdToSubdomain.delete(t.tunnelId);
  tunnelsBySubdomain.delete(subdomain);
}

/** Remove every tunnel owned by a connection (used on iClaw WS close). */
export function removeAllTunnelsForConn(conn: IclawConnection): void {
  for (const sub of conn.subdomains) {
    const t = tunnelsBySubdomain.get(sub);
    if (t) {
      tearDownTunnel(t);
      tunnelsBySubdomain.delete(sub);
    }
  }
  conn.subdomains.clear();
  conn.tunnelIdToSubdomain.clear();
}

export function tunnelCount(): number {
  return tunnelsBySubdomain.size;
}
