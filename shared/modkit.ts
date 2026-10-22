/** Portable mod primitives. Runtime code and custom content are intentionally extensible. */
export const MOD_API_VERSION = 2;
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type ModManifest = {
  schemaVersion: 2;
  api: 2;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  entrypoints: { client?: string; server?: string };
  dependencies?: Record<string, string>;
  assets?: Record<string, string>;
  commands?: Record<string, { from?: "host" | "players"; maxBytes?: number }>;
  channels?: Record<string, { from?: "host" | "players"; maxBytes?: number }>;
};
export function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0") ||
    value.split("/").some((x) => x === ".." || x === "." || !x) ||
    /[:?#]/.test(value)
  )
    throw Error("Use a relative pack path without traversal: " + String(value));
  return value;
}
export function validateManifest(value: any): ModManifest {
  if (!value || value.schemaVersion !== 2 || value.api !== MOD_API_VERSION)
    throw Error("Use bonk.mod.json schemaVersion 2 and api 2.");
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(value.id))
    throw Error(
      "Mod id must be 2–64 lowercase letters, digits, hyphens or underscores.",
    );
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100
  )
    throw Error("Mod name is required (up to 100 characters).");
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version))
    throw Error("Use a semantic version, such as 1.0.0.");
  if (
    !value.entrypoints ||
    !(value.entrypoints.client || value.entrypoints.server)
  )
    throw Error("Declare a client and/or server entrypoint.");
  for (const file of Object.values(value.entrypoints)) validatePath(file);
  for (const [id, range] of Object.entries(value.dependencies || {}))
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id) || typeof range !== "string")
      throw Error("Invalid mod dependency.");
  for (const [name, file] of Object.entries(value.assets || {})) {
    if (!/^[\w./-]+$/.test(name)) throw Error("Invalid asset name.");
    validatePath(file);
  }
  for (const rules of [value.commands || {}, value.channels || {}])
    for (const [name, rule] of Object.entries(rules) as [string, any][])
      if (
        !/^[\w./-]+$/.test(name) ||
        !rule ||
        ![undefined, "host", "players"].includes(rule.from) ||
        (rule.maxBytes !== undefined &&
          (!Number.isInteger(rule.maxBytes) ||
            rule.maxBytes < 1 ||
            rule.maxBytes > 65536))
      )
        throw Error("Invalid mod network permission.");
  return structuredClone(value);
}
export function versionMatches(version: string, range: string): boolean {
  if (range === "*" || range === version) return true;
  const v = version.split(".").map(Number),
    match = /^([~^])(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) return false;
  const min = match.slice(2).map(Number);
  const atLeast =
    v[0] > min[0] ||
    (v[0] === min[0] && (v[1] > min[1] || (v[1] === min[1] && v[2] >= min[2])));
  return (
    atLeast &&
    v[0] === min[0] &&
    (match[1] === "~" || min[0] === 0 ? v[1] === min[1] : true) &&
    (match[1] === "^" && min[0] === 0 && min[1] === 0 ? v[2] === min[2] : true)
  );
}
export function resolveMods<T extends { manifest: ModManifest }>(
  available: T[],
  requested: string[],
): T[] {
  const byId = new Map(available.map((mod) => [mod.manifest.id, mod])),
    active = new Set<string>(),
    done = new Set<string>(),
    ordered: T[] = [];
  const visit = (id: string) => {
    if (active.has(id)) throw Error("Circular mod dependency: " + id);
    if (done.has(id)) return;
    const mod = byId.get(id);
    if (!mod) throw Error("Required mod is not installed: " + id);
    active.add(id);
    for (const [dependency, range] of Object.entries(
      mod.manifest.dependencies || {},
    )) {
      const other = byId.get(dependency);
      if (!other || !versionMatches(other.manifest.version, range))
        throw Error(`${id} requires ${dependency} ${range}.`);
      visit(dependency);
    }
    active.delete(id);
    done.add(id);
    ordered.push(mod);
  };
  requested.forEach(visit);
  return ordered;
}
export function assertJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 50) throw Error("Mod state is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((x) => assertJson(x, depth + 1));
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw Error("Reserved state property: " + key);
      assertJson(item, depth + 1);
    }
    return;
  }
  throw Error(
    "Persistent mod state must contain finite JSON values; register a serializer for custom classes.",
  );
}
export class EventBus {
  private listeners = new Map<
    string,
    { owner: string; fn: (...args: any[]) => any; priority: number }[]
  >();
  constructor(
    private report: (error: unknown, owner: string, event: string) => void = (
      error,
    ) => {
      throw error;
    },
  ) {}
  on(
    event: string,
    fn: (...args: any[]) => any,
    owner = "core",
    priority = 0,
  ): () => void {
    if (typeof fn !== "function") throw Error("Event callback required.");
    const record = { owner, fn, priority },
      list = this.listeners.get(event) || [];
    list.push(record);
    list.sort((a, b) => a.priority - b.priority);
    this.listeners.set(event, list);
    return () => {
      const i = list.indexOf(record);
      if (i >= 0) list.splice(i, 1);
    };
  }
  emit(event: string, ...args: any[]): void {
    for (const record of [...(this.listeners.get(event) || [])]) {
      try {
        record.fn(...args);
      } catch (error) {
        this.report(error, record.owner, event);
      }
    }
  }
  removeOwner(owner: string): void {
    for (const [name, list] of this.listeners)
      this.listeners.set(
        name,
        list.filter((record) => record.owner !== owner),
      );
  }
  has(event: string): boolean {
    return !!this.listeners.get(event)?.length;
  }
}
export class Registry<T = any> {
  private entries = new Map<string, { value: T; owner: string }>();
  constructor(readonly category: string) {}
  register(id: string, value: T, owner = "core"): T {
    if (!/^[a-z][\w-]*:[\w./-]+$/.test(id))
      throw Error("Registry id must be namespaced, such as mymod:orb.");
    if (this.entries.has(id))
      throw Error(`Duplicate ${this.category} registration: ${id}`);
    this.entries.set(id, { value, owner });
    return value;
  }
  get(id: string): T | undefined {
    return this.entries.get(id)?.value;
  }
  require(id: string): T {
    const found = this.get(id);
    if (found === undefined) throw Error(`Unknown ${this.category}: ${id}`);
    return found;
  }
  values(): { id: string; value: T; owner: string }[] {
    return [...this.entries].map(([id, entry]) => ({ id, ...entry }));
  }
  removeOwner(owner: string): void {
    for (const [id, record] of this.entries)
      if (record.owner === owner) this.entries.delete(id);
  }
}
export class Registries {
  private categories = new Map<string, Registry>();
  get(name: string): Registry {
    if (!this.categories.has(name))
      this.categories.set(name, new Registry(name));
    return this.categories.get(name)!;
  }
  removeOwner(owner: string): void {
    this.categories.forEach((registry) => registry.removeOwner(owner));
  }
  summary() {
    return [...this.categories].flatMap(([category, registry]) =>
      registry.values().map(({ id, owner }) => ({ category, id, owner })),
    );
  }
}
export class SeededRandom {
  constructor(public state = 1) {
    if (!state) this.state = 1;
  }
  next(): number {
    let n = this.state | 0;
    n ^= n << 13;
    n ^= n >>> 17;
    n ^= n << 5;
    this.state = n >>> 0;
    return this.state / 4294967296;
  }
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
export type EntityState = {
  id: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
  properties: Record<string, any>;
  components: Record<string, any>;
  [key: string]: any;
};
export type WorldState = {
  nextId: number;
  rng: number;
  entities: Record<string, EntityState>;
  properties: Record<string, any>;
};
export const emptyWorld = (seed = 1): WorldState => ({
  nextId: 1,
  rng: seed || 1,
  entities: {},
  properties: {},
});
export class Entity {
  static defaults: Record<string, any> = {};
  static body: any = null;
  static update(_entity: EntityState, _context: any): void {}
  static render(_entity: EntityState, _view: any, _context: any): void {}
}
/** All state is explicit and serializable so replayed native steps can roll back. */
export class EntityWorld {
  readonly random: SeededRandom;
  constructor(
    readonly state: WorldState,
    readonly registries: Registries,
  ) {
    this.random = new SeededRandom(state.rng);
  }
  spawn(type: string, values: Partial<EntityState> = {}): EntityState {
    const definition = this.registries.get("entities").require(type),
      defaults = structuredClone(definition.defaults || {});
    const id = String(this.state.nextId++);
    const entity: EntityState = {
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
      ...structuredClone(values),
    };
    entity.id = id;
    entity.type = type;
    this.state.entities[id] = entity;
    definition.create?.(entity, { world: this });
    return entity;
  }
  get(id: string): EntityState | undefined {
    return this.state.entities[id];
  }
  remove(id: string): void {
    const entity = this.get(id);
    if (!entity) return;
    this.registries
      .get("entities")
      .get(entity.type)
      ?.destroy?.(entity, { world: this });
    delete this.state.entities[id];
  }
  query(type?: string): EntityState[] {
    return Object.values(this.state.entities).filter(
      (entity) => !type || entity.type === type,
    );
  }
  tick(context: any): void {
    for (const entity of this.query()) {
      if (!this.get(entity.id)) continue;
      this.registries
        .get("entities")
        .require(entity.type)
        .update?.(entity, { ...context, world: this });
      for (const [id, state] of Object.entries(entity.components))
        this.registries
          .get("components")
          .require(id)
          .update?.(entity, state, { ...context, world: this });
    }
    this.state.rng = this.random.state;
  }
}
export function createMixins(registerCleanup: (cleanup: () => void) => void) {
  return {
    wrap(
      target: any,
      name: string,
      wrapper: (original: (...args: any[]) => any, ...args: any[]) => any,
    ) {
      const original = target[name];
      if (typeof original !== "function")
        throw Error("Mixin target is not a function: " + name);
      const replacement = function (this: any, ...args: any[]) {
        return wrapper.call(this, original.bind(this), ...args);
      };
      target[name] = replacement;
      const undo = () => {
        if (target[name] === replacement) target[name] = original;
      };
      registerCleanup(undo);
      return undo;
    },
    define(target: any, name: string, descriptor: PropertyDescriptor) {
      const previous = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        configurable: true,
        ...descriptor,
      });
      const undo = () => {
        if (previous) Object.defineProperty(target, name, previous);
        else delete target[name];
      };
      registerCleanup(undo);
      return undo;
    },
  };
}
