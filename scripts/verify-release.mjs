import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
const io = createRequire(import.meta.url)("socket.io-client-v2");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bonk-release-"));
let child, socket;
const checks = [];
const releaseEnv = {
  ...process.env,
  BONK_DATABASE_URL: "",
  BONK_DATABASE_AUTH_TOKEN: "",
  BONK_MODS_DIR: path.join(directory, "mods"),
  BONK_DATA_PATH: path.join(directory, "data/bonk.sqlite"),
  NODE_TEST_CONTEXT: "",
};
const command = (name, args) =>
  execFileSync(name, args, {
    cwd: directory,
    env: releaseEnv,
    stdio: "pipe",
    timeout: 120000,
  });
try {
  for (const file of [
    "package.json",
    "package-lock.json",
    "dist",
    "public",
    "third-party",
  ])
    fs.cpSync(file, path.join(directory, file), { recursive: true });
  fs.mkdirSync(path.join(directory, "evidence/protocol"), { recursive: true });
  for (const file of ["native-catalog.json", "builtin-maps.json"])
    fs.copyFileSync(
      "evidence/protocol/" + file,
      path.join(directory, "evidence/protocol", file),
    );
  fs.copyFileSync(
    "vendor/manifold-server/LICENSE",
    path.join(directory, "third-party/manifold-server-LICENSE"),
  );
  command("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
  for (const name of ["tsx", "typescript", "@types/express"])
    assert.equal(
      fs.existsSync(path.join(directory, "node_modules", name)),
      false,
    );
  assert.ok(fs.existsSync(path.join(directory, "node_modules/esbuild")));
  checks.push("clean production-only dependency install");
  command("npm", [
    "run",
    "mods",
    "--",
    "install",
    "./public/help/examples/orb-kit-1.0.0.bonkmod",
  ]);
  command("npm", ["run", "mods", "--", "enable", "orb-kit"]);
  checks.push(
    "bundled CLI compiles and installs a real modpack without TypeScript runtime",
  );
  child = spawn(process.execPath, ["dist/server.mjs"], {
    cwd: directory,
    env: {
      ...releaseEnv,
      NODE_ENV: "production",
      NODE_TEST_CONTEXT: "",
      HOST: "127.0.0.1",
      PORT: "0",
      TRUST_PROXY: "",
      BONK_DATA_PATH: path.join(directory, "data/bonk.sqlite"),
      BONK_MODS_DIR: path.join(directory, "mods"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (bytes) => (log += bytes));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Startup timed out: " + log)),
      10000,
    );
    child.stdout.on("data", (bytes) => {
      log += bytes;
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Startup exited " + code + ": " + log));
    });
  });
  assert.equal((await fetch(url + "/api/health")).status, 200);
  const packs = await (await fetch(url + "/api/mods")).json();
  assert.ok(packs.packs.some((pack) => pack.id === "orb-kit"));
  for (const asset of [
    "/",
    "/game/",
    "/game/js/alpha2s.local.js",
    "/enhancements/help.js",
    "/modding/runtime.js",
  ]) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200, asset);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(url + "/evidence")).status, 404);
  checks.push("packaged server, game, Help, SDK and catalog assets load");
  const registration = await fetch(url + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "ReleaseCheck",
      password: "release-test-password",
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await (
        await fetch(url + "/api/profile", { headers: { Cookie: cookie } })
      ).json()
    ).user.username,
    "ReleaseCheck",
  );
  checks.push("account registration and session");
  const room = await (
    await fetch(url + "/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Release check" }),
    })
  ).json();
  const event = (name) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Timed out: " + name)), 5000);
      socket.once(name, (...args) => {
        clearTimeout(timer);
        resolve(args);
      });
    });
  socket = io(url, {
    path: `/rooms/${room.id}/socket.io`,
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    forceNode: true,
  });
  await event("connect");
  const joined = event("3");
  socket.emit("13", {
    userName: "ReleaseGuest",
    guest: true,
    level: 0,
    roomPassword: "",
    avatar: { bc: 0, layers: [] },
  });
  const info = await joined;
  assert.equal(info[2][info[0]].userName, "ReleaseGuest");
  checks.push("real native EIO3 WebSocket join");
  const disconnected = event("disconnect");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await disconnected;
  const [code, signal] = await exited;
  assert.equal(code, 0, log);
  assert.equal(signal, null);
  checks.push(
    "SIGTERM disconnects peers and closes persistent database cleanly",
  );
  const result = {
    at: new Date().toISOString(),
    node: process.version,
    checks,
    status: "passed",
    containerBuilt: false,
  };
  fs.mkdirSync("evidence/verification/publishing", { recursive: true });
  fs.writeFileSync(
    "evidence/verification/publishing/release-smoke.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.disconnect();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
