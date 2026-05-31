/**
 * Per-IP rate limiter for new tunnel registrations.
 *
 * Sliding-window-ish: a fixed window that resets when the elapsed time
 * crosses the window boundary. Good enough for anti-abuse — we don't
 * need cryptographic accuracy, just a way to refuse the 11th tunnel from
 * the same IP in a day.
 *
 * Process-local on purpose. The relay is intentionally stateless across
 * restarts; an attacker who can survive long enough to restart us has
 * bigger problems for us to worry about.
 */

interface CountWindow {
  startAt: number;
  count: number;
}

interface IpRecord {
  hour: CountWindow;
  day: CountWindow;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 10 * 60 * 1000;

const records = new Map<string, IpRecord>();

export interface TunnelRateLimits {
  perHour: number;
  perDay: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Which window tripped — 'hourly' | 'daily' — when `ok` is false. */
  reason?: 'hourly' | 'daily';
  /** Seconds the client should wait before retrying. Best-effort estimate. */
  retryAfterSec?: number;
}

function emptyRecord(now: number): IpRecord {
  return {
    hour: { startAt: now, count: 0 },
    day: { startAt: now, count: 0 },
  };
}

/**
 * Check + increment in one shot. Returns ok=true and records the
 * registration on success; returns ok=false (no increment) on refusal.
 */
export function checkAndCountTunnelRegistration(
  ip: string,
  limits: TunnelRateLimits,
): RateLimitResult {
  const now = Date.now();
  let rec = records.get(ip);
  if (!rec) {
    rec = emptyRecord(now);
    records.set(ip, rec);
  }

  // Roll windows that have fully elapsed.
  if (now - rec.hour.startAt >= HOUR_MS) {
    rec.hour = { startAt: now, count: 0 };
  }
  if (now - rec.day.startAt >= DAY_MS) {
    rec.day = { startAt: now, count: 0 };
  }

  if (rec.hour.count >= limits.perHour) {
    const retryAfterSec = Math.max(1, Math.ceil((HOUR_MS - (now - rec.hour.startAt)) / 1000));
    return { ok: false, reason: 'hourly', retryAfterSec };
  }
  if (rec.day.count >= limits.perDay) {
    const retryAfterSec = Math.max(1, Math.ceil((DAY_MS - (now - rec.day.startAt)) / 1000));
    return { ok: false, reason: 'daily', retryAfterSec };
  }

  rec.hour.count += 1;
  rec.day.count += 1;
  return { ok: true };
}

/**
 * Test-only helper: wipe every IP's counters. Not exported through the
 * public barrel; tests reach in via the module.
 */
export function __resetForTests(): void {
  records.clear();
}

// Periodic garbage collection: drop IPs whose both windows are expired so
// the map doesn't grow unbounded over the lifetime of the process.
const gcTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of records) {
    if (
      now - rec.day.startAt >= DAY_MS &&
      now - rec.hour.startAt >= HOUR_MS
    ) {
      records.delete(ip);
    }
  }
}, GC_INTERVAL_MS);
gcTimer.unref();
