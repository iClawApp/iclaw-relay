# Deployment

The relay runs on **viralo** (`80.241.222.240`) under the dedicated
service user `iclaw-relay`, managed by `systemd`. It sits behind
the existing **Cloudflare Tunnel** (no inbound ports on the host).

## Branch / release model

- All day-to-day work happens on **`dev`**.
- Releases go via PR `dev → main`. Merging to `main` triggers
  [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
  which builds, ships and activates a new release on viralo.
- PRs and pushes to `dev` run [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
  (typecheck + build) so the gate to `main` is non-trivial.

## Required GitHub secrets (repo settings → Secrets → Actions)

| Name                  | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`      | Private SSH key for the deploy keypair (`iclaw-relay-deploy`). |
| `DEPLOY_HOST`         | `80.241.222.240`                                               |
| `DEPLOY_SSH_USER`     | `root`                                                         |
| `DEPLOY_KNOWN_HOSTS`  | Output of `ssh-keyscan -H 80.241.222.240` (any one host key).  |

The deploy keypair is separate from any personal SSH key — rotating it
is just "generate a new pair, replace the secret + replace the line in
`/root/.ssh/authorized_keys` on viralo".

## What a deploy does (on push to `main`)

1. Checkout + Node 24 + `npm ci` + `npm run build`.
2. Pack `dist/` + `package.json` + `package-lock.json` into a tarball
   tagged with version + short SHA.
3. SCP the tarball to `/tmp/` on viralo.
4. Extract into `/opt/iclaw-relay/releases/<name>/`.
5. `npm ci --omit=dev` under the `iclaw-relay` user.
6. Atomically flip `/opt/iclaw-relay/current` → new release.
7. `systemctl restart iclaw-relay`.
8. Wait up to 10s for `localhost:4100/healthz` to answer 200.
9. Prune all but the most recent 5 releases.
10. Verify `https://relay.iclaw.digital/healthz` from the runner.

If any step fails (notably healthz), the workflow exits non-zero. The
**previous release symlink stays** when restart is the failing step;
in the rare case of a partial deploy, just re-run the workflow with
"Re-run all jobs" or roll back manually:

```bash
ssh viralo
ls /opt/iclaw-relay/releases   # pick the previous one
ln -sfn /opt/iclaw-relay/releases/<previous> /opt/iclaw-relay/current
systemctl restart iclaw-relay
```

## Local dev

Same as before:

```bash
npm install
BASE_DOMAIN=lvh.me PUBLIC_SCHEME=http PUBLIC_PORT=4100 npm run dev
```

## Tail logs on viralo

```bash
ssh viralo journalctl -u iclaw-relay -f
```
