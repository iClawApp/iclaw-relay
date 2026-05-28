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
   */
  BASE_DOMAIN: z.string().min(1).default('iclaw.digital'),

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

/** Strongly-typed config object exported to the rest of the app. */
export const config = Object.freeze({
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  host: raw.HOST,
  baseDomain: raw.BASE_DOMAIN.replace(/\/+$/, ''),

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
