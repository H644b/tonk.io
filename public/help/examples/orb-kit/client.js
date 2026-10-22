export async function setup(api) {
  const texture = await api.assets.texture("orb");
  api.components.register("orb-kit:lifetime", {
    update(entity, state, { world }) {
      state.remaining -= 1;
      if (state.remaining <= 0) world.remove(entity.id);
    },
  });
  api.properties.register("orb-kit:spawn-count", {
    default: 0,
    validate(value) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Spawn count must be a nonnegative safe integer.");
    },
  });
  api.entities.register("orb-kit:orb", {
    body: { shape: "circle", radius: 0.7, density: 1, restitution: 0.8 },
    texture,
    width: 1.4,
    height: 1.4,
  });
  function spawn(world, x = 25, y = 6) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error("Orb coordinates must be finite.");
    world.spawn("orb-kit:orb", {
      x,
      y,
      components: { "orb-kit:lifetime": { remaining: 600 } },
    });
    const count = api.properties.read("world", "orb-kit:spawn-count");
    api.properties.write("world", "orb-kit:spawn-count", count + 1);
  }
  api.on("createState", ({ world }) => spawn(world));
  api.commands.register("spawn", (data, { world }) =>
    spawn(world, data.x, data.y),
  );
  api.input.on("KeyO", (event) => {
    if (event.repeat) return;
    if (!api.game)
      return api.ui.notify("Start a match before spawning an orb.");
    api.commands
      .send("spawn", { x: 25, y: 6 })
      .catch((error) => api.ui.notify(error.message));
  });
  api.on("packReady", () =>
    api.ui.notify(
      "Orb Kit loaded. During a match, the host can press O to spawn an orb.",
    ),
  );
}
