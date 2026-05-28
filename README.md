# iclaw-relay

Tunnel relay for **iClaw Remote Access**.

A dumb byte-forwarder that lets a local iClaw expose its UI on a temporary
subdomain (e.g. `silver-fox.iclaw.digital`) without opening any inbound port
on the user's machine. The relay never sees the access password and is not
intended to read request/response bodies — authentication is verified
end-to-end between the browser and the local iClaw.

This repository currently contains the **service skeleton only**: a minimal
Express app with health probe, config, rate-limit and error-handling
middleware. Outbound-WebSocket hub, subdomain allocation and tunnel routing
land on the `dev` branch as follow-up work.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev          # tsx watch src/index.ts
curl http://127.0.0.1:4100/healthz
```

## Scripts

| Command            | Purpose                          |
| ------------------ | -------------------------------- |
| `npm run dev`      | Watch-mode dev server (`tsx`).   |
| `npm run build`    | Compile TypeScript to `dist/`.   |
| `npm start`        | Run the compiled build.          |
| `npm run typecheck`| Type-check without emitting.     |

## Layout

```
src/
├── index.ts                # server bootstrap
├── config.ts               # dotenv + zod env parsing (single source of truth)
├── middleware/
│   ├── rateLimit.ts        # per-IP limiters (placeholders for now)
│   └── errorHandler.ts     # last-resort sanitised error responder
├── routes/
│   └── health.ts           # GET /healthz
└── tunnel/                 # (empty) future home of outbound-WS hub + subdomain router
```

## Conventions

- All env vars are parsed and validated in `src/config.ts`. No other module
  reads `process.env` directly.
- Vanilla `console.*` logging. **Never log request/response bodies** — the
  whole point of this service is to be opaque to payloads.
- Mirrors the structure of the sibling `iClaw-cloud` service for consistency.

## Status

Skeleton. Not production-ready. See the iClaw Remote Access plan for the
full v1 roadmap (outbound tunnel, subdomain allocation, SPAKE2 auth,
device sessions).
