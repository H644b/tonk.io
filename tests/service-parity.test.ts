import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { ServiceStore } from '../server/store.js';
import { makeNativeServiceHandler, setupServices } from '../server/services.js';
import { setupCompatibility } from '../server/compatibility.js';
import { nativeCatalog, curateNativeMap, quickMapPacket, quickMapPool, trainingMapPacket, hotMapRows } from '../server/catalog.js';

const register = (store: ServiceStore, username: string) => store.register({ username, password: 'parity testing password' });
async function fixture(t: test.TestContext) {
  const store = new ServiceStore(':memory:'), app = express();
  setupServices(app, { store });
  setupCompatibility(app, { store, playerCounts: () => ({ quick_classic: 3, quick_arrows: 2, quick_grapple: 1, quick_simple: 4, custom: 5 }) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); });
  const post = async (endpoint: string, body: any = {}) => (await fetch(`${base}/compat/${endpoint}.php`, { method: 'POST', body: new URLSearchParams(body) })).json();
  return { store, base, post };
}

test('native curation privileges, comments, training tiers and mode-specific hot lists work on independent data', async t => {
  const { store, post, base } = await fixture(t);
  const owner = await post('register_legacy', { username: 'Owner', password: 'password123' });
  const alice = await post('register_legacy', { username: 'Alice', password: 'password123' });
  assert.equal(owner.localRole, 'owner');
  assert.equal(alice.localRole, null);
  const saved = await post('map_save_pub', { token: alice.token, mapname: 'Arrow Remix', leveldata: nativeCatalog[0].leveldata, public: 'true', mode: 'ard', remix: 'true', spawns: '8' });
  const input = { mapid: saved.mapid, dbv: 2, comment: 'An independently curated arena', mode: 'ard', tier: 0 };
  assert.throws(() => curateNativeMap(store, store.getSession(alice.token)!.id, input), { code: 'unauthorised' });
  const curator = store.getSession(owner.token)!;
  assert.throws(() => curateNativeMap(store, curator.id, { ...input, comment: 'x'.repeat(501) }), { code: 'comment_too_long' });
  curateNativeMap(store, curator.id, input);
  const picks = JSON.parse(await (await fetch(`${base}/compat/hotmaps/picks.txt`)).text());
  assert.equal(picks.maps.length, 1);
  assert.equal(picks.maps[0].addedby, 'Owner');
  assert.equal(picks.maps[0].comment, input.comment);
  assert.equal(picks.maps[0].authorname, 'Alice');
  assert.equal(picks.maps[0].dbv, 2);
  assert.ok(hotMapRows(store, 'cache3_6_ard.txt').some(map => map.id === String(saved.mapid)));
  assert.ok(!hotMapRows(store, 'cache3_6_sp.txt').some(map => map.id === String(saved.mapid)));
  assert.ok(hotMapRows(store, 'cache_edits_6.txt').some(map => map.id === String(saved.mapid)));
  const classic = nativeCatalog.find(map => map.category === 'mapStrings')!;
  curateNativeMap(store, curator.id, { mapid: classic.id, dbv: classic.sourceDbv ?? classic.dbv, comment: 'Training choice', tier: 1 });
  const training = await post('matchmaking_maps');
  assert.equal(training.t1.length, 1);
  assert.equal(training.t1[0].id, classic.id);
  assert.equal(training.t1[0].addedby, 'Owner');
  const restricted = await post('map_save_pub', { token: alice.token, mapname: 'Private', leveldata: classic.leveldata, public: 'false' });
  assert.throws(() => curateNativeMap(store, curator.id, { mapid: restricted.mapid, dbv: 2, comment: '' }), { code: 'map_private' });
  assert.throws(() => curateNativeMap(store, curator.id, { mapid: 999999999, dbv: 2, comment: '' }), { code: 'invalid_mapid' });
  const fresh = new ServiceStore(':memory:');
  try { assert.ok(trainingMapPacket(fresh).t1.length > 0); } finally { fresh.close(); }
  const counts = JSON.parse(await (await fetch(`${base}/compat/combinedplayercount.txt`)).text());
  assert.equal(counts.bonk.total, 15);
  assert.equal(counts.bonk.quick_arrows, '2');
  assert.equal(counts.bonk.custom, '5');
});

test('native quick map pages wrap stable indices and include published curator-approved custom maps', async () => {
  const store = new ServiceStore(':memory:');
  try {
    const owner = await register(store, 'Owner');
    const map = store.createMap(owner.id, { name: 'New grapple arena', data: nativeCatalog[0].leveldata });
    const mapid = store.nativeId('map', map.id);
    store.setMapMetadata(map.id, owner.id, { mode: 'sp', spawns: 8 });
    curateNativeMap(store, owner.id, { mapid, dbv: 2, comment: 'Grapple rotation', mode: 'sp' });
    const pool = quickMapPool(store, 'sp');
    assert.equal(pool[0].id, String(mapid));
    const packet = quickMapPacket('sp', pool.length - 2, store, pool);
    assert.equal(packet.maps.length, 12);
    assert.equal(packet.maps[0].id, pool.length - 2);
    assert.equal(packet.maps[2].id, 0);
    assert.equal(packet.maps[2].s, map.data);
    assert.ok(!quickMapPool(store, 'ar').some(map => map.id === String(mapid)));
    const emitted: any[][] = [], socket: any = { id: 'one', data: { bonkId: 0 }, emit: (...args: any[]) => emitted.push(args) };
    const room: any = { playerSockets: [socket], gameStartTime: 0, gameSettings: { mo: 'sp' } };
    const handler = makeNativeServiceHandler({ store });
    handler('42', { sf: 0 }, socket, room);
    const before = emitted.at(-1)![1];
    store.removeCuration(owner.id, 2, mapid);
    handler('42', { sf: 0 }, socket, room);
    assert.deepEqual(emitted.at(-1)![1], before, 'live room rotation is stable when the catalog changes');
  } finally { store.close(); }
});

test('XP requires native host outcome agreement, awards100 once per winning round, supports teams and broadcasts levels', async () => {
  const store = new ServiceStore(':memory:');
  try {
    const [alice, bob] = await Promise.all([register(store, 'Alice'), register(store, 'Bob')]);
    const emitted: any[][] = [], broadcast: any[][] = [];
    const sockets = [alice, bob].map((account, sid) => ({ id: `socket-${sid}`, data: { bonkId: sid }, handshake: { headers: { cookie: `bonk_session=${store.createSession(account.id)}` } }, emit: (...args: any[]) => emitted.push([sid, ...args]) }));
    const room: any = { hostId: 0, playerSockets: sockets, playerInfo: [{ team: 1 }, { team: 1 }], gameStartTime: 1000, gameSettings: { ga: 'b', tea: false, mo: 'b' }, io: { to: () => ({ emit: (...args: any[]) => broadcast.push(args) }) } };
    let now = 2000;
    const handler = makeNativeServiceHandler({ store, now: () => now });
    handler('38', { xp: 999999 }, sockets[1], room);
    assert.equal(store.getSetting(bob.id, 'xp', 0), 0);
    assert.equal(emitted.length, 0, 'a rejected claim must not show the native +100 animation');
    assert.ok(handler.recordRound({ round: 0, winner: 1, teams: false }, sockets[1], room).error);
    assert.deepEqual(handler.recordRound({ round: 0, winner: 1, teams: false }, sockets[0], room), { ok: true });
    assert.equal(store.getSetting(bob.id, 'xp', 0), 100, 'claim before host receipt is resolved after verified outcome');
    assert.deepEqual(broadcast.at(-1), ['45', { sid: 1, lv: 2 }]);
    handler('38', {}, sockets[1], room);
    handler('38', {}, sockets[0], room);
    assert.equal(emitted.length, 1, 'duplicate and losing claims do not animate additional XP');
    assert.equal(store.getSetting(alice.id, 'xp', 0), 0);
    assert.equal(store.getSetting(bob.id, 'xp', 0), 100);
    assert.equal(handler.recordRound({ round: 0, winner: 1, teams: false }, sockets[0], room).duplicate, true);
    assert.ok(handler.recordRound({ round: 0, winner: 0, teams: false }, sockets[0], room).error);
    now += 500;
    room.gameSettings.tea = true; room.playerInfo[0].team = 2; room.playerInfo[1].team = 2;
    assert.equal(handler.recordRound({ round: 1, winner: 2, teams: true }, sockets[0], room).ok, true);
    handler('38', {}, sockets[0], room); handler('38', {}, sockets[1], room);
    assert.equal(store.getSetting(alice.id, 'xp', 0), 100);
    assert.equal(store.getSetting(bob.id, 'xp', 0), 200);
    room.playerInfo[1].team = 0;
    assert.equal(handler.recordRound({ round: 2, winner: 2, teams: true }, sockets[0], room).ok, true);
    handler('38', {}, sockets[0], room);
    assert.equal(store.getSetting(alice.id, 'xp', 0), 100, 'solo practice grants no competitive winner award');
    room.gameSettings.ga = 'f';
    assert.ok(handler.recordRound({ round: 3, winner: 2, teams: true }, sockets[0], room).error);
    room.gameSettings.ga = 'b'; room.gameStartTime = 0;
    assert.ok(handler.recordRound({ round: 3, winner: 2, teams: true }, sockets[0], room).error);
  } finally { store.close(); }
});

test('reports persistently hide replays for the reporter while curators can review, hide and restore them globally', async t => {
  const { store, post, base } = await fixture(t);
  const owner = await register(store, 'Owner'), alice = await register(store, 'Alice');
  const ownerToken = store.createSession(owner.id), aliceToken = store.createSession(alice.id);
  const saved = await post('replay_submit', { version: 48, mode: 'ar', replaydata: 'encoded-native-replay' });
  assert.equal((await post('replay_get', { version: 48, mode: 'ar' })).replays.length, 1);
  assert.equal((await post('replay_report', { replayid: saved.id, token: aliceToken })).r, 'success');
  assert.equal((await post('replay_get', { version: 48, mode: 'ar', token: aliceToken })).replays.length, 0);
  assert.equal((await post('replay_get', { version: 48, mode: 'ar', token: ownerToken })).replays.length, 1);
  assert.throws(() => store.listReplayReports(alice.id), { code: 'unauthorised' });
  const response = await fetch(`${base}/api/catalog/replays/reports`, { headers: { Cookie: `bonk_session=${ownerToken}` } });
  assert.equal((await response.json()).replays[0].reports, 1);
  store.moderateReplay(owner.id, saved.id, true, 'Local moderation decision');
  assert.equal((await post('replay_get', { version: 48, mode: 'ar' })).replays.length, 0);
  store.moderateReplay(owner.id, saved.id, false, 'Restored');
  assert.equal((await post('replay_get', { version: 48, mode: 'ar' })).replays.length, 1);
});

test('native curation packets return the shipped client error vocabulary and enforce local roles and throttling', async () => {
  const store = new ServiceStore(':memory:');
  try {
    const owner = await register(store, 'Owner'), alice = await register(store, 'Alice');
    const emitted: any[][] = [];
    const sockets = [owner, alice].map((account, sid) => ({ id: `socket-${sid}`, data: { bonkId: sid }, handshake: { headers: { cookie: `bonk_session=${store.createSession(account.id)}` } }, emit: (...args: any[]) => emitted.push([sid, ...args]) }));
    const guest: any = { id: 'guest', data: { bonkId: 2 }, emit: (...args: any[]) => emitted.push([2, ...args]) };
    const room = { playerSockets: [...sockets, guest], playerInfo: [{ guest: false }, { guest: false }, { guest: true }], gameStartTime: 0 };
    const handler = makeNativeServiceHandler({ store, now: () => 1000 });
    const source = nativeCatalog[0], request = { mapid: source.id, dbv: source.sourceDbv ?? source.dbv, comment: 'A local pick' };
    handler('51', request, guest, room);
    assert.deepEqual(emitted.at(-1), [2, '57', false, 'not_logged_in']);
    handler('51', request, sockets[1], room);
    assert.deepEqual(emitted.at(-1), [1, '57', false, 'unauthorised']);
    handler('51', { ...request, dbv: 999 }, sockets[0], room);
    assert.deepEqual(emitted.at(-1), [0, '57', false, 'invalid_dbv']);
    handler('51', request, sockets[0], room);
    assert.deepEqual(emitted.at(-1), [0, '57', true, '']);
    assert.equal(store.listCurations().length, 1);
    handler('51', request, sockets[0], room);
    assert.deepEqual(emitted.at(-1), [0, '57', false, 'rate_limit']);
  } finally { store.close(); }
});

test('only the independent server owner can grant curator access', async t => {
  const { store, base } = await fixture(t);
  const owner = await register(store, 'Owner'), alice = await register(store, 'Alice'), bob = await register(store, 'Bob');
  const tokens = [owner, alice].map(account => store.createSession(account.id));
  const setRole = (token: string, username: string, role: string | null) => fetch(`${base}/api/admin/roles`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `bonk_session=${token}` }, body: JSON.stringify({ username, role }) });
  assert.equal((await setRole(tokens[1], 'Bob', 'curator')).status, 403);
  assert.equal((await setRole(tokens[0], 'Bob', 'curator')).status, 200);
  assert.equal(store.role(bob.id), 'curator');
  assert.equal((await setRole(tokens[0], 'Owner', null)).status, 400);
  assert.equal((await setRole(tokens[0], 'Bob', null)).status, 200);
  assert.equal(store.role(bob.id), null);
});

test('native error branches distinguish unknown names, wrong passwords, existing friends and missing registration fields', async t => {
  const { post } = await fixture(t);
  assert.deepEqual(await post('register_legacy', { username: '', password: '' }), { r: 'fail', e: 'data_missing' });
  const alice = await post('register_legacy', { username: 'Alice', password: 'password123' });
  const bob = await post('register_legacy', { username: 'Bob', password: 'password123' });
  assert.equal((await post('login_legacy', { username: 'Missing', password: 'password123' })).e, 'username_fail');
  assert.equal((await post('login_legacy', { username: 'Alice', password: 'wrong password' })).e, 'password');
  await post('friends', { token: alice.token, task: 'send', theirname: 'Bob' });
  await post('friends', { token: bob.token, task: 'send', theirname: 'Alice' });
  assert.equal((await post('friends', { token: alice.token, task: 'send', theirname: 'Bob' })).e, 'already_friends');
});
