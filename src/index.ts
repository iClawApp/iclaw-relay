/**
 * iclaw-relay entry point.
 *
 *   /healthz   → liveness probe
 *
 * Tunnel routing (outbound-WS hub + per-subdomain forwarding) lands on the
 * `dev` branch as follow-up work; the skeleton here just stands up the HTTP
 * surface and middleware stack.
 *
 * Order matters: helmet + cors run before routes, error handler is last.
 */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';

import { config } from './config';
import { healthRouter } from './routes/health';
import { errorHandler } from './middleware/errorHandler';

function buildApp(): express.Express {
  const app = express();

  if (config.trustProxy) {
    // Behind Cloudflare / nginx: trust the first proxy hop so req.ip becomes
    // the real client IP for rate limiting.
    app.set('trust proxy', 1);
  }

  app.use(helmet());
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

  app.use(express.json({ limit: '32kb' }));

  app.use(healthRouter);

  app.use(errorHandler);
  return app;
}

function main(): void {
  const app = buildApp();
  const server = app.listen(config.port, config.host, () => {
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
