import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createRequire } from "node:module";
const io = createRequire(import.meta.url)("socket.io-client-v2");
import ManifoldServer from "../vendor/manifold-server/src/server";
import config from "../vendor/manifold-server/config";

const Room = (ManifoldServer as any).default ?? ManifoldServer;
const settings = (config as any).default ?? config;
const app = express();
const httpServer = http.createServer(app);
const makeRoom = (id: string) =>
  new Room(
    {
      ...settings,
      defaultGameSettings: structuredClone(settings.defaultGameSettings),
    },
    {
      httpServer,
      expressApp: app,
      socketPath: `/rooms/${id}/socket.io`,
      metadataPath: false,
      terminal: false,
      origins: true,
    },
  );
const roomA = makeRoom("a");
const roomB = makeRoom("b");
await new Promise<void>((resolve) =>
  httpServer.listen(0, "127.0.0.1", resolve),
);
const address = httpServer.address() as { port: number };
const url = `http://127.0.0.1:${address.port}`;
const clients: any[] = [];
function once(socket: any, event: string) {
  return new Promise<any[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out ${event}`)),
      3000,
    );
    socket.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}
async function connect(room: string, name: string) {
  const socket = io(url, {
    path: `/rooms/${room}/socket.io`,
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  await once(socket, "connect");
  const inform = once(socket, "3");
  socket.emit(13, {
    userName: name,
    guest: true,
    level: 0,
    roomPassword: "",
    avatar: { bc: 0, layers: [] },
  });
  await inform;
  return socket;
}
try {
  const a = await connect("a", "Alice");
  const a2 = await connect("a", "Bob");
  const b = await connect("b", "Carol");
  assert.equal(roomA.playerAmount, 2);
  assert.equal(roomB.playerAmount, 1);
  const gotChat = once(a2, "20");
  let crossed = false;
  b.on("20", () => (crossed = true));
  a.emit("10", { message: "Room isolation" });
  assert.deepEqual(await gotChat, [0, "Room isolation"]);
  const ready = once(a2, "8");
  a.emit("16", { ready: true });
  assert.deepEqual(await ready, [0, true]);
  const error = once(a2, "16");
  a2.emit("5", {
    gs: settings.defaultGameSettings,
    is: "compressed-native-state",
  });
  assert.equal((await error)[0], "not_hosting");
  const ping = once(a, "1");
  a.emit("2");
  const pingInfo = await ping;
  assert.ok(pingInfo[0][0] === 0);
  a.emit("1", { id: pingInfo[1] });
  const balance = once(a2, "36");
  a.emit("29", { sid: 1, bal: 20 });
  assert.deepEqual(await balance, [1, 20]);
  const renamed = once(a2, "58");
  a.emit("52", { newName: "Native renamed" });
  assert.deepEqual(await renamed, ["Native renamed"]);
  const reset = once(a2, "9");
  a.emit("17");
  await reset;
  assert.equal(roomA.playerInfo[0].ready, false);
  const input = once(a2, "7");
  a.emit(4, { i: 1, f: 2, c: 3 });
  assert.deepEqual(await input, [0, { i: 1, f: 2, c: 3 }]);
  const start = once(a2, "15");
  a.emit(5, {
    gs: settings.defaultGameSettings,
    is: "compressed-native-state",
  });
  const started = await start;
  assert.ok(started[0] > 0);
  assert.equal(started[1], "compressed-native-state");
  const admin = once(a2, "31");
  a.emit(25, {
    a: { playersJoined: [{ id: 1, t: 1 }], playersLeft: [] },
    f: 45,
  });
  assert.equal((await admin)[0].f, 45);
  const deniedAdmin = once(a2, "16");
  a2.emit("25", { a: { playersJoined: [], playersLeft: [0] }, f: 45 });
  assert.equal((await deniedAdmin)[0], "not_hosting");
  const end = once(a2, "13");
  a.emit("14");
  await end;
  assert.equal(roomA.gameStartTime, 0);
  const malformed = once(a, "16");
  a.emit("10", null);
  assert.equal((await malformed)[0], "invalid_packet");
  const invalidTarget = once(a, "16");
  a.emit("26", { targetID: -1, targetTeam: 99 });
  assert.equal((await invalidTarget)[0], "invalid_packet");
  const changedHost = once(a2, "6");
  a.disconnect();
  const hostPacket = await changedHost;
  assert.equal(hostPacket[1], 1);
  assert.equal(roomA.hostId, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(crossed, false);
  roomB.dispose();
  assert.equal(httpServer.listening, true);
  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: "Engine.IO v3 websocket (socket.io-client 2.5.0)",
        checks: [
          "two isolated socket paths on one HTTP server",
          "join",
          "chat",
          "ready",
          "non-host start denied",
          "input relay",
          "host starts game",
          "lobby resets time",
          "malformed packet rejected",
          "invalid target rejected",
          "host migration",
          "native ping handshake",
          "balance uses correct event 36",
          "native room rename",
          "ready reset",
          "host admin frame relay",
          "non-host admin denied",
          "dispose preserves parent HTTP",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) client.disconnect();
  roomA.dispose();
  roomB.dispose();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
