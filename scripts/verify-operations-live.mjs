import fs from 'node:fs';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const io=createRequire(import.meta.url)('socket.io-client-v2');
const origin=new URL(process.argv[2]).origin,key=createHash('sha256').update(origin).digest('hex').slice(0,12),state=JSON.parse(fs.readFileSync(`.deployment/live-state-${key}.json`)),admin=JSON.parse(fs.readFileSync('.deployment/admin-verification-session.json'));
assert.equal(admin.origin,origin);const owner='bonk_session='+admin.token,checks=[],sockets=[];
async function req(route,{body,cookie=owner,status=200,method,requestOrigin=origin}={}){const response=await fetch(origin+route,{method:method||(body===undefined?'GET':'POST'),headers:{Origin:requestOrigin,Cookie:cookie,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const text=await response.text();assert.equal(response.status,status,route+' '+text.slice(0,100));return text?JSON.parse(text):{};}
const event=(s,name)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Timeout '+name)),15000);s.once(name,(...args)=>{clearTimeout(timer);resolve(args)})});
const ack=(s,name,data)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Timeout '+name)),15000);s.emit(name,data,value=>{clearTimeout(timer);resolve(value)})});
let room,map;
try{
 const profile=await req('/api/profile');assert.equal(profile.user.username,'H644b');assert.equal(profile.role,'owner');
 await req('/api/admin/overview',{cookie:state.accounts[0].cookie,status:403});await req('/api/admin/settings',{body:{maintenance:true},requestOrigin:'https://example.invalid',status:403});checks.push('H644b owns Admin; member access and cross-origin changes are denied');
 map=(await req('/api/maps',{cookie:state.accounts[0].cookie,body:{name:'Operations QA',data:{test:true},visibility:'private'},status:201})).map;
 const list=await req('/api/admin/maps?q=Operations%20QA');assert.ok(list.maps.some(m=>m.mapKey==='local:'+map.id));
 await req('/api/admin/maps/moderate',{body:{key:'local:'+map.id,hidden:true,reason:'Verification'}});await req('/api/maps/'+map.id,{cookie:state.accounts[0].cookie,status:404});
 await req('/api/admin/maps/moderate',{body:{key:'local:'+map.id,hidden:false}});await req('/api/maps/'+map.id,{cookie:state.accounts[0].cookie});checks.push('Admin finds private non-native maps, removes them from loading, and restores them');
 room=(await req('/api/rooms',{body:{name:'Operations QA',maxPlayers:4},status:201})).id;
 for(const account of state.accounts){const socket=io(origin,{path:`/rooms/${room}/socket.io`,transports:['websocket'],forceNew:true,reconnection:false,extraHeaders:{Origin:origin,Cookie:account.cookie}});sockets.push(socket);socket.on('1',(_,id)=>{if(id)socket.emit('1',{id})});await event(socket,'connect');const joined=event(socket,'3');socket.emit('13',{userName:account.username,guest:false,level:0,avatar:{bc:0,layers:[]}});await joined;}
 assert.ok((await ack(sockets[1],'wb:bots',{count:1,difficulty:'easy'})).error);
 assert.ok((await ack(sockets[0],'wb:bots',{count:3,difficulty:'expert'})).error);
 const bots=await ack(sockets[0],'wb:bots',{count:2,difficulty:'hard'});assert.equal(bots.ok,true);assert.equal(bots.bots.length,2);checks.push('Native room host selects bot count/difficulty; peers and over-capacity requests are denied');
 let rooms=await req('/api/admin/rooms');const member=rooms.rooms.find(r=>r.id===room).players.find(p=>!p.host&&!p.bot);
 const kicked=event(sockets[1],'disconnect');await req(`/api/admin/rooms/${room}/kick`,{body:{playerId:member.id}});await kicked;
 const closed=event(sockets[0],'disconnect');await req(`/api/admin/rooms/${room}/close`,{body:{}});await closed;assert.ok(!(await req('/api/rooms')).some(r=>r.id===room));room=null;checks.push('Admin kicks a native peer and closes a room containing bots');
 const memberProfile=await req('/api/profile',{cookie:state.accounts[1].cookie});const id=memberProfile.user.id;
 await req(`/api/admin/users/${id}/role`,{body:{role:'curator'}});await req(`/api/admin/users/${id}/role`,{body:{role:'member'}});
 await req(`/api/admin/users/${id}/ban`,{body:{reason:'Verification',days:1}});assert.equal((await req('/api/profile',{cookie:state.accounts[1].cookie})).user,null);
 await req('/api/login',{body:{username:state.accounts[1].username,password:state.accounts[1].password},cookie:'',status:403});
 await req(`/api/admin/users/${id}/unban`,{body:{}});checks.push('Curator changes, suspension, session revocation, blocked login and unban work');
 assert.ok((await req('/api/admin/audit')).events.length>=8);checks.push('Administrative mutations have an audit trail');
 fs.writeFileSync('.deployment/operations-live-proof.json',JSON.stringify({at:new Date().toISOString(),origin,checks,status:'passed'},null,2));console.log({status:'passed',checks});
}finally{for(const socket of sockets)socket.disconnect();if(room)await req(`/api/admin/rooms/${room}/close`,{body:{}}).catch(()=>{});if(map)await req('/api/maps/'+map.id,{cookie:state.accounts[0].cookie,method:'DELETE'}).catch(()=>{});}
