import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const io = createRequire(import.meta.url)("socket.io-client-v2");
const target = new URL(process.argv[2] || "");
assert.ok(
  target.protocol === "https:" ||
    (target.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(target.hostname)),
  "Use HTTPS for a public deployment.",
);
const origin = target.origin;
const local = ["localhost", "127.0.0.1"].includes(target.hostname);
const resume = process.argv.includes("--resume");
assert.ok(
  resume || process.argv.includes("--owner-ready"),
  "Provision the owner first, then pass --owner-ready. QA users must not claim the first-account owner role.",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = digest(origin).slice(0, 12);
fs.mkdirSync(".deployment", { recursive: true, mode: 0o700 });
const statePath = path.resolve(`.deployment/live-state-${key}.json`);
const save = (state) =>
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath))
  : {
      origin,
      accounts: ["A", "B"].map((suffix) => ({
        username: "QA" + randomBytes(4).toString("hex") + suffix,
        password: randomBytes(24).toString("base64url"),
      })),
    };
assert.equal(state.origin, origin);
save(state);
const checks = [];
const sockets = [];
let createdRoom;
async function request(route, { body, cookie, method, headers = {} } = {}) {
  const response = await fetch(origin + route, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined && !Buffer.isBuffer(body)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    ...(body !== undefined
      ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }
      : {}),
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json();
  assert.ok(
    response.ok,
    `${route}: ${response.status} ${data.error?.code || data.error || "Request failed"}`,
  );
  return { response, data };
}
const event = (socket, name) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Timed out waiting for native event " + name)),
      30000,
    );
    socket.once(name, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
const ack = (socket, name, ...args) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Timed out waiting for " + name)),
      30000,
    );
    socket.emit(name, ...args, (result) => {
      clearTimeout(timer);
      if (result?.error) reject(Error(result.error.message || result.error));
      else resolve(result || {});
    });
  });
async function connect(account, first = false) {
  const socket = io(origin, {
    path: `/rooms/${createdRoom}/socket.io`,
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    forceNode: true,
    extraHeaders: { Cookie: account.cookie, Origin: origin },
    timeout: 30000,
  });
  sockets.push(socket);
  socket.on("1", (_data, id) => {
    if (id) socket.emit("1", { id });
  });
  await event(socket, "connect");
  const joined = event(socket, "3"),
    settings = first ? event(socket, "21") : Promise.resolve([]);
  socket.emit("13", {
    userName: account.username,
    guest: false,
    level: 0,
    roomPassword: "",
    avatar: { bc: 0, layers: [] },
  });
  const info = await joined;
  assert.equal(info[2][info[0]].userName, account.username);
  assert.equal(info[2][info[0]].guest, false);
  return { socket, info, settings: await settings };
}
try {
  const health = (await request("/api/health")).data;
  assert.equal(health.ok, true);
  checks.push("health responds on the target origin");
  if (resume) {
    assert.ok(state.mapId, "No saved pre-restart verification state.");
    for (const account of state.accounts) {
      const result = await request("/api/login", {
        body: { username: account.username, password: account.password },
      });
      account.cookie = result.response.headers.get("set-cookie").split(";")[0];
      assert.equal(
        (await request("/api/profile", { cookie: account.cookie })).data.user
          .username,
        account.username,
      );
    }
    assert.equal(
      (
        await request(`/api/maps/${state.mapId}`, {
          cookie: state.accounts[0].cookie,
        })
      ).data.map.name,
      state.mapName,
    );
    save(state);
    checks.push(
      "both accounts and private map survive a service restart/redeploy",
    );
  } else {
    for (const account of state.accounts) {
      const route = account.registered ? "/api/login" : "/api/register";
      const result = await request(route, {
        body: { username: account.username, password: account.password },
      });
      const setCookie = result.response.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      if (!local) assert.match(setCookie, /; Secure\b/i);
      account.cookie = setCookie.split(";")[0];
      account.registered = true;
      save(state);
      const profile = (
        await request("/api/profile", { cookie: account.cookie })
      ).data;
      assert.equal(profile.user.username, account.username);
      assert.notEqual(
        profile.role,
        "owner",
        "Provision the actual owner before QA registration.",
      );
      await request("/api/logout", { body: {}, cookie: account.cookie });
      assert.equal(
        (await request("/api/profile", { cookie: account.cookie })).data.user,
        null,
      );
      const login = await request("/api/login", {
        body: { username: account.username, password: account.password },
      });
      account.cookie = login.response.headers.get("set-cookie").split(";")[0];
      save(state);
    }
    checks.push(
      "two accounts register, log out and sign back in; session cookie flags verified",
    );
    state.mapName = "Deployment verification " + key;
    state.mapId = (
      await request("/api/maps", {
        cookie: state.accounts[0].cookie,
        body: { name: state.mapName, data: { v: 1 }, visibility: "private" },
      })
    ).data.map.id;
    save(state);
    assert.equal(
      (
        await request(`/api/maps/${state.mapId}`, {
          cookie: state.accounts[0].cookie,
        })
      ).data.map.name,
      state.mapName,
    );
    checks.push("authenticated private map storage round-trips");
    for (const asset of [
      "/game/js/alpha2s.local.js",
      "/modding/runtime.js",
      "/enhancements/help.js",
    ]) {
      const response = await fetch(origin + asset, {
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200);
      assert.equal(
        digest(Buffer.from(await response.arrayBuffer())),
        digest(fs.readFileSync("public" + asset)),
        asset + " differs from the tested source",
      );
    }
    checks.push(
      "deployed engine, mod runtime and Help match the tested build bytes",
    );
  }
  createdRoom = (
    await request("/api/rooms", {
      body: { name: "Deployment verification " + key },
    })
  ).data.id;
  const host = await connect(state.accounts[0], true),
    peer = await connect(state.accounts[1]);
  const chat = event(peer.socket, "20");
  host.socket.emit("10", { message: "Live room check" });
  assert.deepEqual(await chat, [host.info[0], "Live room check"]);
  const ready = event(peer.socket, "8");
  host.socket.emit("16", { ready: true });
  assert.deepEqual(await ready, [host.info[0], true]);
  const input = event(peer.socket, "7");
  host.socket.emit("4", { i: 1, f: 2, c: 3 });
  assert.deepEqual(await input, [host.info[0], { i: 1, f: 2, c: 3 }]);
  checks.push(
    "two authenticated native EIO3 WebSocket clients join and relay chat, readiness and input",
  );
  const token = (await ack(host.socket, "mods:host-token")).token;
  const published = await request(`/api/rooms/${createdRoom}/modpack`, {
    body: fs.readFileSync("public/help/examples/orb-kit-1.0.0.bonkmod"),
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Bonk-Host": token,
    },
  });
  const profile = published.data.profile;
  const peerProfile = (
    await request(`/api/rooms/${createdRoom}/mods`, {
      cookie: state.accounts[1].cookie,
    })
  ).data;
  assert.equal(peerProfile.hash, profile.hash);
  for (const pack of peerProfile.mods) {
    if (pack.client) {
      const response = await fetch(origin + pack.client);
      assert.equal(response.status, 200);
      assert.equal(
        digest(Buffer.from(await response.arrayBuffer())),
        pack.clientHash,
      );
    }
    for (const asset of Object.values(pack.assets || {})) {
      const response = await fetch(origin + asset.url);
      assert.equal(response.status, 200);
      assert.equal(
        digest(Buffer.from(await response.arrayBuffer())),
        asset.hash,
      );
    }
  }
  const barrier = event(host.socket, "mods:error");
  host.socket.emit("5", { gs: host.settings[0], is: "verification-state" });
  assert.match(String((await barrier)[0].error), /Every player/);
  await ack(host.socket, "mods:ready", profile.hash);
  await ack(peer.socket, "mods:ready", profile.hash);
  const started = event(peer.socket, "15");
  host.socket.emit("5", { gs: host.settings[0], is: "verification-state" });
  assert.equal((await started)[1], "verification-state");
  const lobby = event(peer.socket, "13");
  host.socket.emit("14");
  await lobby;
  checks.push(
    "host archive upload, peer code/assets downloads, SHA-256 identity and readiness barrier pass",
  );
  const migration = event(peer.socket, "6");
  host.socket.disconnect();
  assert.equal((await migration)[1], peer.info[0]);
  peer.socket.disconnect();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = (await request("/api/rooms")).data;
    if (!rows.some((room) => room.id === createdRoom)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    (await fetch(origin + `/api/rooms/${createdRoom}/address`)).status,
    404,
  );
  assert.equal((await fetch(origin + profile.mods[0].client)).status, 404);
  checks.push("host migration and final-player room/archive cleanup pass");
  const result = {
    at: new Date().toISOString(),
    origin,
    node: process.version,
    resume,
    checks,
    status: "passed",
    publicDeploymentVerified: !local,
    browserGameplayVerified: false,
    scope:
      "HTTP accounts and native Socket.IO transport; gameplay and consent UI require two real browser clients",
  };
  fs.writeFileSync(
    `.deployment/verification-${local ? "local" : "live"}${resume ? "-restart" : ""}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const socket of sockets) socket.disconnect();
}
