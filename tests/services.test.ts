import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ServiceError, ServiceStore } from "../server/store.js";
import { setupServices } from "../server/services.js";

const account = (store: ServiceStore, username: string) =>
  store.register({ username, password: "correct horse battery" });
function rejectsCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof ServiceError && error.code === code,
  );
}

test("accounts persist hashed credentials, case-insensitive uniqueness, and revocable sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bonk-store-"));
  let store = new ServiceStore(join(directory, "accounts.sqlite"));
  try {
    const user = await account(store, "Alice");
    const token = store.createSession(user.id);
    store.favoriteCatalogMap(1, "562748", user.id, true);
    store.rateCatalogMap(1, "562748", user.id, 1);
    const persisted = store.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(user.id)!;
    assert.notEqual(persisted.password_hash, "correct horse battery");
    assert.equal(String(persisted.password_hash).length, 64);
    assert.equal(
      store.db.prepare("SELECT token_hash FROM sessions").get()!.token_hash ===
        token,
      false,
    );
    await assert.rejects(account(store, "alice"), { code: "username_taken" });
    await assert.rejects(
      store.login({ username: "ALICE", password: "wrong password" }),
      { code: "invalid_credentials" },
    );
    store.close();
    store = new ServiceStore(join(directory, "accounts.sqlite"));
    assert.equal(
      (
        await store.login({
          username: "ALICE",
          password: "correct horse battery",
        })
      ).id,
      user.id,
    );
    assert.equal(store.getSession(token)?.username, "Alice");
    assert.equal(store.getCatalogSocial(1, "562748", user.id).favorite, true);
    assert.equal(store.getCatalogSocial(1, "562748", user.id).myRating, 1);
    assert.equal(store.getCatalogSocial(2, "562748", user.id).ratingsCount, 0);
    store.revokeSession(token);
    assert.equal(store.getSession(token), null);
    const expired = store.createSession(user.id);
    store.db.prepare("UPDATE sessions SET expires_at = 0").run();
    assert.equal(store.getSession(expired), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("maps enforce ownership and private visibility; ratings replace a vote and favorites remain per-user", async () => {
  const store = new ServiceStore(":memory:");
  try {
    const [alice, bob] = await Promise.all([
      account(store, "Alice"),
      account(store, "Bob"),
    ]);
    const map = store.createMap(alice.id, {
      name: "Moon Ramp",
      data: { physics: { bodies: [] } },
    });
    const privateMap = store.createMap(alice.id, {
      name: "Secret",
      data: "encoded-map",
      visibility: "private",
    });
    assert.equal(store.listMaps().total, 1);
    assert.equal(
      store.listMaps({ viewerId: alice.id, ownerId: alice.id }).total,
      2,
    );
    rejectsCode(() => store.getMap(privateMap.id, bob.id), "map_not_found");
    rejectsCode(
      () => store.updateMap(map.id, bob.id, { name: "Stolen" }),
      "owner_required",
    );
    rejectsCode(() => store.deleteMap(map.id, bob.id), "owner_required");
    assert.equal(store.rateMap(map.id, bob.id, 1).rating, 1);
    const voted = store.rateMap(map.id, bob.id, -1);
    assert.equal(voted.rating, -1);
    assert.equal(voted.ratingsCount, 1);
    assert.equal(store.rateMap(map.id, bob.id, 0).ratingsCount, 0);
    rejectsCode(() => store.rateMap(map.id, bob.id, 5), "invalid_rating");
    store.favoriteMap(map.id, bob.id, true);
    assert.equal(
      store.listMaps({ viewerId: bob.id, favorites: true }).total,
      1,
    );
    assert.equal(
      store.listMaps({ viewerId: alice.id, favorites: true }).total,
      0,
    );
    assert.equal(store.listMaps({ query: "moon" }).maps[0].id, map.id);
    assert.equal(store.listMaps({ query: "alice" }).total, 1);
    store.deleteMap(map.id, alice.id);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM map_favorites").get()!
        .count,
      0,
    );
  } finally {
    store.close();
  }
});

test("only a friend request recipient can accept; neither an unrelated user nor a duplicate pair can mutate it", async () => {
  const store = new ServiceStore(":memory:");
  try {
    const [alice, bob, eve] = await Promise.all([
      account(store, "Alice"),
      account(store, "Bob"),
      account(store, "Eve"),
    ]);
    const request = store.requestFriend(alice.id, "bOB");
    assert.equal(store.listFriends(bob.id)[0].direction, "incoming");
    rejectsCode(
      () => store.acceptFriend(request.id, alice.id),
      "recipient_required",
    );
    rejectsCode(
      () => store.acceptFriend(request.id, eve.id),
      "request_not_found",
    );
    rejectsCode(
      () => store.removeFriend(request.id, eve.id),
      "request_not_found",
    );
    rejectsCode(
      () => store.requestFriend(bob.id, "Alice"),
      "friendship_exists",
    );
    assert.equal(store.acceptFriend(request.id, bob.id).status, "accepted");
    assert.equal(store.listFriends(alice.id)[0].status, "accepted");
    store.removeFriend(request.id, alice.id);
    assert.deepEqual(store.listFriends(bob.id), []);
  } finally {
    store.close();
  }
});

test("skins retain opaque original-style data, enforce ownership, and clear selection when deleted", async () => {
  const store = new ServiceStore(":memory:");
  try {
    const [alice, bob] = await Promise.all([
      account(store, "Alice"),
      account(store, "Bob"),
    ]);
    const skin = store.createSkin(alice.id, {
      name: "Layered",
      data: { bc: 123, layers: [{ type: "circle", x: 0 }] },
    });
    rejectsCode(() => store.equipSkin(skin.id, bob.id), "skin_not_found");
    rejectsCode(
      () => store.updateSkin(skin.id, bob.id, { name: "Stolen" }),
      "skin_not_found",
    );
    rejectsCode(() => store.deleteSkin(skin.id, bob.id), "skin_not_found");
    assert.equal(store.equipSkin(skin.id, alice.id).selectedSkinId, skin.id);
    assert.equal(store.listSkins(alice.id)[0].data.layers[0].type, "circle");
    store.deleteSkin(skin.id, alice.id);
    assert.equal(store.getUser(alice.id)?.selectedSkinId, null);
  } finally {
    store.close();
  }
});

test("HTTP services create HttpOnly sessions, reject cross-origin changes, and round-trip exported maps", async (t) => {
  const store = new ServiceStore(":memory:");
  const app = express();
  setupServices(app, { store });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  });
  let cookie = "";
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(authenticated && cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  assert.equal((await request("/profile")).status, 200);
  assert.equal(
    (await request("/maps", "POST", { name: "No login", data: {} })).status,
    401,
  );
  const registration = await request("/register", "POST", {
    username: "Alice",
    password: "password123",
  });
  assert.equal(registration.status, 201);
  const setCookie = registration.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  const profile = await (await request("/profile")).json();
  assert.equal(profile.user.username, "Alice");
  const blocked = await fetch(`${base}/maps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://other.example",
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "Blocked", data: {} }),
  });
  assert.equal(blocked.status, 403);
  const creation = await request("/maps", "POST", {
    name: "Example",
    data: { physics: { bodies: [{ type: "rectangle" }] } },
  });
  assert.equal(creation.status, 201);
  const saved = (await creation.json()).map;
  const exportedResponse = await request(`/maps/${saved.id}/export`);
  assert.match(
    exportedResponse.headers.get("content-disposition")!,
    /attachment/,
  );
  const exported = await exportedResponse.json();
  const importedResponse = await request("/maps/import", "POST", exported);
  assert.equal(importedResponse.status, 201);
  const imported = (await importedResponse.json()).map;
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(imported.data, saved.data);
  const malformed = await fetch(`${base}/maps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{ invalid",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");
  assert.equal((await request("/logout", "POST")).status, 200);
  assert.equal((await (await request("/profile")).json()).user, null);
});

test("native packets use verified memberships and account-owned votes; elapsed time and client XP claims grant no progress", async () => {
  const { makeNativeServiceHandler, getVerifiedLevel, levelFromXP } =
    await import("../server/services.js");
  const store = new ServiceStore(":memory:");
  try {
    const alice = await account(store, "Alice"),
      token = store.createSession(alice.id);
    const map = store.createMap(alice.id, {
        name: "Owned",
        data: "native-map",
      }),
      mapid = store.nativeId("map", map.id);
    const emitted: any[][] = [],
      socket = {
        id: "socket-one",
        data: { bonkId: 0 },
        handshake: { headers: { cookie: `bonk_session=${token}` } },
        emit: (...args: any[]) => emitted.push(args),
      };
    const room = {
      playerSockets: [socket],
      playerInfo: [{ team: 1, afk: false }],
      gameStartTime: 1000,
      gameSettings: { mo: "b" },
    };
    let now = 2000;
    const handler = makeNativeServiceHandler({ store, now: () => now });
    handler("38", { xp: 1e9, wins: 1000 }, socket, room);
    assert.equal(store.getSetting(alice.id, "xp", 0), 0);
    now += 10_000;
    handler("38", { xp: 1e9 }, socket, room);
    assert.equal(store.getSetting(alice.id, "xp", 0), 0);
    handler("38", {}, socket, room);
    handler("47", { wins: 1e9 }, socket, room);
    assert.equal(store.getSetting(alice.id, "xp", 0), 0);
    handler("39", { mapid, vote: 0 }, socket, room);
    assert.equal(store.getMap(map.id, alice.id).myRating, -1);
    assert.deepEqual(emitted.at(-1), ["50", mapid, 0]);
    handler("39", { mapid, vote: 1 }, socket, room);
    assert.equal(store.getMap(map.id, alice.id).ratingsCount, 1);
    handler("39", { mapid: 562748, vote: 1 }, socket, room);
    assert.equal(store.getCatalogSocial(1, "562748", alice.id).myRating, 1);
    handler("39", { mapid: 562748, vote: 0 }, socket, room);
    assert.equal(store.getCatalogSocial(1, "562748", alice.id).myRating, -1);
    assert.equal(store.getCatalogSocial(1, "562748", alice.id).ratingsCount, 1);
    room.playerInfo[0].team = 0;
    now += 30_000;
    handler("38", {}, socket, room);
    assert.equal(store.getSetting(alice.id, "xp", 0), 0);
    store.revokeSession(token);
    room.playerInfo[0].team = 1;
    now += 30_000;
    handler("38", {}, socket, room);
    assert.equal(store.getSetting(alice.id, "xp", 0), 0);
    assert.equal(getVerifiedLevel(alice.id, store), 1);
    assert.equal(levelFromXP(400), 3);
    const stranger = { ...socket, id: "not-joined" };
    const count = emitted.length;
    handler("42", { sf: 0 }, stranger, room);
    assert.equal(emitted.length, count);
    handler("42", { sf: 0 }, socket, room);
    assert.equal(emitted.at(-1)![0], "51");
    assert.ok(emitted.at(-1)![1].maps.length > 0);
  } finally {
    store.close();
  }
});
