# iclaw-relay

Tunnel relay for **iClaw Remote Access**.

A dumb byte-forwarder that lets a local iClaw expose its UI on a temporary
subdomain (e.g. `silver-fox.iclaw.digital`) without opening any inbound port
on the user's machine. The relay never sees the access passphrase and does not
read request/response bodies — authentication is verified end-to-end between
the browser and the local iClaw (OPAQUE login + encrypted HTTP/WS payloads).
The relay only enforces a coarse **access-token gate** and forwards encrypted
frames; it sees envelopes and routing metadata, never plaintext.

## How it works

```
/healthz                 liveness probe (apex domain)
ws  /tunnel              outbound-WS endpoint a local iClaw dials out to
<sub>.<baseDomain>/*     public traffic, forwarded over that tunnel
```

A local iClaw process dials **out** to `ws /tunnel`, claims (or restores) a
subdomain, and keeps a single multiplexed WebSocket open. Public visitors hit
`<sub>.<baseDomain>`; the relay matches the `Host` header to a live tunnel and
forwards the raw bytes both ways. Apex requests (`/healthz`) get the full
helmet/cors/compression stack; tunneled subdomain requests deliberately skip it
— re-compressing or rewriting content we never inspect would be the wrong layer.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev          # tsx watch src/index.ts
curl http://127.0.0.1:4100/healthz
```

For local browser testing without DNS/TLS, set `BASE_DOMAIN=lvh.me` (resolves
`*.lvh.me` to `127.0.0.1`) and `PUBLIC_PORT=4100`; from a phone on the same
Wi-Fi use `<machine-LAN-ip>.nip.io`. See [`.env.example`](.env.example) for
every option and [`docs/DEPLOY.md`](docs/DEPLOY.md) for production deployment.

## Scripts

| Command             | Purpose                                                         |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | Watch-mode dev server (`tsx`).                                  |
| `npm run build`     | Compile TypeScript to `dist/`.                                  |
| `npm start`         | Run the compiled build.                                         |
| `npm test`          | Vitest suite — access gate, access tokens, conn caps, register/restore flow. |
| `npm run typecheck` | Type-check without emitting.                                    |

## Layout

```
src/
├── index.ts                # server bootstrap (apex middleware + proxy + WS upgrade)
├── config.ts               # dotenv + zod env parsing (single source of truth)
├── middleware/
│   ├── rateLimit.ts        # apex-route limiters
│   └── errorHandler.ts     # last-resort sanitised error responder
├── routes/
│   └── health.ts           # GET /healthz
└── tunnel/
    ├── wsServer.ts         # outbound-WS server: register/restore, keep-alive, ownership
    ├── hub.ts              # in-memory registry of live tunnels
    ├── protocol.ts         # multiplexed wire frames (open / data / close)
    ├── httpProxy.ts        # match Host → forward HTTP over the tunnel
    ├── publicWs.ts         # forward a public browser WebSocket over the tunnel
    ├── accessGate.ts       # relay access-token gate + per-tunnel access sessions
    ├── accessToken.ts      # access-token hashing + rotation
    ├── rateLimit.ts        # per-IP registration / connection limits
    ├── idGen.ts            # subdomain allocation
    ├── host.ts             # subdomain extraction from the Host header
    ├── captureFrame.ts     # opt-in frame-capture hook (smoke tests only)
    └── *Page.ts            # branded HTML for not-found / forbidden / reconnecting
```

## Conventions

- All env vars are parsed and validated in `src/config.ts`. No other module
  reads `process.env` directly.
- Vanilla `console.*` logging. **Never log request/response bodies** — the
  whole point of this service is to be opaque to payloads.
- Mirrors the structure of the sibling `iClaw-cloud` service for consistency.

## Status

Feature-complete for Remote Access **v1**, running in **E2E alpha**. Implemented
and covered by the test suite: outbound-WS hub, subdomain allocation with sticky
reconnect, HTTP + WebSocket tunnel routing, the relay access-token gate with
rotation, per-IP registration/connection caps, and keep-alive. Hardened against
crash-DoS (process-level safety net), `X-Forwarded-For` spoofing, and subdomain
hijack.

**Not** externally audited, and deployed as a private service (not published to
npm). The relay still sees metadata — subdomain, timing, frame sizes, and the
E2E routing paths (`/__ra/e2e/http`, `/__ra/e2e/ws`). Payload confidentiality
rests on the iClaw ↔ browser OPAQUE/E2E layer, not on the relay. The full
security model and host/local setup live in the iClaw repo under
`docs/REMOTE_ACCESS.md`.
