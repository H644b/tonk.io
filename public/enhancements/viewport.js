/* Full viewport projection for the pinned client. Physics and native uniform scales are unchanged. */
(() => {
  const states = new WeakMap(),
    stages = new WeakMap(),
    live = new Set();
  const number = (value) => Math.round(value * 1000) / 1000;
  function capture(renderer, stage, container, kind, scale) {
    if (
      !renderer ||
      !stage ||
      !container ||
      !Number.isFinite(scale) ||
      scale <= 0
    )
      return null;
    const width = container.clientWidth,
      height = container.clientHeight;
    if (width < 1 || height < 1) return null;
    const state = {
      renderer,
      stage,
      container,
      kind,
      width,
      height,
      scale,
      padX: (width - 730 * scale) / 2,
      // The native kill plane is worldY = 500 / ppm. Anchor that canonical
      // bottom edge to the visible bottom; showing space beneath it is misleading.
      padY: height - 500 * scale,
    };
    states.set(renderer, state);
    stages.set(stage, state);
    live.add(renderer);
    if (!renderer.__bonkViewportRender) {
      const render = renderer.render;
      const destroy = renderer.destroy;
      renderer.render = function (displayObject, ...args) {
        const current = stages.get(displayObject);
        if (!current) return render.call(this, displayObject, ...args);
        // Apply the extra camera translation only during projection. The original
        // renderer can continue setting its own shake/camera offsets every frame.
        const x = displayObject.x,
          y = displayObject.y;
        displayObject.x = x + current.padX;
        displayObject.y = y + current.padY;
        try {
          return render.call(this, displayObject, ...args);
        } finally {
          displayObject.x = x;
          displayObject.y = y;
        }
      };
      if (typeof destroy === "function")
        renderer.destroy = function (...args) {
          const current = states.get(this);
          if (current?.stage.__bonkViewportTexture) {
            current.stage.__bonkViewportTexture.destroy(true);
            delete current.stage.__bonkViewportTexture;
          }
          live.delete(this);
          states.delete(this);
          return destroy.apply(this, args);
        };
      renderer.__bonkViewportRender = true;
    }
    renderer.resize(width, height);
    renderer.view.dataset.viewportKind = kind;
    renderer.view.dataset.viewportScale = String(number(scale));
    renderer.view.dataset.viewportExpanded = "true";
    return state;
  }
  function gradient(state, background, fader, units) {
    if (!background) return;
    const sx = state.padX / units,
      sy = state.padY / units,
      w = state.width / units,
      h = state.height / units;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w + 50);
    canvas.height = Math.ceil(h + 50);
    const context = canvas.getContext("2d");
    const textureScale = state.kind === "modern" ? state.scale : 1;
    // Preserve the native gradient center and radius relative to the world.
    const margin = 25 * textureScale;
    if (state.kind === "modern") {
      canvas.width = Math.ceil(w + 50 * textureScale);
      canvas.height = Math.ceil(h + 50 * textureScale);
    }
    const fill = context.createRadialGradient(
      sx,
      sy,
      10 * textureScale,
      sx,
      sy,
      540 * textureScale,
    );
    fill.addColorStop(0, "#3b536b");
    fill.addColorStop(1, "#2c3e50");
    context.fillStyle = fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = PIXI.Texture.from(canvas);
    const previous = state.stage.__bonkViewportTexture;
    state.stage.__bonkViewportTexture = texture;
    for (const graphic of [background, fader])
      if (graphic) {
        graphic.clear();
        graphic.beginTextureFill({ texture });
        graphic.drawRect(0, 0, canvas.width, canvas.height);
        graphic.endFill();
        graphic.position.set(-sx - margin, -sy - margin);
      }
    if (previous) previous.destroy(true);
  }
  window.bonkViewport = {
    enabled: true,
    modern(instance) {
      if (!this.enabled) return;
      const state = capture(
        instance.renderer,
        instance.stage,
        instance.domContainer,
        "modern",
        instance.scaleRatio,
      );
      if (state)
        gradient(state, instance.bgGradient, instance.foregroundFader, 1);
    },
    legacy(options) {
      // Editor pointer coordinates and map thumbnails intentionally retain their native projection.
      if (!this.enabled || options.thumbnail || options.editor) return;
      const state = capture(
        options.renderer,
        options.stage,
        options.container,
        "legacy",
        options.stage.scale.x,
      );
      if (state)
        gradient(state, options.background, options.fader, state.scale);
    },
    football(options) {
      if (!this.enabled) return;
      const state = capture(
        options.renderer,
        options.stage,
        options.container,
        "football",
        options.stage.scale.x,
      );
      if (state && options.background) {
        options.background.clear();
        options.background.beginFill(0x5a7f64);
        options.background.drawRect(
          -state.padX / state.scale,
          -state.padY / state.scale,
          state.width / state.scale,
          state.height / state.scale,
        );
        options.background.endFill();
      }
    },
    snapshot() {
      return [...live]
        .filter((renderer) => renderer.view?.isConnected)
        .map((renderer) => {
          const state = states.get(renderer),
            rect = renderer.view.getBoundingClientRect();
          return {
            kind: state.kind,
            container: [state.width, state.height],
            canvas: [renderer.screen.width, renderer.screen.height],
            css: [number(rect.width), number(rect.height)],
            scaleX: number(state.stage.scale.x),
            scaleY: number(state.stage.scale.y),
            nativeScale: number(state.scale),
            cameraPadding: [number(state.padX), number(state.padY)],
            physicsChanged: false,
            projection: "uniform expansion",
          };
        });
    },
  };
})();
