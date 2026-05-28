/**
 * In-memory registry of live tunnels, keyed by subdomain.
 *
 * Process-local on purpose — the relay is intentionally stateless across
 * restarts. When a tunnel WS closes, its entry vanishes and the subdomain
 * stops resolving.
 */

import type { WebSocket } from 'ws';

export interface PendingRequest {
  resolve(headFrameJson: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface Tunnel {
  subdomain: string;
  ws: WebSocket;
  createdAt: number;
  /** Open HTTP requests waiting for their matching `res` frame. */
  pending: Map<string, PendingRequest>;
  /** Open public-side WebSocket streams, keyed by stream id. */
  streams: Map<string, WebSocket>;
}

const tunnels = new Map<string, Tunnel>();

export function addTunnel(t: Tunnel): void {
  tunnels.set(t.subdomain, t);
}

export function removeTunnel(subdomain: string): void {
  const t = tunnels.get(subdomain);
  if (!t) return;
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
  tunnels.delete(subdomain);
}

export function getTunnel(subdomain: string): Tunnel | undefined {
  return tunnels.get(subdomain);
}

export function tunnelCount(): number {
  return tunnels.size;
}
