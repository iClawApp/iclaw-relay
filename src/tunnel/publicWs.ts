/**
 * Bridge a public-facing WebSocket onto an existing tunnel.
 *
 * Lifecycle:
 *   - public client upgrades on `<sub>.<baseDomain>/<path>` → relay
 *   - relay completes the WS handshake itself (no subprotocol negotiation)
 *   - relay sends a `ws-open` frame down the tunnel with the path + headers
 *   - subsequent messages either way are wrapped in `ws-data` frames
 *   - close either side → `ws-close` frame + drop from the tunnel's
 *     `streams` map
 *
 * We intentionally do NOT replay the full TCP-level upgrade through the
 * tunnel. That would let us preserve subprotocol negotiation perfectly,
 * but iClaw's local /ws server doesn't use subprotocols, so the simpler
 * "two independent WS connections bridged by JSON frames" model is fine.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

import { generateStreamId } from './idGen';
import {
  stripHopByHopHeaders,
  type WsOpenFrame,
  type WsDataFrame,
  type WsCloseFrame,
} from './protocol';
import type { Tunnel } from './hub';
import { config } from '../config';

const publicWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  // Explicitly refuse subprotocols — see file comment.
  handleProtocols: () => false,
});

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(payload);
  } catch {
    // ignore — peer probably closed mid-write
  }
}

export function bridgePublicUpgrade(
  tunnel: Tunnel,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  publicWss.handleUpgrade(req, socket, head, (publicWs) => {
    const streamId = generateStreamId();
    tunnel.streams.set(streamId, publicWs);

    if (config.logAccess) {
      console.log(`[tunnel] ws-open subdomain=${tunnel.subdomain} stream=${streamId}`);
    }

    const openFrame: WsOpenFrame = {
      t: 'ws-open',
      id: streamId,
      path: req.url ?? '/',
      headers: stripHopByHopHeaders(req.headers),
    };

    if (tunnel.ws.readyState !== WebSocket.OPEN) {
      tunnel.streams.delete(streamId);
      try {
        publicWs.close(1011, 'tunnel gone');
      } catch {
        // ignore
      }
      return;
    }
    safeSend(tunnel.ws, JSON.stringify(openFrame));

    publicWs.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      const f: WsDataFrame = {
        t: 'ws-data',
        id: streamId,
        binary: !!isBinary,
        data: buf.toString('base64'),
      };
      safeSend(tunnel.ws, JSON.stringify(f));
    });

    publicWs.on('close', (code, reason) => {
      if (!tunnel.streams.delete(streamId)) {
        // Already removed (probably triggered by inbound ws-close) — don't double-notify.
        return;
      }
      const f: WsCloseFrame = {
        t: 'ws-close',
        id: streamId,
        code,
        reason: reason && reason.length ? reason.toString('utf8') : undefined,
      };
      safeSend(tunnel.ws, JSON.stringify(f));
      if (config.logAccess) {
        console.log(`[tunnel] ws-close subdomain=${tunnel.subdomain} stream=${streamId} code=${code}`);
      }
    });

    publicWs.on('error', () => {
      // 'close' fires next; cleanup happens there.
    });
  });
}

/** Forward a `ws-data` frame received from iClaw to its public peer. */
export function deliverWsData(tunnel: Tunnel, frame: WsDataFrame): void {
  const ws = tunnel.streams.get(frame.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary });
  } catch {
    // ignore
  }
}

/** Forward a `ws-close` frame received from iClaw to its public peer. */
export function deliverWsClose(tunnel: Tunnel, frame: WsCloseFrame): void {
  const ws = tunnel.streams.get(frame.id);
  if (!ws) return;
  // Remove first so the public 'close' handler doesn't echo a frame back.
  tunnel.streams.delete(frame.id);
  try {
    ws.close(frame.code, frame.reason);
  } catch {
    // ignore
  }
}
