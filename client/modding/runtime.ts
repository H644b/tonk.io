import { NativeBots } from "../bots/runtime.ts";
import {
  Entity,
  EntityWorld,
  EventBus,
  Registries,
  emptyWorld,
  createMixins,
  assertJson,
} from "../../shared/modkit.ts";
import { createModBodies, finishModBodies } from "./physics.ts";
import { renderModWorld, clearModViews } from "./views.ts";

declare global {
  interface Window {
    BonkMods: ClientModRuntime;
    manifold: any;
    PIXI: any;
  }
}
type Profile = { api: number; hash: string; mods: any[]; mode?: string | null };
const hashBytes = async (bytes: Uint8Array) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
export class ClientModRuntime {
  readonly apiVersion = 2;
  readonly bots = new NativeBots();
  readonly registries = new Registries();
  readonly events = new EventBus((error, owner, event) =>
    this.report(
      `${owner} / ${event}: ${error instanceof Error ? error.message : error}`,
    ),
  );
  native: any = null;
  nativeWorld: any = null;
  profile: Profile = { api: 2, hash: "", mods: [] };
  private active = new Map<
    string,
    { cleanups: (() => void)[]; blobs: string[] }
  >();
  private steps = new WeakMap<object, any>();
  private current: any = null;
  private loading: Promise<void> | null = null;
  private consents = new Map<string, (accept: boolean) => void>();
  private sequence = 0;
  private socket: any = null;
  private generation = 0;
  private downloads = new AbortController();
  private ensureActive(generation: number): void {
    if (generation !== this.generation)
      throw new DOMException("Modpack loading cancelled.", "AbortError");
  }
  constructor() {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || event.source !== parent) return;
      if (event.data.type === "bonk-modpack-decision") {
        const resolve = this.consents.get(event.data.id);
        this.consents.delete(event.data.id);
        resolve?.(event.data.accept === true);
      }
    });
  }
  attachNative(native: any): void {
    this.native = native;
    this.events.emit("engineReady", native);
  }
  report(message: string): void {
    console.error("[Tonk Mods]", message);
    parent.postMessage({ type: "bonk-mod-notice", message }, location.origin);
  }
  private progress(message: string, done = false): void {
    parent.postMessage(
      { type: "bonk-modpack-progress", message, done },
      location.origin,
    );
  }
  private async consent(profile: Profile): Promise<void> {
    if (!profile.mods.length) return;
    const approvals = JSON.parse(
      localStorage.getItem("bonk.modpackApprovals") || "[]",
    );
    if (approvals.includes(profile.hash)) return;
    const id = String(++this.sequence);
    const accepted = new Promise<boolean>((resolve) =>
      this.consents.set(id, resolve),
    );
    parent.postMessage(
      { type: "bonk-modpack-request", id, profile },
      location.origin,
    );
    if (!(await accepted)) {
      this.leaveRoom();
      throw new DOMException(
        "Left room without downloading its modpack.",
        "AbortError",
      );
    }
    // Approval is saved only after verified code and all declared assets download.
  }
  approve(hash: string): void {
    const list = JSON.parse(
      localStorage.getItem("bonk.modpackApprovals") || "[]",
    );
    localStorage.setItem(
      "bonk.modpackApprovals",
      JSON.stringify([...new Set([...list, hash])].slice(-128)),
    );
  }
  async prepareRoom(id: string): Promise<void> {
    const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/mods`);
    if (!response.ok) throw Error("Room modpack could not be fetched.");
    await this.prepareProfile(await response.json());
  }
  async prepareProfile(profile: Profile): Promise<void> {
    if (
      profile.api !== 2 ||
      typeof profile.hash !== "string" ||
      !Array.isArray(profile.mods)
    )
      throw Error("Unsupported room modpack profile.");
    if (profile.hash === this.profile.hash) {
      this.profile.mode = profile.mode;
      return;
    }
    const generation = this.generation;
    if (this.loading) await this.loading;
    this.ensureActive(generation);
    if (profile.hash === this.profile.hash) {
      this.profile.mode = profile.mode;
      return;
    }
    const loading = this.loadProfile(profile, generation);
    this.loading = loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }
  private async loadProfile(
    profile: Profile,
    generation: number,
  ): Promise<void> {
    await this.consent(profile);
    this.ensureActive(generation);
    const downloaded: {
      pack: any;
      bytes?: Uint8Array;
      assets: Map<string, Uint8Array>;
    }[] = [];
    for (const pack of profile.mods) {
      this.progress(`Downloading ${pack.name} ${pack.version}…`);
      const assets = new Map<string, Uint8Array>();
      let bytes: Uint8Array | undefined;
      if (pack.client)
        bytes = await this.verified(pack.client, pack.clientHash);
      for (const [name, asset] of Object.entries(pack.assets || {}) as [
        string,
        any,
      ][])
        assets.set(name, await this.verified(asset.url, asset.hash));
      downloaded.push({ pack, bytes, assets });
    }
    this.ensureActive(generation);
    this.unload();
    this.profile = profile;
    try {
      for (const { pack, bytes, assets } of downloaded) {
        const record = {
          cleanups: [] as (() => void)[],
          blobs: [] as string[],
        };
        this.active.set(pack.id, record);
        if (!bytes) continue;
        const codeUrl = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: "text/javascript" }),
        );
        record.blobs.push(codeUrl);
        this.ensureActive(generation);
        const module = await import(/* webpackIgnore: true */ codeUrl),
          setup = module.setup || module.default;
        this.ensureActive(generation);
        if (typeof setup !== "function")
          throw Error(
            `${pack.id} must export setup(api) or a default function.`,
          );
        const cleanup = await setup(this.context(pack, assets, record));
        if (generation !== this.generation) {
          if (typeof cleanup === "function") cleanup();
          this.ensureActive(generation);
        }
        if (typeof cleanup === "function") record.cleanups.push(cleanup);
      }
      this.approve(profile.hash);
      this.progress("Modpack downloaded, verified and applied.", true);
      this.events.emit("packReady", { profile, native: this.native });
      parent.postMessage(
        {
          type: "bonk-modpack-ready",
          profile,
          registrations: this.registries.summary(),
        },
        location.origin,
      );
    } catch (error) {
      if (generation === this.generation) {
        this.unload();
        this.profile = { api: 2, hash: "", mods: [] };
        this.progress("Modpack failed: " + String(error), true);
      }
      throw error;
    }
  }
  private async verified(url: string, expected: string): Promise<Uint8Array> {
    const address = new URL(url, location.origin);
    if (address.origin !== location.origin)
      throw Error("Room packs must be supplied through this server.");
    const response = await fetch(address.href, {
      signal: this.downloads.signal,
    });
    if (!response.ok)
      throw Error("Mod file download failed: " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if ((await hashBytes(bytes)) !== expected)
      throw Error(
        "Mod file integrity check failed. Leave and ask the host to republish the pack.",
      );
    return bytes;
  }
  unload(): void {
    clearModViews();
    for (const [id, record] of [...this.active].reverse()) {
      for (const cleanup of record.cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          this.report(String(error));
        }
      }
      for (const url of record.blobs) URL.revokeObjectURL(url);
      this.events.removeOwner(id);
      this.registries.removeOwner(id);
    }
    this.active.clear();
    this.steps = new WeakMap();
    this.current = null;
  }
  private context(
    pack: any,
    assets: Map<string, Uint8Array>,
    record: { cleanups: (() => void)[]; blobs: string[] },
  ): any {
    const owner = pack.id,
      runtime = this,
      textures = new Map<string, any>();
    const registry = (category: string) => ({
      register(id: string, value: any) {
        if (!id.startsWith(owner + ":"))
          throw Error("Use your mod namespace for registrations.");
        return runtime.registries.get(category).register(id, value, owner);
      },
      get: (id: string) => runtime.registries.get(category).get(id),
      values: () => runtime.registries.get(category).values(),
    });
    const namespace = (name: string) =>
      name.includes(":") ? name : owner + ":" + name;
    const blob = (name: string, type: string) => {
      const bytes = assets.get(name);
      if (!bytes) throw Error("Unknown declared asset: " + name);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      record.blobs.push(url);
      return url;
    };
    const properties = {
      ...registry("properties"),
      read(target: string, id: string) {
        const world = runtime.getWorld();
        const definition = runtime.registries.get("properties").require(id);
        return (
          world?.state.properties[target]?.[id] ??
          structuredClone(definition.default ?? null)
        );
      },
      write(target: string, id: string, value: any) {
        const world = runtime.getWorld();
        if (!world) throw Error("No active mod world.");
        const definition = runtime.registries.get("properties").require(id);
        definition.validate?.(value);
        assertJson(value);
        (world.state.properties[target] ||= {})[id] = structuredClone(value);
      },
    };
    return {
      id: owner,
      version: pack.version,
      side: "client",
      Entity,
      get engine() {
        return runtime.native;
      },
      get game() {
        return runtime.nativeWorld;
      },
      get world() {
        return runtime.getWorld();
      },
      registry,
      entities: registry("entities"),
      components: registry("components"),
      modes: registry("modes"),
      properties,
      on: (event: string, fn: (...args: any[]) => any, priority = 0) =>
        runtime.events.on(event, fn, owner, priority),
      mixins: createMixins((cleanup) => record.cleanups.push(cleanup)),
      assets: {
        bytes: (name: string) => assets.get(name)?.slice(),
        url: (name: string) => {
          if (!pack.assets[name]) throw Error("Unknown asset: " + name);
          return pack.assets[name].url;
        },
        text: (name: string) => {
          const bytes = assets.get(name);
          if (!bytes) throw Error("Unknown asset: " + name);
          return new TextDecoder().decode(bytes);
        },
        json: (name: string) => {
          const bytes = assets.get(name);
          if (!bytes) throw Error("Unknown asset: " + name);
          return JSON.parse(new TextDecoder().decode(bytes));
        },
        image: async (name: string) => {
          const image = new Image();
          image.src = blob(name, this.mime(pack.assets[name]?.file));
          await image.decode();
          return image;
        },
        texture: async (name: string) => {
          if (textures.has(name)) return textures.get(name);
          const image = new Image();
          image.src = blob(name, this.mime(pack.assets[name]?.file));
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d")!.drawImage(image, 0, 0);
          const texture = runtime.native.PIXI.Texture.from(canvas);
          textures.set(name, texture);
          record.cleanups.push(() => texture.destroy(true));
          return texture;
        },
        sound: (name: string) => {
          const audio = new Audio(
            blob(name, this.mime(pack.assets[name]?.file)),
          );
          record.cleanups.push(() => {
            audio.pause();
            audio.src = "";
          });
          return audio;
        },
      },
      commands: {
        register: (name: string, handler: any) =>
          runtime.registries
            .get("commands")
            .register(namespace(name), handler, owner),
        send: (name: string, data: any = {}) =>
          runtime.send("mods:command", { name: namespace(name), data }),
      },
      network: {
        on: (name: string, handler: any) =>
          runtime.events.on("network:" + namespace(name), handler, owner),
        send: (name: string, data: any = {}) =>
          runtime.send("mods:message", { channel: namespace(name), data }),
      },
      input: {
        on(key: string, handler: (event: KeyboardEvent) => void) {
          const listener = (event: KeyboardEvent) => {
            if (
              event.code === key &&
              !(
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement
              )
            )
              handler(event);
          };
          document.addEventListener("keydown", listener);
          const stop = () => document.removeEventListener("keydown", listener);
          record.cleanups.push(stop);
          return stop;
        },
      },
      ui: {
        mount(element: HTMLElement, options: { parent?: HTMLElement } = {}) {
          element.dataset.bonkModUi = owner;
          (
            options.parent || document.getElementById("bonkiocontainer")!
          ).append(element);
          record.cleanups.push(() => element.remove());
          return element;
        },
        style(css: string) {
          const style = document.createElement("style");
          style.textContent = css;
          document.head.append(style);
          record.cleanups.push(() => style.remove());
          return style;
        },
        notify: (message: string) =>
          parent.postMessage(
            { type: "bonk-mod-notice", message: String(message) },
            location.origin,
          ),
      },
      storage: {
        get: (key: string, fallback: any = null) =>
          JSON.parse(
            localStorage.getItem(`bonk.mod.${owner}.${key}`) ||
              JSON.stringify(fallback),
          ),
        set: (key: string, value: any) => {
          assertJson(value);
          localStorage.setItem(
            `bonk.mod.${owner}.${key}`,
            JSON.stringify(value),
          );
        },
      },
      dispose: (cleanup: () => void) => record.cleanups.push(cleanup),
    };
  }
  private mime(file: string = ""): string {
    return (
      (
        {
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          webp: "image/webp",
          wav: "audio/wav",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
        } as any
      )[file.split(".").pop()!] || "application/octet-stream"
    );
  }
  getWorld(): EntityWorld | null {
    const state =
      this.current?.world?.state ||
      this.nativeWorld?.getState?.()?.__bonkMods?.world;
    return state ? new EntityWorld(state, this.registries) : null;
  }
  send(event: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(Error("Join a room first."));
      const timer = setTimeout(
        () => reject(Error("Mod request timed out.")),
        10000,
      );
      this.socket.emit(event, data, (result: any) => {
        clearTimeout(timer);
        result?.error ? reject(Error(result.error)) : resolve(result);
      });
    });
  }
  bindSocket(socket: any): void {
    this.socket = socket;
    socket.on("mods:profile", async (profile: Profile) => {
      try {
        await this.prepareProfile(profile);
        socket.emit(
          "mods:ready",
          profile.hash,
          (result: any) => result.error && this.report(result.error),
        );
      } catch (error) {
        if ((error as any)?.name !== "AbortError") {
          this.report(String(error));
          this.leaveRoom();
        }
      }
    });
    socket.on("mods:message", (message: any) =>
      this.events.emit("network:" + message.channel, message.data, {
        sender: message.sender,
      }),
    );
    socket.on("mods:error", (result: any) => this.report(result.error));
    socket.on("mods:command", (command: any) => {
      if (
        window.manifold.localId !== window.manifold.hostId ||
        !this.nativeWorld
      )
        return;
      const frame = this.nativeWorld.getFrame() + 3;
      const existing = this.nativeWorld.adminAt(frame)?.wbCommands || [];
      this.nativeWorld.submitAdmin(
        { wbCommands: [...existing, command] },
        frame,
      );
    });
    socket.on("disconnect", () => {
      this.nativeWorld = null;
      this.events.emit("disconnect");
      this.cancelLoading();
    });
  }
  private cancelLoading(): void {
    this.generation++;
    this.downloads.abort();
    this.downloads = new AbortController();
    for (const resolve of this.consents.values()) resolve(false);
    this.consents.clear();
    this.unload();
    this.profile = { api: 2, hash: "", mods: [] };
  }
  leaveRoom(): void {
    this.cancelLoading();
    if (window.manifold.cancelNativeJoin) window.manifold.cancelNativeJoin();
    else window.manifold.nativeSession?.leaveRoom?.();
    this.socket?.disconnect();
    parent.postMessage({ type: "bonk-modpack-left" }, location.origin);
  }
  nativeEvent(type: string, context: any): void {
    this.bots.observe(type, context);
    if (type === "worldReady") {
      this.nativeWorld = context;
      this.events.emit(type, context);
      return;
    }
    if (!this.active.size) return;
    if (type === "createState") {
      context.state.__bonkMods = {
        api: 2,
        hash: this.profile.hash,
        frame: 0,
        world: emptyWorld(Number(context.seed) || 1),
        data: {},
      };
      const world = new EntityWorld(
        context.state.__bonkMods.world,
        this.registries,
      );
      this.current = { ...context, world };
      this.events.emit(type, this.current);
      this.registries
        .get("modes")
        .get(this.profile.mode || "")
        ?.init?.(this.current);
      this.current = null;
      return;
    }
    if (type === "beforeStep") {
      this.steps.delete(context.simulation);
      this.current = null;
      const metadata = structuredClone(
        context.state.__bonkMods || {
          api: 2,
          hash: this.profile.hash,
          frame: 0,
          world: emptyWorld(),
          data: {},
        },
      );
      if (metadata.hash !== this.profile.hash) {
        this.report(
          "This saved state requires a different modpack. Select its matching pack before playback.",
        );
        return;
      }
      const step = {
        ...context,
        meta: metadata,
        world: new EntityWorld(metadata.world, this.registries),
      };
      this.steps.set(context.simulation, step);
      this.current = step;
      for (const command of context.admin?.wbCommands || [])
        this.registries.get("commands").require(command.name)(command.data, {
          ...step,
          sender: command.sender,
        });
      this.events.emit(type, step);
      this.registries
        .get("modes")
        .get(this.profile.mode || "")
        ?.update?.(step);
      step.world.tick(step);
      return;
    }
    if (type === "beforePhysics") {
      const step = this.steps.get(context.simulation);
      if (!step) return;
      this.current = { ...step, ...context, world: step.world };
      this.events.emit(type, this.current);
      step.bodies = createModBodies(context, step.world, this.native);
      return;
    }
    if (type === "afterPhysics") {
      const step = this.steps.get(context.simulation);
      if (!step) return;
      finishModBodies(context, step.world, step.bodies);
      this.current = { ...step, ...context, world: step.world };
      this.events.emit(type, this.current);
      return;
    }
    if (type === "afterStep") {
      const step = this.steps.get(context.simulation);
      if (!step) return;
      // A native round reset may already have created a fresh mod world.
      const metadata = context.state.__bonkMods || step.meta;
      metadata.frame = step.meta.frame + 1;
      context.state.__bonkMods = metadata;
      this.current = {
        ...context,
        meta: metadata,
        world: new EntityWorld(metadata.world, this.registries),
      };
      this.events.emit(type, this.current);
      this.current = null;
      return;
    }
    if (type === "beforeRender" || type === "afterRender") {
      const metadata = context.state?.__bonkMods;
      if (!metadata || metadata.hash !== this.profile.hash) return;
      const world = new EntityWorld(metadata.world, this.registries);
      this.current = { ...context, world };
      if (type === "beforeRender") renderModWorld(context, world, this.native);
      this.events.emit(type, this.current);
      if (type === "afterRender")
        this.registries
          .get("modes")
          .get(this.profile.mode || "")
          ?.render?.(this.current);
      this.current = null;
      return;
    }
    this.events.emit(type, context);
  }
}
window.BonkMods = new ClientModRuntime();
(window as any).TonkMods = window.BonkMods;
