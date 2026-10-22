import type { EntityState, EntityWorld } from "../../shared/modkit.ts";

type EntityView = {
  container: any;
  graphic?: any;
  sprite?: any;
  signature?: string;
  texture?: any;
};
type RenderSession = {
  key: object;
  layer: any;
  views: Map<string, EntityView>;
  undoDestroy?: () => void;
};
const byRenderer = new WeakMap<object, RenderSession>();
const live = new Set<RenderSession>();

function destroyObject(object: any): void {
  if (!object || object.destroyed || object._destroyed) return;
  object.parent?.removeChild(object);
  // Textures are shared asset registry objects; owned views never dispose them.
  object.destroy?.({ children: true, texture: false, baseTexture: false });
}

function clearSession(session: RenderSession): void {
  destroyObject(session.layer);
  session.views.clear();
  session.undoDestroy?.();
  byRenderer.delete(session.key);
  live.delete(session);
}

export function clearModViews(renderer?: object): void {
  if (renderer) {
    const session = byRenderer.get(renderer);
    if (session) clearSession(session);
  } else for (const session of [...live]) clearSession(session);
}

const positive = (value: any, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
const colour = (value: any, fallback = 0x48cfad) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)
      ? Number.parseInt(value.replace("#", ""), 16)
      : fallback;

function drawDefault(
  entity: EntityState,
  definition: any,
  view: EntityView,
  context: any,
): void {
  const descriptor =
    (typeof definition.body === "function"
      ? definition.body(entity, context)
      : definition.body) || {};
  const width = positive(
    definition.width ?? descriptor.width,
    positive(descriptor.radius, 0.5) * 2,
  );
  const height = positive(
    definition.height ?? descriptor.height,
    positive(descriptor.radius, 0.5) * 2,
  );
  const texture =
    typeof definition.texture === "function"
      ? definition.texture(entity, context)
      : definition.texture;
  const visible = definition.defaultView !== false;
  if (texture && visible) {
    if (!view.sprite) {
      view.sprite = new context.PIXI.Sprite(typeof texture === "string" ? context.PIXI.Texture.from(texture) : texture);
      view.sprite.anchor.set(0.5);
      view.container.addChild(view.sprite);
    }
    if (view.texture !== texture) {
      view.sprite.texture =
        typeof texture === "string"
          ? context.PIXI.Texture.from(texture)
          : texture;
      view.texture = texture;
    }
    view.sprite.width = width;
    view.sprite.height = height;
    view.sprite.visible = true;
    view.sprite.tint = colour(
      entity.properties?.tint ?? definition.tint,
      0xffffff,
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
    definition.outlineWidth,
  ]);
  if (view.signature === signature) return;
  view.signature = signature;
  const graphic = view.graphic;
  graphic.clear();
  if (definition.outline !== undefined)
    graphic.lineStyle(
      positive(definition.outlineWidth, 0.05),
      colour(definition.outline, 0xffffff),
      1,
    );
  graphic.beginFill(color, alpha);
  if (shape === "box") graphic.drawRect(-width / 2, -height / 2, width, height);
  else if (shape === "polygon" && Array.isArray(descriptor.points))
    graphic.drawPolygon(
      descriptor.points.flatMap((point: any) =>
        Array.isArray(point) ? point : [point.x, point.y],
      ),
    );
  else
    graphic.drawCircle(
      0,
      0,
      positive(descriptor.radius, Math.max(width, height) / 2),
    );
  graphic.endFill();
}

/** Draw real PIXI objects in the native game's own camera and world units. */
export function renderModWorld(
  ctx: any,
  world: EntityWorld,
  native: any,
): void {
  const PIXI = native.PIXI;
  const key = ctx.renderer || ctx.nativeRenderer || ctx.stage;
  const target =
    ctx.kind === "modern"
      ? ctx.environment || ctx.renderer?.environmentContainer
      : ctx.stage;
  if (
    !key ||
    !target ||
    target.destroyed ||
    target._destroyed ||
    !PIXI?.Container
  )
    return;
  const entities = world.query();
  let session = byRenderer.get(key);
  if (!entities.length) {
    if (session) clearSession(session);
    return;
  }
  if (session?.layer.destroyed || session?.layer._destroyed) {
    clearSession(session);
    session = undefined;
  }
  if (!session) {
    const layer = new PIXI.Container();
    layer.name = "BonkMods:world";
    session = { key, layer, views: new Map() };
    byRenderer.set(key, session);
    live.add(session);
    // Release GPU objects when the native per-game renderer goes away.
    if (typeof key.destroy === "function") {
      const original = key.destroy;
      const replacement = function (this: any, ...args: any[]) {
        clearModViews(key);
        return original.apply(this, args);
      };
      key.destroy = replacement;
      session.undoDestroy = () => {
        if (key.destroy === replacement) key.destroy = original;
      };
    }
  }
  // Native round rebuilding may detach owned children. Reattach without
  // clearing, replacing or changing any of the game's own display objects.
  if (session.layer.parent !== target) target.addChild(session.layer);
  if (target.children?.at(-1) !== session.layer) target.addChild(session.layer);
  const ppm = positive(ctx.state?.physics?.ppm ?? ctx.state?.ppm, 12);
  const factor =
    ctx.kind === "modern" ? ppm * positive(ctx.renderer?.scaleRatio, 1) : ppm;
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
      defaultSprite: view.sprite,
    };
    drawDefault(entity, definition, view, context);
    context.defaultGraphic = view.graphic;
    context.defaultSprite = view.sprite;
    definition.render?.(entity, view.container, context);
  }
}
