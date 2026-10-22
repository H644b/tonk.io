# Deployment

Run one persistent Node 24+ process behind an HTTPS reverse proxy. Rooms, host tokens, live connections, and mod readiness live in memory: do not use multiple replicas or a serverless host. Persistence uses either a writable disk or the configured Turso/libSQL database. Restarting disconnects active rooms; accounts and saved content survive.

## Free hosting: Render + Turso

`render.yaml` defines one **Free** Node web service. Use a **Free** Turso/libSQL database for persistent accounts, sessions, maps, skins, replays, installed mod code/assets, enabled packs, and mod SDK storage. No paid Render disk is required. Mod data is stored in verified chunks and restored into the disposable filesystem on startup. Gameplay rooms remain in memory and close on restart.

1. Create a Turso database on its Free plan and generate a database authentication token.
2. Put the project in a Git repository accessible to Render. Create a Render Blueprint from the repository, or create a Node Web Service manually using the settings in `render.yaml`. Select **Free**.
3. Set `BONK_DATABASE_URL` to the database's `libsql://…` URL and `BONK_DATABASE_AUTH_TOKEN` to its token in Render's secret environment settings. Keep them out of Git and the frontend.
4. Deploy. Render supplies the HTTPS `onrender.com` URL and routes WebSockets to the Node process. A separate Caddy service or custom domain is unnecessary.
5. Register the owner account before opening registration to other players. Check login cookies have `Secure`, create a two-client room, upload a pack, and perform a redeploy to verify persistence on the actual host.

The build command includes development dependencies explicitly, builds the artifacts, then removes development dependencies. `HOST=0.0.0.0` and Render's assigned `PORT` expose the process to its router. The supplied proxy setting trusts loopback, link-local, and private proxy addresses; adapt it if the host's actual proxy path differs.

Render Free currently grants 750 instance hours/month and sleeps after 15 minutes without inbound HTTP or WebSocket traffic. Waking takes about a minute. Render may restart free instances, and monthly bandwidth/build quotas also apply. Turso currently includes 5 GB storage, 500 million row reads, and 10 million row writes/month on Free. These are provider quotas, not unlimited hosting promises. Confirm the current [Render Free limits](https://render.com/docs/free) and [Turso pricing](https://turso.tech/pricing?frequency=monthly) before enabling billing.

Vercel Functions now support WebSockets, but connections end at the function duration limit and new connections can reach different instances. This server's rooms require a single process. Cloudflare Workers/Durable Objects require a different runtime/transport and cannot directly run the current Node mod compiler and arbitrary Node server entrypoints. This release targets Render for the full multiplayer server; it does not claim a Vercel-only or Workers-only port. See [Vercel WebSockets](https://vercel.com/docs/functions/websockets) and [Workers Node support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

### Operator mods on Free

Render Free has no interactive shell. Install and enable trusted server packs from a workstation using the same database secrets, then use Render's restart/deploy action. The CLI writes their compiled code and assets to durable storage; the next server start restores them. Use a temporary empty cache directory, supply secrets through the shell/service environment, and run:

```sh
npm ci
npm run build
# BONK_DATABASE_URL and BONK_DATABASE_AUTH_TOKEN must be set in this process.
BONK_MODS_DIR=/tmp/bonk-mod-admin npm run mods -- install ./pack.bonkmod
BONK_MODS_DIR=/tmp/bonk-mod-admin npm run mods -- enable pack-id
```

Room-host uploads remain available in the browser and do not need a service restart. These uploads belong to the room and expire when it closes; retain the original archive for reuse. Server mods should use `api.storage` for durable data. Arbitrary writes outside managed storage remain subject to the host's ephemeral filesystem. Keep one game instance and avoid changing packs while a deployment is in progress.

Cloud mode fails if its database is unavailable; it does not silently switch to an empty local database. Moving an existing disk deployment to cloud storage does not automatically migrate its database: export/import the SQLite data through the database provider and preserve its mod repository before changing configuration. Test with separate data first.

### Cold-start verification

The release was checked on Node 24 against an actual libSQL server, including a complete app-filesystem wipe and SIGKILL. Accounts, sessions, maps, installed compiled mod code, custom assets, enabled packs, and mod SDK data survive. This is separate from verifying Render/Turso account settings, live TLS, region latency, quotas, or WAN behavior.

To reproduce with the official `sqld` binary:

```sh
npm run verify:cloud -- /absolute/path/to/sqld
```

The verifier creates a disposable libSQL database and application caches; it never uses a production database or your configured credentials.

## Build and verify

```sh
npm ci
npm run check
npm test
npm run verify:release
```

`verify:release` creates a temporary release containing only built code, public assets, catalog data, notices, and production dependencies. It installs and compiles the example pack through the bundled CLI, starts the server, joins through an EIO3 WebSocket, then shuts down and removes the temporary release. It does not publish anything.

## Docker

The multi-stage Dockerfile builds the client, server, and operator CLI, installs production dependencies, and runs as the unprivileged `node` user. The image does not contain existing accounts, installed packs, development evidence, or credentials.

```sh
cp .env.example .env
# Set proxy addresses and curator usernames in .env.
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3210/api/health
```

Compose publishes the game port on loopback only. Named volumes `game-data` and `game-mods` retain the database and installed mod files. Keep these volumes across updates. Do not run `docker compose down -v` when retaining data.

## HTTPS

Point the domain's DNS at the host and allow inbound ports 80 and 443. Run Caddy on that host with `deploy/Caddyfile`; set `BONK_DOMAIN` in **Caddy's process environment** to the actual hostname. Configure the service manager to retain that variable on restart.

```sh
BONK_DOMAIN=game.example.com caddy validate --config deploy/Caddyfile --adapter caddyfile
BONK_DOMAIN=game.example.com caddy run --config deploy/Caddyfile --adapter caddyfile
```

Caddy handles HTTPS and WebSocket forwarding. Keep the upstream Host unchanged. The sample `.env` trusts loopback and private network proxy addresses because Docker's published port may translate the proxy source address. This assumes the app port remains loopback-only and the Docker network is controlled. For another topology, restrict `TRUST_PROXY` to the actual proxy IPs/subnets. Leave it empty when running directly. Do not use unrestricted trust: the setting controls client IPs, rate limiting, and secure session cookies. See the [Express proxy guide](https://expressjs.com/en/guide/behind-proxies/) and [Caddy proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Bare Node

```sh
npm ci
npm run build
npm prune --omit=dev
NODE_ENV=production HOST=127.0.0.1 PORT=3210 TRUST_PROXY=loopback npm start
```

Run from the project root. A service manager should restart failures and send SIGTERM on shutdown with at least 15 seconds before forced termination. The server disconnects rooms, runs mod cleanup, and closes SQLite on SIGTERM/SIGINT. `.env` is a Compose input; bare Node does not load it automatically. Supply variables through the service manager or shell.

| Variable                   | Default            | Purpose                                                     |
| -------------------------- | ------------------ | ----------------------------------------------------------- |
| `HOST`                     | `127.0.0.1`        | Listen address; container uses `0.0.0.0`.                   |
| `PORT`                     | `3210`             | HTTP and WebSocket port.                                    |
| `BONK_DATABASE_URL`        | empty              | Optional durable libSQL/Turso endpoint for ephemeral hosts. |
| `BONK_DATABASE_AUTH_TOKEN` | empty              | Database secret, server and operator CLI only.              |
| `BONK_DATA_PATH`           | `data/bonk.sqlite` | Persistent database file.                                   |
| `BONK_MODS_DIR`            | `mods`             | Persistent pack repository and configuration.               |
| `TRUST_PROXY`              | empty              | Trusted proxy addresses/subnets, comma-separated.           |
| `BONK_CURATORS`            | empty              | Curator usernames, comma-separated.                         |

The first account registered to a fresh database receives the owner role. Register the operator account before opening access to other players. See [service administration](SERVICE-PARITY.md) for roles.

## Mods in the container

The CLI is bundled at `dist/mods.mjs` and remains available after omitting development dependencies. Copy an inspected archive into the running container, install it, enable it, then restart:

```sh
docker compose cp ./pack.bonkmod game:/tmp/pack.bonkmod
docker compose exec game npm run mods -- install /tmp/pack.bonkmod
docker compose exec game npm run mods -- enable pack-id
docker compose restart game
```

Room uploads compile automatically without a restart. Only operator-installed packs may execute Node server entrypoints.

## Updates and backups

Before updating, stop the game, back up both persistent volumes, then rebuild and start. For disk-backed Node, stop the process and copy the entire `data` and `mods` directories. For cloud mode, back up the remote database, including `mod_files` and `mod_file_chunks`; the app cache is not the source of truth. Copying only a live SQLite file can omit uncheckpointed WAL changes; use an SQLite-aware backup or stop the process first. Test restoration into separate storage. An image rollback alone does not roll back the database, so retain the matching backup.

After deployment, check HTTPS, registration/login, a two-browser room, WebSocket transport, mod download consent, reconnect, and last-player room cleanup on the actual domain. Local tests do not verify DNS, certificate issuance, firewall rules, WAN behavior, or the hosting provider.

## Distribution notices

Retain third-party notices. The original Bonk client, fonts, artwork, and other assets remain owned by their respective rights holders; this project does not grant redistribution rights. Resolve those rights before public distribution. Original provenance and hashes remain in the development evidence, outside the public site.
