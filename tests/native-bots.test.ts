import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNativeHarness} from '../scripts/native-harness.mjs';
import {botDecision} from '../shared/bot-ai.ts';
import {NativeBots} from '../client/bots/runtime.ts';
const catalog=JSON.parse(fs.readFileSync('evidence/protocol/native-catalog.json','utf8'));
const source=fs.readFileSync('public/game/js/alpha2s.local.js','utf8');
test('bots move and score in all seven native modes against an idle opponent',()=>{
 const harness=createNativeHarness(source);harness.context.decision=botDecision;harness.context.mapData=catalog.find((m:any)=>m.name==='Classic').leveldata;
 for(const mode of ['b','v','sp','ar','ard','bs','f']){
  harness.context.mode=mode;
  const result=harness.run(`(()=>{const gs=new __native.settings();gs.mo=mode;gs.ga=mode==='f'?'f':'b';gs.tea=mode==='f';gs.map=__native.mapEncoder.decodeFromDatabase(mapData);const E=mode==='f'?__native.football:__native.simulation;let state=E.createNewState([{id:0,team:gs.tea?2:1},{id:1,team:gs.tea?3:1}],gs.map,123,false,null,gs);state.rc=0;const engine=new E();let moves=0,wins=0;for(let f=0;f<2400;f++){const before=state;state=engine.step(state,[{},decision(state,gs,1,'expert',f)],null,30,gs,1,false,false);if(state.discs[1]&&before.discs[1]&&Math.hypot(state.discs[1].x-before.discs[1].x,state.discs[1].y-before.discs[1].y)>.001)moves++;if(before.fte===-1&&state.fte>=0&&state.lscr===(gs.tea?3:1))wins++;}return {moves,wins}})()`);
  assert.ok(result.moves>100,mode+' bot moves in native physics');assert.ok(result.wins>0,mode+' bot scores a round');
 }
});
test('bot admin controls survive native rollback snapshots and reproduce peer simulation',()=>{
 const run=()=>{
  const observer=new NativeBots(),harness=createNativeHarness(source,{nativeEvent:(type:string,ctx:any)=>observer.observe(type,ctx)});
  harness.context.mapData=catalog.find((m:any)=>m.name==='Classic').leveldata;harness.context.decision=botDecision;
  return harness.run(`(()=>{const gs=new __native.settings();gs.map=__native.mapEncoder.decodeFromDatabase(mapData);let state=__native.simulation.createNewState([{id:0,team:1},{id:1,team:1}],gs.map,123,false,null,gs);state.rc=0;const engine=new __native.simulation(),record=[];for(let f=0;f<180;f++){const update=f%8===0?{playersLeft:[],playersJoined:[],tonkBots:{1:decision(state,gs,1,'hard',f)}}:null;state=engine.step(state,[{},{}],update,30,gs,1,false,false);if(f===90)state=__native.constructors[86].pson.decode(__native.constructors[86].pson.encode(state));record.push(JSON.stringify(state));}return {record,controls:state.__tonkBots?.controls,discs:state.discs}})()`);
 };
 const host=run(),peer=run();assert.ok(host.controls?.[1]);assert.equal(JSON.stringify(host.record),JSON.stringify(peer.record));assert.ok(host.discs.length>0);
});
