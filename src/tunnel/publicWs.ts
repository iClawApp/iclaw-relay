/**
 * Bridge a public-facing WebSocket onto an existing tunnel.
 *
 * One WS upgrade arriving at `<sub>.<baseDomain>/<path>` → relay
 * completes the handshake → relay sends a `ws-open` frame down the
 * tunnel's *iClaw* WS (the shared one for the whole iClaw process)
 * carrying both the `tunnelId` and a fresh stream id. Further data
 * goes back and forth as `ws-data`. Either side closing emits
 * `ws-close`.
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
  handleProtocols: () => false,
});

/**
 * Upper bound on concurrent public WS streams multiplexed onto a single
 * tunnel. A client past the access gate could otherwise open unbounded
 * sockets, each pinned in `tunnel.streams` and bridged to the shared iClaw
 * control WS. 256 is far above any real browser's needs.
 */
const MAX_STREAMS_PER_TUNNEL = 256;

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
  // Tunnel exists but its iClaw is in the reconnecting grace window — we
  // can't forward this WS upgrade. Refuse at the HTTP layer so the
  // browser sees a clean 503 rather than a black-hole socket.
  if (tunnel.reconnecting || !tunnel.conn || tunnel.conn.ws.readyState !== WebSocket.OPEN) {
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\n' +
      'Retry-After: 5\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n',
    );
    socket.destroy();
    return;
  }
  if (tunnel.streams.size >= MAX_STREAMS_PER_TUNNEL) {
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\n' +
      'Retry-After: 5\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n',
    );
    socket.destroy();
    return;
  }
  const iclawWs = tunnel.conn.ws;

  publicWss.handleUpgrade(req, socket, head, (publicWs) => {
    const streamId = generateStreamId();
    tunnel.streams.set(streamId, publicWs);

    if (config.logAccess) {
      console.log(`[tunnel] ws-open subdomain=${tunnel.subdomain} stream=${streamId}`);
    }

    const openFrame: WsOpenFrame = {
      t: 'ws-open',
      tunnelId: tunnel.tunnelId,
      id: streamId,
      path: req.url ?? '/',
      headers: stripHopByHopHeaders(req.headers),
    };

    if (iclawWs.readyState !== WebSocket.OPEN) {
      tunnel.streams.delete(streamId);
      try {
        publicWs.close(1011, 'tunnel gone');
      } catch {
        // ignore
      }
      return;
    }
    safeSend(iclawWs, JSON.stringify(openFrame));

    publicWs.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      const f: WsDataFrame = {
        t: 'ws-data',
        tunnelId: tunnel.tunnelId,
        id: streamId,
        binary: !!isBinary,
        data: buf.toString('base64'),
      };
      // tunnel.conn may have flipped to null during reconnect — guard.
      if (tunnel.conn) safeSend(tunnel.conn.ws, JSON.stringify(f));
    });

    publicWs.on('close', (code, reason) => {
      if (!tunnel.streams.delete(streamId)) return;
      const f: WsCloseFrame = {
        t: 'ws-close',
        tunnelId: tunnel.tunnelId,
        id: streamId,
        code,
        reason: reason && reason.length ? reason.toString('utf8') : undefined,
      };
      if (tunnel.conn) safeSend(tunnel.conn.ws, JSON.stringify(f));
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
  tunnel.streams.delete(frame.id);
  try {
    ws.close(frame.code, frame.reason);
  } catch {
    // ignore
  }
}
