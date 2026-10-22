import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { applyNativeHooks } from "../scripts/native-hooks.mjs";
import { createNativeHarness } from "../scripts/native-harness.mjs";

const original = fs.readFileSync("vendor/bonk/alpha2s.js", "utf8");
const catalog = JSON.parse(
  fs.readFileSync("evidence/protocol/native-catalog.json", "utf8"),
);
const sha = (input: crypto.BinaryLike) =>
  crypto.createHash("sha256").update(input).digest("hex");
// v8.serialize is intentionally not canonical for equal values. This encoder
// records every own enumerable key, sparse-array slot and IEEE754 double.
function exactState(input: unknown): string {
  const references = new Map<object, number>();
  function encode(value: any): any {
    if (value === undefined) return ["undefined"];
    if (typeof value === "number") {
      if (Number.isNaN(value)) return ["number", "NaN"];
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value);
      return ["number", bytes.toString("hex")];
    }
    if (value === null || typeof value !== "object")
      return [typeof value, value];
    if (references.has(value)) return ["ref", references.get(value)];
    references.set(value, references.size);
    return [
      Array.isArray(value) ? "array" : "object",
      Array.isArray(value) ? value.length : null,
      Object.keys(value).map((key) => [key, encode(value[key])]),
    ];
  }
  return JSON.stringify(encode(input));
}

test(
  "actual prepared independent client preserves complete native simulation state across seven modes",
  { timeout: 120_000 },
  () => {
    const prepared = fs.readFileSync("public/game/js/alpha2s.local.js", "utf8");
    assert.ok(
      prepared.includes('window.BonkMods.nativeEvent("beforePhysics"'),
      "The actual prepared build includes the tested native extension hooks",
    );
    const hookCounts: Record<string, number> = {};
    const baseline = createNativeHarness(original);
    const extended = createNativeHarness(prepared, {
      nativeEvent(type: string) {
        hookCounts[type] = (hookCounts[type] || 0) + 1;
      },
    });
    const results: object[] = [];
    const frames = 420;
    const scenarioProgram = `
    gs=new __native.settings();gs.mo=scenario.mode;gs.ga=scenario.mode==='f'?'f':'b';gs.tea=scenario.teams||scenario.mode==='f';
    gs.map=__native.mapEncoder.decodeFromDatabase(scenario.map.leveldata);
    E=scenario.mode==='f'?__native.football:__native.simulation;
    players=[{id:0,team:gs.tea?2:1},{id:1,team:gs.tea?3:1},{id:2,team:gs.tea?2:1}];
    state=E.createNewState(players,gs.map,scenario.seed,false,null,gs);state.rc=0;engine=new E();
    record(state);movements=0;rounds=0;arrows=0;grapples=0;
    for(let frame=0;frame<${frames};frame++){
      const inputs=players.map((p,i)=>({left:(frame+i*13)%120>=60,right:(frame+i*13)%120<60,up:(frame+i*17)%90<30,down:(frame+i*7)%130>110,action:(frame+i*19)%80<35,action2:(frame+i*23)%100<55}));
      const previous=state;
      state=engine.step(state,inputs,null,30,gs,1,false,false);
      if(state.discs.some((d,i)=>d&&previous.discs[i]&&(d.x!==previous.discs[i].x||d.y!==previous.discs[i].y)))movements++;
      if(previous.fte===-1&&state.fte>=0)rounds++;
      if(state.projectiles&&state.projectiles.length)arrows++;
      if(state.discs.some(d=>d&&d.swing))grapples++;
      record(state);
    }
    ({movements,rounds,arrows,grapples,finalRound:state.rc,physicsBodies:gs.map.physics.bodies.length,physicsJoints:gs.map.physics.joints.length});
  `;
    for (const mode of ["b", "v", "sp", "ar", "ard", "bs", "f"]) {
      const names =
        mode === "sp"
          ? ["Classic", "Shuffling Platforms", "Simple 1v1 CZ"]
          : mode === "ar" || mode === "ard"
            ? ["Classic", "Just Fight", "Commando"]
            : ["Classic", "Bad Platform", "Simplex"];
      // Football has its own shipped pitch rather than using the selected map.
      for (const mapName of mode === "f" ? ["Classic"] : names) {
        const map = catalog.find(
          (item: { name: string }) => item.name === mapName,
        );
        assert.ok(map, `Bundled native map ${mapName} exists`);
        for (const seed of [123, 981])
          for (const teams of mode === "f" ? [true] : [false, true]) {
            const scenario = { mode, map, seed, teams };
            const hashes: string[][] = [[], []];
            const snapshots: string[][] = [[], []];
            const stats = [baseline, extended].map((harness, index) => {
              harness.context.scenario = scenario;
              harness.context.record = (state: object) => {
                const snapshot = exactState(state);
                snapshots[index].push(snapshot);
                hashes[index].push(sha(snapshot));
              };
              return harness.run(scenarioProgram, 15_000);
            });
            const mismatch = hashes[0].findIndex(
              (hash, index) => hash !== hashes[1][index],
            );
            if (mismatch !== -1) {
              const offset = [...snapshots[0][mismatch]].findIndex(
                (character, index) =>
                  character !== snapshots[1][mismatch][index],
              );
              assert.fail(
                `Native state mismatch ${mode}/${mapName}/seed${seed}/teams${teams}/frame${mismatch}: ${snapshots[0][mismatch].slice(offset - 130, offset + 220)} versus ${snapshots[1][mismatch].slice(offset - 130, offset + 220)}`,
              );
            }
            assert.deepEqual(
              structuredClone(stats[1]),
              structuredClone(stats[0]),
            );
            assert.ok(
              stats[0].movements > 50,
              "Real native bodies moved over multiple physics frames",
            );
            results.push({
              mode,
              map: mapName,
              sourceMapId: map.id,
              seed,
              teams,
              frames: frames + 1,
              exactStateHash: sha(hashes[0].join("")),
              ...structuredClone(stats[0]),
            });
          }
      }
    }
    assert.ok(
      hookCounts.beforePhysics > 0 &&
        hookCounts.afterPhysics === hookCounts.beforePhysics,
    );
    assert.equal(hookCounts.beforeStep, hookCounts.afterStep);
    const evidence = {
      sourceSha256: sha(original),
      preparedClientSha256: sha(prepared),
      physicsSha256: sha(
        fs.readFileSync("public/game/js/physics/box2dweb/Box2DModuleGJMod.js"),
      ),
      comparison:
        "Original shipped native simulation versus actual public/game/js/alpha2s.local.js prepared independent build, including compatibility, viewport, match completion, native session and mod hooks. Actual native Box2D, map decoder, settings and state constructors execute in separate Node VM contexts; bridge functions are inert, and no mods are enabled.",
      equality:
        "SHA256 of canonical full state encoding including own enumerable property order, sparse arrays, references, undefined fields and hexadecimal IEEE754 finite doubles; signed zero preserved, NaN payload/sign normalized to JS NaN. No positional tolerance.",
      scenarios: results.length,
      comparedStateFrames: results.length * (frames + 1),
      passed: true,
      hookCounts,
      results,
      limitations: [
        "Pinned shipped version only",
        "This is simulation parity; browser rendering, network latency, UI flows and the original private backend require separate checks",
        "Not an exhaustive proof over all maps, seeds and input sequences",
      ],
    };
    fs.writeFileSync(
      "evidence/verification/native-differential-parity.json",
      JSON.stringify(evidence, null, 2),
    );
  },
);

test("native generic state sync preserves new mod properties and entity state", () => {
  const harness = createNativeHarness(original);
  const output = harness.run(`
    state={discs:[],__bonkMods:{entities:[{id:'example:orb',x:1.25,y:2.5,properties:{health:20,inventory:['example:gem']}}],custom:{mana:12}}};
    decoded=__native.constructors[86].pson.decode(__native.constructors[86].pson.encode(state));
    JSON.stringify(decoded);
  `);
  assert.deepEqual(JSON.parse(output), {
    discs: [],
    __bonkMods: {
      entities: [
        {
          id: "example:orb",
          x: 1.25,
          y: 2.5,
          properties: { health: 20, inventory: ["example:gem"] },
        },
      ],
      custom: { mana: 12 },
    },
  });
});

test("a shipped-format replay decodes and replays native physics, inputs and custom admin fields", () => {
  const harness = createNativeHarness(original);
  harness.context.mapData = catalog.find(
    (item: { name: string }) => item.name === "Classic",
  ).leveldata;
  const result = harness.run(`
    gs=new __native.settings();gs.map=__native.mapEncoder.decodeFromDatabase(mapData);
    initial=__native.simulation.createNewState([{id:0,team:1},{id:1,team:1}],gs.map,123,false,null,gs);initial.rc=0;
    initial.__bonkMods={frame:0,entities:[{id:'example:orb',properties:{mana:8}}]};
    replay=new __native.constructors[86]();replay.startingState=initial;replay.playerArray=[{userName:'Replay One',avatar:{bc:16711680,layers:[]}},{userName:'Replay Two',avatar:{bc:255,layers:[]}}];
    replay.inputs=[[],[]];for(let f=0;f<420;f+=20){replay.inputs[0][f]={left:0,right:1,up:f%40===0?1:0,down:0,action:f%60===0?1:0,action2:0};replay.inputs[1][f]={left:1,right:0,up:0,down:0,action:0,action2:0};}
    replay.adminInputs=[];replay.adminInputs[120]={playersLeft:[],playersJoined:[],wbCommands:[{id:'example:spawn',payload:{kind:'example:orb',x:2,y:3}}]};
    replay.gameSettings=JSON.parse(JSON.stringify(gs));replay.gameSettings.map=null;replay.mn='Classic';replay.ma='Crabiki';replay.rxn='';replay.rxa='';replay.es=420;replay.mid=-1;
    encoded=replay.toDatabase();decoded=new __native.constructors[86]();decoded.fromDatabase(encoded);
    engine=new __native.simulation();state=decoded.startingState;startX=state.discs[0].x;rounds=0;inputs=[{},{}];frames=0;movedFrames=0;
    for(let f=0;f<420;f++){for(let i=0;i<2;i++)if(decoded.inputs[i][f])inputs[i]=decoded.inputs[i][f];previous=state;state=engine.step(state,inputs,decoded.adminInputs[f],30,decoded.gameSettings,1,false,false);frames++;if(state.discs.some((d,i)=>d&&previous.discs[i]&&d.x!==previous.discs[i].x))movedFrames++;if(previous.fte===-1&&state.fte>=0)rounds++;if(state.fte===1)break;}
    // Native shared replays contain one round and stop before the next round's
    // map reset. Their gameSettings intentionally omit the database map blob.
    decoded.es=frames;encoded=decoded.toDatabase();
    ({encoded,startingState:decoded.startingState,customAdmin:decoded.adminInputs[120].wbCommands,frames,rounds,moved:movedFrames>0,finalScores:state.scores});
  `);
  assert.ok(result.frames > 90 && result.frames <= 420);
  assert.ok(
    result.moved && result.rounds > 0,
    "Real native replay playback moved players and completed a round",
  );
  assert.equal(result.startingState.__bonkMods.entities[0].properties.mana, 8);
  assert.equal(result.customAdmin[0].id, "example:spawn");
  fs.writeFileSync(
    "evidence/verification/native-replay-fixture.json",
    JSON.stringify(
      {
        replaydata: result.encoded,
        version: 49,
        mode: "b",
        map: "Classic",
        author: "Crabiki",
        frames: result.frames,
        roundEnds: result.rounds,
        producedBy: "Actual shipped native replay.toDatabase()",
        verifiedBy:
          "Actual native replay.fromDatabase(), native simulation.step() through the recorded round; custom state and admin command decode preserved",
        sourceSha256: sha(original),
      },
      null,
      2,
    ),
  );
});

test("a new mod entity participates in the actual native Box2D world and contacts", () => {
  let harness: ReturnType<typeof createNativeHarness>;
  let entityBody: any;
  let contacts = 0;
  let captured: any;
  const contactDelegates = new WeakMap<object, any>();
  harness = createNativeHarness(applyNativeHooks(original).source, {
    nativeEvent(type: string, context: any) {
      if (type === "beforePhysics" && context.kind === "modern") {
        const B = harness.native.Box2D;
        const definition = new B.Dynamics.b2BodyDef();
        definition.type = B.Dynamics.b2Body.b2_dynamicBody;
        definition.position.Set(
          context.discs[0].body.GetPosition().x + 1.2,
          context.discs[0].body.GetPosition().y,
        );
        definition.userData = { type: "mod", entityID: "test:orb" };
        entityBody = context.world.CreateBody(definition);
        const fixture = new B.Dynamics.b2FixtureDef();
        fixture.shape = new B.Collision.Shapes.b2CircleShape(1);
        fixture.density = 1;
        fixture.friction = 0.2;
        fixture.restitution = 0.3;
        fixture.userData = { type: "mod", entityID: "test:orb" };
        entityBody.CreateFixture(fixture);
        let listener = contactDelegates.get(context.engine.contactListener);
        if (!listener) {
          const native = context.engine.contactListener;
          listener = {
            ...native,
            BeginContact(contact: any) {
              contacts++;
              native.BeginContact.call(native, contact);
            },
          };
          contactDelegates.set(native, listener);
        }
        context.world.SetContactListener(listener);
      }
      if (type === "afterPhysics" && entityBody)
        captured = {
          x: entityBody.GetPosition().x,
          y: entityBody.GetPosition().y,
          xv: entityBody.GetLinearVelocity().x,
          yv: entityBody.GetLinearVelocity().y,
        };
    },
  });
  const control = createNativeHarness(original);
  for (const run of [harness, control]) {
    run.context.mapData = catalog.find(
      (item: { name: string }) => item.name === "Classic",
    ).leveldata;
    run.run(
      `gs=new __native.settings();gs.map=__native.mapEncoder.decodeFromDatabase(mapData);state=__native.simulation.createNewState([{id:0,team:1},{id:1,team:1}],gs.map,123,false,null,gs);state.rc=0;state.ftu=-1;engine=new __native.simulation();state=engine.step(state,[{},{ }],null,30,gs,1,false,false);`,
    );
  }
  assert.ok(
    contacts > 0,
    "Box2D delivered a native contact callback for the new body",
  );
  assert.ok(
    captured && Object.values(captured).every(Number.isFinite),
    "New body position and velocity captured before native cleanup",
  );
  assert.notEqual(
    harness.run("state.discs[0].x"),
    control.run("state.discs[0].x"),
    "New entity physically displaced the native player",
  );
});

test("native hook transformation fails closed when pinned physics anchors change", () => {
  assert.throws(
    () =>
      applyNativeHooks(
        original.replace("z0M[16][z0M[2][327]]", "z0M[16][z0M[2][99999]]"),
      ),
    /modern:beforePhysics/,
  );
});
