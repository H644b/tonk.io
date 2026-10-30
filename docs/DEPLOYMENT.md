# Tonk deployment

Production runs on Cloudflare Workers with one SQLite-backed Durable Object for the native room server and Supabase Postgres for persistent game records. Static files are served by Workers Assets. The current entry point is `workers/index.ts`; Node and Docker remain available for development or alternate hosting.

## Cloudflare Workers + Supabase

1. Install Node 24+ and run `npm ci`.
2. Create a Supabase Free project. Apply `supabase/migrations/20261030054753_cloudflare_persistence.sql` using the Supabase CLI or SQL editor. Both tables must retain RLS, and only `service_role` may read records or execute `bonk_apply_changes`.
3. Authenticate Wrangler, update `account_id` and the Worker name in `wrangler.jsonc`, and create a private JSON secrets file outside Git containing `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The secret key is server-only. The game does not use Supabase Auth or expose its record store directly to browsers; existing game accounts and salted password hashes are retained.
4. Run `npm run check`, `npm run check:workers`, `npm test`, and `npm run build:workers`.
5. Deploy with `npx wrangler deploy --secrets-file /absolute/path/to/private-secrets.json`. The SQLite Durable Object migration is declared in `wrangler.jsonc`.
6. Provision the owner before public registration. Existing deployments must migrate the account and `server_roles` records together. Verify HTTPS, login, native WebSockets, room cleanup, and mod downloads at the actual public URL.

For development, put the same keys in ignored `.dev.vars`, build, and run `npm run dev:workers`. This connects to the configured Supabase database: use a separate project for isolated development. Stop the development Worker before importing records into a shared database.

### Persistence and recovery

Supabase is the canonical store. The Durable Object keeps an indexed SQLite query cache. Row triggers capture inserts, updates, deletes and cascades into an outbox; a Postgres function commits each batch with a revision check before an HTTP response completes. Only application tables are mirrored; runtime and emulator metadata are excluded. The secret key and password hashes never enter static assets.

On a cold start, the object compares its revision with Supabase. It restores records when the cache is stale or an interrupted mutation remains. Conflicting writers fail and reload the canonical store. Use one production object and do not run two independently writable deployments against the same database. Stop active writers before operator imports. Back up `bonk_state` and all `bonk_records`, including managed mod files, together. Restore into separate storage before switching traffic.

Rooms and uploaded room packs are transient. A deployment disconnects games; accounts, maps, skins, replays, settings and operator-managed mod data remain. The final human leaving closes a room even when bots remain. WebSockets use native Engine.IO 3 or 4 framing; long polling is not supported on Workers.

### Mods

Room hosts upload `.tonkmod` or ZIP archives. The browser bundles JS/TS and relative imports with esbuild WebAssembly, then the Worker validates and relays the files. Other players approve the content before loading; downloaded code and assets are checked against SHA-256 hashes. Changed content requires approval again. Workers currently limits each room pack to **8 MiB compressed and expanded**, with 2,048 files. Node hosting defaults to 64 MiB. Keep original archives; room uploads expire when the room closes.

Trusted operator server entrypoints are compiled into the Worker at deployment. Install and enable the pack with the mod CLI, then run `npm run build:workers` and redeploy. `scripts/build-workers.mjs` includes enabled server modules from `mods/installed`. Server packs must use APIs supported by Workers; arbitrary native Node addons and runtime loading of new server JavaScript are unavailable. Browser room uploads remain client-only. The mod API, native engine access, entities, registries, UI, custom assets, rollback state, and replay hooks remain available. Legacy `.bonkmod`, `bonk.mod.json`, and `BonkMods` aliases preserve existing packs.

### Free plan limits

The configuration uses SQLite Durable Objects, which are available on Workers Free, and stays below the Free Worker compressed bundle limit. Provider limits still apply to requests, active object duration, storage, and database egress. In particular, this compatibility transport keeps an object active during connected games; it does not claim hibernation. Supabase Free currently includes a 500 MB database and 5 GB database egress. Verify current limits before changing plan or billing settings:

- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase)

## Maps and moderation

`scripts/import-community-maps.mjs --apply` imports available public community feeds, retains creator/source metadata, converts legacy maps with the native codec, validates geometry, and writes the configured Supabase project. It replaces the imported community catalog, not player-created maps. Run it while the Worker is stopped or before deployment, then deploy a new version to reload the cache. Feed availability and popularity change; this is a bounded imported catalog rather than access to every historical original map.

Search uses a metadata index, trigram intersections and bounded result caching. Geometry is loaded only for the selected result page, and social aggregates are batched. Reproduce the public comparison with `node scripts/benchmark-map-search.mjs PREVIOUS_ORIGIN CURRENT_ORIGIN`; the report records page size, bytes, timing and scope under ignored `.deployment/`.

H644b has the owner role in the migrated database. Owners see Admin in the native navigation and Workbench. It supports room closure, kicks, account suspension/unbanning, session revocation, curator assignment, map removal/restoration, replay reports, registration controls, maintenance controls and an audit trail. Every endpoint checks the server session and role; hiding a UI control is not authorization. Owner accounts are protected from accidental demotion or suspension.

## Verification

`node scripts/verify-live.mjs https://YOUR_WORKER --owner-ready` creates disposable QA accounts, verifies cookie flags and private map persistence, connects two native WebSocket peers, uploads a room pack, verifies code/assets and readiness, transfers hosting, and checks room/archive cleanup. Its private state file contains QA credentials; never commit it. After a redeploy, run the same command with `--resume` to verify account/map recovery. Real browser gameplay and consent require a separate browser pass.

## Node and Docker

`npm run build && npm start` runs the same game application with Node's native Socket.IO transport and a SQLite database at `data/bonk.sqlite`. Preserve both the database and managed `mods` directory. `BONK_DATA_PATH`, `BONK_MODS_DIR`, `HOST`, `PORT` and `TRUST_PROXY` configure this alternate host. The historical `BONK_DATABASE_URL` and `BONK_DATABASE_AUTH_TOKEN` still support libSQL as a compatibility option; production Workers does not use them.

The Dockerfile and Compose file remain available for Node hosting. Keep the application port behind HTTPS and restrict proxy trust to actual reverse proxies. Retain third-party notices and original asset provenance when distributing the game.

## Legacy address cutover

The Node launcher supports `TONK_REDIRECT_ORIGIN=https://YOUR_WORKER`. In that mode it serves the health check and redirects other requests with HTTP 307 before opening a game database. The existing Render service can retain old bookmarks without running a second game/account system. Remove the variable to roll back to Node hosting with its existing database. The target is a non-secret environment setting, managed through Render rather than duplicated in its Blueprint.
