import http from 'node:http';
import { createApplication } from './application.ts';
import { serviceStore } from './store.ts';
const port=Number(process.env.PORT||3210),host=process.env.HOST||'127.0.0.1';
const redirect=process.env.TONK_REDIRECT_ORIGIN;
let game:Awaited<ReturnType<typeof createApplication>>|undefined;
let server:http.Server;
if(redirect){
 const destination=new URL(redirect);
 if(destination.protocol!=='https:'||destination.username||destination.password)throw Error('TONK_REDIRECT_ORIGIN must be an HTTPS origin.');
 server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/api/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,redirect:true}));return;}
  res.writeHead(307,{Location:destination.origin+(req.url?.startsWith('/')?req.url:'/')});res.end();
 });
}else{game=await createApplication();server=game.server;}
server.listen(port,host,()=>{const address=server.address();console.log(`Tonk.io http://${host}:${typeof address==='object'&&address?address.port:port}`);});
let stopping=false;
function shutdown(){if(stopping)return;stopping=true;const timeout=setTimeout(()=>process.exit(1),10000);timeout.unref();
 server.close(()=>{if(game)serviceStore.close();clearTimeout(timeout)});game?.dispose();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
