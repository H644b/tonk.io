import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createNativeHarness } from "./native-harness.mjs";

const source = fs.readFileSync("vendor/bonk/alpha2s.js", "utf8");
const harness = createNativeHarness(source);
// Use native decode/construct/step, freeze countdown so no integration moves a
// sample across the boundary before the actual native death predicate runs.
const results = [];
for (const ppm of [12, 15, 30])
  for (const pixels of [499.999, 500, 500.001]) {
    harness.context.sample = { ppm, pixels };
    const result = harness.run(`
    map=__native.mapEncoder.getBlankMap();map.physics.ppm=sample.ppm;
    map.spawns=[__native.mapEncoder.getNewSpawn(),__native.mapEncoder.getNewSpawn()];
    gs=new __native.settings();gs.map=map;
    state=__native.simulation.createNewState([{id:0,team:1},{id:1,team:1}],map,123,false,null,gs);state.rc=0;
    state.discs[0].x=365/sample.ppm;state.discs[0].y=sample.pixels/sample.ppm;
    state.discs[1].x=100/sample.ppm;state.discs[1].y=100/sample.ppm;
    state.ftu=90;
    next=new __native.simulation().step(state,[{},{}],null,30,gs,1,false,false);
    ({ppm:sample.ppm,worldY:sample.pixels/sample.ppm,pixelY:sample.pixels,alive:!!next.discs[0],deathReason:next.discDeaths.find(d=>d.i===0)?.m??null});
  `);
    assert.equal(result.alive, pixels <= 500);
    if (pixels > 500) assert.equal(result.deathReason, 4);
    results.push(result);
  }
const projections = [
  [1443, 1236],
  [2560, 1440],
  [390, 844],
  [1920, 1080],
  [730, 500],
].map(([width, height]) => {
  const scale = Math.min(width / 730, height / 500);
  const centeredPadY = (height - 500 * scale) / 2;
  const anchoredPadY = height - 500 * scale;
  const result = {
    width,
    height,
    scale,
    centeredKillY: 500 * scale + centeredPadY,
    bottomAnchoredKillY: 500 * scale + anchoredPadY,
    bottomPaddingBefore: height - (500 * scale + centeredPadY),
    anchoredPadY,
  };
  assert.ok(Math.abs(result.bottomAnchoredKillY - height) < 1e-10);
  return result;
});
fs.writeFileSync(
  "evidence/verification/native-viewport-boundary.json",
  JSON.stringify(
    {
      sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
      nativePredicate:
        "disc.body.GetPosition().y > 500 / state.physics.ppm; separate distance limit >850/ppm from (365/ppm,250/ppm) when step argument 6 is false",
      sourceAnchor: "z.prototype.step: z0M[158] || z0M[577] => diedThisStep=4",
      nativeProjection:
        "Modern renderer pixels = worldMeters * physics.ppm * renderer.scaleRatio; legacy stage.scale supplies renderer ratio",
      fix: "padY = viewportHeight - 500 * nativeUniformScale; padX remains centered; native world, forces, kill predicates and physics state unchanged",
      samples: results,
      projections,
      verified:
        "The actual unmodified native simulation keeps centers at/below500 canonicalpixels and kills centers beyond500 for ppm12,15,30; bottom-anchor projection maps500 to exact viewportbottom across tested viewport dimensions",
    },
    null,
    2,
  ),
);
console.log(
  `Verified ${results.length} actual native boundary samples and ${projections.length} viewport projections.`,
);
