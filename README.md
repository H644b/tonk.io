# Tonk.io

The native browser engine and UI connected to an independent Cloudflare Workers multiplayer server, Supabase persistence, full viewport projection, and JavaScript/TypeScript modpacks. This preserves the native simulation, seven modes, map/skin editors, tutorial and controls. Accounts and community data belong to this server.

## Run

Requires Node 24 or newer:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3210. Fullscreen and Workbench are in the native top navigation. Home → Help sits between Skins and Friend List and contains the complete modding guide. The XP progress sits beside your identity in the navigation. The native bottom kill plane is projected to the visible bottom without changing physics.

Use Custom Game to browse/create rooms or Quick Play for native mode matchmaking. The room closes when its last player disconnects; if other players remain, host ownership transfers to a remaining player. Accounts, friends, maps, skins, controls, votes, curator picks and replays persist in `data/bonk.sqlite` (`BONK_DATA_PATH` overrides it). Preserve this database when updating. `PORT`, `HOST` and `BONK_MODS_DIR` configure the server. The default bind is loopback. Production uses [Cloudflare Workers with Supabase](docs/DEPLOYMENT.md). Docker/Node hosting is also available. See [deployment instructions](docs/DEPLOYMENT.md) for HTTPS, storage, updates and backups. Live account, WebSocket room, modpack and persistence checks are recorded separately from browser gameplay.

## Full code modpacks

Workbench → Mods installs room content; Home → Help documents the API and includes a downloadable Orb Kit example. Packs can add entities with real native Box2D bodies, textures/images/audio, components, properties, modes, arbitrary registries and UI. They can hook simulation/rendering, access the actual engine, patch functions/properties, and send commands through native synchronized admin inputs. State is retained by native rollback, PSON and replays. This is executable mod code with direct engine access. Optional legacy CSS/Worker tools remain in a collapsed section.

A host can upload a `.tonkmod` ZIP containing `tonk.mod.json`, client code and assets. The server compiles and relays the host's files. Other players must choose **Download & Join** or **Leave Room**. The client verifies every code/asset SHA-256 before activation. Exact content approvals are remembered; changed content asks again. Leaving during download aborts loading; the match cannot start until all room members are ready. Workers room packs have an 8 MiB compressed/expanded limit and 2,048 files; Node defaults to 64 MiB.

Operator-installed mods may also run Node server code:

```sh
npm run mods -- install /absolute/path/to/my-mod
npm run mods -- enable my-mod
npm run mods -- pack /absolute/path/to/my-mod /absolute/path/to/my-mod.tonkmod
npm start
```

`install` bundles JS/TS entrypoints with esbuild; `pack` archives source files. Host archives must include all imports as relative files inside the pack; bundle npm dependencies before packaging. Server entrypoints require trusted operator installation and a restart. Browser hosts cannot install Node code. Client code has full access to the game page and this origin's local data, so only accept content you trust. Versions are immutable; change the version when changing bytes.

See [service administration](docs/SERVICE-PARITY.md) for curator roles, map curation and replay reports.

## Verification

```sh
npm run check
npm test
npm run verify:release
```

The current suite includes, tests for production proxy trust, secure cookies, graceful shutdown, and account persistence across restarts. The native differential harness compares the actual prepared client with the pinned original across 74 scenarios and 31,154 complete states, all seven modes. Finite IEEE doubles and signed zero compare exactly; NaN payload/sign is normalized because V8 itself varies it. Tests also cover native replay playback, XP settlement routes, custom Box2D collisions, host pack distribution/readiness, permissions, integrity, dependencies, cancellation, account/services and real EIO3 peers. Browser evidence is under `evidence/verification/current/`.

This is not a certification of every original service rule or map/input combination. Original private ranking, matchmaking eligibility and anti-cheat cannot be proven from the public client. Official accounts and moderation decisions are not copied. Public map feeds are imported with creator attribution; the imported catalog is bounded. Physics follows the native host/client model; it is not server-authoritative. [Coverage](docs/COVERAGE.md) separates implemented behavior from verified parity.

## Attribution

Bonk.io's original client/assets remain proprietary to their owners. This project grants no redistribution rights to that material. Manifold server compatibility code is MIT, with notices retained in `vendor/manifold-server/LICENSE` and `third-party/manifold-client-LICENSE`. Source identities and insertions are recorded under `evidence/`. No official account credentials are required.

## Rooms, maps and administration

The host can add bots to open player slots and select Easy, Normal, Hard or Expert difficulty. Decisions account for terrain, opponents and native modes, and travel through synchronized admin inputs. Bots leave when the last human leaves. H644b has owner administration controls for rooms, accounts, maps, replays and server settings. Imported community maps use an indexed search and preserve creator metadata. See [deployment and operations](docs/DEPLOYMENT.md).
