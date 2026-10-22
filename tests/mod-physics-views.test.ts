import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createModBodies, finishModBodies } from "../client/modding/physics.ts";
import { clearModViews, renderModWorld } from "../client/modding/views.ts";
import { EntityWorld, Registries, emptyWorld } from "../shared/modkit.ts";
import { createNativeHarness } from "../scripts/native-harness.mjs";
import { applyNativeHooks } from "../scripts/native-hooks.mjs";

const source = fs.readFileSync("vendor/bonk/alpha2s.js", "utf8");
const catalog = JSON.parse(
  fs.readFileSync("evidence/protocol/native-catalog.json", "utf8"),
);

test("entity physics adapter collides with real native players and preserves native listeners", () => {
  const registry = new Registries();
  let collisions = 0,
    nativeContacts = 0,
    initialX = 0,
    world: EntityWorld,
    handles: Map<string, any>;
  registry.get("entities").register("example:orb", {
    body: { shape: "circle", radius: 1 },
    collide(_entity: any, other: any, context: any) {
      assert.equal(other.type, "disc");
      assert.equal(context.phase, "begin");
      collisions++;
    },
  });
  let harness: ReturnType<typeof createNativeHarness>;
  harness = createNativeHarness(applyNativeHooks(source).source, {
    nativeEvent(type: string, context: any) {
      if (type === "beforePhysics") {
        if (!world) {
          world = new EntityWorld(emptyWorld(), registry);
          initialX = context.discs[0].body.GetPosition().x + 1.2;
          world.spawn("example:orb", {
            x: initialX,
            y: context.discs[0].body.GetPosition().y,
          });
        }
        const original = context.engine.contactListener.BeginContact;
        context.engine.contactListener.BeginContact = function (
          ...args: any[]
        ) {
          nativeContacts++;
          return original.apply(this, args);
        };
        handles = createModBodies(context, world, harness.native);
      }
      if (type === "afterPhysics") {
        finishModBodies(context, world, handles);
        assert.equal(
          context.world.m_contactManager.m_contactListener,
          context.engine.contactListener,
        );
      }
    },
  });
  const control = createNativeHarness(source);
  for (const run of [harness, control]) {
    run.context.mapData = catalog.find(
      (item: any) => item.name === "Classic",
    ).leveldata;
    run.run(
      "gs=new __native.settings();gs.map=__native.mapEncoder.decodeFromDatabase(mapData);state=__native.simulation.createNewState([{id:0,team:1},{id:1,team:1}],gs.map,123,false,null,gs);state.rc=0;state.ftu=-1;state=new __native.simulation().step(state,[{},{}],null,30,gs,1,false,false);",
    );
  }
  assert.ok(collisions > 0 && nativeContacts > 0);
  assert.notEqual(
    harness.run("state.discs[0].x"),
    control.run("state.discs[0].x"),
  );
  assert.ok(
    world!
      .query()
      .every((entity) =>
        [
          entity.x,
          entity.y,
          entity.vx,
          entity.vy,
          entity.angle,
          entity.angularVelocity,
        ].every(Number.isFinite),
      ),
  );
  assert.notEqual(
    world!.query()[0].x,
    initialX,
    "Native collision resolution displaced the new entity as well as the player",
  );
});

test("body adapter uses native circle, box, polygon, sensor and collision filters", () => {
  const harness = createNativeHarness(source),
    B = harness.native.Box2D;
  const registry = new Registries(),
    world = new EntityWorld(emptyWorld(), registry);
  registry
    .get("entities")
    .register("test:circle", {
      body: { shape: "circle", radius: 1, categoryBits: 8, maskBits: 16 },
    });
  registry
    .get("entities")
    .register("test:box", {
      body: { shape: "box", width: 2, height: 3, static: true, sensor: true },
    });
  registry.get("entities").register("test:polygon", {
    body: {
      shape: "polygon",
      points: [
        [-1, -1],
        [1, -1],
        [0, 1],
      ],
      density: 2,
    },
  });
  const circle = world.spawn("test:circle", { x: 4, y: 5, vx: 3, angle: 0.3 }),
    box = world.spawn("test:box"),
    polygon = world.spawn("test:polygon", { x: 10 });
  const ctx = {
    world: new B.Dynamics.b2World(new B.Common.Math.b2Vec2(0, 0)),
    engine: { contactListener: {} },
  };
  const handles = createModBodies(ctx, world, harness.native);
  assert.equal(
    handles.get(circle.id).GetFixtureList().GetFilterData().categoryBits,
    8,
  );
  assert.equal(
    handles.get(circle.id).GetFixtureList().GetFilterData().maskBits,
    16,
  );
  assert.equal(handles.get(box.id).GetType(), B.Dynamics.b2Body.b2_staticBody);
  assert.equal(handles.get(box.id).GetFixtureList().IsSensor(), true);
  assert.equal(
    handles.get(polygon.id).GetFixtureList().GetShape().GetVertices().length,
    3,
  );
  ctx.world.Step(1 / 30, 2, 6);
  finishModBodies(ctx, world, handles);
  assert.ok(circle.x > 4 && Math.abs(circle.angle - 0.3) < 1e-10);
  registry.get("entities").register("test:invalid", {
    body: {
      shape: "polygon",
      points: [
        [0, 0],
        [1, 0],
        [0.2, 0.2],
        [0, 1],
      ],
    },
  });
  world.spawn("test:invalid");
  const count = ctx.world.GetBodyCount();
  assert.throws(() => createModBodies(ctx, world, harness.native), /convex/);
  assert.equal(
    ctx.world.GetBodyCount(),
    count,
    "Geometry rejects invalid bodies before mutating the native world",
  );
});

class Display {
  parent: any = null;
  children: any[] = [];
  destroyed = false;
  name = "";
  x = 0;
  y = 0;
  rotation = 0;
  visible = true;
  scale = {
    x: 1,
    y: 1,
    set: (x: number, y = x) => {
      this.scale.x = x;
      this.scale.y = y;
    },
  };
  position = {
    set: (x: number, y: number) => {
      this.x = x;
      this.y = y;
    },
  };
  addChild(child: any) {
    child.parent?.removeChild(child);
    this.children.push(child);
    child.parent = this;
    return child;
  }
  removeChild(child: any) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  destroy(options: any) {
    if (options?.children)
      for (const child of [...this.children]) child.destroy(options);
    this.destroyed = true;
  }
}
class Graphics extends Display {
  draws: any[] = [];
  clear() {
    this.draws = [];
  }
  lineStyle(...args: any[]) {
    this.draws.push(["line", ...args]);
  }
  beginFill(...args: any[]) {
    this.draws.push(["fill", ...args]);
  }
  drawRect(...args: any[]) {
    this.draws.push(["box", ...args]);
  }
  drawCircle(...args: any[]) {
    this.draws.push(["circle", ...args]);
  }
  drawPolygon(...args: any[]) {
    this.draws.push(["polygon", ...args]);
  }
  endFill() {}
}
class Sprite extends Display {
  width = 0;
  height = 0;
  tint = 0;
  anchor = { set() {} };
  constructor(public texture: any) {
    super();
  }
}
const PIXI = {
  Container: Display,
  Graphics,
  Sprite,
  Texture: {
    from: (value: any) => { if (typeof value === "object") throw Error("PIXI 5 Texture.from expects a resource source, not a Texture"); return { url: value }; },
  },
};

test("view adapter owns only its children and maps meters into modern and legacy cameras", () => {
  const registry = new Registries(),
    world = new EntityWorld(emptyWorld(), registry);
  let customRenders = 0;
  registry.get("entities").register("test:orb", {
    body: { shape: "circle", radius: 1 },
    render(_entity: any, view: any, context: any) {
      assert.ok(view instanceof Display);
      assert.equal(context.PIXI, PIXI);
      customRenders++;
    },
  });
  const orb = world.spawn("test:orb", { x: 2, y: 3, angle: 0.2 });
  const environment = new Display(),
    nativeObject = new Display();
  environment.addChild(nativeObject);
  let destroyed = 0;
  const renderer = {
    scaleRatio: 2,
    destroy() {
      destroyed++;
    },
  };
  const ctx = {
    kind: "modern",
    renderer,
    environment,
    state: { physics: { ppm: 15 } },
  };
  renderModWorld(ctx, world, { PIXI });
  const layer = environment.children[1],
    entityView = layer.children[0];
  assert.equal(layer.scale.x, 30);
  assert.equal(entityView.x, 2);
  assert.equal(entityView.y, 3);
  assert.equal(entityView.rotation, 0.2);
  assert.equal(entityView.children[0].draws.at(-1)[0], "circle");
  environment.removeChild(layer);
  renderModWorld(ctx, world, { PIXI });
  assert.equal(environment.children[1], layer);
  world.remove(orb.id);
  renderModWorld(ctx, world, { PIXI });
  assert.deepEqual(environment.children, [nativeObject]);
  assert.equal(nativeObject.destroyed, false);
  const texture = { baseTexture: { valid: true } };
  registry.get("entities").register("test:sprite", { texture, width: 1, height: 1 });
  world.spawn("test:sprite");
  renderModWorld(ctx, world, { PIXI });
  assert.equal(environment.children[1].children[0].children[0].texture, texture);
  world.spawn("test:orb");
  renderModWorld(ctx, world, { PIXI });
  renderer.destroy();
  assert.equal(destroyed, 1);
  assert.deepEqual(environment.children, [nativeObject]);
  const stage = new Display();
  stage.scale.set(2);
  renderModWorld(
    { kind: "legacy", renderer: {}, stage, state: { physics: { ppm: 15 } } },
    world,
    { PIXI },
  );
  assert.equal(
    stage.children[0].scale.x,
    15,
    "Legacy native stage already supplies the camera ratio",
  );
  assert.ok(customRenders >= 4);
  clearModViews();
});
