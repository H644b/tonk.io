import type { EntityState, EntityWorld } from "../../shared/modkit.ts";

export type ModBodyHandles = Map<string, any>;
type Collision = {
  phase: "begin" | "end" | "postSolve";
  contact: any;
  impulse?: any;
};
type BodySession = {
  nativeListener: any;
  listener: any;
  world: any;
  collisions: Collision[];
};
const sessions = new WeakMap<ModBodyHandles, BodySession>();

const finite = (value: unknown, fallback: number, name: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw Error(`Entity body ${name} must be finite.`);
  return value;
};
const positive = (value: unknown, fallback: number, name: string) => {
  const number = finite(value, fallback, name);
  if (number <= 0) throw Error(`Entity body ${name} must be positive.`);
  return number;
};

function polygonPoints(points: any): { x: number; y: number }[] {
  if (!Array.isArray(points) || points.length < 3 || points.length > 8)
    throw Error(
      "Entity polygons need 3–8 convex vertices; use multiple fixtures for compound shapes.",
    );
  const vertices = points.map((point: any) => ({
    x: finite(Array.isArray(point) ? point[0] : point?.x, 0, "polygon x"),
    y: finite(Array.isArray(point) ? point[1] : point?.y, 0, "polygon y"),
  }));
  let direction = 0,
    area = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index],
      b = vertices[(index + 1) % vertices.length],
      c = vertices[(index + 2) % vertices.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9)
      throw Error(
        "Entity polygon vertices must form a nondegenerate convex polygon.",
      );
    if (direction && Math.sign(cross) !== direction)
      throw Error(
        "Entity polygon must be convex; use compound fixtures for concave entities.",
      );
    direction = Math.sign(cross);
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) vertices.reverse();
  return vertices;
}

function createShape(descriptor: any, B: any): any {
  const kind = descriptor.shape || descriptor.type || "circle";
  if (kind === "circle")
    return new B.Collision.Shapes.b2CircleShape(
      positive(descriptor.radius, 0.5, "radius"),
    );
  const shape = new B.Collision.Shapes.b2PolygonShape();
  if (kind === "box")
    shape.SetAsBox(
      positive(descriptor.width, 1, "width") / 2,
      positive(descriptor.height, 1, "height") / 2,
    );
  else if (kind === "polygon")
    shape.SetAsArray(
      polygonPoints(descriptor.points).map(
        (point) => new B.Common.Math.b2Vec2(point.x, point.y),
      ),
    );
  else throw Error(`Unknown entity body shape: ${kind}`);
  return shape;
}

/** Rebuild serializable mod bodies inside the actual native rollback step. */
export function createModBodies(
  ctx: any,
  world: EntityWorld,
  native: any,
): ModBodyHandles {
  const handles: ModBodyHandles = new Map();
  if (!ctx.world) return handles;
  const B = native.Box2D;
  if (!B?.Dynamics?.b2BodyDef)
    throw Error("Native Box2Dweb module is not attached.");
  const definitions = world.query().flatMap((entity) => {
    const definition = world.registries.get("entities").require(entity.type);
    const descriptor =
      typeof definition.body === "function"
        ? definition.body(entity, { ...ctx, world, native })
        : definition.body;
    if (
      !descriptor ||
      descriptor.enabled === false ||
      entity.bodyEnabled === false
    )
      return [];
    const fixtures = (descriptor.fixtures || [descriptor]).map(
      (fixture: any) => ({
        descriptor: fixture,
        shape: createShape(fixture, B),
      }),
    );
    for (const key of [
      "x",
      "y",
      "vx",
      "vy",
      "angle",
      "angularVelocity",
    ] as const)
      finite(entity[key], 0, key);
    return [{ entity, descriptor, fixtures }];
  });
  for (const { entity, descriptor, fixtures } of definitions) {
    const bd = new B.Dynamics.b2BodyDef();
    bd.type = descriptor.static
      ? B.Dynamics.b2Body.b2_staticBody
      : descriptor.kinematic
        ? B.Dynamics.b2Body.b2_kinematicBody
        : B.Dynamics.b2Body.b2_dynamicBody;
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
        "density",
      );
      fd.friction = finite(
        fixture.descriptor.friction ?? descriptor.friction,
        0.3,
        "friction",
      );
      fd.restitution = finite(
        fixture.descriptor.restitution ?? descriptor.restitution,
        0.2,
        "restitution",
      );
      fd.isSensor = (fixture.descriptor.sensor ?? descriptor.sensor) === true;
      fd.filter.categoryBits = finite(
        fixture.descriptor.categoryBits ?? descriptor.categoryBits,
        1,
        "categoryBits",
      );
      fd.filter.maskBits = finite(
        fixture.descriptor.maskBits ?? descriptor.maskBits,
        0xffff,
        "maskBits",
      );
      fd.filter.groupIndex = finite(
        fixture.descriptor.groupIndex ?? descriptor.groupIndex,
        0,
        "groupIndex",
      );
      fd.userData = {
        type: "mod",
        entityID: entity.id,
        entityType: entity.type,
      };
      body.CreateFixture(fd);
    }
    descriptor.created?.(entity, body, { ...ctx, world, native });
  }
  // Native worlds are reconstructed every tick. Never replace their collision
  // behavior: delegate each original callback and queue mod callbacks until the
  // world is unlocked and the new transforms are captured.
  const nativeListener =
    ctx.engine?.contactListener ||
    ctx.world.m_contactManager?.m_contactListener;
  const collisions: Collision[] = [];
  const listener: any = {};
  for (const [name, phase] of [
    ["BeginContact", "begin"],
    ["EndContact", "end"],
    ["PreSolve", null],
    ["PostSolve", "postSolve"],
  ] as const)
    listener[name] = (...args: any[]) => {
      const result = nativeListener?.[name]?.apply(nativeListener, args);
      if (
        phase &&
        (args[0].GetFixtureA().GetBody().GetUserData()?.type === "mod" ||
          args[0].GetFixtureB().GetBody().GetUserData()?.type === "mod")
      )
        collisions.push({ phase, contact: args[0], impulse: args[1] });
      return result;
    };
  if (handles.size) ctx.world.SetContactListener(listener);
  sessions.set(handles, {
    nativeListener,
    listener,
    world: ctx.world,
    collisions,
  });
  return handles;
}

/** Capture transforms before native cleanup destroys every Box2D body. */
export function finishModBodies(
  ctx: any,
  world: EntityWorld,
  handles: ModBodyHandles,
): void {
  const session = sessions.get(handles);
  for (const [id, body] of handles) {
    const entity = world.get(id);
    if (!entity) continue;
    const position = body.GetPosition(),
      velocity = body.GetLinearVelocity();
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
    const a = collision.contact.GetFixtureA(),
      b = collision.contact.GetFixtureB();
    for (const [own, other] of [
      [a, b],
      [b, a],
    ]) {
      const data = own.GetBody().GetUserData();
      if (data?.type !== "mod") continue;
      const entity = world.get(data.entityID);
      if (!entity) continue;
      const otherData = other.GetBody().GetUserData() || {};
      const counterpart =
        otherData.type === "mod"
          ? world.get(otherData.entityID)
          : {
              type: otherData.type || "native",
              id: otherData.arrayID,
              body: other.GetBody(),
              fixture: other,
              data: otherData,
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
        otherFixture: other,
      };
      if (collision.phase === "begin")
        definition.collide?.(entity, counterpart, context);
      const callback =
        collision.phase === "begin"
          ? "beginContact"
          : collision.phase === "end"
            ? "endContact"
            : "postSolve";
      definition[callback]?.(entity, counterpart, context);
    }
  }
}
