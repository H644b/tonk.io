# Tonk.io

Tonk.io is based on Bonk.io, with its own multiplayer server, separate accounts, and JavaScript/TypeScript mod support.

## What's different

### Separate server and accounts

Tonk.io has its own accounts and community data. Your Bonk.io account doesn't carry over, and you don't need your Bonk.io login.

The hosted version uses Cloudflare Workers and Supabase. You can also run your own copy with Node or Docker.

### Modpacks

Mods can add game objects, textures, sounds, modes, and UI. They can also change engine functions, hook into physics and rendering, and create objects with actual Box2D bodies.

Open **Workbench → Mods** to install a pack. **Home → Help** has the modding guide, API docs, and an Orb Kit example you can download.

Room hosts can upload a `.tonkmod` ZIP with a `tonk.mod.json` file, client code, and assets. Other players choose **Download & Join** or **Leave Room**.

Every code and asset file is checked against its SHA-256 hash before loading. Once you approve a pack, that approval is remembered unless its contents change. Leaving cancels the download, and the match waits until everyone has finished loading.

Room packs on Cloudflare Workers have an 8 MiB limit for both the compressed and expanded files, with up to 2,048 files. The Node server defaults to 64 MiB.

Mods can access the game page and its local data, so only load packs you trust.

### Screen layout

The game fills the window, and the bottom kill boundary lines up with the bottom of the screen. This is a display change; the physics stay the same.

### Owner controls

H644b has controls for managing Tonk.io rooms, accounts, maps, replays, and server settings. More details are in the [admin guide](docs/SERVICE-PARITY.md).

## Run it locally

Install Node 24 or newer, then open a terminal in the project folder and run:

```sh
npm ci
npm run build
npm start
```

Once it starts, open [http://127.0.0.1:3210](http://127.0.0.1:3210).

Leave the terminal open while you're using it. Press Ctrl+C when you want to stop the server.

Your local accounts and game data are saved in `data/bonk.sqlite`. Keep that file when you update.

By default, the server only accepts connections from your computer. You can change the address and port with `HOST` and `PORT`. `BONK_DATA_PATH` changes the database location, and `BONK_MODS_DIR` changes the mods folder.

### Installing a mod on your server

For a mod you have saved locally:

```sh
npm run mods -- install /absolute/path/to/my-mod
npm run mods -- enable my-mod
npm start
```

To turn it into a `.tonkmod` file you can share:

```sh
npm run mods -- pack /absolute/path/to/my-mod /absolute/path/to/my-mod.tonkmod
```

`install` bundles the JavaScript or TypeScript code. `pack` puts the source files into an archive. Include all imported files inside the pack using relative paths, and bundle any npm dependencies before packaging.

Mods with Node server code need to be installed directly by the server operator. Restart the server after installing them. Room hosts can't upload Node server code through the browser.

If you change a pack's contents, give it a new version number.

To put your server online, follow the [hosting guide](docs/DEPLOYMENT.md).
