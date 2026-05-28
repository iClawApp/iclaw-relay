/**
 * HTTP proxy middleware.
 *
 * For any request whose Host header matches `<subdomain>.<baseDomain>`,
 * locate the tunnel and forward the request as a `req` frame, then write
 * the `res` frame back as a normal HTTP response.
 *
 * Falls through (calls `next()`) when the Host header has no subdomain or
 * no matching tunnel exists — that lets normal routes (e.g. /healthz) keep
 * working on the apex domain in production.
 */

import type { RequestHandler } from 'express';
import { config } from '../config';
import { getTunnel } from './hub';
import { generateRequestId } from './idGen';
import {
  parseFrame,
  stripHopByHopHeaders,
  type ReqFrame,
  type ResFrame,
  type ErrFrame,
} from './protocol';

const REQUEST_TIMEOUT_MS = 30_000;

function extractSubdomain(hostHeader: string | undefined, baseDomain: string): string | null {
  if (!hostHeader) return null;
  // Strip port if present.
  const host = hostHeader.split(':')[0].toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  // Reject empty / nested subdomains for now.
  if (!sub || sub.includes('.')) return null;
  return sub;
}

async function readRequestBody(req: Parameters<RequestHandler>[0]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const tunnelProxy: RequestHandler = (req, res, next) => {
  const subdomain = extractSubdomain(req.headers.host, config.baseDomain);
  if (!subdomain) return next();

  const tunnel = getTunnel(subdomain);
  if (!tunnel) {
    res.status(404).type('text/plain').send('tunnel not found');
    return;
  }

  // Forward request → frame → tunnel WS → await `res` frame.
  void (async () => {
    try {
      const body = await readRequestBody(req);
      const id = generateRequestId();

      const reqFrame: ReqFrame = {
        t: 'req',
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
        tunnel.ws.send(JSON.stringify(reqFrame));
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
        res.status(504).type('text/plain').send(`gateway timeout: ${message}`);
      } else {
        res.end();
      }
    }
  })();
};
