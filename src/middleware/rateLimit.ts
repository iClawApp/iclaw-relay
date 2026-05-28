/**
 * Per-IP rate limits.
 *
 * Two separate limiters:
 *   - registerLimiter: throttles tunnel registration (one budget per hour).
 *   - inviteLimiter:   throttles first-access / invite validation (cheap, generous).
 *
 * Both key off `req.ip`, which respects `app.set('trust proxy', …)` in
 * index.ts when running behind a reverse proxy.
 *
 * NOTE: These are scaffolded but not yet wired to real endpoints — the
 * tunnel/invite routes land in follow-up work on the `dev` branch.
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const registerLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1 hour
  limit: config.limits.registerPerIpPerHour,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many tunnel registrations from this IP — slow down a bit' },
});

export const inviteLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: config.limits.invitePerIpPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many invite attempts from this IP' },
});
