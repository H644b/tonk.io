import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import express from "express";
import { zipSync, strToU8 } from "fflate";
import { ModRepository, sha256 } from "../server/modding/repository.ts";
import { ModServer } from "../server/modding/runtime.ts";
import { resolveMods, versionMatches, validatePath } from "../shared/modkit.ts";
import Manifold from "../vendor/manifold-server/src/server.ts";
import defaultConfig from "../vendor/manifold-server/config.ts";
const io = createRequire(import.meta.url)("socket.io-client-v2");
const Room = (Manifold as any).default ?? Manifold;
const config = (defaultConfig as any).default ?? defaultConfig;
const manifest = (id = "testmod", extra: any = {}) => ({
  schemaVersion: 2,
  api: 2,
  id,
  name: id,
  version: "1.0.0",
  entrypoints: { client: "client.js" },
  ...extra,
});
function archive(
  file: string,
  definition: any,
  code = 'export function setup(api) { api.entities.register(api.id+":orb", {body:{shape:"circle",radius:1}}); }',
  extras: Record<string, Uint8Array> = {},
) {
  fs.writeFileSync(
    file,
    zipSync({
      "bonk.mod.json": strToU8(JSON.stringify(definition)),
      "client.js": strToU8(code),
      ...extras,
    }),
  );
  return file;
}
function once(socket: any, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Timed out " + event)), 4000);
    socket.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}
function ack(socket: any, event: string, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Ack timed out " + event)),
      4000,
    );
    socket.emit(event, ...args, (result: any) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

test("immutable code packs: compilation, dependency ordering, integrity and archive isolation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-modrepo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = new ModRepository(path.join(root, "repo"));
  const first = await repo.install(
    archive(
      path.join(root, "a.zip"),
      manifest("basepack", { assets: { orb: "orb.svg" } }),
      undefined,
      { "orb.svg": strToU8("<svg/>") },
    ),
    { clientOnly: true },
  );
  const second = await repo.install(
    archive(
      path.join(root, "b.zip"),
      manifest("addon", { dependencies: { basepack: "^1.0.0" } }),
    ),
    { clientOnly: true },
  );
  assert.deepEqual(
    resolveMods([second, first], ["addon"]).map((p) => p.manifest.id),
    ["basepack", "addon"],
  );
  assert.equal(first.assetHashes.orb, sha256("<svg/>"));
  assert.match(
    fs.readFileSync(path.join(first.root, ".build/client.js"), "utf8"),
    /function setup/,
  );
  assert.deepEqual(
    (
      await repo.install(path.join(root, "a.zip"), {
        clientOnly: true,
        reuseIdentical: true,
      })
    ).hash,
    first.hash,
  );
  await assert.rejects(
    repo.install(path.join(root, "a.zip")),
    /already installed/,
  );
  archive(
    path.join(root, "changed.zip"),
    manifest("basepack"),
    "export function setup() { return 42; }",
  );
  await assert.rejects(
    repo.install(path.join(root, "changed.zip"), {
      clientOnly: true,
      reuseIdentical: true,
    }),
    /different bytes/,
  );
  repo.setEnabled("addon", true);
  assert.equal(repo.enabled().length, 2);
  repo.setEnabled("addon", true); // Re-enabling keeps already-enabled dependencies available.
  assert.equal(repo.enabled().length, 2);
  await repo.install(
    archive(
      path.join(root, "addon-two.zip"),
      manifest("addontwo", { dependencies: { basepack: "^1.0.0" } }),
    ),
    { clientOnly: true },
  );
  repo.setEnabled("addontwo", true);
  assert.equal(repo.enabled().length, 3);
  assert.throws(() => repo.setEnabled("basepack", false), /requires/);
  assert.throws(
    () =>
      resolveMods(
        [
          { manifest: manifest("aa", { dependencies: { bb: "*" } }) },
          { manifest: manifest("bb", { dependencies: { aa: "*" } }) },
        ],
        ["aa"],
      ),
    /Circular/,
  );
  assert.equal(versionMatches("0.0.2", "^0.0.1"), false);
  assert.equal(versionMatches("1.9.0", "^1.0.0"), true);
  for (const name of [
    "../secret",
    "/tmp/file",
    "a/../../file",
    "https://bad",
    "a\\file",
  ])
    assert.throws(() => validatePath(name));
  const escape = archive(
    path.join(root, "escape.zip"),
    manifest("escape"),
    'import secret from "../../../../etc/passwd"; export function setup(){ console.log(secret); }',
  );
  await assert.rejects(repo.install(escape, { clientOnly: true }), /escapes/);
  await assert.rejects(
    repo.install(
      archive(
        path.join(root, "server.zip"),
        manifest("servermod", { entrypoints: { server: "client.js" } }),
      ),
      { clientOnly: true },
    ),
    /operator installation/,
  );
  fs.appendFileSync(path.join(first.root, ".build/client.js"), "\n// modified");
  assert.throws(() => repo.list(), /was changed/);
});

test("real EIO3 peers: host transfer, consent hash, readiness, permissions and native admin relay", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-modroom-"));
  const repo = new ModRepository(path.join(root, "repo"));
  const mods = new ModServer(repo);
  await mods.initialize();
  const app = express(),
    server = http.createServer(app);
  mods.routes(app);
  const native = new Room(structuredClone(config), {
    httpServer: server,
    expressApp: app,
    socketPath: "/rooms/test/socket.io",
    metadataPath: false,
    terminal: false,
    origins: true,
    authorizeJoin: (data: any, socket: any) =>
      mods.authorizeJoin("test", data, socket),
  });
  mods.attachRoom("test", native, []);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  const clients: any[] = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    mods.dispose();
    native.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function connect(name: string, hash?: string) {
    const client = io(url, {
      path: "/rooms/test/socket.io",
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    await once(client, "connect");
    const joined = once(client, "3");
    client.emit(13, {
      userName: name,
      guest: true,
      level: 0,
      roomPassword: "",
      avatar: { bc: 0, layers: [] },
      modProfile: hash,
    });
    await joined;
    return client;
  }
  const host = await connect("Host"),
    peer = await connect("Peer");
  assert.match((await ack(peer, "mods:host-token")).error, /current host/);
  const { token } = await ack(host, "mods:host-token");
  const zip = archive(
    path.join(root, "pack.zip"),
    manifest("roompack", {
      commands: { ping: { from: "players" } },
      channels: { chat: { from: "players" } },
    }),
  );
  const bytes = fs.readFileSync(zip);
  assert.equal(
    (
      await fetch(url + "/api/rooms/test/modpack", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Bonk-Host": "wrong",
        },
        body: bytes,
      })
    ).status,
    403,
  );
  const profileEvent = once(peer, "mods:profile");
  const response = await fetch(url + "/api/rooms/test/modpack", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Bonk-Host": token,
    },
    body: bytes,
  });
  assert.equal(response.status, 201);
  const { profile } = (await response.json()) as any;
  assert.equal((await profileEvent)[0].hash, profile.hash);
  assert.equal(mods.ready("test"), false);
  assert.equal(native.playerSockets[0].data.modReady, null);
  assert.match((await ack(peer, "mods:ready", "wrong")).error, /differs/);
  const blocked = once(host, "mods:error");
  host.emit(5, { gs: config.defaultGameSettings, is: "state" });
  assert.match((await blocked)[0].error, /Every player/);
  assert.equal(native.gameStartTime, 0);
  const file = await fetch(url + profile.mods[0].client);
  assert.equal(
    sha256(new Uint8Array(await file.arrayBuffer())),
    profile.mods[0].clientHash,
  );
  assert.equal(
    (
      await fetch(
        url + "/roompacks/test/" + profile.mods[0].hash + "/pack.bonkmod",
      )
    ).status,
    200,
  );
  await ack(host, "mods:ready", profile.hash);
  await ack(peer, "mods:ready", profile.hash);
  assert.equal(mods.ready("test"), true);
  const late = await connect("Late", profile.hash);
  assert.equal(native.playerAmount, 3);
  assert.equal(mods.ready("test"), true);
  assert.match(
    (await ack(peer, "mods:command", { name: "roompack:secret", data: {} }))
      .error,
    /host/,
  );
  const cmd = once(host, "mods:command");
  assert.equal(
    (
      await ack(peer, "mods:command", {
        name: "roompack:ping",
        data: { count: 1 },
      })
    ).ok,
    true,
  );
  const command = (await cmd)[0];
  assert.equal(command.sender, 1);
  const relay = once(peer, "31");
  host.emit(25, {
    a: { playersJoined: [], playersLeft: [], wbCommands: [command] },
    f: 30,
  });
  assert.deepEqual((await relay)[0].a.wbCommands, [command]);
  const msg = once(host, "mods:message");
  await ack(peer, "mods:message", {
    channel: "roompack:chat",
    data: { hello: true },
  });
  assert.deepEqual((await msg)[0].data, { hello: true });
  assert.match(
    (await ack(peer, "mods:message", { channel: "other:chat", data: {} }))
      .error,
    /not registered/,
  );
  assert.match(
    (await ack(peer, "mods:mode", { id: "roompack:extra", base: "ar" })).error,
    /host/,
  );
  assert.match(
    (await ack(host, "mods:mode", { id: "foreign:extra", base: "ar" })).error,
    /provides/,
  );
  assert.match(
    (await ack(host, "mods:mode", { id: "roompack:extra", base: "bad" })).error,
    /native base/,
  );
  const modeChanged = once(peer, "26");
  const selected = await ack(host, "mods:mode", {
    id: "roompack:extra",
    base: "ar",
  });
  assert.equal(selected.profile.mode, "roompack:extra");
  assert.deepEqual(await modeChanged, ["b", "ar"]);
  assert.equal((await ack(host, "mods:mode", "")).profile.mode, null);
  const started = once(peer, "15");
  host.emit(5, { gs: config.defaultGameSettings, is: "state" });
  await started;
  assert.ok(native.gameStartTime > 0);
  assert.match((await ack(host, "mods:profile", [])).error, /lobby/);
  const end = once(peer, "13");
  host.emit(14);
  await end;
  const migrated = once(peer, "6");
  host.disconnect();
  await migrated;
  assert.equal(native.hostId, 1);
  assert.equal(
    (
      await fetch(url + "/api/rooms/test/modpack", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Bonk-Host": token,
        },
        body: bytes,
      })
    ).status,
    403,
  );
  assert.ok((await ack(peer, "mods:host-token")).token);
  late.disconnect();
});

test("trusted operator server code runs and persists custom content through the mod API", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-servermod-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = new ModRepository(path.join(root, "repo"));
  await repo.install(
    archive(
      path.join(root, "server.zip"),
      manifest("operator", { entrypoints: { server: "client.js" } }),
      'export function setup(api){api.storage.set("started",true);api.modes.register("operator:newmode",{name:"New mode",base:"ar"});api.on("roomCreate",room=>api.storage.set("room",room.id));return ()=>api.storage.set("stopped",true);}',
    ),
  );
  repo.setEnabled("operator", true);
  const mods = new ModServer(repo);
  await mods.initialize();
  assert.equal(mods.mode("operator:newmode").base, "ar");
  mods.dispose();
  const state = JSON.parse(
    fs.readFileSync(path.join(repo.directory, "data/operator.json"), "utf8"),
  );
  assert.deepEqual(state, { started: true, stopped: true });
});

test("leaving while a client download is pending aborts it before executing setup", async () => {
  const compiled = await build({
    entryPoints: ["client/modding/runtime.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const approvals = ["accepted"];
  let requested = false,
    aborted = false;
  const notices: any[] = [];
  const window: any = {
    addEventListener() {},
    manifold: { nativeSession: { leaveRoom() {} } },
  };
  const context: any = {
    window,
    parent: { postMessage: (message: any) => notices.push(message) },
    location: { origin: "http://localhost" },
    console,
    crypto: webcrypto,
    TextDecoder,
    Uint8Array,
    Blob,
    URL,
    AbortController,
    DOMException,
    structuredClone,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => JSON.stringify(approvals), setItem() {} },
    fetch: (_url: any, options: any) => {
      requested = true;
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      );
    },
  };
  vm.runInNewContext(compiled.outputFiles[0].text, context);
  const runtime = window.BonkMods;
  const loading = runtime.prepareProfile({
    api: 2,
    hash: "accepted",
    mods: [
      {
        id: "testmod",
        name: "Test",
        version: "1.0.0",
        client: "/code.js",
        clientHash: "x",
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, true);
  runtime.leaveRoom();
  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(aborted, true);
  assert.equal(runtime.profile.mods.length, 0);
  assert.equal(
    notices.some((message) => message.type === "bonk-modpack-ready"),
    false,
  );
});
