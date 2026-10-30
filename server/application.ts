import { RoomBots } from "./bots.ts";
import { setupAdministration } from "./administration.ts";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import ManifoldServer from "../vendor/manifold-server/src/server.ts";
import {
  setupServices,
  getRequestToken,
  makeNativeServiceHandler,
  getVerifiedLevel,
} from "./services.ts";
import { serviceStore as defaultStore, type ServiceStore } from "./store.ts";
import { setupCompatibility, nativeFriendRows } from "./compatibility.ts";
import { ModServer } from "./modding/runtime.ts";
import type { ModRepository } from "./modding/repository.ts";
import defaultConfig from "../vendor/manifold-server/config.ts";
const baseConfig = (defaultConfig as any).default ?? defaultConfig;
const RoomServer = (ManifoldServer as any).default ?? ManifoldServer;
export interface ApplicationOptions { store?: ServiceStore; repository?: ModRepository; modServer?: ModServer; socketServer?: (id: string) => any; skipStatic?: boolean; }
export async function createApplication(options: ApplicationOptions = {}) {
const serviceStore = options.store ?? defaultStore;
const app = express();
app.disable("x-powered-by");
// Only trust the configured proxy addresses, never arbitrary forwarded headers.
if (process.env.TRUST_PROXY)
  app.set(
    "trust proxy",
    process.env.TRUST_PROXY.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
let shuttingDown = false;
const upgradedSockets = new Set<Duplex>();
// Each room owns an unattached transport server. Route through the shared
// listener so disposing a room removes its endpoint without retaining Socket.IO
// request wrappers or closing the HTTP server used by the other rooms.
const server = http.createServer((req, res) => {
  if (shuttingDown) {
    res.writeHead(503, { Connection: "close", "Retry-After": "10" });
    return void res.end("Server restarting. Please reconnect shortly.");
  }
  const transport = roomTransport(req.url);
  if (transport === undefined) return app(req, res);
  if (transport) return void transport.emit("request", req, res);
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Room not found." }));
});
server.on("upgrade", (req, socket, head) => {
  if (shuttingDown) return void socket.destroy();
  const transport = roomTransport(req.url);
  if (transport) {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    transport.emit("upgrade", req, socket, head);
  } else socket.destroy();
});
function roomTransport(url = ""): http.Server | null | undefined {
  const match = /^\/rooms\/([^/]+)\/socket\.io\//.exec(url);
  return match ? rooms.get(match[1])?.transport || null : undefined;
}
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false, limit: "4mb" }));
app.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host)
        return res.status(403).json({ error: "Use this server’s page." });
    } catch {
      return res.status(403).json({ error: "Invalid origin." });
    }
  }
  next();
});
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
const nativeCatalog = JSON.parse(
  fs.readFileSync(
    new URL("../evidence/protocol/native-catalog.json", import.meta.url),
    "utf8",
  ),
);
const nativeServices = makeNativeServiceHandler({ store: serviceStore });
const modServer = options.modServer ?? new ModServer(options.repository);
await modServer.initialize();
const roomAttempts = new Map<string, { count: number; until: number }>();
const rooms = new Map<
  string,
  {
    id: string;
    room: ManifoldServer;
    transport: http.Server;
    created: number;
    unlisted: boolean;
    mods: any[];
    bots: RoomBots;
  }
>();
function maybeAutoStart(id: string) {
  const room = rooms.get(id)?.room as any;
  if (!room) return;
  if (room.gameStartTime || room.playerAmount < 2)
    room.autoStartRequested = false;
  if (
    room.gameSettings.q &&
    !room.gameStartTime &&
    room.playerAmount >= 2 &&
    !room.autoStartRequested &&
    modServer.ready(id)
  ) {
    room.autoStartRequested = true;
    room.playerSockets[room.hostId]?.emit("wb:auto-start");
  }
}
modServer.onRoomReady = maybeAutoStart;
function createRoom(input: any = {}, id = randomBytes(4).toString("hex")) {
  if (rooms.size >= 50) throw Error("Room limit reached");
  const config = structuredClone({
    ...baseConfig,
    restrictions: {
      ...baseConfig.restrictions,
      usernames: { ...baseConfig.restrictions.usernames },
    },
  });
  const selectedPacks = modServer.resolve(input.mods || []);
  const customMode =
    typeof input.mode === "string" && input.mode.includes(":")
      ? modServer.mode(input.mode)
      : null;
  if (typeof input.mode === "string" && input.mode.includes(":") && !customMode)
    throw Error("Custom mode is not installed on this server.");
  if (
    customMode &&
    !selectedPacks.some((pack) => pack.manifest.id === input.mode.split(":")[0])
  )
    throw Error("Select the mod that provides this mode.");
  const mode = customMode?.base || input.mode;
  config.roomNameOnStartup = String(input.name || "Classic room")
    .replace(/[<>]/g, "")
    .slice(0, 60);
  config.roomPasswordOnStartup =
    String(input.password || "").slice(0, 64) || null;
  config.restrictions.levels.minLevel = Math.max(
    0,
    Math.min(999, Number(input.minLevel) || 0),
  );
  config.restrictions.levels.maxLevel = Math.max(
    config.restrictions.levels.minLevel,
    Math.min(999, Number(input.maxLevel) || 999),
  );
  config.maxPlayers = Math.max(2, Math.min(8, Number(input.maxPlayers) || 8));
  config.defaultGameSettings.mo = [
    "b",
    "ar",
    "ard",
    "bs",
    "sp",
    "f",
    "v",
  ].includes(mode)
    ? mode
    : "b";
  config.defaultGameSettings.ga =
    config.defaultGameSettings.mo === "f" ? "f" : "b";
  config.defaultGameSettings.q = input.quick === true;
  if (customMode) (config.defaultGameSettings as any).wbMode = input.mode;
  const defaultMap = nativeCatalog.find(
    (m: any) =>
      m.name ===
      (config.defaultGameSettings.mo === "ar" ||
      config.defaultGameSettings.mo === "ard"
        ? "Just Fight"
        : config.defaultGameSettings.mo === "sp"
          ? "average grapple user"
          : "Classic"),
  );
  if (defaultMap) config.defaultGameSettings.map = defaultMap.leveldata;
  const transport = http.createServer();
  const room = new RoomServer(config, {
    httpServer: transport,
    expressApp: express(),
    socketPath: `/rooms/${id}/socket.io`,
    metadataPath: false,
    terminal: false,
    origins: false,
    onServiceEvent: nativeServices,
    socketServer: options.socketServer?.(id),
    onChange: () => {
      queueMicrotask(() => {
        rooms.get(id)?.bots.changed();
        modServer.changed(id);
        maybeAutoStart(id);
      });
    },
    onEmpty: (emptyRoom: ManifoldServer) => {
      // Let the final membership notification run before disposing mod state.
      queueMicrotask(() => closeRoom(id, emptyRoom));
    },
    authorizeJoin: (data: any, socket: any) => {
      const rejection = modServer.authorizeJoin(id, data, socket);
      if (rejection) return rejection;
      const profile =
        data.guest === true
          ? null
          : serviceStore.getSession(
              getRequestToken({ headers: socket.handshake.headers } as any),
            );
      if (profile) {
        socket.data.userId = profile.id;
        data.userName = profile.username;
        data.level = getVerifiedLevel(profile.id, serviceStore);
        data.guest = false;
      } else {
        data.level = 0;
        data.guest = true;
      }
    },
  });
  modServer.attachRoom(id, room, selectedPacks);
  const bots = new RoomBots(room, () => modServer.rooms.get(id)?.profile || {hash:""});
  room.io.on("connection", (socket: any) => {
    socket.on("wb:round", (data: any, ack: any) => {
      const result = nativeServices.recordRound(data, socket, room);
      if (typeof ack === "function") ack(result);
    });
    socket.on("wb:rules", (rules: any, ack: any) => {
      const reply = (data: any) => {
        if (typeof ack === "function") ack(data);
      };
      if (room.playerSockets[room.hostId]?.id !== socket.id)
        return reply({ error: "Only the current host can change room rules." });
      if (room.gameStartTime)
        return reply({ error: "Return to the lobby before changing rules." });
      if (!rules || typeof rules !== "object" || Array.isArray(rules))
        return reply({ error: "Rules must be an object." });
      if (rules.rounds !== undefined) {
        if (
          !Number.isInteger(rules.rounds) ||
          rules.rounds < 1 ||
          rules.rounds > 99
        )
          return reply({ error: "Rounds must be 1–99." });
        room.gameSettings.wl = rules.rounds;
        room.io.to("main").emit("27", rules.rounds);
      }
      if (typeof rules.teams === "boolean") {
        room.gameSettings.tea = rules.teams;
        room.io.to("main").emit("39", rules.teams);
      }
      if (typeof rules.map === "string" && rules.map.length < 1000000) {
        room.gameSettings.map = rules.map;
        room.io.to("main").emit("29", rules.map);
      }
      reply({ ok: true });
    });
  });
  rooms.set(id, {
    id,
    room,
    transport,
    created: Date.now(),
    unlisted: !!input.unlisted,
    mods: selectedPacks.map((pack) => pack.manifest.id),
    bots,
  });
  return id;
}
function closeRoom(id: string, expectedRoom?: ManifoldServer) {
  const entry = rooms.get(id);
  if (
    !entry ||
    entry.room.playerAmount !== 0 ||
    (expectedRoom && entry.room !== expectedRoom)
  )
    return;
  rooms.delete(id);
  try {
    entry.bots.dispose();
    modServer.disposeRoom(id);
  } finally {
    entry.room.dispose();
    entry.transport.removeAllListeners();
  }
}
const cleanup = setInterval(() => {
  for (const [id, entry] of rooms)
    if (
      entry.room.playerAmount === 0 &&
      Date.now() - entry.created > 15 * 60_000
    ) {
      closeRoom(id, entry.room);
    }
}, 60_000);
cleanup.unref();
function nativeRooms() {
  return [...rooms.values()]
    .filter((r) => !r.unlisted)
    .map(({ id, room: r }) => ({
      id,
      roomname: r.roomName,
      players: r.playerAmount,
      maxplayers: r.config.maxPlayers,
      password: r.password ? 1 : 0,
      mode_ga: r.gameSettings.ga,
      mode_mo: r.gameSettings.mo,
      country: "US",
      latitude: 0,
      longitude: 0,
      minlevel: r.config.restrictions.levels.minLevel,
      maxlevel: r.config.restrictions.levels.maxLevel,
      version: 49,
      quick: r.gameSettings.q,
      ingame: r.gameStartTime ? 1 : 0,
    }));
}
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, independent: true, rooms: rooms.size }),
);
app.get("/api/rooms", (_req, res) => res.json(nativeRooms()));
function roomForUser(userId: string): string | null {
  for (const [id, entry] of rooms)
    if (
      entry.room.playerSockets.some((socket) => socket?.data.userId === userId)
    )
      return id;
  return null;
}
app.get("/api/rooms/native", (req, res) => {
  const list = nativeRooms(),
    included = rooms.get(String(req.query.include || ""));
  if (included && !list.some((r) => r.id === included.id)) {
    const r = included.room;
    list.push({
      id: included.id,
      roomname: r.roomName,
      players: r.playerAmount,
      maxplayers: r.config.maxPlayers,
      password: r.password ? 1 : 0,
      mode_ga: r.gameSettings.ga,
      mode_mo: r.gameSettings.mo,
      country: "US",
      latitude: 0,
      longitude: 0,
      minlevel: r.config.restrictions.levels.minLevel,
      maxlevel: r.config.restrictions.levels.maxLevel,
      version: 49,
      quick: r.gameSettings.q,
      ingame: 0,
    });
  }
  const viewer = serviceStore.getSession(getRequestToken(req));
  res.json({
    country: "",
    createserver: "local",
    friends: viewer
      ? nativeFriendRows(serviceStore, viewer.id, roomForUser).friends
      : [],
    lat: 0,
    long: 0,
    rooms: list,
  });
});
app.get("/api/rooms/:id/address", (req, res) =>
  rooms.has(req.params.id)
    ? res.json({ r: "success", id: req.params.id, server: "local", address: 0 })
    : res.status(404).json({ r: "room_not_found" }),
);
app.post("/api/rooms", (req, res) => {
  const maintenance = serviceStore.db.prepare("SELECT value FROM server_settings WHERE key='maintenance'").get() as any;
  if(maintenance && JSON.parse(maintenance.value)===true)return res.status(503).json({error:"Room creation is temporarily paused."});
  const key = req.ip || "local",
    now = Date.now();
  let rate = roomAttempts.get(key);
  if (!rate || rate.until < now) {
    rate = { count: 0, until: now + 60_000 };
    roomAttempts.set(key, rate);
  }
  if (++rate.count > 10)
    return res
      .status(429)
      .json({ error: "Wait a minute before creating more rooms." });
  try {
    res.status(201).json({ id: createRoom(req.body) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
setupAdministration(app, serviceStore, {rooms,closeRoom,modServer});
setupServices(app, { store: serviceStore });
setupCompatibility(app, {
  store: serviceStore,
  roomForUser,
  playerCount: () =>
    [...rooms.values()].reduce((n, r) => n + r.room.playerAmount, 0),
  playerCounts: () => {
    const counts = {
      quick_classic: 0,
      quick_arrows: 0,
      quick_grapple: 0,
      quick_simple: 0,
      custom: 0,
    };
    for (const { room } of rooms.values()) {
      const key = room.gameSettings.q
        ? (
            {
              b: "quick_classic",
              ar: "quick_arrows",
              sp: "quick_grapple",
              bs: "quick_simple",
            } as const
          )[room.gameSettings.mo as "b" | "ar" | "sp" | "bs"] || "custom"
        : "custom";
      counts[key] += room.playerAmount;
    }
    return counts;
  },
});
modServer.routes(app);
app.all("/compat/:endpoint", (req, res) => {
  const e = req.params.endpoint;
  if (e === "combinedplayercount.txt")
    return res.type("text/plain").send(
      JSON.stringify({
        bonk: [...rooms.values()].reduce((n, r) => n + r.room.playerAmount, 0),
        hitbox: 0,
        supercar: 0,
      }),
    );
  console.log("COMPAT", e, Object.keys(req.body || {}).join(","));
  if (e === "getrooms.php")
    return res.json({
      country: "",
      createserver: "local",
      friends: [],
      lat: 0,
      long: 0,
      rooms: nativeRooms(),
    });
  if (/playercount/.test(e))
    return res.json({
      count: [...rooms.values()].reduce((n, r) => n + r.room.playerAmount, 0),
      counts: { total: 0 },
    });
  if (/news/.test(e)) return res.json({ r: "success", news: [] });

  return res.json({
    r: "fail",
    error: "Service unavailable",
    message: "Please try again later.",
  });
});
app.get("/enhancements/mod-worker.js", (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'",
  );
  res
    .type("js")
    .send(fs.readFileSync("public/enhancements/mod-worker.js", "utf8"));
});
if (!options.skipStatic) app.use(express.static("public"));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if(error?.type === "entity.too.large")return res.status(413).json({error:"Upload exceeds this server’s pack size limit."});
  if(error?.type === "entity.parse.failed")return res.status(400).json({error:"Invalid request data."});
  console.error("Request failed",error);res.status(500).json({error:"Could not complete the request. Please try again."});
});
app.use((req, res) => {
  if (process.env.NODE_ENV !== "production")
    console.log("MISSING", req.method, req.path);
  res.status(404).json({ error: "Not found", path: req.path });
});

return {app, server, rooms, modServer, createRoom, closeRoom, nativeRooms, roomForUser, dispose() {
shuttingDown=true;clearInterval(cleanup);modServer.dispose();for(const entry of rooms.values()){entry.room.dispose();entry.transport.removeAllListeners();}rooms.clear();for(const socket of upgradedSockets)socket.end();
}};
}
