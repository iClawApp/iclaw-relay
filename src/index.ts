/**
 * iclaw-relay entry point.
 *
 *   /healthz                     → liveness probe (apex domain)
 *   ws  /tunnel                  → outbound-WS endpoint for local iClaw instances
 *   any  <sub>.<baseDomain>/*    → forwarded to the matching tunnel
 *
 * Order matters: helmet + cors run before routes, the tunnel proxy is the
 * catch-all just before the error handler. We deliberately do NOT install
 * express.json globally — the proxy needs the raw request body for any
 * content type, so JSON parsing belongs on specific routes only.
 */

import { createServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';

import { config } from './config';
import { healthRouter } from './routes/health';
import { errorHandler } from './middleware/errorHandler';
import { attachTunnelWs } from './tunnel/wsServer';
import { tunnelProxy } from './tunnel/httpProxy';
import { extractSubdomain } from './tunnel/host';

function buildApp(): express.Express {
  const app = express();

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // Helmet only on the relay's own routes (apex domain). For tunneled
  // subdomain requests the response body is iClaw's — we're just a byte
  // forwarder and have no business setting CSP/HSTS/COOP on content we
  // never inspect. helmet's defaults (upgrade-insecure-requests,
  // form-action 'self', HSTS) also break legitimate http-only local-dev
  // tunnels (broken form submits, ERR_SSL_PROTOCOL_ERROR on /favicon.ico,
  // etc.).
  const helmetMiddleware = helmet();
  app.use((req, res, next) => {
    if (extractSubdomain(req.headers.host, config.baseDomain)) {
      return next();
    }
    helmetMiddleware(req, res, next);
  });
  app.use(compression());

  app.use(
    cors({
      origin: (origin, cb) => {
        const allow = config.cors.allowedOrigins;
        if (allow === '*') return cb(null, true);
        if (!origin) return cb(null, true);
        if (allow.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );

  app.use(healthRouter);

  // Tunnel proxy is the catch-all: it inspects the Host header, forwards to
  // the matching tunnel, or calls `next()` to let normal apex routes run.
  app.use(tunnelProxy);

  app.use(errorHandler);
  return app;
}

function main(): void {
  const app = buildApp();
  const server = createServer(app);
  attachTunnelWs(server);

  server.listen(config.port, config.host, () => {
    console.log(
      `[iclaw-relay] listening on ${config.host}:${config.port} (${config.env}, base=${config.baseDomain})`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[iclaw-relay] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
