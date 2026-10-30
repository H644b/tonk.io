import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {createRequire} from 'node:module';
import {createApplication} from '../server/application.ts';
import {ServiceStore} from '../server/store.ts';
import {mapIndex} from '../server/map-index.ts';
import {nativeCatalog} from '../server/catalog.ts';
import {botDecision,botReactionFrames} from '../shared/bot-ai.ts';
const io=createRequire(import.meta.url)('socket.io-client-v2');

test('administration enforces ownership, suspends accounts, hides maps, and records actions',async t=>{
  const store=new ServiceStore(':memory:'),app=await createApplication({store});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const origin='http://127.0.0.1:'+(app.server.address() as any).port;
  t.after(async()=>{app.dispose();await new Promise<void>(resolve=>app.server.close(()=>resolve()));store.close();});
  const owner=await store.register({username:'H644b',password:'password123'}),member=await store.register({username:'Member',password:'password123'});
  const token=store.createSession(owner.id),memberToken=store.createSession(member.id);
  const request=(path:string,body?:any,credential=token)=>fetch(origin+'/api/admin/'+path,{method:body?'POST':'GET',headers:{Origin:origin,Cookie:'bonk_session='+credential,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('overview',undefined,'')).status,401);
  assert.equal((await request('overview',undefined,memberToken)).status,403);
  assert.equal((await request('overview')).status,200);
  const map=store.createMap(member.id,{name:'Moderation map',data:'encoded',visibility:'public'});
  assert.equal((await request('maps/moderate',{key:'local:'+map.id,hidden:true})).status,200);
  assert.throws(()=>store.getMap(map.id),/Map not found/);
  assert.equal(store.listMaps().maps.length,0);
  assert.equal((await request('maps/moderate',{key:'local:'+map.id,hidden:false})).status,200);
  assert.equal(store.getMap(map.id).name,'Moderation map');
  assert.equal((await request(`users/${member.id}/ban`,{reason:'Test suspension',days:1})).status,200);
  assert.equal(store.getSession(memberToken),null);
  await assert.rejects(()=>store.login({username:'Member',password:'password123'}),/suspended/);
  assert.equal((await request(`users/${owner.id}/ban`,{reason:'No',days:1})).status,400);
  assert.equal((await request(`users/${member.id}/unban`,{})).status,200);
  assert.equal((await store.login({username:'Member',password:'password123'})).id,member.id);
  assert.equal((await request('settings',{registrationOpen:false})).status,200);
  await assert.rejects(()=>store.register({username:'Closed',password:'password123'}),/closed/);
  assert.ok((await (await request('audit')).json()).events.length>=5);
});

test('indexed map search includes imported geometry, preserves creator data, and invalidates moderation',async()=>{
  const store=new ServiceStore(':memory:');try{
    const row={id:'2:555777',dbv:2,source_id:'555777',name:'Popular Parkour',authorname:'Original Creator',leveldata:nativeCatalog[0].leveldata,category:'mapStrings',vu:5000,vd:5,published_at:'2026-10-01',source_url:'https://bonk2.io/scripts/hotmaps/picks.txt',updated_at:Date.now()};
    store.db.prepare('INSERT INTO community_maps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
    const index=mapIndex(store,nativeCatalog),result=index.search({query:'parkour',includeData:false});assert.equal(result.maps.length,1);assert.equal((result.maps[0] as any).leveldata,undefined);
    const playable=index.search({query:'parkour'}).maps[0] as any;assert.equal(playable.leveldata,row.leveldata);assert.equal(playable.authorname,row.authorname);
    assert.equal(index.search({query:'creator',name:false,author:true}).total,1);
    assert.equal(index.search({query:'creator',name:true,author:false}).total,0);
    const moderator=await store.register({username:'Moderator',password:'password123'});
    store.db.prepare('INSERT INTO map_moderation VALUES(?,?,?,?,?)').run(row.id,1,'reason',moderator.id,Date.now());
    assert.equal(index.search({query:'parkour'}).total,0);
  }finally{store.close()}
});

test('room host controls bot count and difficulty; bots never retain an empty human room',async t=>{
  const store=new ServiceStore(':memory:'),app=await createApplication({store});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const origin='http://127.0.0.1:'+(app.server.address() as any).port,id=app.createRoom({maxPlayers:4});
  const socket=io(origin,{path:`/rooms/${id}/socket.io`,transports:['websocket'],forceNew:true,reconnection:false});
  t.after(async()=>{socket.disconnect();app.dispose();await new Promise<void>(resolve=>app.server.close(()=>resolve()));store.close();});
  await once(socket,'connect');const joined=once(socket,'3');socket.emit('13',{userName:'Host',guest:true,level:0,avatar:{bc:0,layers:[]}});await joined;
  const ack=(data:any)=>new Promise<any>(resolve=>socket.emit('wb:bots',data,resolve));
  assert.equal((await ack({count:4,difficulty:'hard'})).error,'There are not enough open player slots.');
  const added=await ack({count:2,difficulty:'expert'});assert.equal(added.ok,true);assert.equal(added.bots.length,2);assert.equal(app.rooms.get(id)!.room.playerAmount,3);
  assert.ok(added.bots.every((bot:any)=>bot.difficulty==='expert'));
  await ack({count:1,difficulty:'easy'});assert.equal(app.rooms.get(id)!.room.playerAmount,2);
  socket.disconnect();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(app.rooms.has(id),false);
});

test('bot decisions react to opponents, hazards, game mode, and difficulty',()=>{
  const map={physics:{ppm:30,bodies:[{p:[0,0],a:0,fx:[0],s:{f_p:true}}],fixtures:[{sh:0,d:false}],shapes:[{type:'bx',w:900,h:30,c:[450,450],a:0}]}},state={discs:[{x:5,y:14,xv:0,yv:0,team:1},{x:10,y:14,xv:0,yv:0,team:1}]};
  const classic=botDecision(state,{mo:'b',map},0,'expert',30);assert.equal(classic.right,true);
  const arrows=botDecision(state,{mo:'ar',map},0,'expert',30);assert.equal(arrows.action2,true);
  const football=botDecision({...state,ball:{x:3,y:14}},{mo:'f',map},0,'expert',30);assert.equal(football.left,true);
  assert.ok(botReactionFrames('expert')<botReactionFrames('easy'));
  assert.deepEqual(botDecision({discs:[]},{},0,'hard',1),{left:false,right:false,up:false,down:false,action:false,action2:false});
});
