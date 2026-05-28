/**
 * Tunnel wire protocol (v0).
 *
 * Frames are sent as JSON text over a single WebSocket between the relay
 * and the local iClaw. All bodies are base64-encoded — there's no streaming
 * yet, requests and responses are fully buffered on each side.
 *
 *   relay  → iClaw : HelloFrame      (sent once, right after connect)
 *   relay  → iClaw : ReqFrame        (one per public HTTP request)
 *   iClaw  → relay : ResFrame        (one per ReqFrame, matched by `id`)
 *   either → either: PingFrame / PongFrame  (keep-alive, optional)
 *
 * Constraints / known limitations of v0:
 *   - No streaming (whole request and response bodies live in memory)
 *   - No SSE / chunked-encoding pass-through
 *   - No WebSocket upgrade *through* the tunnel
 *
 * These are intentional simplifications; we'll lift them once the basic
 * end-to-end path is proven.
 */

export interface HelloFrame {
  t: 'hello';
  /** The subdomain allocated to this tunnel (e.g. "silver-fox-7h3k"). */
  subdomain: string;
  /** Base domain under which the subdomain is reachable. */
  baseDomain: string;
  /** Convenience: public URL the operator can share with users. */
  publicUrl: string;
}

export interface ReqFrame {
  t: 'req';
  /** Correlation id; the matching ResFrame echoes this back. */
  id: string;
  method: string;
  /** Path + query string (no scheme/host). */
  path: string;
  /** Lower-cased header names → value. Hop-by-hop headers already stripped. */
  headers: Record<string, string>;
  /** Base64-encoded body, or empty string if none. */
  body: string;
}

export interface ResFrame {
  t: 'res';
  id: string;
  status: number;
  headers: Record<string, string>;
  /** Base64-encoded body, or empty string if none. */
  body: string;
}

export interface ErrFrame {
  t: 'err';
  /** Optional correlation id (set when the error is tied to a specific request). */
  id?: string;
  message: string;
}

export interface PingFrame {
  t: 'ping';
}

export interface PongFrame {
  t: 'pong';
}

export type Frame =
  | HelloFrame
  | ReqFrame
  | ResFrame
  | ErrFrame
  | PingFrame
  | PongFrame;

/**
 * Hop-by-hop headers (RFC 7230 §6.1) that must not be forwarded through a
 * proxy. We strip them on both sides.
 */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  // Not strictly hop-by-hop but irrelevant once we forward to a different host:
  'host',
  'content-length', // re-derived on the receiving side
]);

export function stripHopByHopHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    out[lower] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function parseFrame(raw: string): Frame | null {
  try {
    const obj = JSON.parse(raw) as Frame;
    if (typeof obj !== 'object' || obj === null || typeof (obj as { t?: unknown }).t !== 'string') {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}
