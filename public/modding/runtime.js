"use strict";
(() => {
  // shared/modkit.ts
  function assertJson(value, depth = 0) {
    if (depth > 50) throw Error("Mod state is nested too deeply.");
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      value.forEach((x) => assertJson(x, depth + 1));
      return;
    }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw Error("Reserved state property: " + key);
        assertJson(item, depth + 1);
      }
      return;
    }
    throw Error(
      "Persistent mod state must contain finite JSON values; register a serializer for custom classes."
    );
  }
  var EventBus = class {
    constructor(report = (error) => {
      throw error;
    }) {
      this.report = report;
    }
    report;
    listeners = /* @__PURE__ */ new Map();
    on(event, fn, owner = "core", priority = 0) {
      if (typeof fn !== "function") throw Error("Event callback required.");
      const record = { owner, fn, priority }, list = this.listeners.get(event) || [];
      list.push(record);
      list.sort((a, b) => a.priority - b.priority);
      this.listeners.set(event, list);
      return () => {
        const i = list.indexOf(record);
        if (i >= 0) list.splice(i, 1);
      };
    }
    emit(event, ...args) {
      for (const record of [...this.listeners.get(event) || []]) {
        try {
          record.fn(...args);
        } catch (error) {
          this.report(error, record.owner, event);
        }
      }
    }
    removeOwner(owner) {
      for (const [name, list] of this.listeners)
        this.listeners.set(
          name,
          list.filter((record) => record.owner !== owner)
        );
    }
    has(event) {
      return !!this.listeners.get(event)?.length;
    }
  };
  var Registry = class {
    constructor(category) {
      this.category = category;
    }
    category;
    entries = /* @__PURE__ */ new Map();
    register(id, value, owner = "core") {
      if (!/^[a-z][\w-]*:[\w./-]+$/.test(id))
        throw Error("Registry id must be namespaced, such as mymod:orb.");
      if (this.entries.has(id))
        throw Error(`Duplicate ${this.category} registration: ${id}`);
      this.entries.set(id, { value, owner });
      return value;
    }
    get(id) {
      return this.entries.get(id)?.value;
    }
    require(id) {
      const found = this.get(id);
      if (found === void 0) throw Error(`Unknown ${this.category}: ${id}`);
      return found;
    }
    values() {
      return [...this.entries].map(([id, entry]) => ({ id, ...entry }));
    }
    removeOwner(owner) {
      for (const [id, record] of this.entries)
        if (record.owner === owner) this.entries.delete(id);
    }
  };
  var Registries = class {
    categories = /* @__PURE__ */ new Map();
    get(name) {
      if (!this.categories.has(name))
        this.categories.set(name, new Registry(name));
      return this.categories.get(name);
    }
    removeOwner(owner) {
      this.categories.forEach((registry) => registry.removeOwner(owner));
    }
    summary() {
      return [...this.categories].flatMap(
        ([category, registry]) => registry.values().map(({ id, owner }) => ({ category, id, owner }))
      );
    }
  };
  var SeededRandom = class {
    constructor(state = 1) {
      this.state = state;
      if (!state) this.state = 1;
    }
    state;
    next() {
      let n = this.state | 0;
      n ^= n << 13;
      n ^= n >>> 17;
      n ^= n << 5;
      this.state = n >>> 0;
      return this.state / 4294967296;
    }
    between(min, max) {
      return min + (max - min) * this.next();
    }
  };
  var emptyWorld = (seed = 1) => ({
    nextId: 1,
    rng: seed || 1,
    entities: {},
    properties: {}
  });
  var Entity = class {
    static defaults = {};
    static body = null;
    static update(_entity, _context) {
    }
    static render(_entity, _view, _context) {
    }
  };
  var EntityWorld = class {
    constructor(state, registries) {
      this.state = state;
      this.registries = registries;
      this.random = new SeededRandom(state.rng);
    }
    state;
    registries;
    random;
    spawn(type, values = {}) {
      const definition = this.registries.get("entities").require(type), defaults = structuredClone(definition.defaults || {});
      const id = String(this.state.nextId++);
      const entity = {
        id,
        type,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angle: 0,
        angularVelocity: 0,
        properties: {},
        components: {},
        ...defaults,
        ...structuredClone(values)
      };
      entity.id = id;
      entity.type = type;
      this.state.entities[id] = entity;
      definition.create?.(entity, { world: this });
      return entity;
    }
    get(id) {
      return this.state.entities[id];
    }
    remove(id) {
      const entity = this.get(id);
      if (!entity) return;
      this.registries.get("entities").get(entity.type)?.destroy?.(entity, { world: this });
      delete this.state.entities[id];
    }
    query(type) {
      return Object.values(this.state.entities).filter(
        (entity) => !type || entity.type === type
      );
    }
    tick(context) {
      for (const entity of this.query()) {
        if (!this.get(entity.id)) continue;
        this.registries.get("entities").require(entity.type).update?.(entity, { ...context, world: this });
        for (const [id, state] of Object.entries(entity.components))
          this.registries.get("components").require(id).update?.(entity, state, { ...context, world: this });
      }
      this.state.rng = this.random.state;
    }
  };
  function createMixins(registerCleanup) {
    return {
      wrap(target, name, wrapper) {
        const original = target[name];
        if (typeof original !== "function")
          throw Error("Mixin target is not a function: " + name);
        const replacement = function(...args) {
          return wrapper.call(this, original.bind(this), ...args);
        };
        target[name] = replacement;
        const undo = () => {
          if (target[name] === replacement) target[name] = original;
        };
        registerCleanup(undo);
        return undo;
      },
      define(target, name, descriptor) {
        const previous = Object.getOwnPropertyDescriptor(target, name);
        Object.defineProperty(target, name, {
          configurable: true,
          ...descriptor
        });
        const undo = () => {
          if (previous) Object.defineProperty(target, name, previous);
          else delete target[name];
        };
        registerCleanup(undo);
        return undo;
      }
    };
  }

  // client/modding/physics.ts
  var sessions = /* @__PURE__ */ new WeakMap();
  var finite = (value, fallback, name) => {
    if (value === void 0) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw Error(`Entity body ${name} must be finite.`);
    return value;
  };
  var positive = (value, fallback, name) => {
    const number = finite(value, fallback, name);
    if (number <= 0) throw Error(`Entity body ${name} must be positive.`);
    return number;
  };
  function polygonPoints(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > 8)
      throw Error(
        "Entity polygons need 3\u20138 convex vertices; use multiple fixtures for compound shapes."
      );
    const vertices = points.map((point) => ({
      x: finite(Array.isArray(point) ? point[0] : point?.x, 0, "polygon x"),
      y: finite(Array.isArray(point) ? point[1] : point?.y, 0, "polygon y")
    }));
    let direction = 0, area = 0;
    for (let index = 0; index < vertices.length; index++) {
      const a = vertices[index], b = vertices[(index + 1) % vertices.length], c = vertices[(index + 2) % vertices.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-9)
        throw Error(
          "Entity polygon vertices must form a nondegenerate convex polygon."
        );
      if (direction && Math.sign(cross) !== direction)
        throw Error(
          "Entity polygon must be convex; use compound fixtures for concave entities."
        );
      direction = Math.sign(cross);
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) vertices.reverse();
    return vertices;
  }
  function createShape(descriptor, B) {
    const kind = descriptor.shape || descriptor.type || "circle";
    if (kind === "circle")
      return new B.Collision.Shapes.b2CircleShape(
        positive(descriptor.radius, 0.5, "radius")
      );
    const shape = new B.Collision.Shapes.b2PolygonShape();
    if (kind === "box")
      shape.SetAsBox(
        positive(descriptor.width, 1, "width") / 2,
        positive(descriptor.height, 1, "height") / 2
      );
    else if (kind === "polygon")
      shape.SetAsArray(
        polygonPoints(descriptor.points).map(
          (point) => new B.Common.Math.b2Vec2(point.x, point.y)
        )
      );
    else throw Error(`Unknown entity body shape: ${kind}`);
    return shape;
  }
  function createModBodies(ctx, world, native) {
    const handles = /* @__PURE__ */ new Map();
    if (!ctx.world) return handles;
    const B = native.Box2D;
    if (!B?.Dynamics?.b2BodyDef)
      throw Error("Native Box2Dweb module is not attached.");
    const definitions = world.query().flatMap((entity) => {
      const definition = world.registries.get("entities").require(entity.type);
      const descriptor = typeof definition.body === "function" ? definition.body(entity, { ...ctx, world, native }) : definition.body;
      if (!descriptor || descriptor.enabled === false || entity.bodyEnabled === false)
        return [];
      const fixtures = (descriptor.fixtures || [descriptor]).map(
        (fixture) => ({
          descriptor: fixture,
          shape: createShape(fixture, B)
        })
      );
      for (const key of [
        "x",
        "y",
        "vx",
        "vy",
        "angle",
        "angularVelocity"
      ])
        finite(entity[key], 0, key);
      return [{ entity, descriptor, fixtures }];
    });
    for (const { entity, descriptor, fixtures } of definitions) {
      const bd = new B.Dynamics.b2BodyDef();
      bd.type = descriptor.static ? B.Dynamics.b2Body.b2_staticBody : descriptor.kinematic ? B.Dynamics.b2Body.b2_kinematicBody : B.Dynamics.b2Body.b2_dynamicBody;
      bd.position.Set(entity.x, entity.y);
      bd.linearVelocity.Set(entity.vx, entity.vy);
      bd.angle = entity.angle;
      bd.angularVelocity = entity.angularVelocity;
      bd.linearDamping = finite(descriptor.linearDamping, 0, "linearDamping");
      bd.angularDamping = finite(descriptor.angularDamping, 0, "angularDamping");
      bd.fixedRotation = descriptor.fixedRotation === true;
      bd.bullet = descriptor.bullet === true;
      bd.userData = { type: "mod", entityID: entity.id, entityType: entity.type };
      const body = ctx.world.CreateBody(bd);
      handles.set(entity.id, body);
      for (const fixture of fixtures) {
        const fd = new B.Dynamics.b2FixtureDef();
        fd.shape = fixture.shape;
        fd.density = finite(
          fixture.descriptor.density ?? descriptor.density,
          1,
          "density"
        );
        fd.friction = finite(
          fixture.descriptor.friction ?? descriptor.friction,
          0.3,
          "friction"
        );
        fd.restitution = finite(
          fixture.descriptor.restitution ?? descriptor.restitution,
          0.2,
          "restitution"
        );
        fd.isSensor = (fixture.descriptor.sensor ?? descriptor.sensor) === true;
        fd.filter.categoryBits = finite(
          fixture.descriptor.categoryBits ?? descriptor.categoryBits,
          1,
          "categoryBits"
        );
        fd.filter.maskBits = finite(
          fixture.descriptor.maskBits ?? descriptor.maskBits,
          65535,
          "maskBits"
        );
        fd.filter.groupIndex = finite(
          fixture.descriptor.groupIndex ?? descriptor.groupIndex,
          0,
          "groupIndex"
        );
        fd.userData = {
          type: "mod",
          entityID: entity.id,
          entityType: entity.type
        };
        body.CreateFixture(fd);
      }
      descriptor.created?.(entity, body, { ...ctx, world, native });
    }
    const nativeListener = ctx.engine?.contactListener || ctx.world.m_contactManager?.m_contactListener;
    const collisions = [];
    const listener = {};
    for (const [name, phase] of [
      ["BeginContact", "begin"],
      ["EndContact", "end"],
      ["PreSolve", null],
      ["PostSolve", "postSolve"]
    ])
      listener[name] = (...args) => {
        const result = nativeListener?.[name]?.apply(nativeListener, args);
        if (phase && (args[0].GetFixtureA().GetBody().GetUserData()?.type === "mod" || args[0].GetFixtureB().GetBody().GetUserData()?.type === "mod"))
          collisions.push({ phase, contact: args[0], impulse: args[1] });
        return result;
      };
    if (handles.size) ctx.world.SetContactListener(listener);
    sessions.set(handles, {
      nativeListener,
      listener,
      world: ctx.world,
      collisions
    });
    return handles;
  }
  function finishModBodies(ctx, world, handles) {
    const session = sessions.get(handles);
    for (const [id, body] of handles) {
      const entity = world.get(id);
      if (!entity) continue;
      const position = body.GetPosition(), velocity = body.GetLinearVelocity();
      entity.x = position.x;
      entity.y = position.y;
      entity.vx = velocity.x;
      entity.vy = velocity.y;
      entity.angle = body.GetAngle();
      entity.angularVelocity = body.GetAngularVelocity();
    }
    if (!session) return;
    session.world.SetContactListener(session.nativeListener);
    sessions.delete(handles);
    for (const collision of session.collisions) {
      const a = collision.contact.GetFixtureA(), b = collision.contact.GetFixtureB();
      for (const [own, other] of [
        [a, b],
        [b, a]
      ]) {
        const data = own.GetBody().GetUserData();
        if (data?.type !== "mod") continue;
        const entity = world.get(data.entityID);
        if (!entity) continue;
        const otherData = other.GetBody().GetUserData() || {};
        const counterpart = otherData.type === "mod" ? world.get(otherData.entityID) : {
          type: otherData.type || "native",
          id: otherData.arrayID,
          body: other.GetBody(),
          fixture: other,
          data: otherData
        };
        if (!counterpart) continue;
        const definition = world.registries.get("entities").require(entity.type);
        const context = {
          ...ctx,
          world,
          phase: collision.phase,
          contact: collision.contact,
          impulse: collision.impulse,
          body: own.GetBody(),
          fixture: own,
          otherBody: other.GetBody(),
          otherFixture: other
        };
        if (collision.phase === "begin")
          definition.collide?.(entity, counterpart, context);
        const callback = collision.phase === "begin" ? "beginContact" : collision.phase === "end" ? "endContact" : "postSolve";
        definition[callback]?.(entity, counterpart, context);
      }
    }
  }

  // client/modding/views.ts
  var byRenderer = /* @__PURE__ */ new WeakMap();
  var live = /* @__PURE__ */ new Set();
  function destroyObject(object) {
    if (!object || object.destroyed || object._destroyed) return;
    object.parent?.removeChild(object);
    object.destroy?.({ children: true, texture: false, baseTexture: false });
  }
  function clearSession(session) {
    destroyObject(session.layer);
    session.views.clear();
    session.undoDestroy?.();
    byRenderer.delete(session.key);
    live.delete(session);
  }
  function clearModViews(renderer) {
    if (renderer) {
      const session = byRenderer.get(renderer);
      if (session) clearSession(session);
    } else for (const session of [...live]) clearSession(session);
  }
  var positive2 = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  var colour = (value, fallback = 4771757) => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value) ? Number.parseInt(value.replace("#", ""), 16) : fallback;
  function drawDefault(entity, definition, view, context) {
    const descriptor = (typeof definition.body === "function" ? definition.body(entity, context) : definition.body) || {};
    const width = positive2(
      definition.width ?? descriptor.width,
      positive2(descriptor.radius, 0.5) * 2
    );
    const height = positive2(
      definition.height ?? descriptor.height,
      positive2(descriptor.radius, 0.5) * 2
    );
    const texture = typeof definition.texture === "function" ? definition.texture(entity, context) : definition.texture;
    const visible = definition.defaultView !== false;
    if (texture && visible) {
      if (!view.sprite) {
        view.sprite = new context.PIXI.Sprite(typeof texture === "string" ? context.PIXI.Texture.from(texture) : texture);
        view.sprite.anchor.set(0.5);
        view.container.addChild(view.sprite);
      }
      if (view.texture !== texture) {
        view.sprite.texture = typeof texture === "string" ? context.PIXI.Texture.from(texture) : texture;
        view.texture = texture;
      }
      view.sprite.width = width;
      view.sprite.height = height;
      view.sprite.visible = true;
      view.sprite.tint = colour(
        entity.properties?.tint ?? definition.tint,
        16777215
      );
      if (view.graphic) view.graphic.visible = false;
      return;
    }
    if (view.sprite) view.sprite.visible = false;
    if (!visible) {
      if (view.graphic) view.graphic.visible = false;
      return;
    }
    if (!view.graphic) {
      view.graphic = new context.PIXI.Graphics();
      view.container.addChild(view.graphic);
    }
    view.graphic.visible = true;
    const color = colour(entity.properties?.color ?? definition.color);
    const alpha = definition.alpha ?? 1;
    const shape = descriptor.shape || descriptor.type || "circle";
    const signature = JSON.stringify([
      shape,
      width,
      height,
      descriptor.radius,
      descriptor.points,
      color,
      alpha,
      definition.outline,
      definition.outlineWidth
    ]);
    if (view.signature === signature) return;
    view.signature = signature;
    const graphic = view.graphic;
    graphic.clear();
    if (definition.outline !== void 0)
      graphic.lineStyle(
        positive2(definition.outlineWidth, 0.05),
        colour(definition.outline, 16777215),
        1
      );
    graphic.beginFill(color, alpha);
    if (shape === "box") graphic.drawRect(-width / 2, -height / 2, width, height);
    else if (shape === "polygon" && Array.isArray(descriptor.points))
      graphic.drawPolygon(
        descriptor.points.flatMap(
          (point) => Array.isArray(point) ? point : [point.x, point.y]
        )
      );
    else
      graphic.drawCircle(
        0,
        0,
        positive2(descriptor.radius, Math.max(width, height) / 2)
      );
    graphic.endFill();
  }
  function renderModWorld(ctx, world, native) {
    const PIXI = native.PIXI;
    const key = ctx.renderer || ctx.nativeRenderer || ctx.stage;
    const target = ctx.kind === "modern" ? ctx.environment || ctx.renderer?.environmentContainer : ctx.stage;
    if (!key || !target || target.destroyed || target._destroyed || !PIXI?.Container)
      return;
    const entities = world.query();
    let session = byRenderer.get(key);
    if (!entities.length) {
      if (session) clearSession(session);
      return;
    }
    if (session?.layer.destroyed || session?.layer._destroyed) {
      clearSession(session);
      session = void 0;
    }
    if (!session) {
      const layer = new PIXI.Container();
      layer.name = "BonkMods:world";
      session = { key, layer, views: /* @__PURE__ */ new Map() };
      byRenderer.set(key, session);
      live.add(session);
      if (typeof key.destroy === "function") {
        const original = key.destroy;
        const replacement = function(...args) {
          clearModViews(key);
          return original.apply(this, args);
        };
        key.destroy = replacement;
        session.undoDestroy = () => {
          if (key.destroy === replacement) key.destroy = original;
        };
      }
    }
    if (session.layer.parent !== target) target.addChild(session.layer);
    if (target.children?.at(-1) !== session.layer) target.addChild(session.layer);
    const ppm = positive2(ctx.state?.physics?.ppm ?? ctx.state?.ppm, 12);
    const factor = ctx.kind === "modern" ? ppm * positive2(ctx.renderer?.scaleRatio, 1) : ppm;
    session.layer.scale.set(factor);
    const active = new Set(entities.map((entity) => entity.id));
    for (const [id, view] of session.views)
      if (!active.has(id)) {
        destroyObject(view.container);
        session.views.delete(id);
      }
    for (const entity of entities) {
      const definition = world.registries.get("entities").require(entity.type);
      let view = session.views.get(entity.id);
      if (!view) {
        view = { container: new PIXI.Container() };
        view.container.name = `BonkMods:${entity.type}:${entity.id}`;
        session.views.set(entity.id, view);
        session.layer.addChild(view.container);
      }
      view.container.position.set(entity.x, entity.y);
      view.container.rotation = entity.angle;
      view.container.visible = entity.visible !== false;
      const context = {
        ...ctx,
        world,
        PIXI,
        native,
        layer: session.layer,
        defaultGraphic: view.graphic,
        defaultSprite: view.sprite
      };
      drawDefault(entity, definition, view, context);
      context.defaultGraphic = view.graphic;
      context.defaultSprite = view.sprite;
      definition.render?.(entity, view.container, context);
    }
  }

  // client/modding/runtime.ts
  var hashBytes = async (bytes) => [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes)
    )
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  var ClientModRuntime = class {
    apiVersion = 2;
    registries = new Registries();
    events = new EventBus(
      (error, owner, event) => this.report(
        `${owner} / ${event}: ${error instanceof Error ? error.message : error}`
      )
    );
    native = null;
    nativeWorld = null;
    profile = { api: 2, hash: "", mods: [] };
    active = /* @__PURE__ */ new Map();
    steps = /* @__PURE__ */ new WeakMap();
    current = null;
    loading = null;
    consents = /* @__PURE__ */ new Map();
    sequence = 0;
    socket = null;
    generation = 0;
    downloads = new AbortController();
    ensureActive(generation) {
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
    attachNative(native) {
      this.native = native;
      this.events.emit("engineReady", native);
    }
    report(message) {
      console.error("[Bonk Mods]", message);
      parent.postMessage({ type: "bonk-mod-notice", message }, location.origin);
    }
    progress(message, done = false) {
      parent.postMessage(
        { type: "bonk-modpack-progress", message, done },
        location.origin
      );
    }
    async consent(profile) {
      if (!profile.mods.length) return;
      const approvals = JSON.parse(
        localStorage.getItem("bonk.modpackApprovals") || "[]"
      );
      if (approvals.includes(profile.hash)) return;
      const id = String(++this.sequence);
      const accepted = new Promise(
        (resolve) => this.consents.set(id, resolve)
      );
      parent.postMessage(
        { type: "bonk-modpack-request", id, profile },
        location.origin
      );
      if (!await accepted) {
        this.leaveRoom();
        throw new DOMException(
          "Left room without downloading its modpack.",
          "AbortError"
        );
      }
    }
    approve(hash) {
      const list = JSON.parse(
        localStorage.getItem("bonk.modpackApprovals") || "[]"
      );
      localStorage.setItem(
        "bonk.modpackApprovals",
        JSON.stringify([.../* @__PURE__ */ new Set([...list, hash])].slice(-128))
      );
    }
    async prepareRoom(id) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/mods`);
      if (!response.ok) throw Error("Room modpack could not be fetched.");
      await this.prepareProfile(await response.json());
    }
    async prepareProfile(profile) {
      if (profile.api !== 2 || typeof profile.hash !== "string" || !Array.isArray(profile.mods))
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
    async loadProfile(profile, generation) {
      await this.consent(profile);
      this.ensureActive(generation);
      const downloaded = [];
      for (const pack of profile.mods) {
        this.progress(`Downloading ${pack.name} ${pack.version}\u2026`);
        const assets = /* @__PURE__ */ new Map();
        let bytes;
        if (pack.client)
          bytes = await this.verified(pack.client, pack.clientHash);
        for (const [name, asset] of Object.entries(pack.assets || {}))
          assets.set(name, await this.verified(asset.url, asset.hash));
        downloaded.push({ pack, bytes, assets });
      }
      this.ensureActive(generation);
      this.unload();
      this.profile = profile;
      try {
        for (const { pack, bytes, assets } of downloaded) {
          const record = {
            cleanups: [],
            blobs: []
          };
          this.active.set(pack.id, record);
          if (!bytes) continue;
          const codeUrl = URL.createObjectURL(
            new Blob([bytes], { type: "text/javascript" })
          );
          record.blobs.push(codeUrl);
          this.ensureActive(generation);
          const module = await import(
            /* webpackIgnore: true */
            codeUrl
          ), setup = module.setup || module.default;
          this.ensureActive(generation);
          if (typeof setup !== "function")
            throw Error(
              `${pack.id} must export setup(api) or a default function.`
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
            registrations: this.registries.summary()
          },
          location.origin
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
    async verified(url, expected) {
      const address = new URL(url, location.origin);
      if (address.origin !== location.origin)
        throw Error("Room packs must be supplied through this server.");
      const response = await fetch(address.href, {
        signal: this.downloads.signal
      });
      if (!response.ok)
        throw Error("Mod file download failed: " + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await hashBytes(bytes) !== expected)
        throw Error(
          "Mod file integrity check failed. Leave and ask the host to republish the pack."
        );
      return bytes;
    }
    unload() {
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
      this.steps = /* @__PURE__ */ new WeakMap();
      this.current = null;
    }
    context(pack, assets, record) {
      const owner = pack.id, runtime = this, textures = /* @__PURE__ */ new Map();
      const registry = (category) => ({
        register(id, value) {
          if (!id.startsWith(owner + ":"))
            throw Error("Use your mod namespace for registrations.");
          return runtime.registries.get(category).register(id, value, owner);
        },
        get: (id) => runtime.registries.get(category).get(id),
        values: () => runtime.registries.get(category).values()
      });
      const namespace = (name) => name.includes(":") ? name : owner + ":" + name;
      const blob = (name, type) => {
        const bytes = assets.get(name);
        if (!bytes) throw Error("Unknown declared asset: " + name);
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        record.blobs.push(url);
        return url;
      };
      const properties = {
        ...registry("properties"),
        read(target, id) {
          const world = runtime.getWorld();
          const definition = runtime.registries.get("properties").require(id);
          return world?.state.properties[target]?.[id] ?? structuredClone(definition.default ?? null);
        },
        write(target, id, value) {
          const world = runtime.getWorld();
          if (!world) throw Error("No active mod world.");
          const definition = runtime.registries.get("properties").require(id);
          definition.validate?.(value);
          assertJson(value);
          (world.state.properties[target] ||= {})[id] = structuredClone(value);
        }
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
        on: (event, fn, priority = 0) => runtime.events.on(event, fn, owner, priority),
        mixins: createMixins((cleanup) => record.cleanups.push(cleanup)),
        assets: {
          bytes: (name) => assets.get(name)?.slice(),
          url: (name) => {
            if (!pack.assets[name]) throw Error("Unknown asset: " + name);
            return pack.assets[name].url;
          },
          text: (name) => {
            const bytes = assets.get(name);
            if (!bytes) throw Error("Unknown asset: " + name);
            return new TextDecoder().decode(bytes);
          },
          json: (name) => {
            const bytes = assets.get(name);
            if (!bytes) throw Error("Unknown asset: " + name);
            return JSON.parse(new TextDecoder().decode(bytes));
          },
          image: async (name) => {
            const image = new Image();
            image.src = blob(name, this.mime(pack.assets[name]?.file));
            await image.decode();
            return image;
          },
          texture: async (name) => {
            if (textures.has(name)) return textures.get(name);
            const image = new Image();
            image.src = blob(name, this.mime(pack.assets[name]?.file));
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            canvas.getContext("2d").drawImage(image, 0, 0);
            const texture = runtime.native.PIXI.Texture.from(canvas);
            textures.set(name, texture);
            record.cleanups.push(() => texture.destroy(true));
            return texture;
          },
          sound: (name) => {
            const audio = new Audio(
              blob(name, this.mime(pack.assets[name]?.file))
            );
            record.cleanups.push(() => {
              audio.pause();
              audio.src = "";
            });
            return audio;
          }
        },
        commands: {
          register: (name, handler) => runtime.registries.get("commands").register(namespace(name), handler, owner),
          send: (name, data = {}) => runtime.send("mods:command", { name: namespace(name), data })
        },
        network: {
          on: (name, handler) => runtime.events.on("network:" + namespace(name), handler, owner),
          send: (name, data = {}) => runtime.send("mods:message", { channel: namespace(name), data })
        },
        input: {
          on(key, handler) {
            const listener = (event) => {
              if (event.code === key && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement))
                handler(event);
            };
            document.addEventListener("keydown", listener);
            const stop = () => document.removeEventListener("keydown", listener);
            record.cleanups.push(stop);
            return stop;
          }
        },
        ui: {
          mount(element, options = {}) {
            element.dataset.bonkModUi = owner;
            (options.parent || document.getElementById("bonkiocontainer")).append(element);
            record.cleanups.push(() => element.remove());
            return element;
          },
          style(css) {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.append(style);
            record.cleanups.push(() => style.remove());
            return style;
          },
          notify: (message) => parent.postMessage(
            { type: "bonk-mod-notice", message: String(message) },
            location.origin
          )
        },
        storage: {
          get: (key, fallback = null) => JSON.parse(
            localStorage.getItem(`bonk.mod.${owner}.${key}`) || JSON.stringify(fallback)
          ),
          set: (key, value) => {
            assertJson(value);
            localStorage.setItem(
              `bonk.mod.${owner}.${key}`,
              JSON.stringify(value)
            );
          }
        },
        dispose: (cleanup) => record.cleanups.push(cleanup)
      };
    }
    mime(file = "") {
      return {
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        webp: "image/webp",
        wav: "audio/wav",
        mp3: "audio/mpeg",
        ogg: "audio/ogg"
      }[file.split(".").pop()] || "application/octet-stream";
    }
    getWorld() {
      const state = this.current?.world?.state || this.nativeWorld?.getState?.()?.__bonkMods?.world;
      return state ? new EntityWorld(state, this.registries) : null;
    }
    send(event, data) {
      return new Promise((resolve, reject) => {
        if (!this.socket?.connected) return reject(Error("Join a room first."));
        const timer = setTimeout(
          () => reject(Error("Mod request timed out.")),
          1e4
        );
        this.socket.emit(event, data, (result) => {
          clearTimeout(timer);
          result?.error ? reject(Error(result.error)) : resolve(result);
        });
      });
    }
    bindSocket(socket) {
      this.socket = socket;
      socket.on("mods:profile", async (profile) => {
        try {
          await this.prepareProfile(profile);
          socket.emit(
            "mods:ready",
            profile.hash,
            (result) => result.error && this.report(result.error)
          );
        } catch (error) {
          if (error?.name !== "AbortError") {
            this.report(String(error));
            this.leaveRoom();
          }
        }
      });
      socket.on(
        "mods:message",
        (message) => this.events.emit("network:" + message.channel, message.data, {
          sender: message.sender
        })
      );
      socket.on("mods:error", (result) => this.report(result.error));
      socket.on("mods:command", (command) => {
        if (window.manifold.localId !== window.manifold.hostId || !this.nativeWorld)
          return;
        const frame = this.nativeWorld.getFrame() + 3;
        const existing = this.nativeWorld.adminAt(frame)?.wbCommands || [];
        this.nativeWorld.submitAdmin(
          { wbCommands: [...existing, command] },
          frame
        );
      });
      socket.on("disconnect", () => {
        this.nativeWorld = null;
        this.events.emit("disconnect");
        this.cancelLoading();
      });
    }
    cancelLoading() {
      this.generation++;
      this.downloads.abort();
      this.downloads = new AbortController();
      for (const resolve of this.consents.values()) resolve(false);
      this.consents.clear();
      this.unload();
      this.profile = { api: 2, hash: "", mods: [] };
    }
    leaveRoom() {
      this.cancelLoading();
      if (window.manifold.cancelNativeJoin) window.manifold.cancelNativeJoin();
      else window.manifold.nativeSession?.leaveRoom?.();
      this.socket?.disconnect();
      parent.postMessage({ type: "bonk-modpack-left" }, location.origin);
    }
    nativeEvent(type, context) {
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
          data: {}
        };
        const world = new EntityWorld(
          context.state.__bonkMods.world,
          this.registries
        );
        this.current = { ...context, world };
        this.events.emit(type, this.current);
        this.registries.get("modes").get(this.profile.mode || "")?.init?.(this.current);
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
            data: {}
          }
        );
        if (metadata.hash !== this.profile.hash) {
          this.report(
            "This saved state requires a different modpack. Select its matching pack before playback."
          );
          return;
        }
        const step = {
          ...context,
          meta: metadata,
          world: new EntityWorld(metadata.world, this.registries)
        };
        this.steps.set(context.simulation, step);
        this.current = step;
        for (const command of context.admin?.wbCommands || [])
          this.registries.get("commands").require(command.name)(command.data, {
            ...step,
            sender: command.sender
          });
        this.events.emit(type, step);
        this.registries.get("modes").get(this.profile.mode || "")?.update?.(step);
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
        const metadata = context.state.__bonkMods || step.meta;
        metadata.frame = step.meta.frame + 1;
        context.state.__bonkMods = metadata;
        this.current = {
          ...context,
          meta: metadata,
          world: new EntityWorld(metadata.world, this.registries)
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
          this.registries.get("modes").get(this.profile.mode || "")?.render?.(this.current);
        this.current = null;
        return;
      }
      this.events.emit(type, context);
    }
  };
  window.BonkMods = new ClientModRuntime();
})();
//# sourceMappingURL=runtime.js.map
