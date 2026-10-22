import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { ServiceStore } from '../server/store.js';
import { setupCompatibility } from '../server/compatibility.js';
import { createNativeHarness } from '../scripts/native-harness.mjs';

test('an actual native replay survives HTTP storage and plays the same native round after retrieval', async t => {
  const original = fs.readFileSync('vendor/bonk/alpha2s.js', 'utf8');
  const fixture = JSON.parse(fs.readFileSync('evidence/verification/native-replay-fixture.json', 'utf8'));
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), fixture.sourceSha256);
  const store = new ServiceStore(':memory:'), app = express();
  setupCompatibility(app, { store });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); });
  const post = async (endpoint: string, data: any) => (await fetch(`${base}/compat/${endpoint}.php`, { method: 'POST', body: new URLSearchParams(data) })).json();
  const submission = await post('replay_submit', { replaydata: fixture.replaydata, version: fixture.version, mode: fixture.mode });
  assert.equal(submission.r, 'success');
  const response = await post('replay_get', { version: fixture.version, mode: fixture.mode });
  assert.equal(response.replays.length, 1);
  assert.equal(response.replays[0].id, submission.id);
  assert.equal(response.replays[0].replaydata, fixture.replaydata);
  const native = createNativeHarness(original);
  native.context.encoded = response.replays[0].replaydata;
  const result = native.run(`
    replay=new __native.constructors[86]();replay.fromDatabase(encoded);
    engine=new __native.simulation();state=replay.startingState;inputs=[{},{}];rounds=0;movedFrames=0;
    for(let frame=0;frame<replay.es;frame++){
      for(let id=0;id<inputs.length;id++)if(replay.inputs[id][frame])inputs[id]=replay.inputs[id][frame];
      previous=state;state=engine.step(state,inputs,replay.adminInputs[frame],30,replay.gameSettings,1,false,false);
      if(state.discs.some((disc,id)=>disc&&previous.discs[id]&&disc.x!==previous.discs[id].x))movedFrames++;
      if(previous.fte===-1&&state.fte>=0)rounds++;
    }
    ({frames:replay.es,rounds,movedFrames,scores:state.scores,customProperty:replay.startingState.__bonkMods.entities[0].properties.mana,customCommand:replay.adminInputs[120].wbCommands[0].id});
  `);
  assert.equal(result.frames, fixture.frames);
  assert.equal(result.rounds, fixture.roundEnds);
  assert.ok(result.movedFrames > 0);
  assert.deepEqual(structuredClone(result.scores), [1, 0]);
  assert.equal(result.customProperty, 8);
  assert.equal(result.customCommand, 'example:spawn');
  fs.writeFileSync('evidence/verification/native-replay-service.json', JSON.stringify({
    sourceSha256: fixture.sourceSha256,
    replaySha256: crypto.createHash('sha256').update(fixture.replaydata).digest('hex'),
    submittedAndRetrievedThroughRealHTTP: true,
    bytesPreserved: true,
    decodedBy: 'Pinned shipped Replay.fromDatabase()',
    replayedBy: 'Pinned shipped simulation.step()',
    passed: true,
    ...structuredClone(result),
    limitations: ['Browser replay navigation and visual rendering require separate UI checks', 'Native admin custom command bytes survive; this test does not execute a mod command handler'],
  }, null, 2) + '\n');
});
