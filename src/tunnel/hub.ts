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
  /** SHA-256(access token) base64url — relay never stores plaintext token. */
  tokenHash: string | null;
  /**
   * SHA-256(tunnel ownership secret) base64url, or null for tunnels first
   * registered by a legacy client that sent no ownerProof. When non-null, a
   * reconnect-restore or token rotation for this tunnelId MUST present a
   * matching ownerProof — this is what stops a stranger who knows only the
   * tunnelId from hijacking the subdomain.
   */
  ownerHash: string | null;
  /**
   * Access sessions issued after a successful ?access= check, validated via
   * the HttpOnly cookie. A SET (not a single value) so multiple devices /
   * tabs can hold the gate concurrently — one visitor activating the link no
   * longer evicts another. Bounded + cleared on token rotation.
   */
  accessSessions: Set<string>;
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
  t.tokenHash = null;
  t.ownerHash = null;
  t.accessSessions.clear();
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
 * Move an existing tunnel onto `conn`, preserving its subdomain. Handles both
 * cases that a re-registering iClaw can hit:
 *   - the tunnel is in the reconnecting grace window (normal sticky restore);
 *   - the tunnel is still bound to a now-stale connection (e.g. the old socket
 *     hasn't been reaped yet) — we detach it there first so a live tunnel's
 *     registry entry is never silently orphaned.
 *
 * Returns the tunnel, or undefined when no tunnel with that id exists.
 *
 * SECURITY: this performs NO ownership check. The caller (handleRegister) must
 * verify the ownerProof against `tunnel.ownerHash` before calling, otherwise
 * any connection could claim any tunnelId.
 */
export function reassignTunnelToConn(
  tunnelId: string,
  conn: IclawConnection,
): Tunnel | undefined {
  const t = tunnelsByTunnelId.get(tunnelId);
  if (!t) return undefined;
  // Detach from a previous, different connection if one is still attached.
  if (t.conn && t.conn !== conn) {
    t.conn.subdomains.delete(t.subdomain);
    t.conn.tunnelIdToSubdomain.delete(t.tunnelId);
  }
  // Close any per-connection state tied to the previous owner (in-flight
  // requests / public WS streams). No-op if it was already reconnecting.
  detachConnState(t);
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
