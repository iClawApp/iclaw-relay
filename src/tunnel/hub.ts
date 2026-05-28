/**
 * In-memory registries for the relay.
 *
 * Two parallel views of the world:
 *
 * - **Connections** — one per active iClaw process. Each carries the
 *   underlying WS and a set of subdomains it currently owns.
 * - **Tunnels** — one per logical tunnel (one per public subdomain).
 *   Each holds the pending HTTP requests + open public WS streams for
 *   that subdomain and a back-reference to its connection.
 *
 * Sticky subdomain: when a connection closes, its tunnels are NOT
 * immediately deleted. They go into a "reconnecting" state and stay in
 * the registry (with their subdomain reserved) for a grace window
 * (default 10 min). If iClaw reconnects and re-registers the same
 * `tunnelId` within that window, the tunnel is attached to the new
 * connection and the URL is preserved. After the window elapses,
 * the tunnel is fully deleted and its subdomain becomes available.
 *
 * Process-local on purpose; relay restart wipes everything.
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
  /** Subdomains currently active for this iClaw process. */
  subdomains: Set<string>;
  /** tunnelId → subdomain on this conn. */
  tunnelIdToSubdomain: Map<string, string>;
  /** WS-protocol-level keep-alive state. */
  isAlive: boolean;
  pingTimer: NodeJS.Timeout | null;
}

export interface Tunnel {
  subdomain: string;
  /** iClaw-side stable identifier (survives reconnects on iClaw). */
  tunnelId: string;
  /** null while the tunnel is in the reconnecting grace window. */
  conn: IclawConnection | null;
  createdAt: number;
  pending: Map<string, PendingRequest>;
  streams: Map<string, WebSocket>;
  /** True iff the tunnel's iClaw is currently disconnected. */
  reconnecting: boolean;
  /** Set when reconnecting — fires to fully delete after grace window. */
  evictTimer: NodeJS.Timeout | null;
}

const tunnelsBySubdomain = new Map<string, Tunnel>();
const tunnelsByTunnelId = new Map<string, Tunnel>();

/** How long to keep a tunnelId→subdomain mapping after the iClaw WS closes. */
const RECONNECT_GRACE_MS = 10 * 60_000; // 10 min

/* ─────────────────────────────────────────── connections ───── */

export function newConnection(ws: WebSocket, ip: string): IclawConnection {
  return {
    ws,
    ip,
    createdAt: Date.now(),
    subdomains: new Set(),
    tunnelIdToSubdomain: new Map(),
    isAlive: true,
    pingTimer: null,
  };
}

/* ───────────────────────────────────────────── tunnels ───── */

export function addTunnel(t: Tunnel): void {
  tunnelsBySubdomain.set(t.subdomain, t);
  tunnelsByTunnelId.set(t.tunnelId, t);
  if (t.conn) {
    t.conn.subdomains.add(t.subdomain);
    t.conn.tunnelIdToSubdomain.set(t.tunnelId, t.subdomain);
  }
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

/**
 * Look up a tunnel by tunnelId across ALL state, including ones currently
 * in the reconnecting grace window. Used by `tryRestoreTunnel` so a
 * re-registering iClaw on a fresh connection can recover the original
 * subdomain.
 */
export function getTunnelByTunnelIdGlobal(tunnelId: string): Tunnel | undefined {
  return tunnelsByTunnelId.get(tunnelId);
}

/** Tear down only the per-conn active state — keep the subdomain reserved. */
function detachConnState(t: Tunnel): void {
  // Reject any in-flight HTTP requests; their conn is gone.
  for (const p of t.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('tunnel reconnecting'));
  }
  t.pending.clear();
  // Public-side WS streams were tied to the now-gone iClaw — close them.
  // The browser will follow up with a fresh upgrade once the tunnel is
  // back, hitting the reconnecting page in the meantime.
  for (const ws of t.streams.values()) {
    try {
      ws.close(1011, 'tunnel reconnecting');
    } catch {
      // ignore
    }
  }
  t.streams.clear();
}

/** Final removal — clears both maps + the evict timer. */
function fullyRemove(t: Tunnel): void {
  if (t.evictTimer) {
    clearTimeout(t.evictTimer);
    t.evictTimer = null;
  }
  tunnelsBySubdomain.delete(t.subdomain);
  tunnelsByTunnelId.delete(t.tunnelId);
}

/**
 * Called when iClaw explicitly says "unregister this tunnel". We remove
 * immediately (no grace), regardless of reconnecting state.
 */
export function removeTunnelBySubdomain(subdomain: string): void {
  const t = tunnelsBySubdomain.get(subdomain);
  if (!t) return;
  detachConnState(t);
  if (t.conn) {
    t.conn.subdomains.delete(subdomain);
    t.conn.tunnelIdToSubdomain.delete(t.tunnelId);
  }
  fullyRemove(t);
}

/**
 * Called on iClaw WS close. Doesn't actually delete tunnels — moves them
 * into the reconnecting grace window so the subdomain stays reserved.
 */
export function detachConnAndKeepReserved(conn: IclawConnection): void {
  for (const sub of conn.subdomains) {
    const t = tunnelsBySubdomain.get(sub);
    if (!t) continue;
    detachConnState(t);
    t.conn = null;
    t.reconnecting = true;
    if (t.evictTimer) clearTimeout(t.evictTimer);
    t.evictTimer = setTimeout(() => {
      fullyRemove(t);
    }, RECONNECT_GRACE_MS);
    t.evictTimer.unref();
  }
  conn.subdomains.clear();
  conn.tunnelIdToSubdomain.clear();
}

/**
 * Attempt to revive a reconnecting tunnel for `tunnelId` on a fresh
 * connection. Returns the resurrected tunnel on success, undefined when
 * there is no matching reconnecting tunnel to restore.
 */
export function tryRestoreTunnel(
  tunnelId: string,
  conn: IclawConnection,
): Tunnel | undefined {
  const t = tunnelsByTunnelId.get(tunnelId);
  if (!t || !t.reconnecting) return undefined;
  if (t.evictTimer) {
    clearTimeout(t.evictTimer);
    t.evictTimer = null;
  }
  t.conn = conn;
  t.reconnecting = false;
  conn.subdomains.add(t.subdomain);
  conn.tunnelIdToSubdomain.set(t.tunnelId, t.subdomain);
  return t;
}

export function tunnelCount(): number {
  return tunnelsBySubdomain.size;
}
