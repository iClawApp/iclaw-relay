/**
 * Integration tests for the iClaw→relay control protocol over REAL sockets.
 *
 * These exercise the register/restore/ownership state machine in wsServer.ts —
 * the highest-risk code in the relay and the H1 subdomain-hijack defence —
 * end to end: an actual HTTP server with attachTunnelWs(), driven by a real
 * `ws` client speaking the JSON frame protocol. No mocking of the hub.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { attachTunnelWs } from './wsServer';
import { __resetRegistryForTests, getTunnelByTunnelIdGlobal } from './hub';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer();
  attachTunnelWs(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetRegistryForTests();
});

/* ----------------------------------------------------------------- helpers */

const sockets: WebSocket[] = [];

afterEach(async () => {
  // Close every socket a test opened and wait for each to actually close so the
  // next test starts from a clean connection table.
  await Promise.all(
    sockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.on('close', () => resolve());
          try {
            ws.close();
          } catch {
            resolve();
          }
        }),
    ),
  );
});

interface Frame {
  t: string;
  [k: string]: unknown;
}

/** Open a control connection to /tunnel and return a small frame-driver. */
async function connect(): Promise<{
  ws: WebSocket;
  send(frame: Frame): void;
  next(timeoutMs?: number): Promise<Frame>;
  closeAndWait(): Promise<void>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  sockets.push(ws);
  const queue: Frame[] = [];
  let waiter: ((f: Frame) => void) | null = null;

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (waiter) {
      waiter(frame);
      waiter = null;
    } else {
      queue.push(frame);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  return {
    ws,
    send(frame: Frame) {
      ws.send(JSON.stringify(frame));
    },
    next(timeoutMs = 2000): Promise<Frame> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        waiter = (f) => {
          clearTimeout(timer);
          resolve(f);
        };
      });
    },
    closeAndWait() {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.on('close', () => resolve());
        ws.close();
      });
    },
  };
}

function mkTunnelId(): string {
  return `t-${randomBytes(16).toString('hex')}`;
}
function mkToken(): string {
  return randomBytes(32).toString('base64url');
}
function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('base64url');
}

/** Wait until `predicate()` is true, polling briefly (server close is async). */
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ------------------------------------------------------------------- tests */

describe('register-tunnel: validation', () => {
  it('rejects an empty tunnelId', async () => {
    const c = await connect();
    c.send({ t: 'register-tunnel', tunnelId: '', tokenHash: hash(mkToken()) });
    const f = await c.next();
    expect(f.t).toBe('tunnel-rejected');
    expect(f.reason).toBe('invalid tunnelId');
  });

  it('rejects a malformed tokenHash', async () => {
    const c = await connect();
    c.send({ t: 'register-tunnel', tunnelId: mkTunnelId(), tokenHash: 'too-short' });
    const f = await c.next();
    expect(f.t).toBe('tunnel-rejected');
    expect(f.reason).toBe('invalid tokenHash');
  });
});

describe('register-tunnel: fresh + idempotent', () => {
  it('assigns a subdomain + publicUrl on first register', async () => {
    const c = await connect();
    const tunnelId = mkTunnelId();
    c.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: mkToken() });
    const f = await c.next();
    expect(f.t).toBe('tunnel-registered');
    expect(f.tunnelId).toBe(tunnelId);
    expect(typeof f.subdomain).toBe('string');
    expect(String(f.subdomain).length).toBeGreaterThan(0);
    expect(String(f.publicUrl)).toContain(String(f.subdomain));
  });

  it('keeps the same subdomain on idempotent re-register over one connection', async () => {
    const c = await connect();
    const tunnelId = mkTunnelId();
    const proof = mkToken();
    c.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const first = await c.next();
    c.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const second = await c.next();
    expect(second.t).toBe('tunnel-registered');
    expect(second.subdomain).toBe(first.subdomain);
  });
});

describe('restore across connections (H1 ownership)', () => {
  it('preserves the subdomain when the real owner reconnects with the proof', async () => {
    const tunnelId = mkTunnelId();
    const proof = mkToken();

    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const reg = await c1.next();
    const subdomain = reg.subdomain;

    // Owner drops; wait for the relay to move the tunnel into the grace window.
    await c1.closeAndWait();
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId)?.reconnecting === true);

    // Owner reconnects on a fresh socket WITH the correct proof → same URL.
    const c2 = await connect();
    c2.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const restored = await c2.next();
    expect(restored.t).toBe('tunnel-registered');
    expect(restored.subdomain).toBe(subdomain);
  });

  it('rejects a reconnecting-window claim with NO proof and leaves the victim intact', async () => {
    const tunnelId = mkTunnelId();
    const proof = mkToken();

    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const reg = await c1.next();
    const subdomain = reg.subdomain;

    await c1.closeAndWait();
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId)?.reconnecting === true);

    // Attacker knows the tunnelId but not the proof.
    const attacker = await connect();
    attacker.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()) });
    const rejected = await attacker.next();
    expect(rejected.t).toBe('tunnel-rejected');
    expect(rejected.reason).toBe('ownership proof required');

    // Victim's reservation is untouched: the real owner can still restore it.
    const owner = await connect();
    owner.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const restored = await owner.next();
    expect(restored.t).toBe('tunnel-registered');
    expect(restored.subdomain).toBe(subdomain);
  });

  it('rejects a WRONG proof', async () => {
    const tunnelId = mkTunnelId();
    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: mkToken() });
    await c1.next();
    await c1.closeAndWait();
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId)?.reconnecting === true);

    const attacker = await connect();
    attacker.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: mkToken() });
    const f = await attacker.next();
    expect(f.t).toBe('tunnel-rejected');
    expect(f.reason).toBe('ownership proof required');
  });

  it('blocks an ACTIVE hijack: a 2nd live conn cannot steal an owned tunnelId', async () => {
    const tunnelId = mkTunnelId();
    const proof = mkToken();
    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const reg = await c1.next();

    // c1 stays OPEN. Attacker races a register for the same id on another conn.
    const attacker = await connect();
    attacker.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: mkToken() });
    const f = await attacker.next();
    expect(f.t).toBe('tunnel-rejected');

    // The original tunnel is still bound to c1's subdomain.
    expect(getTunnelByTunnelIdGlobal(tunnelId)?.subdomain).toBe(reg.subdomain);
  });
});

describe('legacy tunnels (backward compat)', () => {
  it('lets a no-proof legacy tunnel be restored, then adopts the first proof presented', async () => {
    const tunnelId = mkTunnelId();

    // Legacy client: registers WITHOUT an ownerProof → ownerHash stays null.
    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()) });
    const reg = await c1.next();
    expect(getTunnelByTunnelIdGlobal(tunnelId)?.ownerHash).toBeNull();

    await c1.closeAndWait();
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId)?.reconnecting === true);

    // Newer client reconnects WITH a proof → restore allowed, proof adopted.
    const proof = mkToken();
    const c2 = await connect();
    c2.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: proof });
    const restored = await c2.next();
    expect(restored.subdomain).toBe(reg.subdomain);
    expect(getTunnelByTunnelIdGlobal(tunnelId)?.ownerHash).toBe(hash(proof));

    // Now the tunnel is owned: a no-proof claim from elsewhere is refused.
    await c2.closeAndWait();
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId)?.reconnecting === true);
    const attacker = await connect();
    attacker.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()) });
    const f = await attacker.next();
    expect(f.t).toBe('tunnel-rejected');
    expect(f.reason).toBe('ownership proof required');
  });
});

describe('unregister', () => {
  it('frees the tunnel so a later same-id register is a fresh registration', async () => {
    const tunnelId = mkTunnelId();
    const c1 = await connect();
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()), ownerProof: mkToken() });
    const reg = await c1.next();
    expect(getTunnelByTunnelIdGlobal(tunnelId)).toBeDefined();

    c1.send({ t: 'unregister-tunnel', tunnelId });
    await waitFor(() => getTunnelByTunnelIdGlobal(tunnelId) === undefined);

    // Re-registering the same id with no proof now succeeds as brand new
    // (the prior owner hash is gone), proving unregister fully released it.
    c1.send({ t: 'register-tunnel', tunnelId, tokenHash: hash(mkToken()) });
    const reg2 = await c1.next();
    expect(reg2.t).toBe('tunnel-registered');
    // Fresh allocation — not asserting equality/inequality of subdomain, just
    // that we got a clean registration rather than an ownership rejection.
    expect(typeof reg2.subdomain).toBe('string');
    expect(reg).toBeDefined();
  });
});
