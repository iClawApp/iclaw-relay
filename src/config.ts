/**
 * Centralised, validated configuration.
 *
 * `config.ts` is the ONLY place that reads `process.env`. Every other module
 * imports values from `config`, so we get:
 *   - a single point of validation (fail-fast on missing/invalid env at boot)
 *   - strict typing (no `string | undefined` leaking through the codebase)
 *   - one obvious place to document each knob
 *
 * `dotenv` is loaded here too, so importing this module anywhere automatically
 * sets up the environment.
 */

import 'dotenv/config';
import { z } from 'zod';

/* ---------------------------------------------------------------- schema -- */

const RawConfigSchema = z.object({
  /** Node lifecycle mode. Production tightens CORS + disables verbose errors. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** HTTP port. */
  PORT: z.coerce.number().int().positive().default(4100),

  /**
   * Bind address for the HTTP server.
   * Default to localhost so the app is private behind nginx/cloudflared.
   */
  HOST: z.string().min(1).default('127.0.0.1'),

  /**
   * Base domain under which per-tunnel subdomains are minted, e.g.
   * a tunnel "silver-fox" → https://silver-fox.iclaw.digital
   *
   * For local browser testing, set this to `lvh.me` (or `<ip>.nip.io`) —
   * those wildcards resolve to 127.0.0.1 automatically, so the URL we
   * print is openable directly in the browser without /etc/hosts.
   */
  BASE_DOMAIN: z.string().min(1).default('iclaw.digital'),

  /**
   * Scheme used when constructing the public tunnel URL we report back to
   * the iClaw client. In production this is `https` (the relay sits
   * behind a TLS terminator); in local dev set to `http` so the printed
   * URL is openable in a browser without TLS.
   */
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),

  /**
   * Port to include in the public tunnel URL. Leave empty in production
   * (so the URL uses the default 80/443). In local dev set to the same
   * value as PORT (e.g. 4100) so browsers can reach the relay directly.
   */
  PUBLIC_PORT: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`PUBLIC_PORT must be 1..65535, got ${v}`);
      }
      return n;
    }),

  /**
   * Comma-separated list of origins allowed for the public HTTP API.
   * Special value "*" allows any origin — convenient for dev, never in prod.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:4100'),

  /** Per-IP rate limit for tunnel registration (requests per hour). */
  RATE_LIMIT_REGISTER_PER_IP_HOUR: z.coerce.number().int().positive().default(20),

  /** Per-IP rate limit for first-access / invite validation (requests per minute). */
  RATE_LIMIT_INVITE_PER_IP_MINUTE: z.coerce.number().int().positive().default(60),

  /**
   * If true, log tunnel register/connect/disconnect events (subdomain,
   * ip-hash). NEVER logs request/response bodies regardless of this flag.
   */
  LOG_ACCESS: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  /**
   * Trust upstream proxy headers (X-Forwarded-For). Set to "1" when behind
   * Cloudflare / nginx so rate-limiting keys off the real client IP.
   */
  TRUST_PROXY: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
});

/* ---------------------------------------------------------------- parse -- */

const parsed = RawConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[config] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.error(`  - ${path}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

/** Derived: split ALLOWED_ORIGINS into a clean array. */
function parseAllowedOrigins(input: string): readonly string[] | '*' {
  const trimmed = input.trim();
  if (trimmed === '*') return '*';
  return Object.freeze(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function buildPublicUrl(subdomain: string): string {
  const scheme = raw.PUBLIC_SCHEME;
  const port = raw.PUBLIC_PORT;
  const base = raw.BASE_DOMAIN.replace(/\/+$/, '');
  // Omit the port suffix when it matches the scheme's default.
  const isDefaultPort =
    (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
  const portSuffix = port === undefined || isDefaultPort ? '' : `:${port}`;
  return `${scheme}://${subdomain}.${base}${portSuffix}`;
}

/** Strongly-typed config object exported to the rest of the app. */
export const config = Object.freeze({
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  host: raw.HOST,
  baseDomain: raw.BASE_DOMAIN.replace(/\/+$/, ''),
  publicScheme: raw.PUBLIC_SCHEME,
  publicPort: raw.PUBLIC_PORT,

  /** Build the user-facing URL for a tunnel subdomain. */
  publicUrlFor: buildPublicUrl,

  cors: Object.freeze({
    allowedOrigins: parseAllowedOrigins(raw.ALLOWED_ORIGINS),
  }),

  limits: Object.freeze({
    registerPerIpPerHour: raw.RATE_LIMIT_REGISTER_PER_IP_HOUR,
    invitePerIpPerMinute: raw.RATE_LIMIT_INVITE_PER_IP_MINUTE,
  }),

  logAccess: raw.LOG_ACCESS,
  trustProxy: raw.TRUST_PROXY,
});

/** Public type so callers can declare config-shaped params. */
export type AppConfig = typeof config;
