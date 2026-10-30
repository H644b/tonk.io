import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApplication } from '../server/application.ts';
import { ServiceStore } from '../server/store.ts';
import { CloudFiles } from '../server/modding/persistence.ts';
import { ModRepository } from '../server/modding/repository.ts';
import { ModServer } from '../server/modding/runtime.ts';
import { SupabasePersistence, type PersistenceEnv } from './persistence.ts';
import { WorkerSocketServer } from './transport.ts';
import { serverModules } from './server-modules.generated.ts';

interface Env extends PersistenceEnv { ASSETS: Fetcher; GAME: DurableObjectNamespace<GameServer>; }
export class GameServer extends DurableObject<Env> {
  private game!: Awaited<ReturnType<typeof createApplication>>;
  private persistence!: SupabasePersistence;
  private handler!: {fetch(request:Request): Promise<Response>};
  private queue: Promise<unknown> = Promise.resolve();
  private initialized: Promise<void>;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    this.initialized=ctx.blockConcurrencyWhile(async()=>{
      this.persistence=new SupabasePersistence(ctx.storage,env);
      const store=new ServiceStore(':memory:',this.persistence.db);
      const files=new CloudFiles(this.persistence.db);
      this.persistence.trackTables();
      await this.persistence.initialize();
      const repository=new ModRepository('/tmp/bonk-mods',false,files);
      const modServer=new ModServer(repository,{maxPackBytes:8*1024*1024,loadModule:async pack=>{
        const module=serverModules[pack.manifest.id+'@'+pack.manifest.version];
        if(!module)throw Error('Server pack must be included in the Worker deployment: '+pack.manifest.id);
        return module;
      }});
      this.game=await createApplication({store,repository,modServer,skipStatic:true,socketServer:()=>new WorkerSocketServer(fn=>this.serial(fn)) as any});
      this.game.app.set('trust proxy','loopback,linklocal,uniquelocal');
      this.handler=httpServerHandler(this.game.server as any) as any;
      this.persistence.trackTables();
      await this.persistence.flush();
    });
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{
    const pending=this.queue.then(async()=>{const value=await fn();await this.persistence.flush();return value;});
    this.queue=pending.catch(()=>{});return pending;
  }
  async fetch(request:Request):Promise<Response>{
    try{
      await this.initialized;
      return await this.serial(async()=>{
        const url=new URL(request.url);
        const headers=new Headers(request.headers);
        headers.set('X-Forwarded-For',request.headers.get('CF-Connecting-IP')||'127.0.0.1');
        headers.set('X-Forwarded-Proto',url.protocol==='https:'?'https':'http');
        const forwarded=new Request(request,{headers});
        const match=/^\/rooms\/([^/]+)\/socket\.io\//.exec(url.pathname);
        if(match){
          const room=this.game.rooms.get(match[1]);
          return room?(room.room.io as any as WorkerSocketServer).upgrade(forwarded):Response.json({error:'Room not found.'},{status:404});
        }
        return this.handler.fetch(forwarded);
      });
    }catch(error){console.error('Game request failed',error);return Response.json({error:'The service is temporarily unavailable. Please try again.'},{status:503,headers:{'Retry-After':'5'}});}
  }
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/api/platform')return Response.json({hosting:'cloudflare',persistence:'supabase',packCompiler:'browser',maxPackBytes:8*1024*1024});
    const backend=/^\/(?:api|compat|rooms|roompacks|modpacks)(?:\/|$)/.test(url.pathname);
    if(backend){
      const origin=request.headers.get('Origin');
      if(origin&&origin!==url.origin)return Response.json({error:'Use this server’s page.'},{status:403});
      return env.GAME.get(env.GAME.idFromName('main')).fetch(request);
    }
    const response=await env.ASSETS.fetch(request);
    if(url.pathname==='/enhancements/mod-worker.js'){
      const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'");return new Response(response.body,{status:response.status,headers});
    }
    return response;
  },
};
