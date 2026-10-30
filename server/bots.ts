import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export const botDifficulties=['easy','normal','hard','expert'] as const;
/** Virtual native players. Their decisions travel in the host's normal rollback
 * admin stream; they never open paid browser instances or external AI services.
 */
class BotSocket {
  id='bot-'+randomUUID();connected=true;data:any={bot:true};
  handshake={address:'bot:'+this.id,headers:{}};conn=new EventEmitter();
  private events=new EventEmitter();private middleware:any[]=[];
  constructor(readonly room:any,readonly changed:()=>void){}
  on(event:string,fn:any){this.events.on(event,fn);return this;}
  once(event:string,fn:any){this.events.once(event,fn);return this;}
  use(fn:any){this.middleware.push(fn);}
  join(_room:string){}
  get broadcast(){return {emit:(event:string,...args:any[])=>this.room.io.to('main').emit(event,...args)};}
  emit(event:string,...args:any[]){if(event==='1')void this.receive('1',{id:args[1]});return true;}
  async receive(event:string,...args:any[]){const packet=[event,...args];for(const handler of this.middleware){let next=false;handler(packet,()=>next=true);if(!next)return;}for(const handler of this.events.listeners(event))await handler(...args);}
  disconnect(){if(!this.connected)return;this.connected=false;this.events.emit('disconnect','bot removed');this.events.removeAllListeners();this.changed();}
}
export class RoomBots {
  private sockets:BotSocket[]=[];
  private desired=0;
  private updating=false;
  difficulty:typeof botDifficulties[number]='normal';
  constructor(readonly room:any,readonly profile:()=>any) {
    room.io.on('connection',(socket:any)=>{
      socket.on('wb:bots',async(input:any,ack:any)=>{
        const reply=(value:any)=>typeof ack==='function'&&ack(value);
        if(room.playerSockets[room.hostId]?.id!==socket.id)return reply({error:'Only the room host can change bots.'});
        if(room.gameStartTime)return reply({error:'Return to the lobby before changing bots.'});
        if(!Number.isInteger(input?.count)||input.count<0||input.count>7||!botDifficulties.includes(input?.difficulty))return reply({error:'Choose 0–7 bots and a difficulty.'});
        const humans=room.playerSockets.filter((player:any)=>player&&!player.data.bot).length;
        if(input.count+humans>room.config.maxPlayers)return reply({error:'There are not enough open player slots.'});
        this.desired=input.count;this.difficulty=input.difficulty;await this.reconcile();reply({ok:true,bots:this.list(),difficulty:this.difficulty});
      });
      socket.on('13',()=>queueMicrotask(()=>this.publish()));
    });
  }
  list(){return this.sockets.filter(socket=>socket.connected&&socket.data.bonkId!==undefined).map(socket=>({id:socket.data.bonkId,difficulty:this.difficulty,name:this.room.playerInfo[socket.data.bonkId]?.userName}));}
  publish(){for(const socket of this.room.playerSockets.filter(Boolean))if(socket.data.bot)socket.data.modReady=this.profile().hash;this.room.io.to('main').emit('wb:bots',{bots:this.list(),difficulty:this.difficulty});}
  changed(){
    this.sockets=this.sockets.filter(socket=>socket.connected);
    const humans=this.room.playerSockets.filter((socket:any)=>socket&&!socket.data.bot);
    if(!humans.length){this.desired=0;for(const socket of [...this.sockets])socket.disconnect();this.sockets=[];}
    this.publish();
  }
  private async reconcile(){
    if(this.updating)return;this.updating=true;
    try{
      this.sockets=this.sockets.filter(socket=>socket.connected);
      while(this.sockets.length>this.desired)this.sockets.pop()!.disconnect();
      while(this.sockets.length<this.desired){
        const socket=new BotSocket(this.room,()=>this.changed());this.sockets.push(socket);this.room.connectSocket(socket);
        const names=new Set(this.room.playerInfo.filter(Boolean).map((player:any)=>player.userName));let number=1;while(names.has('Bot '+number))number++;
        await socket.receive('13',{userName:'Bot '+number,guest:true,level:0,roomPassword:this.room.password||'',avatar:{bc:[16755200,10070709,4308187,12800180][(number-1)%4],layers:[]},modProfile:this.profile().hash});
        if(socket.data.bonkId===undefined){socket.disconnect();throw Error('Could not allocate a bot player.');}
        socket.data.modReady=this.profile().hash;
      }
      this.publish();
    }finally{this.updating=false;}
  }
  dispose(){this.desired=0;for(const socket of [...this.sockets])socket.disconnect();this.sockets=[];}
}
