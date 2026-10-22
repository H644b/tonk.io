import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createNativeHarness } from "../scripts/native-harness.mjs";

const original = fs.readFileSync("vendor/bonk/alpha2s.js", "utf8");
const prepared = fs.readFileSync("public/game/js/alpha2s.local.js", "utf8");
const maps = JSON.parse(
  fs.readFileSync("evidence/protocol/native-catalog.json", "utf8"),
);
const map = maps.find((entry: any) => entry.name === "Classic");
const sha = (source: string) =>
  crypto.createHash("sha256").update(source).digest("hex");

function settlementFunction(source: string): string {
  const ast = ts.createSourceFile(
    "native.js",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "G_R")
      functions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(functions.length, 1);
  return functions[0].getText(ast);
}

test("actual native settlement confirms host outcomes before the original winner XP request", () => {
  const routes: any[] = [];
  for (const teams of [false, true]) {
    const harness = createNativeHarness(original);
    harness.context.sample = {
      leveldata: map.leveldata,
      mapid: Number(map.id),
      teams,
    };
    // All history states below are produced by the actual shipped simulation.
    const fixture = harness.run(`
      gs=new __native.settings();gs.tea=sample.teams;gs.map=__native.mapEncoder.decodeFromDatabase(sample.leveldata);gs.map.m.dbid=sample.mapid;gs.map.m.dbv=2;
      state=__native.simulation.createNewState([{id:0,team:sample.teams?2:1},{id:1,team:sample.teams?3:1}],gs.map,123,false,null,gs);state.rc=0;
      history=[state];engine=new __native.simulation();confirmedIndex=-1;
      for(let f=0;f<360;f++){
        const block=Math.floor(f/20)*20;
        const input=[{left:0,right:1,up:block%40===0?1:0,down:0,action:block%60===0?1:0,action2:0},{left:1,right:0,up:0,down:0,action:0,action2:0}];
        state=engine.step(state,input,null,30,gs,1,false,false);history.push(state);
        if(confirmedIndex<0&&state.fte===89&&state.lscr>=0)confirmedIndex=history.length-1;
        if(confirmedIndex>=0&&history.length>confirmedIndex+31)break;
      }
      ({confirmedIndex,winner:history[confirmedIndex]?.lscr,round:history[confirmedIndex]?.rc,frame:confirmedIndex,historyLength:history.length});
    `);
    assert.ok(
      fixture.confirmedIndex >= 0,
      "Native control simulation produced a winning round",
    );
    const winnerSid = teams ? (fixture.winner === 2 ? 0 : 1) : fixture.winner;
    for (const input of [
      {
        label: "registered winning host",
        localSid: winnerSid,
        hostSid: winnerSid,
        guest: false,
        ga: "b",
        historicalOffset: 0,
        receipt: true,
        xp: true,
      },
      {
        label: "registered losing host",
        localSid: 1 - winnerSid,
        hostSid: 1 - winnerSid,
        guest: false,
        ga: "b",
        historicalOffset: 0,
        receipt: true,
        xp: false,
      },
      {
        label: "guest losing host",
        localSid: 1 - winnerSid,
        hostSid: 1 - winnerSid,
        guest: true,
        ga: "b",
        historicalOffset: 0,
        receipt: true,
        xp: false,
      },
      {
        label: "registered winning non-host",
        localSid: winnerSid,
        hostSid: 1 - winnerSid,
        guest: false,
        ga: "b",
        historicalOffset: 0,
        receipt: false,
        xp: true,
      },
      {
        label: "guest winning host",
        localSid: winnerSid,
        hostSid: winnerSid,
        guest: true,
        ga: "b",
        historicalOffset: 0,
        receipt: true,
        xp: false,
      },
      {
        label: "football XP gate",
        localSid: winnerSid,
        hostSid: winnerSid,
        guest: false,
        ga: "f",
        historicalOffset: 0,
        receipt: false,
        xp: false,
      },
      {
        label: "unsettled prior frame",
        localSid: winnerSid,
        hostSid: winnerSid,
        guest: false,
        ga: "b",
        historicalOffset: -1,
        receipt: false,
        xp: false,
      },
    ]) {
      harness.context.route = {
        ...input,
        confirmedIndex: fixture.confirmedIndex,
      };
      const outputs: any[] = [];
      for (const source of [original, prepared]) {
        const result = harness.run(`(() => {
          const events=[];const k7V=B3jF8,t$e=__native.constructors,z=__native.simulation,Date={now:()=>1000000};
          t$e[61]={guest:route.guest,resetRenderer:false};
          const a5H=[];a5H[34]=Infinity;a5H[74]=[];a5H[4]=history;a5H[6]=route.confirmedIndex+30+route.historicalOffset-1;a5H[72]=34;a5H[76]=Date.now();a5H[60]={...gs,ga:route.ga};a5H[60].q=false;
          a5H[96]={hostID:route.hostSid,getLSID:()=>route.localSid,sendReqXP:()=>events.push({event:'sendReqXP'})};
          a5H[2]=[{team:${teams ? 2 : 1}},{team:${teams ? 3 : 1}}];a5H[28]={update(){}};a5H[59]={a:1};a5H[22]=1;a5H[73]=false;
          const document={hidden:true};
          const v6V=()=>a5H[6]++;
          window.manifold.confirmedRound=receipt=>events.push({event:'confirmedRound',receipt});
          ${settlementFunction(source)}
          G_R();return {events,localSid:route.localSid,hostSid:route.hostSid,guest:route.guest,ga:route.ga};
        })()`);
        outputs.push(structuredClone(result));
      }
      assert.equal(
        outputs[0].events.some((event: any) => event.event === "sendReqXP"),
        input.xp,
        `Original native XP path: ${input.label}`,
      );
      assert.equal(
        outputs[1].events.some((event: any) => event.event === "sendReqXP"),
        input.xp,
        `Prepared native XP path: ${input.label}`,
      );
      const receipt = outputs[1].events.find(
        (event: any) => event.event === "confirmedRound",
      )?.receipt;
      assert.equal(
        !!receipt,
        input.receipt,
        `Prepared host receipt: ${input.label}`,
      );
      if (receipt) {
        assert.equal(receipt.round, fixture.round);
        assert.equal(receipt.winner, fixture.winner);
        assert.equal(receipt.teams, teams);
        assert.equal(receipt.frame, fixture.frame);
        assert.equal(receipt.mapid, Number(map.id));
      }
      if (input.receipt && input.xp)
        assert.deepEqual(
          outputs[1].events.map((event: any) => event.event),
          ["confirmedRound", "sendReqXP"],
          "Receipt is sent before the unchanged original winner request",
        );
      routes.push({
        label: input.label,
        teams,
        original: outputs[0],
        prepared: outputs[1],
      });
    }
  }
  fs.writeFileSync(
    "evidence/verification/native-xp-settlement-path.json",
    JSON.stringify(
      {
        sourceSha256: sha(original),
        preparedClientSha256: sha(prepared),
        method:
          "Execute the exact original and actual prepared G_R settlement function source against state history generated by actual native Classic simulation. Only frame advancement, network sends, rendering and UI effects are substituted; native winner history and request predicates execute unchanged.",
        pass: true,
        routes,
        limitations: [
          "This verifies client request and confirmed host receipt paths, not a server-authoritative physics proof",
          "Persistent award, guest exclusion and deduplication are separately exercised by service-parity tests",
          "Browser network delivery and XP display require separate UI checks",
        ],
      },
      null,
      2,
    ),
  );
});
