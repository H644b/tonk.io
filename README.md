# Tonk.io

Tonk.io uses Bonk.io's original engine and UI with its own multiplayer server, accounts, and community data. It keeps the original physics, all seven game modes, map and skin editors, tutorial, and controls. It also supports JavaScript and TypeScript modpacks with direct access to the game engine.

Production runs on Cloudflare Workers with Supabase for storage. You can also host it with Node or Docker.

## Run locally

You'll need Node 24 or newer.

```sh
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210).

Fullscreen and Workbench are in the top bar, along with your profile and XP progress. The full modding guide is under **Home → Help**, between Skins and Friend List.

The game view fills the window. The bottom kill plane lines up with the visible bottom of the screen, while the physics stay the same.

## Rooms and maps

Use **Custom Game** to browse or create rooms, or **Quick Play** to find a match in one of the original game modes.

If the host disconnects while other players are still in the room, another player becomes the host. The room closes when the last player disconnects.

Hosts can fill open slots with bots and choose Easy, Normal, Hard, or Expert difficulty. Bots account for the terrain, other players, and the current mode. Their actions go through the game's synchronized admin inputs, and they leave when the last human leaves.

Imported community maps keep their creator information and use indexed search. The imported catalog is limited, so it doesn't include every public map.

H644b has owner controls for rooms, accounts, maps, replays, and server settings. See [service administration](docs/SERVICE-PARITY.md) for curator roles, map curation, and replay reports.

## Data and hosting

The Node server saves accounts, friends, maps, skins, controls, votes, curator picks, and replays in `data/bonk.sqlite`. **Keep this database when updating.**

You can change the database path with `BONK_DATA_PATH`. Other settings are available through `PORT`, `HOST`, and `BONK_MODS_DIR`. The server binds to loopback by default.

The [deployment guide](docs/DEPLOYMENT.md) covers Cloudflare Workers with Supabase, Node and Docker hosting, HTTPS, storage, updates, and backups.

## Modpacks

Open **Workbench → Mods** to install content for a room. **Home → Help** has the API docs and a downloadable Orb Kit example.

Mods can add entities with actual Box2D bodies, textures, images, audio, components, properties, game modes, custom registries, and UI. They can also hook into simulation and rendering, access the engine directly, patch functions and properties, and send commands through synchronized admin inputs.

Mod state is handled by the game's rollback, PSON, and replay systems. The older CSS and Worker tools are still available in a collapsed section.

### Sharing a pack with a room

A host can upload a `.tonkmod` ZIP containing `tonk.mod.json`, client code, and assets. The server compiles and shares the host's files.

Other players choose **Download & Join** or **Leave Room**. Before loading anything, the client checks the SHA-256 hash of every code and asset file. Approval is remembered for that exact content. If the content changes, players have to approve it again.

Leaving during a download cancels it. Everyone in the room has to finish loading before the match can start.

Cloudflare Workers allows up to **8 MiB compressed and 8 MiB expanded**, with a maximum of **2,048 files** per room pack. Node's default size limit is **64 MiB**.

Client mods can access the whole game page and its origin's local data, so only accept packs you trust.

### Installing mods on the server

Mods installed by the server operator can also run Node server code.

```sh
npm run mods -- install /absolute/path/to/my-mod
npm run mods -- enable my-mod
npm run mods -- pack /absolute/path/to/my-mod /absolute/path/to/my-mod.tonkmod
npm start
```

`install` bundles JavaScript and TypeScript entrypoints with esbuild. `pack` creates an archive of the source files.

Host packs need to include all imports as relative files inside the pack. If you use npm dependencies, bundle them before packaging.

Node server code requires installation by a trusted server operator and a restart. Room hosts using the browser can't install Node code.

Pack versions are fixed. If you change the contents, bump the version.

## Tests

```sh
npm run check
npm test
npm run verify:release
```

The suite tests production proxy trust, secure cookies, graceful shutdown, and keeping accounts after a restart. It also covers replay playback, XP settlement routes, custom Box2D collisions, account services, and real EIO3 peers.

Modpack tests cover host pack distribution, readiness, permissions, file integrity, dependencies, and cancellation.

The client comparison tests check the actual prepared client against the pinned original across **74 scenarios and 31,154 complete states**, covering all seven modes. Finite IEEE doubles and signed zero match exactly. NaN payloads and signs are normalized because V8 can vary them.

Browser gameplay evidence is in `evidence/verification/current/`. Live account, WebSocket room, modpack, and persistence checks are recorded separately.

### What these tests cover

Passing these tests doesn't prove that every original service rule or every map and input combination behaves the same. The public client doesn't provide enough information to verify private ranking rules, matchmaking eligibility, or anti-cheat.

Physics still uses the original host/client model and is not server-authoritative. Official accounts and moderation decisions are not copied.

See [coverage](docs/COVERAGE.md) for what's implemented and what's been verified against the original.

## Credits

Bonk.io's original client and assets remain proprietary and belong to their owners. This project doesn't grant permission to redistribute them.

The Manifold server compatibility code is MIT licensed. Its notices are kept in:

- `vendor/manifold-server/LICENSE`
- `third-party/manifold-client-LICENSE`

Source identities and code insertions are recorded under `evidence/`.

No official Bonk.io account credentials are required.
