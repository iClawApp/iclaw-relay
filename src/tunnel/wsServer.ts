/**
 * WebSocket upgrade handler for outbound tunnels.
 *
 * iClaw connects out to `ws(s)://relay/tunnel`. We allocate a subdomain,
 * register the tunnel in the hub, send a `hello` frame, and route `res`
 * frames back to the matching pending request.
 *
 * Auth / invite-token validation is NOT yet wired here — that lands on
 * follow-up work along with rate limiting. For this slice anyone can open a
 * tunnel, which is fine for local development behind 127.0.0.1.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { config } from '../config';
import { addTunnel, removeTunnel, type Tunnel } from './hub';
import { generateSubdomain } from './idGen';
import { parseFrame, type HelloFrame } from './protocol';

const TUNNEL_PATH = '/tunnel';

export function attachTunnelWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== TUNNEL_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws));
  });
}

function handleTunnel(ws: WebSocket): void {
  const subdomain = generateSubdomain();
  const tunnel: Tunnel = {
    subdomain,
    ws,
    createdAt: Date.now(),
    pending: new Map(),
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

    if (frame.t === 'res' || frame.t === 'err') {
      const id = frame.t === 'res' ? frame.id : frame.id;
      if (!id) return;
      const pending = tunnel.pending.get(id);
      if (!pending) return;
      tunnel.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(raw);
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
