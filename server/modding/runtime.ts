import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import express, { type Express } from "express";
import {
  EventBus,
  Registries,
  Entity,
  assertJson,
  resolveMods,
  createMixins,
} from "../../shared/modkit.ts";
import { ModRepository, sha256, type Pack } from "./repository.ts";

type Room = {
  id: string;
  native: any;
  packs: Pack[];
  profile: any;
  started: number;
  members: Set<string>;
  archived: Map<string, Pack>;
  uploading?: boolean;
};
export class ModServer {
  readonly registries = new Registries();
  readonly events = new EventBus((error, owner, event) =>
    console.error(`[mod ${owner}:${event}]`, error),
  );
  readonly available: Pack[];
  readonly rooms = new Map<string, Room>();
  onRoomReady?: (id: string) => void;
  ready(id: string): boolean {
    const room = this.rooms.get(id);
    return (
      !!room &&
      room.native.playerSockets
        .filter(Boolean)
        .every((socket: any) => socket.data.modReady === room.profile.hash)
    );
  }
  private channels = new Map<
    string,
    {
      owner: string;
      from: "host" | "players";
      maxBytes: number;
      handler?: (data: any, context: any) => any;
    }
  >();
  private commands = new Map<
    string,
    { owner: string; handler?: (data: any, context: any) => any }
  >();
  private cleanups: (() => void)[] = [];
  private tick: NodeJS.Timeout;
  constructor(readonly repository = new ModRepository()) {
    this.available = repository.enabled();
    this.tick = setInterval(() => {
      for (const room of this.rooms.values())
        if (room.packs.length)
          this.events.emit("tick", {
            room: this.roomAPI(room),
            time: Date.now(),
          });
    }, 1000 / 60);
    this.tick.unref();
  }
  async initialize(): Promise<void> {
    for (const pack of this.available) {
      if (!pack.manifest.entrypoints.server) continue;
      const module = await import(
        pathToFileURL(path.join(pack.root, ".build/server.mjs")).href +
          "?hash=" +
          pack.hash
      );
      const setup = module.setup || module.default;
      if (typeof setup !== "function")
        throw Error(
          pack.manifest.id + " must export setup(api) or a default function.",
        );
      const cleanup = await setup(this.api(pack));
      if (typeof cleanup === "function") this.cleanups.push(cleanup);
    }
  }
  private api(pack: Pack): any {
    const owner = pack.manifest.id;
    const owned = (name: string) => ({
      register: (id: string, value: any) => {
        if (!id.startsWith(owner + ":"))
          throw Error("Register content in your mod namespace.");
        return this.registries.get(name).register(id, value, owner);
      },
      get: (id: string) => this.registries.get(name).get(id),
      values: () => this.registries.get(name).values(),
    });
    const storageFile = path.join(
      this.repository.directory,
      "data",
      owner + ".json",
    );
    const read = () =>
      fs.existsSync(storageFile)
        ? JSON.parse(fs.readFileSync(storageFile, "utf8"))
        : {};
    return {
      id: owner,
      version: pack.manifest.version,
      side: "server",
      Entity,
      registry: (name: string) => owned(name),
      entities: owned("entities"),
      components: owned("components"),
      properties: owned("properties"),
      modes: owned("modes"),
      on: (event: string, fn: (...args: any[]) => any, priority = 0) =>
        this.events.on(
          event,
          (...args: any[]) => {
            const candidate = args[0]?.room || args[0];
            if (
              !candidate?.id ||
              this.rooms
                .get(candidate.id)
                ?.packs.some((pack) => pack.manifest.id === owner)
            )
              fn(...args);
          },
          owner,
          priority,
        ),
      mixins: createMixins((cleanup) => this.cleanups.push(cleanup)),
      rooms: {
        get: (id: string) => {
          const room = this.rooms.get(id);
          return room && this.roomAPI(room);
        },
        list: () =>
          [...this.rooms.values()]
            .filter((room) =>
              room.packs.some((pack) => pack.manifest.id === owner),
            )
            .map((room) => this.roomAPI(room)),
      },
      network: {
        register: (
          name: string,
          options: any = {},
          handler?: (data: any, context: any) => any,
        ) => {
          const channel = this.namespace(owner, name);
          if (this.channels.has(channel))
            throw Error("Duplicate mod channel: " + channel);
          this.channels.set(channel, {
            owner,
            from: options.from === "players" ? "players" : "host",
            maxBytes: Math.min(65536, Math.max(1, options.maxBytes || 16384)),
            handler,
          });
        },
        send: (roomId: string, name: string, data: any, target?: number) => {
          const room = this.rooms.get(roomId);
          if (!room) throw Error("Unknown room.");
          assertJson(data);
          const message = {
            channel: this.namespace(owner, name),
            data,
            sender: null,
          };
          if (Number.isInteger(target))
            room.native.playerSockets[target!]?.emit("mods:message", message);
          else room.native.io.to("main").emit("mods:message", message);
        },
      },
      commands: {
        register: (name: string, handler?: (data: any, context: any) => any) =>
          this.commands.set(this.namespace(owner, name), { owner, handler }),
        send: (roomId: string, name: string, data: any) => {
          const room = this.rooms.get(roomId);
          if (!room) throw Error("Unknown room.");
          this.schedule(room, this.namespace(owner, name), data, null);
        },
      },
      storage: {
        get: (key: string, fallback: any = null) => read()[key] ?? fallback,
        set: (key: string, value: any) => {
          assertJson(value);
          const data = read();
          data[key] = value;
          fs.mkdirSync(path.dirname(storageFile), { recursive: true });
          const bytes = Buffer.from(JSON.stringify(data));
          this.repository.persistence?.write("data/" + owner + ".json", bytes);
          fs.writeFileSync(storageFile + ".tmp", bytes);
          fs.renameSync(storageFile + ".tmp", storageFile);
        },
      },
      log: (...args: any[]) => console.log(`[mod ${owner}]`, ...args),
    };
  }
  private namespace(owner: string, name: string) {
    return name.includes(":") ? name : owner + ":" + name;
  }
  resolve(ids: unknown): Pack[] {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string") ||
      ids.length > 64
    )
      throw Error("Room mods must be an array of installed mod ids.");
    return resolveMods(this.available, ids);
  }
  profile(packs: Pack[]) {
    const mods = packs.map((pack) => this.repository.publicInfo(pack));
    return {
      api: 2,
      hash: sha256(
        JSON.stringify(
          mods.map((mod) => ({
            id: mod.id,
            version: mod.version,
            hash: mod.hash,
          })),
        ),
      ),
      mods,
    };
  }
  mode(id: string): any {
    return this.registries.get("modes").get(id);
  }
  attachRoom(id: string, native: any, packs: Pack[]): void {
    const room: Room = {
      id,
      native,
      packs,
      profile: this.profile(packs),
      started: 0,
      members: new Set(),
      archived: new Map(),
    };
    this.rooms.set(id, room);
    native.io.on("connection", (socket: any) =>
      this.attachSocket(room, socket),
    );
    if (packs.length) this.events.emit("roomCreate", this.roomAPI(room));
  }
  private roomAPI(room: Room): any {
    return {
      id: room.id,
      native: room.native,
      profile: room.profile,
      settings: room.native.gameSettings,
      players: room.native.playerInfo,
      broadcast: (event: string, data: any) =>
        room.native.io.to("main").emit(event, data),
    };
  }
  authorizeJoin(id: string, data: any, socket: any): string | void {
    const room = this.rooms.get(id);
    if (!room) return "room_not_found";
    if (room.packs.length && data.modProfile !== room.profile.hash)
      return "modpack_mismatch";
    socket.data.modReady = room.profile.hash;
  }
  changed(id: string): void {
    const room = this.rooms.get(id);
    if (!room || !room.packs.length) return;
    const now = room.native.gameStartTime;
    if (now !== room.started) {
      this.events.emit(now ? "matchStart" : "matchEnd", this.roomAPI(room));
      room.started = now;
    }
    const members = new Set<string>(
      room.native.playerSockets.filter(Boolean).map((socket: any) => socket.id),
    );
    for (const socket of room.native.playerSockets.filter(Boolean))
      if (!room.members.has(socket.id))
        this.events.emit("playerJoin", {
          room: this.roomAPI(room),
          id: socket.data.bonkId,
          socket,
        });
    for (const id of room.members)
      if (!members.has(id))
        this.events.emit("playerLeave", {
          room: this.roomAPI(room),
          socketId: id,
        });
    room.members = members;
  }
  private member(room: Room, socket: any): boolean {
    return room.native.playerSockets[socket.data.bonkId]?.id === socket.id;
  }
  private attachSocket(room: Room, socket: any): void {
    socket.data.modUploadToken = randomBytes(32).toString("hex");
    const fail = (error: unknown, ack?: any) => {
      const result = {
        error: error instanceof Error ? error.message : String(error),
      };
      if (typeof ack === "function") ack(result);
      else socket.emit("mods:error", result);
    };
    socket.use((packet: any[], next: any) => {
      if (
        String(packet[0]) === "5" &&
        room.packs.length &&
        room.native.playerSockets
          .filter(Boolean)
          .some((player: any) => player.data.modReady !== room.profile.hash)
      )
        return fail("Every player must finish loading this room's modpack.");
      next();
    });
    socket.on("mods:ready", (hash: string, ack: any) => {
      if (hash !== room.profile.hash)
        return fail("Modpack hash differs from the room.", ack);
      if (!this.member(room, socket)) return fail("Join this room first.", ack);
      socket.data.modReady = hash;
      ack?.({ ok: true });
      this.onRoomReady?.(room.id);
    });
    socket.on("mods:host-token", (ack: any) => {
      if (
        !this.member(room, socket) ||
        socket.data.bonkId !== room.native.hostId
      )
        return fail("Only the current host can publish a room pack.", ack);
      ack?.({ token: socket.data.modUploadToken });
    });
    socket.on("mods:profile", (ids: unknown, ack: any) => {
      try {
        if (
          !this.member(room, socket) ||
          room.native.hostId !== socket.data.bonkId
        )
          throw Error("Only the room host can select a modpack.");
        if (room.native.gameStartTime)
          throw Error("Return to the lobby before changing the modpack.");
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
          throw Error("Select a list of mod ids.");
        room.packs = resolveMods(
          [
            ...this.available,
            ...[...room.archived.values()].filter(
              (pack) =>
                !this.available.some(
                  (other) => other.manifest.id === pack.manifest.id,
                ),
            ),
          ],
          ids,
        );
        room.profile = {
          ...this.profile(room.packs),
          mode: room.native.gameSettings.wbMode || null,
        };
        for (const player of room.native.playerSockets.filter(Boolean))
          player.data.modReady = null;
        room.native.io.to("main").emit("mods:profile", room.profile);
        ack?.({ ok: true, profile: room.profile });
      } catch (error) {
        fail(error, ack);
      }
    });
    socket.on("mods:mode", (selection: any, ack: any) => {
      try {
        if (
          !this.member(room, socket) ||
          room.native.hostId !== socket.data.bonkId
        )
          throw Error("Only the room host can select a mode.");
        if (room.native.gameStartTime)
          throw Error("Return to the lobby before changing modes.");
        const id = typeof selection === "string" ? selection : selection?.id;
        if (typeof id !== "string") throw Error("Select a mode id.");
        if (id) {
          if (!room.packs.some((pack) => id.startsWith(pack.manifest.id + ":")))
            throw Error("Select the pack that provides this mode.");
          const definition = this.mode(id),
            base = definition?.base || selection?.base;
          if (!["b", "ar", "ard", "bs", "sp", "f", "v"].includes(base))
            throw Error("Custom modes must declare a supported native base.");
          room.native.gameSettings.mo = base;
          room.native.gameSettings.ga = base === "f" ? "f" : "b";
          room.native.gameSettings.wbMode = id;
          room.native.io
            .to("main")
            .emit("26", room.native.gameSettings.ga, base);
        } else delete room.native.gameSettings.wbMode;
        room.profile = { ...room.profile, mode: id || null };
        room.native.io.to("main").emit("mods:profile", room.profile);
        ack?.({ ok: true, profile: room.profile });
      } catch (error) {
        fail(error, ack);
      }
    });
    socket.on("20", () => {
      if (
        !this.member(room, socket) ||
        socket.data.bonkId !== room.native.hostId
      )
        return;
      delete room.native.gameSettings.wbMode;
      room.profile = { ...room.profile, mode: null };
      if (room.packs.length)
        room.native.io.to("main").emit("mods:profile", room.profile);
    });
    socket.on("mods:message", async (message: any, ack: any) => {
      try {
        if (!this.member(room, socket)) throw Error("Join this room first.");
        const channel = String(message?.channel || ""),
          owner = channel.split(":")[0],
          declared = room.packs.find((pack) => pack.manifest.id === owner)
            ?.manifest.channels?.[channel.slice(owner.length + 1)];
        const rule =
          this.channels.get(channel) ||
          (declared
            ? {
                owner,
                from: declared.from || "host",
                maxBytes: declared.maxBytes || 16384,
                handler: undefined,
              }
            : undefined);
        if (
          !rule ||
          !room.packs.some((pack) => pack.manifest.id === rule.owner)
        )
          throw Error(
            "This channel is not registered by the room's server mods.",
          );
        if (rule.from === "host" && socket.data.bonkId !== room.native.hostId)
          throw Error("This mod channel accepts only the host.");
        assertJson(message.data);
        if (JSON.stringify(message.data).length > rule.maxBytes)
          throw Error("Mod message exceeds the channel size limit.");
        const result = await rule.handler?.(message.data, {
          room: this.roomAPI(room),
          playerId: socket.data.bonkId,
          socket,
          command: (name: string, data: any) =>
            this.schedule(
              room,
              this.namespace(rule.owner, name),
              data,
              socket.data.bonkId,
            ),
        });
        if (!rule.handler)
          room.native.io.to("main").emit("mods:message", {
            channel,
            data: message.data,
            sender: socket.data.bonkId,
          });
        ack?.({ ok: true, ...(result === undefined ? {} : { result }) });
      } catch (error) {
        fail(error, ack);
      }
    });
    socket.on("mods:command", (message: any, ack: any) => {
      try {
        if (!this.member(room, socket)) throw Error("Join this room first.");
        const name = String(message?.name || ""),
          owner = name.split(":")[0];
        const pack = room.packs.find((pack) => pack.manifest.id === owner);
        if (!pack) throw Error("Command namespace is absent from this room.");
        const rule = pack.manifest.commands?.[name.slice(owner.length + 1)];
        if (
          socket.data.bonkId !== room.native.hostId &&
          rule?.from !== "players"
        )
          throw Error(
            "This command requires the host; player commands must be declared by the pack.",
          );
        if (JSON.stringify(message.data).length > (rule?.maxBytes || 65536))
          throw Error("Command exceeds its declared size limit.");
        this.schedule(room, name, message.data, socket.data.bonkId);
        ack?.({ ok: true });
      } catch (error) {
        fail(error, ack);
      }
    });
    // Bound each socket's extension traffic independently of native packets.
    let windowStart = Date.now(),
      messages = 0;
    socket.use((packet: any[], next: any) => {
      if (!String(packet[0]).startsWith("mods:")) return next();
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        messages = 0;
      }
      if (++messages > 120) return fail("Mod traffic limit exceeded.");
      next();
    });
  }
  private schedule(
    room: Room,
    name: string,
    data: any,
    sender: number | null,
  ): void {
    assertJson(data);
    if (JSON.stringify(data).length > 65536)
      throw Error("Simulation command exceeds64KB.");
    const owner = name.split(":")[0];
    if (!room.packs.some((pack) => pack.manifest.id === owner))
      throw Error("Command mod is not active in this room.");
    const registered = this.commands.get(name);
    registered?.handler?.(data, { room: this.roomAPI(room), sender });
    room.native.playerSockets[room.native.hostId]?.emit("mods:command", {
      name,
      data,
      sender,
    });
  }
  routes(app: Express): void {
    app.get("/api/mods", (_req, res) =>
      res.json({
        api: 2,
        packs: this.available.map((pack) => this.repository.publicInfo(pack)),
        modes: this.registries
          .get("modes")
          .values()
          .map(({ id, value }) => ({
            id,
            name: value.name || id,
            base: value.base || "b",
          })),
      }),
    );
    app.get("/api/rooms/:id/mods", (req, res) => {
      const room = this.rooms.get(req.params.id);
      if (!room) return res.status(404).json({ error: "Room not found." });
      res.json({
        ...room.profile,
        mode: room.native.gameSettings.wbMode || null,
      });
    });
    app.post(
      "/api/rooms/:id/modpack",
      express.raw({ type: "application/octet-stream", limit: "64mb" }),
      async (req, res) => {
        const room = this.rooms.get(req.params.id),
          host = room?.native.playerSockets[room.native.hostId];
        if (
          !room ||
          !host ||
          req.get("X-Bonk-Host") !== host.data.modUploadToken
        )
          return res
            .status(403)
            .json({ error: "Only the current room host can publish a pack." });
        if (room.native.gameStartTime || room.uploading)
          return res.status(409).json({
            error: "Return to the lobby and wait for any previous upload.",
          });
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          return res
            .status(400)
            .json({ error: "Upload a .bonkmod ZIP archive." });
        room.uploading = true;
        const repository = new ModRepository(
            path.join(this.repository.directory, "host-packs", room.id),
            false,
          ),
          archive = path.join(
            repository.directory,
            "upload-" + randomBytes(8).toString("hex") + ".zip",
          );
        try {
          fs.writeFileSync(archive, req.body);
          const pack = await repository.install(archive, {
            clientOnly: true,
            reuseIdentical: true,
          });
          if (
            this.available.some(
              (other) =>
                other.manifest.id === pack.manifest.id &&
                other.hash !== pack.hash,
            )
          )
            throw Error(
              "This mod id is reserved by an operator-installed version. Use a new id/version or select that installed pack.",
            );
          // Host role may have migrated while the archive was compiled.
          if (
            room.native.playerSockets[room.native.hostId]?.id !== host.id ||
            room.native.gameStartTime
          )
            throw Error(
              "Room host or phase changed during upload; publish again from the lobby.",
            );
          pack.distributionBase = `/roompacks/${room.id}/${pack.hash}`;
          fs.copyFileSync(archive, path.join(pack.root, ".source.bonkmod"));
          room.archived.set(pack.hash, pack);
          room.packs = resolveMods(
            [
              ...this.available,
              ...room.packs.filter(
                (other) => other.manifest.id !== pack.manifest.id,
              ),
              pack,
            ],
            [
              ...room.packs
                .map((other) => other.manifest.id)
                .filter((id) => id !== pack.manifest.id),
              pack.manifest.id,
            ],
          );
          room.profile = {
            ...this.profile(room.packs),
            mode: room.native.gameSettings.wbMode || null,
          };
          for (const player of room.native.playerSockets.filter(Boolean))
            player.data.modReady = null;
          // Response lets the publishing host approve its deliberate selection first;
          // all other members still receive their own explicit download/leave prompt.
          res.status(201).json({ ok: true, profile: room.profile });
          setImmediate(() =>
            room.native.io.to("main").emit("mods:profile", room.profile),
          );
        } catch (error) {
          res.status(400).json({
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          room.uploading = false;
          if (fs.existsSync(archive)) fs.unlinkSync(archive);
        }
      },
    );
    app.get("/modpacks/:id/:version/client.js", (req, res) => {
      const pack = this.available.find(
        (pack) =>
          pack.manifest.id === req.params.id &&
          pack.manifest.version === req.params.version,
      );
      if (!pack?.clientHash) return res.sendStatus(404);
      res
        .set("Cache-Control", "public,max-age=31536000,immutable")
        .type("js")
        .sendFile(path.join(pack.root, ".build/client.js"), {
          dotfiles: "allow",
        });
    });
    app.get("/modpacks/:id/:version/assets/:name", (req, res) => {
      const pack = this.available.find(
          (pack) =>
            pack.manifest.id === req.params.id &&
            pack.manifest.version === req.params.version,
        ),
        file = pack?.manifest.assets?.[req.params.name];
      if (!pack || !file) return res.sendStatus(404);
      res
        .set("Cache-Control", "public,max-age=31536000,immutable")
        .sendFile(path.join(pack.root, file), { dotfiles: "allow" });
    });
    app.get("/roompacks/:id/:hash/:kind/:name?", (req, res) => {
      const pack = this.rooms.get(req.params.id)?.archived.get(req.params.hash);
      if (!pack) return res.sendStatus(404);
      let file: string | undefined;
      if (req.params.kind === "client.js" && pack.clientHash)
        file = ".build/client.js";
      if (req.params.kind === "pack.bonkmod") file = ".source.bonkmod";
      if (req.params.kind === "assets")
        file = pack.manifest.assets?.[req.params.name || ""];
      if (!file) return res.sendStatus(404);
      res.set("Cache-Control", "public,max-age=31536000,immutable");
      if (file.endsWith(".js")) res.type("js");
      res.sendFile(path.join(pack.root, file), { dotfiles: "allow" });
    });
  }
  disposeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (room?.packs.length) this.events.emit("roomDispose", this.roomAPI(room));
    this.rooms.delete(id);
  }
  dispose(): void {
    clearInterval(this.tick);
    for (const cleanup of this.cleanups.reverse()) cleanup();
  }
}
