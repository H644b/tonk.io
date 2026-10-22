import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const io = createRequire(import.meta.url)("socket.io-client-v2");

test("production artifact starts independently and enforces host mod rules and empty-room lifecycle", async () => {
  const modsDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bonk-room-lifecycle-"),
  );
  const child = spawn(process.execPath, ["dist/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      BONK_DATA_PATH: ":memory:",
      BONK_MODS_DIR: modsDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (b) => (errors += String(b)));
  const clients: any[] = [];
  const event = (socket: any, name: string) =>
    new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Timeout " + name)), 3000);
      socket.once(name, (...args: any[]) => {
        clearTimeout(timer);
        resolve(args);
      });
    });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Server did not start: " + errors)),
        5000,
      );
      child.stdout.on("data", (b) => {
        output += String(b);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("Server exited " + code + ": " + errors));
      });
    });
    assert.equal(
      (await (await fetch(url + "/api/health")).json()).independent,
      true,
    );
    assert.equal(
      (await fetch(url + "/enhancements/mod-worker.js")).headers
        .get("content-security-policy")
        ?.includes("connect-src 'none'"),
      true,
    );
    assert.equal(
      (
        await fetch(url + "/api/rooms", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://example.invalid",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const created = await (
      await fetch(url + "/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Host permissions", maxPlayers: 99 }),
      })
    ).json();
    const connect = async (
      name: string,
      needsSettings = false,
      identity: { cookie?: string; guest?: boolean } = {},
      roomId = created.id,
    ) => {
      const socket = io(url, {
        path: `/rooms/${roomId}/socket.io`,
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        forceNode: true,
        extraHeaders: identity.cookie ? { Cookie: identity.cookie } : {},
      });
      clients.push(socket);
      await event(socket, "connect");
      const joined = event(socket, "3"),
        settings = needsSettings ? event(socket, "21") : Promise.resolve([]);
      socket.emit("13", {
        userName: name,
        guest: identity.guest ?? true,
        level: 0,
        roomPassword: "",
        avatar: { bc: 0, layers: [] },
      });
      const info = await joined;
      return { socket, settings, info };
    };
    const registration = await fetch(url + "/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "VerifiedPlayer",
        password: "independent-test-strong-password",
      }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get("set-cookie")!.split(";")[0];
    const identityRoom = await (
      await fetch(url + "/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Identity verification" }),
      })
    ).json();
    const optedGuest = await connect(
      "Chosen Guest",
      false,
      {
        cookie,
        guest: true,
      },
      identityRoom.id,
    );
    assert.equal(
      optedGuest.info[2][optedGuest.info[0]].userName,
      "Chosen Guest",
    );
    assert.equal(optedGuest.info[2][optedGuest.info[0]].guest, true);
    const signedIn = await connect(
      "Untrusted claimed name",
      false,
      {
        cookie,
        guest: false,
      },
      identityRoom.id,
    );
    assert.equal(signedIn.info[2][signedIn.info[0]].userName, "VerifiedPlayer");
    assert.equal(signedIn.info[2][signedIn.info[0]].guest, false);
    optedGuest.socket.disconnect();
    signedIn.socket.disconnect();
    await fetch(url + "/api/rooms");
    const { socket: host, settings } = await connect("Alice", true);
    const gs = (await settings)[0];
    const { socket: guest } = await connect("Bob");
    const rules = (socket: any, data: any) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("No mod acknowledgement")),
          3000,
        );
        socket.emit("wb:rules", data, (result: any) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    assert.equal(
      (await rules(guest, { rounds: 5 })).error,
      "Only the current host can change room rules.",
    );
    assert.equal(
      (await rules(host, { rounds: 0 })).error,
      "Rounds must be 1–99.",
    );
    const rounds = event(guest, "27");
    assert.equal((await rules(host, { rounds: 5 })).ok, true);
    assert.equal((await rounds)[0], 5);
    const ready = event(guest, "8");
    host.emit("16", { ready: true });
    await ready;
    const started = event(host, "15");
    host.emit("5", { is: "native-shaped-opaque-compressed-state", gs });
    await started;
    assert.equal(
      (await rules(host, { teams: true })).error,
      "Return to the lobby before changing rules.",
    );
    const returned = event(host, "13");
    host.emit("14");
    await returned;
    assert.equal((await rules(host, { teams: true })).ok, true);
    const startedAgain = event(host, "15");
    host.emit("5", { is: "native-shaped-opaque-compressed-state", gs });
    await startedAgain;
    const waitForRooms = async (
      predicate: (rooms: any[]) => boolean,
    ): Promise<any[]> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const rows = await (await fetch(url + "/api/rooms")).json();
        if (predicate(rows)) return rows;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Room directory did not reach the expected lifecycle state");
    };
    const assertClosed = async (id: string) => {
      await waitForRooms((rows) => !rows.some((room) => room.id === id));
      assert.equal((await fetch(url + `/api/rooms/${id}/address`)).status, 404);
      assert.equal((await fetch(url + `/api/rooms/${id}/mods`)).status, 404);
      assert.equal(
        (await fetch(url + `/rooms/${id}/socket.io/?EIO=3&transport=polling`))
          .status,
        404,
      );
      const native = await (
        await fetch(url + "/api/rooms/native?include=" + id)
      ).json();
      assert.equal(
        native.rooms.some((room: any) => room.id === id),
        false,
      );
      assert.equal((await (await fetch(url + "/api/health")).json()).ok, true);
    };
    // The host is the sole remaining player in a running game, then leaves.
    guest.disconnect();
    const stillOpen = (
      await waitForRooms(
        (rows) => rows.find((room) => room.id === created.id)?.players === 1,
      )
    ).find((room) => room.id === created.id);
    assert.equal(stillOpen.ingame, 1);
    assert.equal(stillOpen.maxplayers, 8);
    host.disconnect();
    await assertClosed(created.id);
    await assertClosed(identityRoom.id);

    const newRoom = async (name: string) =>
      (
        await (
          await fetch(url + "/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          })
        ).json()
      ).id;
    const soloId = await newRoom("Single host in lobby");
    const solo = await connect("Solo", false, {}, soloId);
    const survivorId = await newRoom("Other room survives");
    const survivor = await connect("Survivor", false, {}, survivorId);
    const credential = await new Promise<any>((resolve) =>
      solo.socket.emit("mods:host-token", resolve),
    );
    const published = await fetch(url + `/api/rooms/${soloId}/modpack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Bonk-Host": credential.token,
      },
      body: fs.readFileSync("public/help/examples/orb-kit-1.0.0.bonkmod"),
    });
    assert.equal(published.status, 201);
    const pack = (await published.json()).profile.mods[0];
    assert.equal((await fetch(url + pack.client)).status, 200);
    // An unjoined transport connection must not keep an ownerless room alive.
    const pending = io(url, {
      path: `/rooms/${soloId}/socket.io`,
      transports: ["polling"],
      forceNew: true,
      reconnection: false,
    });
    clients.push(pending);
    await event(pending, "connect");
    const pendingClosed = event(pending, "disconnect");
    solo.socket.disconnect();
    await pendingClosed;
    await assertClosed(soloId);
    assert.equal(
      (await fetch(url + pack.client)).status,
      404,
      "Closed rooms no longer distribute host packs",
    );
    assert.equal(survivor.socket.connected, true);
    assert.equal(
      (
        await fetch(
          url + `/rooms/${survivorId}/socket.io?EIO=3&transport=polling`,
          { signal: AbortSignal.timeout(1000) },
        )
      ).status,
      404,
      "Malformed transport paths must not hang",
    );
    assert.equal((await rules(survivor.socket, { rounds: 4 })).ok, true);

    // A departing host hands the room to the remaining member; only the last
    // departure closes it. Explicit host transfer must obey the same rule.
    const peer = await connect("NextHost", false, {}, survivorId);
    const migration = event(peer.socket, "6");
    survivor.socket.disconnect();
    assert.equal((await migration)[1], peer.info[0]);
    await waitForRooms(
      (rows) => rows.find((room) => room.id === survivorId)?.players === 1,
    );
    assert.equal((await rules(peer.socket, { rounds: 7 })).ok, true);
    const nextPeer = await connect("TransferredHost", false, {}, survivorId);
    const transfer = event(nextPeer.socket, "41");
    peer.socket.emit("34", { id: nextPeer.info[0] });
    assert.equal((await transfer)[0].newHost, nextPeer.info[0]);
    peer.socket.disconnect();
    await waitForRooms(
      (rows) => rows.find((room) => room.id === survivorId)?.players === 1,
    );
    nextPeer.socket.disconnect();
    await assertClosed(survivorId);
    assert.deepEqual(await (await fetch(url + "/api/rooms")).json(), []);
  } finally {
    for (const client of clients) client.disconnect();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    fs.rmSync(modsDirectory, { recursive: true, force: true });
  }
});
