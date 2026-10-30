import express, {type Express} from 'express';
import { randomUUID } from 'node:crypto';
import { ServiceError, type ServiceStore } from './store.ts';
import { getRequestToken } from './services.ts';
import { mapIndex } from './map-index.ts';
import { nativeCatalog } from './catalog.ts';
type Controls={rooms:Map<string,any>; closeRoom:(id:string,expected?:any)=>void; modServer:any};
export function setupAdministration(app:Express,store:ServiceStore,controls:Controls){
  const router=express.Router();
  router.use(express.json({limit:'32kb'}));
  router.use((req,res,next)=>{
    const account=store.getSession(getRequestToken(req));
    if(!account)return res.status(401).json({error:'Sign in first.'});
    if(store.role(account.id)!=='owner')return res.status(403).json({error:'Administrator access required.'});
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'Use this server’s page.'});
    (req as any).administrator=account;res.set('Cache-Control','no-store');next();
  });
  const audit=(actor:string,action:string,target:string,details:any={})=>store.db.prepare('INSERT INTO moderation_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),actor,action,target,JSON.stringify(details),Date.now());
  router.get('/overview',(req,res)=>{
    const count=(table:string)=>Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
    const settings=store.db.prepare("SELECT key,value FROM server_settings WHERE key IN ('registrationOpen','maintenance')").all() as any[];
    res.json({user:(req as any).administrator,counts:{users:count('users'),maps:count('maps'),importedMaps:count('community_maps'),rooms:controls.rooms.size,reports:count('replay_reports')},settings:Object.fromEntries(settings.map(row=>[row.key,JSON.parse(row.value)]))});
  });
  router.get('/rooms',(_req,res)=>res.json({rooms:[...controls.rooms.values()].map(({id,room})=>({id,name:room.roomName,mode:room.gameSettings.mo,playing:!!room.gameStartTime,maxPlayers:room.config.maxPlayers,password:!!room.password,players:room.playerSockets.filter(Boolean).map((socket:any)=>({id:socket.data.bonkId,userId:socket.data.userId||null,name:room.playerInfo[socket.data.bonkId]?.userName,host:room.hostId===socket.data.bonkId,bot:!!socket.data.bot}))}))}));
  router.post('/rooms/:id/close',(req,res)=>{
    const entry=controls.rooms.get(req.params.id);if(!entry)throw new ServiceError(404,'room_not_found','Room not found.');
    audit((req as any).administrator.id,'room.close',entry.id,{name:entry.room.roomName});
    entry.room.io.to('main').emit('wb:moderation',{action:'room_closed',message:'An administrator closed this room.'});
    for(const socket of [...entry.room.playerSockets].filter(Boolean) as any[])socket.disconnect(true);
    controls.closeRoom(entry.id,entry.room);res.json({ok:true});
  });
  router.post('/rooms/:id/kick',(req,res)=>{
    const room=controls.rooms.get(req.params.id)?.room,player=room?.playerSockets[Number(req.body.playerId)];
    if(!player)throw new ServiceError(404,'player_not_found','Player not found.');
    audit((req as any).administrator.id,'player.kick',`${req.params.id}:${req.body.playerId}`);
    player.emit('wb:moderation',{action:'kicked',message:'An administrator removed you from this room.'});player.disconnect(true);res.json({ok:true});
  });
  router.get('/users',(req,res)=>{
    const query=String(req.query.q||'').slice(0,100);
    const users=store.db.prepare(`SELECT u.id,u.username,u.created_at,r.role,b.reason AS banReason,b.expires_at AS banExpires FROM users u LEFT JOIN server_roles r ON r.user_id=u.id LEFT JOIN account_bans b ON b.user_id=u.id WHERE u.username LIKE ? ORDER BY u.created_at DESC LIMIT 100`).all('%'+query+'%');
    res.json({users});
  });
  router.post('/users/:id/:action',(req,res)=>{
    const actor=(req as any).administrator,user=store.getUser(req.params.id),action=req.params.action;
    if(!user)throw new ServiceError(404,'user_not_found','Account not found.');
    if(user.id===actor.id||store.role(user.id)==='owner')throw new ServiceError(400,'protected_account','Owner accounts are protected.');
    if(action==='ban'){
      const reason=String(req.body.reason||'Community rules violation.').slice(0,500),days=Math.max(0,Math.min(365,Number(req.body.days)||0)),expires=days?Date.now()+days*86400000:null;
      store.db.prepare('INSERT INTO account_bans VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,moderator_id=excluded.moderator_id,created_at=excluded.created_at').run(user.id,reason,expires,actor.id,Date.now());
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      for(const {room} of controls.rooms.values())for(const socket of room.playerSockets.filter(Boolean))if(socket.data.userId===user.id)socket.disconnect(true);
    }else if(action==='unban')store.db.prepare('DELETE FROM account_bans WHERE user_id=?').run(user.id);
    else if(action==='revoke-sessions')store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    else if(action==='role'){if(!['curator','member'].includes(req.body.role))throw new ServiceError(400,'invalid_role','Choose curator or member.');store.setRole(user.id,req.body.role==='curator'?'curator':null);}
    else throw new ServiceError(400,'invalid_action','Unknown account action.');
    audit(actor.id,'account.'+action,user.id,action==='role'?{role:req.body.role}:{});res.json({ok:true});
  });
  router.get('/maps',(req,res)=>{
    const query=String(req.query.q||'').slice(0,100),result=mapIndex(store,nativeCatalog).search({query,limit:100,includeData:false});
    const local=store.db.prepare(`SELECT m.id,m.name,u.username AS authorname,m.visibility FROM maps m JOIN users u ON u.id=m.owner_id WHERE (m.name LIKE ? OR u.username LIKE ?) AND NOT EXISTS(SELECT 1 FROM map_moderation x WHERE x.map_key='local:'||m.id AND x.hidden=1) ORDER BY m.updated_at DESC LIMIT 100`).all('%'+query+'%','%'+query+'%') as any[];
    const maps=new Map(result.maps.map((map:any)=>[map.mapKey,map]));
    for(const map of local)maps.set('local:'+map.id,{...map,mapKey:'local:'+map.id,kind:'local'});
    res.json({...result,maps:[...maps.values()],hidden:store.db.prepare('SELECT * FROM map_moderation WHERE hidden=1 ORDER BY updated_at DESC LIMIT 100').all()});
  });
  router.post('/maps/moderate',(req,res)=>{
    const key=String(req.body.key||'');if(!/^(?:local:[a-f0-9-]+|[12]:\d+)$/.test(key)||typeof req.body.hidden!=='boolean')throw new ServiceError(400,'invalid_map','Choose a map and visibility.');
    const actor=(req as any).administrator,reason=String(req.body.reason||'').slice(0,500);
    store.db.prepare('INSERT INTO map_moderation VALUES(?,?,?,?,?) ON CONFLICT(map_key) DO UPDATE SET hidden=excluded.hidden,reason=excluded.reason,moderator_id=excluded.moderator_id,updated_at=excluded.updated_at').run(key,req.body.hidden?1:0,reason,actor.id,Date.now());
    audit(actor.id,req.body.hidden?'map.hide':'map.restore',key,{reason});res.json({ok:true});
  });
  router.get('/reports',(_req,res)=>res.json({reports:store.listReplayReports((store.db.prepare("SELECT user_id FROM server_roles WHERE role='owner' LIMIT 1").get() as any).user_id)}));
  router.post('/reports/:id',(req,res)=>{const actor=(req as any).administrator;store.moderateReplay(actor.id,req.params.id,req.body.hidden,String(req.body.reason||'').slice(0,500));audit(actor.id,'replay.moderate',req.params.id,{hidden:req.body.hidden});res.json({ok:true});});
  router.get('/audit',(_req,res)=>res.json({events:store.db.prepare('SELECT a.*,u.username AS actor FROM moderation_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY created_at DESC LIMIT 100').all()}));
  router.post('/settings',(req,res)=>{
    const actor=(req as any).administrator;
    for(const key of ['registrationOpen','maintenance'])if(req.body[key]!==undefined){if(typeof req.body[key]!=='boolean')throw new ServiceError(400,'invalid_setting','Settings must be on or off.');store.db.prepare('INSERT INTO server_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(req.body[key]));audit(actor.id,'setting.change',key,{value:req.body[key]});}
    res.json({ok:true});
  });
  router.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(error instanceof ServiceError)return res.status(error.status).json({error:error.message});console.error('Administration request failed',error);res.status(500).json({error:'Could not complete the action. Please try again.'});});
  app.use('/api/admin',router);
}
