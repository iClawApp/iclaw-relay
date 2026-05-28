/**
 * WebSocket upgrade router.
 *
 * Two kinds of upgrades land on this server:
 *
 *   1. POST-style outbound from a local iClaw:  ws://relay/tunnel
 *      → register a new tunnel, allocate subdomain, send `hello`.
 *
 *   2. Public client opening a WS on a tunnel subdomain:
 *      ws(s)://<sub>.<baseDomain>/<anything>
 *      → bridge it onto the existing tunnel as a `ws-open` stream.
 *
 * Both flows share the same Node http.Server `upgrade` event; we discriminate
 * by the path AND the Host header.
 *
 * Auth / invite-token validation is NOT yet wired here for the tunnel
 * registration path. The password gate on the iClaw side guards the public
 * stream (we forward the upgrade headers including Cookie, iClaw verifies
 * the session before opening the loopback WS).
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { config } from '../config';
import { addTunnel, getTunnel, removeTunnel, type Tunnel } from './hub';
import { generateSubdomain } from './idGen';
import { extractSubdomain } from './host';
import { parseFrame, type HelloFrame } from './protocol';
import { bridgePublicUpgrade, deliverWsData, deliverWsClose } from './publicWs';

const TUNNEL_PATH = '/tunnel';

export function attachTunnelWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // (1) Outbound iClaw client registering a new tunnel.
    if (url.pathname === TUNNEL_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws));
      return;
    }

    // (2) Public client connecting to <sub>.<baseDomain>/*.
    const sub = extractSubdomain(req.headers.host, config.baseDomain);
    if (sub) {
      const tunnel = getTunnel(sub);
      if (!tunnel) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      bridgePublicUpgrade(tunnel, req, socket, head);
      return;
    }

    // Neither — refuse.
    socket.destroy();
  });
}

function handleTunnel(ws: WebSocket): void {
  const subdomain = generateSubdomain();
  const tunnel: Tunnel = {
    subdomain,
    ws,
    createdAt: Date.now(),
    pending: new Map(),
    streams: new Map(),
  };
  addTunnel(tunnel);

  if (config.logAccess) {
    console.log(`[tunnel] open subdomain=${subdomain}`);
  }

  const hello: HelloFrame = {
    t: 'hello',
    subdomain,
    baseDomain: config.baseDomain,
    publicUrl: `https://${subdomain}.${config.baseDomain}`,
  };
  ws.send(JSON.stringify(hello));

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const frame = parseFrame(raw);
    if (!frame) return;

    // HTTP request/response correlation.
    if (frame.t === 'res' || frame.t === 'err') {
      const id = frame.id;
      if (!id) return;
      const pending = tunnel.pending.get(id);
      if (!pending) return;
      tunnel.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(raw);
      return;
    }

    // WS-stream correlation.
    if (frame.t === 'ws-data') {
      deliverWsData(tunnel, frame);
      return;
    }
    if (frame.t === 'ws-close') {
      deliverWsClose(tunnel, frame);
      return;
    }

    if (frame.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    // Unknown frames are ignored — be lenient with peers running newer protocol versions.
  });

  const cleanup = (): void => {
    removeTunnel(subdomain);
    if (config.logAccess) {
      console.log(`[tunnel] close subdomain=${subdomain}`);
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`[tunnel] ws error subdomain=${subdomain} :: ${err.message}`);
    cleanup();
  });
}
