import { EventEmitter } from 'node:events';
import { Encoder, Decoder, PacketType } from 'socket.io-parser';
import { randomUUID } from 'node:crypto';

/** Engine.IO 3/4 + Socket.IO protocol adapter over Workers WebSocketPair.
 * Native room handlers remain shared with the Node server. No Node upgrade socket
 * is used: workerd deliberately does not implement that Node HTTP API.
 */
export class WorkerSocket {
  readonly id = randomUUID();
  data: Record<string,any> = {};
  connected = true;
  readonly rooms = new Set<string>();
  readonly conn = new EventEmitter();
  private readonly events = new EventEmitter();
  private readonly decoder = new Decoder();
  private readonly encoder = new Encoder();
  private readonly middleware: ((packet:any[],next:()=>void)=>void)[] = [];
  private started = false;
  private bytes = 0;
  private lastSeen = Date.now();
  readonly handshake: { address: string; headers: Record<string,string> };
  constructor(readonly owner: WorkerSocketServer, readonly ws: WebSocket, request: Request, readonly protocol: 3|4) {
    this.handshake = { address: request.headers.get('CF-Connecting-IP') || '127.0.0.1',headers:Object.fromEntries(request.headers) };
    this.events.setMaxListeners(100);
    this.decoder.on('decoded', packet => void owner.enqueue(async()=>this.packet(packet)).catch(error=>{console.error('Socket handler failed',error);this.disconnect();}));
    ws.addEventListener('message', event => this.receive(event.data));
    ws.addEventListener('close', ()=>void owner.enqueue(async()=>this.disconnect(false)).catch(console.error));
    ws.addEventListener('error', ()=>void owner.enqueue(async()=>this.disconnect(false)).catch(console.error));
    this.send('0'+JSON.stringify({sid:this.id,upgrades:[],pingInterval:20000,pingTimeout:30000,maxPayload:2*1024*1024}));
    if(protocol===3)this.start();
  }
  start(){
    if(this.started)return;
    this.started=true;
    this.send(this.protocol===3?'40':'40'+JSON.stringify({sid:this.id}));
    this.owner.connect(this);
  }
  on(event: string, fn: (...args:any[])=>any){this.events.on(event,fn);return this;}
  once(event: string, fn: (...args:any[])=>any){this.events.once(event,fn);return this;}
  off(event: string, fn: (...args:any[])=>any){this.events.off(event,fn);return this;}
  use(fn:(packet:any[],next:()=>void)=>void){this.middleware.push(fn);return this;}
  join(room:string){this.rooms.add(room);}
  leave(room:string){this.rooms.delete(room);}
  get broadcast(){return {emit:(event:string,...args:any[])=>this.owner.broadcast(event,args,undefined,this)};}
  emit(event:string,...args:any[]){this.encode({type:PacketType.EVENT,nsp:'/',data:[event,...args]});return true;}
  private send(data:string|ArrayBuffer|Uint8Array){try{if(this.connected)this.ws.send(data);}catch{this.disconnect(false);}}
  private encode(packet:any){
    for(const frame of this.encoder.encode(packet)){
      if(typeof frame==='string')this.send('4'+frame);
      else if(this.protocol===3){const bytes=new Uint8Array(frame.buffer||frame,frame.byteOffset||0,frame.byteLength);const out=new Uint8Array(bytes.length+1);out[0]=4;out.set(bytes,1);this.send(out);}
      else this.send(frame);
    }
  }
  private receive(data:string|ArrayBuffer){
    this.lastSeen=Date.now();
    try{
      this.bytes+=typeof data==='string'?new TextEncoder().encode(data).length:data.byteLength;
      if(this.bytes>2*1024*1024+65536)throw Error('Socket packet too large');
      if(typeof data==='string'){
        if(data[0]==='2'){this.bytes=0;this.send('3'+data.slice(1));return;}
        if(data[0]==='3'){this.bytes=0;return;}
        if(data[0]==='1'){this.disconnect();return;}
        if(data[0]!=='4')return;
        if(data==='40'&&!this.started){this.bytes=0;this.start();return;}
        this.conn.emit('packet',{type:'message',data:data.slice(1)});
        this.decoder.add(data.slice(1));
      }else{
        const bytes=new Uint8Array(data);
        this.decoder.add(this.protocol===3?bytes.slice(1).buffer:data);
      }
    }catch{this.disconnect();}
  }
  private async packet(packet:any){
    this.bytes=0;
    if(packet.type===PacketType.CONNECT){this.start();return;}
    if(packet.type===PacketType.DISCONNECT){this.disconnect();return;}
    if(packet.nsp!=='/'||![PacketType.EVENT,PacketType.BINARY_EVENT].includes(packet.type)||!Array.isArray(packet.data)||!['string','number'].includes(typeof packet.data[0]))return;
    const args=[...packet.data];args[0]=String(args[0]);
    for(const middleware of this.middleware){let accepted=false;middleware(args,()=>{accepted=true});if(!accepted)return;}
    const [event,...values]=args;
    let replied=false;
    if(packet.id!==undefined)values.push((...reply:any[])=>{if(replied)return;replied=true;this.encode({type:PacketType.ACK,nsp:'/',id:packet.id,data:reply});});
    for(const listener of this.events.listeners(event))await listener(...values);
  }
  heartbeat(){if(Date.now()-this.lastSeen>60000)this.disconnect();else if(this.protocol===4)this.send('2');}
  disconnect(close=true){
    if(!this.connected)return;
    this.connected=false;
    this.decoder.destroy();
    this.owner.remove(this);
    this.events.emit('disconnect','transport close');
    this.events.removeAllListeners();
    if(close)try{this.ws.close(1000,'Disconnected');}catch{}
    return this;
  }
}

export class WorkerSocketServer {
  private readonly events = new EventEmitter();
  readonly clients=new Map<string,WorkerSocket>();
  readonly engine={close:()=>{clearInterval(this.timer);this.disconnectSockets();}};
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly enqueue:<T>(fn:()=>Promise<T>)=>Promise<T>){this.timer=setInterval(()=>{for(const socket of this.clients.values())socket.heartbeat()},20000);}
  on(event:string,fn:(socket:any)=>void){this.events.on(event,fn);return this;}
  connect(socket:WorkerSocket){this.clients.set(socket.id,socket);this.events.emit('connection',socket);}
  remove(socket:WorkerSocket){this.clients.delete(socket.id);}
  emit(event:string,...args:any[]){this.broadcast(event,args);}
  to(room:string){return {emit:(event:string,...args:any[])=>this.broadcast(event,args,room)};}
  broadcast(event:string,args:any[],room?:string,except?:WorkerSocket){for(const socket of this.clients.values())if(socket!==except&&(!room||socket.rooms.has(room)))socket.emit(event,...args);}
  disconnectSockets(_force=true){for(const socket of [...this.clients.values()])socket.disconnect();}
  upgrade(request:Request):Response{
    const version=new URL(request.url).searchParams.get('EIO');
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket'||!['3','4'].includes(version||''))return Response.json({error:'WebSocket transport required.'},{status:400});
    const pair=new WebSocketPair();pair[1].accept();
    new WorkerSocket(this,pair[1],request,Number(version) as 3|4);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
}
