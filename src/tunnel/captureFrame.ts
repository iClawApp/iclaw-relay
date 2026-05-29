/**
 * TEST-ONLY traffic capture.
 *
 * When `config.captureFile` is set (hard-gated to NODE_ENV=test in config.ts),
 * the relay appends a JSONL record of every request it forwards to an iClaw
 * tunnel. Each record holds the *outer* public request (method/path/headers)
 * plus the forwarded `req`/`res` frame bodies the relay actually sees.
 *
 * Purpose: the E2E integration test reads this file to prove the relay only
 * ever handles ciphertext envelopes on the E2E endpoints and to detect any
 * plaintext passphrase / session-cookie leakage in what the relay touches.
 *
 * This module is a no-op unless the capture file is configured, so importing
 * it from the hot path is cheap in normal operation.
 */

import { appendFileSync } from 'node:fs';
import { config } from '../config';

export interface RelayCaptureRecord {
  /** Tunnel subdomain that received the request. */
  subdomain: string;
  tunnelId: string;
  /** Outer public request as the relay received it. */
  outer: {
    method: string;
    path: string;
    headers: Record<string, unknown>;
  };
  /** The `req` frame body (base64) the relay forwarded down the WS. */
  reqBodyB64: string;
  /** The `res` frame body (base64) the relay sent back, if any. */
  resBodyB64: string;
  /** Response status the relay returned to the public client. */
  status: number;
  ts: number;
}

/**
 * Append one capture record. No-op unless `config.captureFile` is set.
 * Swallows write errors — capture is a test aid, never load-bearing.
 */
export function captureRelayFrame(record: RelayCaptureRecord): void {
  const file = config.captureFile;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* capture must never break the proxy path */
  }
}

/** Whether capture is active (lets the hot path skip building records). */
export function captureEnabled(): boolean {
  return config.captureFile !== null;
}
