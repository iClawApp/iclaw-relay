/**
 * HTTP proxy middleware.
 *
 * For any request whose Host header matches `<subdomain>.<baseDomain>`,
 * locate the tunnel, forward the request as a `req` frame over the
 * owning iClaw WS (a single WS may carry many tunnels), then write the
 * `res` frame back as a normal HTTP response.
 *
 * Falls through (`next()`) when the Host has no subdomain or no
 * matching tunnel exists.
 */

import type { RequestHandler } from 'express';
import { config } from '../config';
import { getTunnelBySubdomain } from './hub';
import { generateRequestId } from './idGen';
import { extractSubdomain } from './host';
import {
  parseFrame,
  stripHopByHopHeaders,
  type ReqFrame,
  type ResFrame,
  type ErrFrame,
} from './protocol';
import { renderTunnelNotFoundPage } from './tunnelNotFoundPage';
import { renderReconnectingPage } from './reconnectingPage';
import { applyHttpAccessGate } from './accessGate';
import { captureEnabled, captureRelayFrame } from './captureFrame';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Hard cap on a single forwarded request body. Two reasons:
 *  - Unbounded buffering lets a few concurrent large POSTs exhaust relay RAM.
 *  - The forwarded `req` frame base64-encodes the body (+~33%) and wraps it in
 *    JSON, all sent over the shared iClaw control WS whose `maxPayload` is
 *    16 MiB. A body that crosses that ceiling would kill the control socket —
 *    taking *every* tunnel on it down, not just this request. Keep the limit
 *    comfortably below 16 MiB once base64 + JSON overhead is accounted for.
 */
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

async function readRequestBody(req: Parameters<RequestHandler>[0]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const tunnelProxy: RequestHandler = (req, res, next) => {
  const subdomain = extractSubdomain(req.headers.host, config.baseDomain);
  if (!subdomain) return next();

  const tunnel = getTunnelBySubdomain(subdomain);
  if (!tunnel) {
    res.status(404).type('html').send(renderTunnelNotFoundPage());
    return;
  }
  // Sticky subdomain — iClaw lost its WS but its tunnel is reserved.
  // Tell the browser to retry shortly; the URL is still valid.
  if (tunnel.reconnecting || !tunnel.conn || tunnel.conn.ws.readyState !== 1) {
    res.status(503).setHeader('Retry-After', '5');
    res.type('html').send(renderReconnectingPage());
    return;
  }

  if (!applyHttpAccessGate(tunnel, req, res)) {
    return;
  }

  // Forward request → frame → iClaw conn WS → await `res` frame.
  void (async () => {
    try {
      const body = await readRequestBody(req);
      const id = generateRequestId();

      const reqFrame: ReqFrame = {
        t: 'req',
        tunnelId: tunnel.tunnelId,
        id,
        method: req.method,
        path: req.originalUrl,
        headers: stripHopByHopHeaders(req.headers),
        body: body.length > 0 ? body.toString('base64') : '',
      };

      const responseRaw = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          tunnel.pending.delete(id);
          reject(new Error('tunnel timeout'));
        }, REQUEST_TIMEOUT_MS);
        tunnel.pending.set(id, { resolve, reject, timer });
        if (!tunnel.conn || tunnel.conn.ws.readyState !== 1) {
          clearTimeout(timer);
          tunnel.pending.delete(id);
          reject(new Error('tunnel reconnecting'));
          return;
        }
        tunnel.conn.ws.send(JSON.stringify(reqFrame));
      });

      const frame = parseFrame(responseRaw);
      if (!frame) {
        res.status(502).type('text/plain').send('bad gateway: malformed frame');
        return;
      }

      if (frame.t === 'err') {
        const ef = frame as ErrFrame;
        res.status(502).type('text/plain').send(`bad gateway: ${ef.message}`);
        return;
      }

      if (frame.t !== 'res') {
        res.status(502).type('text/plain').send('bad gateway: unexpected frame');
        return;
      }

      const resFrame = frame as ResFrame;

      if (captureEnabled()) {
        captureRelayFrame({
          subdomain,
          tunnelId: tunnel.tunnelId,
          outer: {
            method: req.method,
            path: req.originalUrl,
            headers: req.headers as Record<string, unknown>,
          },
          reqBodyB64: reqFrame.body,
          resBodyB64: resFrame.body ?? '',
          status: resFrame.status,
          ts: Date.now(),
        });
      }

      res.status(resFrame.status);
      for (const [k, v] of Object.entries(resFrame.headers)) {
        res.setHeader(k, v);
      }
      if (resFrame.body) {
        res.end(Buffer.from(resFrame.body, 'base64'));
      } else {
        res.end();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'tunnel error';
      if (!res.headersSent) {
        if (err instanceof PayloadTooLargeError) {
          res.status(413).type('text/plain').send('payload too large');
        } else {
          res.status(504).type('text/plain').send(`gateway timeout: ${message}`);
        }
      } else {
        res.end();
      }
    }
  })();
};
