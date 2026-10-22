import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { applyNativeSessionHooks } from '../scripts/native-session-hooks.mjs';
import { applyNativeHooks } from '../scripts/native-hooks.mjs';
import { createNativeHarness } from '../scripts/native-harness.mjs';

const original = fs.readFileSync('vendor/bonk/alpha2s.js', 'utf8');
const result = applyNativeSessionHooks(original);
const findHook = (name: string) => result.evidence.hooks.find(hook => hook.name === name)!;

test('native session helpers only insert at exact pinned anchors and compose with engine mod hooks', () => {
  let restored = result.source;
  for (const hook of result.evidence.hooks) {
    assert.equal(restored.split(hook.code).length, 2);
    restored = restored.replace(hook.code, '');
  }
  assert.equal(restored, original);
  new vm.Script(result.source);
  const composed = applyNativeSessionHooks(applyNativeHooks(original).source);
  new vm.Script(composed.source);
  assert.equal(composed.evidence.hooks.length, 4);
  assert.throws(() => applyNativeSessionHooks(original.replace('t$e[61][y4F[9][640]] == false && a5H[4][a5H[6] - 30]', 't$e[61][y4F[9][640]] == false && a5H[4][a5H[6] - 29]')), /confirmation anchor changed/);
  assert.throws(() => applyNativeSessionHooks(original.replace('function F8(', 'function ChangedF8(')), /session:native-leave/);
  assert.throws(() => applyNativeSessionHooks(original.replace('function g7(', 'function ChangedMenu(')), /session:cancel-join/);
  assert.throws(() => applyNativeSessionHooks(original.replace('function D70(', 'function ChangedCredit(')), /session:empty-replay-credit/);
});

test('confirmed outcome uses the original 30-frame settlement point even when the host lost or is a guest', () => {
  const harness = createNativeHarness(original);
  harness.context.encoded = JSON.parse(fs.readFileSync('evidence/verification/native-replay-fixture.json', 'utf8')).replaydata;
  const history = harness.run(`
    replay=new __native.constructors[86]();replay.fromDatabase(encoded);engine=new __native.simulation();state=replay.startingState;inputs=[{},{}];history=[state];
    for(let frame=0;frame<replay.es;frame++){for(let id=0;id<2;id++)if(replay.inputs[id][frame])inputs[id]=replay.inputs[id][frame];state=engine.step(state,inputs,replay.adminInputs[frame],30,replay.gameSettings,1,false,false);history.push(state);}
    history;
  `);
  const calls: any[] = [], context: any = { window: { manifold: { confirmedRound: (receipt: any) => calls.push(structuredClone(receipt)) } }, a5H: [], z: { fte: 90 } };
  context.a5H[4] = history;
  context.a5H[60] = { ga: 'b', mo: 'b', tea: false, map: { m: { dbid: 562748, dbv: 2 } } };
  context.a5H[96] = { hostID: 1, getLSID: () => 1 };
  vm.createContext(context);
  const hook = new vm.Script(findHook('session:confirmed-round').code);
  for (let frame = 0; frame < history.length; frame++) { context.a5H[6] = frame; hook.runInContext(context); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].winner, 0, 'losing host still confirms the native winner');
  assert.equal(calls[0].round, 0);
  assert.equal(calls[0].teams, false);
  assert.equal(history[calls[0].frame].fte, 89);
  assert.equal(calls[0].mapid, 562748);
  assert.equal(calls[0].dbv, 2);
  assert.equal(calls[0].mode, 'b');
  const confirmingFrame = calls[0].frame + 30;
  context.a5H[6] = calls[0].frame;
  hook.runInContext(context);
  assert.equal(calls.length, 1, 'a speculative current-frame finish is not enough');
  context.a5H[6] = confirmingFrame;
  context.a5H[96].getLSID = () => 0;
  hook.runInContext(context);
  assert.equal(calls.length, 1, 'non-hosts do not report host receipts');
  context.a5H[96].getLSID = () => 1;
  context.a5H[60].ga = 'f';
  hook.runInContext(context);
  assert.equal(calls.length, 1, 'native Football does not use Bonk winner XP requests');
  fs.writeFileSync('evidence/verification/native-session-hooks.json', JSON.stringify({ ...result.evidence,
    confirmedOutcome: calls[0], confirmedAtFrame: confirmingFrame,
    nativeHistoryFrames: history.length, losingHostVerified: true, guestHostSupported: true,
    speculativeCurrentFrameRejected: true, nonHostRejected: true,
    verificationScope: 'Original native simulation replay history evaluated at the exact inserted confirmed-frame guard; browser hook invocation remains a separate integration check',
  }, null, 2) + '\n');
});

function nativeCleanupFunctions() {
  const decoded = fs.readFileSync('evidence/protocol/alpha2s.decoded.js', 'utf8');
  const ast = ts.createSourceFile('decoded.js', decoded, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let menuCallback = '', controllerDestroy = '', networkDestroy = '', hideConnecting = '', showClassic = '', lateAddress = '', addressFailure = '';
  const hasLocal = (node: ts.FunctionExpression, name: string) => node.body.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name));
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'j0e[451]["on"]' && node.arguments[0]?.getText(ast) === '"endSession"') menuCallback = node.arguments[1].getText(ast);
    if (ts.isFunctionExpression(node) && hasLocal(node, 'R3W') && node.getText(ast).includes('v$q[33]["destroy"]()')) controllerDestroy = node.getText(ast);
    if (ts.isFunctionExpression(node) && hasLocal(node, 't3z') && node.getText(ast).includes('w0O[325]["close"]()')) networkDestroy = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'P5i') hideConnecting = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'k3G') showClassic = node.getText(ast);
    if (ts.isArrowFunction(node) && node.getText(ast).includes('v8m["id"] != j0e[562]') && node.getText(ast).includes('f7E(i1I)')) lateAddress = node.getText(ast);
    if (ts.isFunctionExpression(node) && hasLocal(node, 'C2n') && node.getText(ast).includes('a6N("Address fetch failed")')) addressFailure = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(menuCallback && controllerDestroy && networkDestroy);
  assert.ok(hideConnecting && showClassic && lateAddress && addressFailure);
  return { menuCallback, controllerDestroy, networkDestroy, hideConnecting, showClassic, lateAddress, addressFailure };
}

test('native leave invokes original controller/socket cleanup and main-menu return while preserving the logged-in account', () => {
  const functions = nativeCleanupFunctions(), counters: Record<string, number> = {};
  const count = (name: string) => () => { counters[name] = (counters[name] || 0) + 1; };
  const account = Object.freeze({ loggedIn: true, guest: false, userName: 'AccountKept', token: 'existing-local-token', xp: 400 });
  const chat = { firstChild: null, removeChild: count('chatRemove'), value: 'old chat' };
  const context: any = { window: { manifold: {} }, v$q: [], w0O: [], j0e: [], session: {}, M$QCc: [], k7V: { t8H() {} },
    document: { getElementById: () => chat }, clearTimeout: count('timeout'), clearInterval: count('interval'), account };
  context.w0O[325] = { close: count('socketClose') };
  context.w0O[614] = { destroy: count('peerDestroy') };
  context.w0O[999] = { destroy: count('reporterDestroy') };
  context.v$q[3] = {};
  context.v$q[79] = { destroy: count('lobbyDestroy') };
  context.v$q[52] = { destroy: count('standbyDestroy') };
  context.v$q[28] = { destroy: count('worldDestroy') };
  context.v$q[18] = { destroy: count('quickMapsDestroy') };
  context.j0e[9] = { returnToMain: count('returnToMain') };
  context.j0e[486] = { refreshIfNecessary: count('refreshRooms') };
  context.j0e[72] = account.token;
  vm.createContext(context);
  context.v$q[33] = vm.runInContext(`({destroy:${functions.networkDestroy}})`, context);
  context.session.destroy = vm.runInContext(`(${functions.controllerDestroy})`, context);
  context.j0e[451] = context.session;
  const nativeEnd = vm.runInContext(`(${functions.menuCallback})`, context);
  context.b2$ = (event: string) => { assert.equal(event, 'endSession'); nativeEnd(); };
  vm.runInContext(`(function(){${findHook('session:native-leave').code}}).call(session)`, context);
  assert.equal(context.window.manifold.nativeSession, context.session);
  assert.equal(context.session.leaveRoom(), true);
  assert.equal(context.session.leaveRoom(), false, 'leaving twice is harmless after native destruction');
  assert.equal(context.j0e[451], null);
  for (const name of ['socketClose', 'peerDestroy', 'reporterDestroy', 'lobbyDestroy', 'standbyDestroy', 'worldDestroy', 'quickMapsDestroy', 'returnToMain', 'refreshRooms']) assert.equal(counters[name], 1, name);
  assert.equal(context.j0e[72], account.token);
  assert.equal(context.account, account);
  assert.equal(context.account.loggedIn, true);
  assert.equal(context.account.guest, false);
  assert.equal(chat.value, '');
});

test('declining a pending native join hides its overlay synchronously, invalidates late address replies and preserves account state', () => {
  const functions = nativeCleanupFunctions(), counters: Record<string, number> = {};
  const count = (name: string) => () => { counters[name] = (counters[name] || 0) + 1; };
  const account = Object.freeze({ classic: true, loggedIn: true, guest: false, userName: 'StillSignedIn', xp: 900 });
  const container = { style: { visibility: 'inherit', opacity: '1' } };
  let animations: any[] = [];
  const anime = Object.assign((options: any) => { animations.push(options); }, { remove: (target: any) => { animations = animations.filter(item => item.targets !== target); count('cancelAnimation')(); } });
  const context: any = { window: { manifold: {} }, j0e: [], t$e: [], M$QCc: [], k7V: { t8H() {} }, anime,
    location: { reload() { throw Error('Native join cancellation must not reload the page'); } }, f7E: count('lateJoin') };
  context.t$e[61] = account;
  context.j0e[3] = { style: { display: 'block' } };
  context.j0e[74] = { style: { visibility: 'hidden', opacity: '0' } };
  context.j0e[538] = container;
  context.j0e[624] = { innerHTML: 'Got address, connecting...' };
  context.j0e[490] = ['Got address, connecting...'];
  context.j0e[451] = null;
  context.j0e[473] = true;
  context.j0e[562] = 123;
  context.j0e[285] = 'room-password';
  context.j0e[72] = 'keep-this-account-token';
  context.j0e[486] = { enableMouseEvents: count('enableMouseEvents') };
  context.j0e[513] = { unblur: count('unblurReplay') };
  context.j0e[9] = { returnToMain: () => { count('returnToMain')(); context.j0e[3].style.display = 'block'; } };
  context.a6N = (message: string) => { context.j0e[490].push(message); context.j0e[624].innerHTML = context.j0e[490].join('<br>'); };
  vm.createContext(context);
  vm.runInContext(`${functions.hideConnecting};${functions.showClassic};${findHook('session:cancel-join').code}`, context);
  assert.equal(context.window.manifold.cancelNativeJoin(), false, 'pre-session cancellation needs no live F8 controller');
  assert.equal(container.style.visibility, 'hidden');
  assert.equal(container.style.opacity, '0');
  assert.equal(animations.length, 0, 'pending connecting fades cannot restore the overlay');
  assert.equal(context.j0e[490].length, 0);
  assert.equal(context.j0e[624].innerHTML, '');
  assert.equal(context.j0e[473], false);
  assert.equal(context.j0e[562], -1);
  assert.equal(context.j0e[285], '');
  assert.equal(context.j0e[74].style.visibility, 'inherit');
  const done = vm.runInContext(`(${functions.lateAddress})`, context);
  done({ r: 'success', id: 123, address: 123, server: 'local' });
  assert.equal(counters.lateJoin || 0, 0, 'a cancelled address lookup cannot construct another native session');
  const fail = vm.runInContext(`(${functions.addressFailure})`, context);
  fail();
  assert.equal(container.style.visibility, 'hidden', 'late native failure text does not make the overlay visible');
  assert.match(context.j0e[624].innerHTML, /Address fetch failed/);
  context.window.manifold.cancelNativeJoin();
  assert.equal(context.j0e[624].innerHTML, '', 'calling after Deferred.reject removes its synchronous native fail text');
  context.j0e[451] = { destroy: count('destroyPending') };
  context.j0e[3].style.display = 'none';
  assert.equal(context.window.manifold.cancelNativeJoin(), true);
  assert.equal(context.window.manifold.cancelNativeJoin(), false);
  assert.equal(counters.destroyPending, 1);
  assert.equal(counters.returnToMain, 1);
  assert.equal(context.j0e[451], null);
  assert.equal(context.j0e[3].style.display, 'block');
  assert.equal(context.j0e[72], 'keep-this-account-token');
  assert.equal(context.t$e[61], account);
  assert.equal(context.t$e[61].loggedIn, true);
  assert.equal(context.t$e[61].guest, false);
  const evidencePath = 'evidence/verification/native-session-hooks.json';
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.pendingJoinCancellation = { passed: true, synchronousOverlayHide: true, pendingAnimationsRemoved: true, lateAddressCannotJoin: true,
    nativeFailThenCancelClearsText: true, existingSessionDestroyedOnce: true, accountPreserved: true, pageReloaded: false,
    browserVerificationRequired: true };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
});

test('an independent server without menu replays disables native replay favoriting without dereferencing null', () => {
  const decoded = fs.readFileSync('evidence/protocol/alpha2s.decoded.js', 'utf8');
  const ast = ts.createSourceFile('decoded.js', decoded, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let source = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'D70') source = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(source.startsWith('function D70(){'));
  const code = source.replace('function D70(){', `function D70(){${findHook('session:empty-replay-credit').code}`);
  const classes = new Set<string>(['pretty_top_replay_fav_checked']);
  const context: any = { j0e: [], t$e: [], M$QCc: [], k7V: { t8H() {} } };
  context.j0e[60] = { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } };
  context.t$e[61] = { guest: false };
  vm.createContext(context);
  vm.runInContext(code, context);
  for (const empty of [null, undefined]) {
    context.j0e[81] = empty;
    assert.doesNotThrow(() => context.D70());
    assert.ok(classes.has('pretty_top_replay_fav_disabled'));
    assert.ok(!classes.has('pretty_top_replay_fav_checked'));
  }
  context.j0e[81] = { mid: 562748 };
  context.D70();
  assert.ok(!classes.has('pretty_top_replay_fav_disabled'), 'a published replay map still follows the original valid-data branch');
  context.t$e[61].guest = true;
  context.D70();
  assert.ok(classes.has('pretty_top_replay_fav_disabled'), 'native guests still cannot favorite a map');
  const evidencePath = 'evidence/verification/native-session-hooks.json';
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.emptyReplayFavorite = { passed: true, nullAndUndefinedSafe: true, validNativeBranchUnchanged: true, guestRestrictionPreserved: true };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
});
