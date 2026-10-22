import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { ServiceStore } from "../server/store.js";
import { setupCompatibility } from "../server/compatibility.js";

async function fixture(t: test.TestContext) {
  const store = new ServiceStore(":memory:"),
    app = express();
  setupCompatibility(app, { store, roomForUser: () => "practice" });
  app.all("/compat/:endpoint", (_req, res) =>
    res.status(501).json({ r: "unimplemented" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/compat`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  });
  async function post(
    endpoint: string,
    values: Record<string, string | number | boolean> = {},
  ) {
    const response = await fetch(`${base}/${endpoint}.php`, {
      method: "POST",
      body: new URLSearchParams(
        Object.entries(values).map(([key, value]) => [key, String(value)]),
      ),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { store, base, post };
}

test("native account/avatar/control schemas persist and password changes preserve the current native token", async (t) => {
  const { post, store, base } = await fixture(t);
  const registered = await post("register_legacy", {
    username: "Alice",
    password: "password123",
    remember: true,
  });
  assert.equal(registered.r, "success");
  assert.equal(Number.isInteger(registered.id), true);
  assert.equal(registered.activeAvatarNumber, 1);
  assert.equal(registered.rememberToken, registered.token);
  const user = store.getSession(registered.token)!;
  const otherSession = store.createSession(user.id);
  assert.equal(
    (
      await post("avatar_update", {
        token: registered.token,
        task: "updateavatar",
        newavatarslot: 2,
        newavatar: "opaque-native-avatar",
      })
    ).r,
    "success",
  );
  await post("avatar_update", {
    token: registered.token,
    task: "updateslot",
    newactive: 2,
  });
  await post("account_savecontrols", {
    token: registered.token,
    controls: "opaque-native-controls",
  });
  const automatic = await post("login_auto", {
    rememberToken: registered.token,
  });
  assert.equal(automatic.avatar2, "opaque-native-avatar");
  assert.equal(automatic.avatar, "opaque-native-avatar");
  assert.equal(automatic.activeAvatarNumber, 2);
  assert.equal(automatic.controls, "opaque-native-controls");
  assert.equal(store.listSkins(user.id)[0].data, "opaque-native-avatar");
  assert.equal(
    (
      await post("account_changepassword", {
        token: registered.token,
        oldpass: "password123",
        newpass: "new password123",
      })
    ).r,
    "success",
  );
  assert.equal(store.getSession(registered.token)?.id, user.id);
  assert.equal(store.getSession(otherSession), null);
  assert.equal(
    (
      await post("login_legacy", {
        username: "alice",
        password: "new password123",
      })
    ).id,
    registered.id,
  );
  assert.equal((await fetch(`${base}/login_clearauto.php`)).status, 405);
});

test("native maps save with overwrite confirmation and stable numeric IDs while enforcing account ownership", async (t) => {
  const { post, store } = await fixture(t);
  const alice = await post("register_legacy", {
    username: "Alice",
    password: "password123",
  });
  const bob = await post("register_legacy", {
    username: "Bob",
    password: "password123",
  });
  const input = {
    token: alice.token,
    mapname: "Ramp",
    leveldata: "native-encoded-map",
    public: true,
    overwriteok: false,
  };
  const saved = await post("map_save_pub", input);
  assert.equal(saved.r, "success");
  assert.equal(Number.isInteger(saved.mapid), true);
  assert.equal((await post("map_save_pub", input)).r, "overwrite_confirm");
  assert.equal(
    (
      await post("map_save_pub", {
        ...input,
        overwriteok: true,
        leveldata: "updated-native-map",
      })
    ).mapid,
    saved.mapid,
  );
  const listed = await post("map_getfresh");
  assert.equal(listed.maps.length, 1);
  assert.equal(listed.maps[0].leveldata, "updated-native-map");
  assert.equal(listed.maps[0].published, 1);
  assert.match(
    listed.maps[0].creationdate,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
  assert.equal(
    (await post("map_delete", { token: bob.token, mapid: saved.mapid })).e,
    "owner_required",
  );
  assert.equal(
    (
      await post("map_fave", {
        token: bob.token,
        mapid: saved.mapid,
        action: "f",
      })
    ).r,
    "success",
  );
  assert.equal(
    (
      await post("map_fave", {
        token: bob.token,
        mapid: saved.mapid,
        action: "f",
      })
    ).e,
    "already_faved",
  );
  assert.equal(
    (await post("map_getfave", { token: bob.token })).maps[0].id,
    String(saved.mapid),
  );
  assert.equal(
    (
      await post("map_getsearch", {
        searchstring: "alice",
        searchauthor: true,
        searchmapname: false,
      })
    ).maps.length,
    1,
  );
  assert.equal(
    (
      await post("map_getsearch", {
        searchstring: "alice",
        searchauthor: false,
        searchmapname: true,
      })
    ).maps.length,
    0,
  );
  assert.ok(store.entityId("map", saved.mapid));
  assert.equal(
    (await post("map_delete", { token: alice.token, mapid: saved.mapid })).r,
    "success",
  );
  assert.equal((await post("map_getfresh")).maps.length, 0);
});

test("native friend schemas support incoming requests, reciprocal acceptance, presence, and removal", async (t) => {
  const { post } = await fixture(t);
  const alice = await post("register_legacy", {
    username: "Alice",
    password: "password123",
  });
  const bob = await post("register_legacy", {
    username: "Bob",
    password: "password123",
  });
  assert.equal(
    (
      await post("friends", {
        token: alice.token,
        task: "send",
        theirname: "Bob",
      })
    ).r,
    "send_success",
  );
  const incoming = await post("friends", {
    token: bob.token,
    task: "getfriends",
  });
  assert.equal(incoming.requests[0].name, "Alice");
  assert.equal(incoming.requests[0].id, alice.id);
  assert.equal(
    (
      await post("friends", {
        token: bob.token,
        task: "send",
        theirname: "Alice",
      })
    ).r,
    "accept_success",
  );
  const accepted = await post("friends", {
    token: alice.token,
    task: "getfriends",
  });
  assert.equal(accepted.friends[0].roomid, "practice");
  assert.equal(accepted.friends[0].id, bob.id);
  assert.equal(
    (
      await post("friends", {
        token: alice.token,
        task: "unfriend",
        theirid: bob.id,
      })
    ).r,
    "success",
  );
  assert.deepEqual(
    (await post("friends", { token: bob.token, task: "getfriends" })).friends,
    [],
  );
});

test("bundled catalog preserves all authors/versions without assigning local owners and returns text cache schemas", async (t) => {
  const { base, store, post } = await fixture(t);
  const catalogResponse = await fetch(
    base.replace("/compat", "/api/catalog/maps"),
  );
  const catalog = await catalogResponse.json();
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.total, 289);
  assert.ok(catalog.maps.some((map: any) => map.dbv === 1));
  assert.ok(catalog.maps.some((map: any) => map.dbv === 2));
  assert.equal(catalog.maps[0].authorname, catalog.maps[0].source.author);
  assert.equal(store.listMaps().total, 0);
  const cache = await fetch(`${base}/picks.txt`);
  assert.match(cache.headers.get("content-type")!, /text\/plain/);
  assert.equal(JSON.parse(await cache.text()).maps.length, 0, 'picks contain actual local curator decisions');
  const hot = JSON.parse(await (await fetch(`${base}/cache3_4_sp.txt`)).text());
  assert.ok(hot.maps.length > 0);
  assert.ok(
    hot.maps.every(
      (map: any) => map.dbv === 2 && map.category === "grappleMapStrings",
    ),
  );
  const legacy = await post("map_b1_getbest");
  const encoded = new URLSearchParams(legacy.maps);
  assert.ok(Number(encoded.get("cant")) > 0);
  assert.ok(encoded.get("authorname0"));
  assert.ok(encoded.get("leveldata0"));
  const countResponse = await fetch(`${base}/combinedplayercount.txt`);
  const count = JSON.parse(await countResponse.text());
  assert.equal(count.bonk.total, 0);
  assert.equal(count.bonk.quick_arrows, "0");
});

test("native replays persist opaque data, deduplicate submissions, filter versions, and record reports", async (t) => {
  const { post, store } = await fixture(t);
  const input = {
    replaydata: "opaque-native-replay",
    version: 48,
    mode: "b",
    mapid: 123,
  };
  const saved = await post("replay_submit", input);
  assert.equal(saved.r, "success");
  assert.equal((await post("replay_submit", input)).id, saved.id);
  assert.equal(
    (await post("replay_get", { version: 48 })).replays[0].replaydata,
    input.replaydata,
  );
  assert.deepEqual((await post("replay_get", { version: 47 })).replays, []);
  assert.equal(
    (await post("replay_report", { replayid: saved.id })).r,
    "success",
  );
  assert.equal(
    (await post("replay_report", { replayid: saved.id })).r,
    "success",
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM replay_reports").get()!
      .count,
    1,
  );
});

test("source favorites and local ratings preserve provenance across modern, B1, REST, and native packet schemas", async (t) => {
  const { post, store, base } = await fixture(t);
  const { nativeCatalog, builtinCatalog, sourceVersion } = await import(
    "../server/catalog.js"
  );
  const source = nativeCatalog.find((map) => sourceVersion(map) === 1)!;
  const modernSource = nativeCatalog.find((map) => sourceVersion(map) === 2)!;
  const originalData = builtinCatalog.find(
    (map) => map.dbv === 1 && map.id === source.id,
  )!.leveldata;
  const alice = await post("register_legacy", {
    username: "Alice",
    password: "password123",
  });
  const bob = await post("register_legacy", {
    username: "Bob",
    password: "password123",
  });
  assert.equal(
    (
      await post("map_fave", {
        token: alice.token,
        mapid: source.id,
        action: "f",
      })
    ).r,
    "success",
  );
  assert.equal(
    (
      await post("map_fave", {
        token: alice.token,
        mapid: modernSource.id,
        action: "f",
      })
    ).r,
    "success",
  );
  const favorites = await post("map_getfave", { token: alice.token });
  const convertedFavorite = favorites.maps.find(
    (map: any) => map.id === source.id,
  );
  assert.equal(convertedFavorite.dbv, 2);
  assert.equal(convertedFavorite.sourceDbv, 1);
  assert.equal(convertedFavorite.leveldata, source.leveldata);
  assert.equal(convertedFavorite.authorname, source.authorname);
  assert.equal(convertedFavorite.source.author, source.authorname);
  assert.equal(convertedFavorite.ratingScope, "local-server");
  assert.equal(
    (await post("map_getfave", { token: bob.token })).maps.length,
    0,
  );
  const legacy = new URLSearchParams(
    (await post("map_b1_getfave", { token: alice.token })).maps,
  );
  assert.equal(legacy.get("cant"), "1");
  assert.equal(legacy.get("authorname0"), source.authorname);
  assert.equal(legacy.get("leveldata0"), originalData);
  assert.equal(
    (await post("map_getown", { token: alice.token })).maps.length,
    0,
  );
  assert.equal(store.listMaps().total, 0);
  const path = base.replace("/compat", `/api/catalog/maps/1/${source.id}`);
  const rate = (token: string, rating: number) =>
    fetch(`${path}/rating`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `bonk_session=${token}`,
      },
      body: JSON.stringify({ rating }),
    });
  assert.equal((await rate(alice.token, 1)).status, 200);
  const voted = await (await rate(bob.token, -1)).json();
  assert.equal(voted.map.localVotesUp, 1);
  assert.equal(voted.map.localVotesDown, 1);
  assert.equal(voted.map.ratingsCount, 2);
  assert.equal(voted.map.myRating, -1);
  assert.equal(voted.map.authorname, source.authorname);
  assert.equal(voted.map.leveldata, source.leveldata);
  await rate(alice.token, -1);
  assert.equal(store.getCatalogSocial(1, source.id).ratingsCount, 2);
  assert.equal(store.getCatalogSocial(1, source.id).localVotesDown, 2);
  assert.equal(store.getCatalogSocial(2, source.id).ratingsCount, 0);
  await rate(alice.token, 0);
  assert.equal(store.getCatalogSocial(1, source.id).ratingsCount, 1);
  const anonymous = await fetch(`${path}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(anonymous.status, 401);
  const crossOrigin = await fetch(`${path}/favorite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `bonk_session=${alice.token}`,
      Origin: "https://unrelated.example",
    },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(
    (
      await post("map_fave", {
        token: alice.token,
        mapid: source.id,
        action: "u",
      })
    ).r,
    "success",
  );
  assert.equal(
    new URLSearchParams(
      (await post("map_b1_getfave", { token: alice.token })).maps,
    ).get("cant"),
    "0",
  );
  assert.equal(
    (await post("map_getfave", { token: alice.token })).maps.length,
    1,
  );
  assert.equal(
    nativeCatalog.find(
      (map) => sourceVersion(map) === 1 && map.id === source.id,
    )!.authorname,
    source.authorname,
  );
});
