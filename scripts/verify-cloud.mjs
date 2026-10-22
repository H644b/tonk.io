// Run against the official sqld binary in an isolated, disposable database.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import Libsql from "libsql";
const binary = process.argv[2];
if (!binary) throw Error("Usage: node scripts/verify-cloud.mjs /path/to/sqld");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-cloud-proof-"));
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const databaseUrl = `http://127.0.0.1:${port}`;
const sqld = spawn(
  binary,
  [
    "--db-path",
    path.join(root, "database"),
    "--http-listen-addr",
    `127.0.0.1:${port}`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let sqlLog = "";
sqld.stderr.on("data", (bytes) => (sqlLog += bytes));
let game, database;
const checks = [];
function env(cache) {
  return {
    ...process.env,
    NODE_ENV: "production",
    NODE_TEST_CONTEXT: "",
    HOST: "127.0.0.1",
    PORT: "0",
    TRUST_PROXY: "",
    BONK_DATABASE_URL: databaseUrl,
    BONK_DATABASE_AUTH_TOKEN: "",
    BONK_DATA_PATH: path.join(cache, "data/bonk.sqlite"),
    BONK_MODS_DIR: path.join(cache, "mods"),
  };
}
async function start(cache) {
  game = spawn(process.execPath, ["dist/server.mjs"], {
    env: env(cache),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  game.stderr.on("data", (bytes) => (output += bytes));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Game start timeout: " + output)),
      15000,
    );
    game.stdout.on("data", (bytes) => {
      output += bytes;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    game.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Game exited " + code + ": " + output));
    });
  });
}
async function stop(signal = "SIGTERM") {
  if (!game || game.exitCode !== null || game.signalCode !== null) return;
  const exited = once(game, "exit");
  game.kill(signal);
  const [code, actualSignal] = await exited;
  if (signal === "SIGTERM") {
    assert.equal(code, 0);
    assert.equal(actualSignal, null);
  }
  game = undefined;
}
async function request(url, route, body, cookie) {
  const response = await fetch(url + route, {
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return { response, data };
}
function state() {
  const file = database
    .prepare("SELECT * FROM mod_files WHERE path='data/cloud-check.json'")
    .get();
  const parts = [];
  for (let i = 0; i < Number(file.chunks); i++)
    parts.push(
      Buffer.from(
        database
          .prepare(
            "SELECT bytes FROM mod_file_chunks WHERE generation=? AND chunk=?",
          )
          .get(file.generation, i).bytes,
      ),
    );
  return JSON.parse(Buffer.concat(parts).toString());
}
try {
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await fetch(databaseUrl + "/health");
      break;
    } catch (error) {
      if (Date.now() > deadline) throw Error("sqld start timeout: " + sqlLog);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const firstCache = path.join(root, "first");
  const url = await start(firstCache);
  const account = await request(url, "/api/register", {
    username: "ColdStartPlayer",
    password: "cloud-test-password",
  });
  const cookie = account.response.headers.get("set-cookie").split(";")[0];
  await request(
    url,
    "/api/maps",
    { name: "Cloud map", data: { v: 1 }, visibility: "private" },
    cookie,
  );
  await stop();
  checks.push(
    "accounts, sessions and maps committed through real remote libSQL",
  );
  const pack = path.join(root, "cloud-check");
  fs.mkdirSync(pack);
  fs.writeFileSync(
    path.join(pack, "bonk.mod.json"),
    JSON.stringify({
      schemaVersion: 2,
      api: 2,
      id: "cloud-check",
      name: "Cloud Check",
      version: "1.0.0",
      entrypoints: { client: "client.js", server: "server.js" },
      assets: { image: "asset.svg" },
    }),
  );
  fs.writeFileSync(
    path.join(pack, "client.js"),
    "export function setup(api){api.properties.register('cloud-check:test',{default:1});}",
  );
  fs.writeFileSync(
    path.join(pack, "server.js"),
    "export function setup(api){api.storage.set('starts',api.storage.get('starts',0)+1);api.modes.register('cloud-check:mode',{name:'Cloud mode',base:'b'});}",
  );
  const asset =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="#007f73"/></svg>';
  fs.writeFileSync(path.join(pack, "asset.svg"), asset);
  for (const args of [
    ["install", pack],
    ["enable", "cloud-check"],
  ])
    execFileSync(process.execPath, ["dist/mods.mjs", ...args], {
      env: env(firstCache),
      stdio: "pipe",
      timeout: 30000,
    });
  fs.rmSync(firstCache, { recursive: true, force: true });
  const secondCache = path.join(root, "second");
  const secondUrl = await start(secondCache);
  assert.equal(
    (await request(secondUrl, "/api/profile", undefined, cookie)).data.user
      .username,
    "ColdStartPlayer",
  );
  assert.ok(
    (await request(secondUrl, "/api/maps", undefined, cookie)).data.maps.some(
      (map) => map.name === "Cloud map",
    ),
  );
  const mods = (await request(secondUrl, "/api/mods")).data;
  assert.ok(mods.packs.some((pack) => pack.id === "cloud-check"));
  assert.ok(mods.modes.some((mode) => mode.id === "cloud-check:mode"));
  const bytes = await (
    await fetch(secondUrl + "/modpacks/cloud-check/1.0.0/assets/image")
  ).text();
  assert.equal(bytes, asset);
  database = new Libsql(databaseUrl);
  assert.equal(state().starts, 1);
  checks.push(
    "complete filesystem wipe restores installed code, assets, enabled packs and server entrypoint",
  );
  await stop("SIGKILL");
  fs.rmSync(secondCache, { recursive: true, force: true });
  const thirdUrl = await start(path.join(root, "third"));
  assert.equal(
    (await request(thirdUrl, "/api/profile", undefined, cookie)).data.user
      .username,
    "ColdStartPlayer",
  );
  assert.equal(state().starts, 2);
  assert.equal(
    (await request(thirdUrl, "/api/mods")).data.packs[0].hash,
    mods.packs[0].hash,
  );
  checks.push(
    "hard process kill and second empty-filesystem restart retain account and mod SDK storage",
  );
  await stop();
  const result = {
    at: new Date().toISOString(),
    node: process.version,
    sqld: "0.24.32",
    checks,
    status: "passed",
    hostedProviderVerified: false,
  };
  fs.mkdirSync("evidence/verification/publishing", { recursive: true });
  fs.writeFileSync(
    "evidence/verification/publishing/cloud-cold-start.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (game && game.exitCode === null && game.signalCode === null) {
    const exited = once(game, "exit");
    game.kill("SIGKILL");
    await exited;
  }
  database?.close();
  if (sqld.exitCode === null && sqld.signalCode === null) {
    const exited = once(sqld, "exit");
    sqld.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
