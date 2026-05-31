import { describe, expect, it } from 'vitest';

import {
  MAX_TUNNEL_CONNS,
  MAX_TUNNEL_CONNS_PER_IP,
  wouldExceedConnCap,
} from './wsServer';

describe('tunnel connection cap (M6)', () => {
  it('admits a connection under both limits', () => {
    expect(wouldExceedConnCap({ total: 0, perIp: 0, isLoopback: false })).toBe(false);
    expect(
      wouldExceedConnCap({
        total: MAX_TUNNEL_CONNS - 1,
        perIp: MAX_TUNNEL_CONNS_PER_IP - 1,
        isLoopback: false,
      }),
    ).toBe(false);
  });

  it('refuses at the global cap regardless of per-IP count', () => {
    expect(wouldExceedConnCap({ total: MAX_TUNNEL_CONNS, perIp: 0, isLoopback: false })).toBe(true);
  });

  it('refuses at the per-IP cap', () => {
    expect(
      wouldExceedConnCap({ total: 0, perIp: MAX_TUNNEL_CONNS_PER_IP, isLoopback: false }),
    ).toBe(true);
  });

  it('exempts loopback from the per-IP cap but not the global cap', () => {
    // Local-mode dev hammers reconnects from 127.0.0.1 — never per-IP capped.
    expect(
      wouldExceedConnCap({
        total: 0,
        perIp: MAX_TUNNEL_CONNS_PER_IP + 1000,
        isLoopback: true,
      }),
    ).toBe(false);
    // ...but the global ceiling still protects the process.
    expect(wouldExceedConnCap({ total: MAX_TUNNEL_CONNS, perIp: 0, isLoopback: true })).toBe(true);
  });
});
