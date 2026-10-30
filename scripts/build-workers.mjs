import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
const require=createRequire(import.meta.url);
import { build } from 'esbuild';
const root=process.cwd();
const generated='workers/server-modules.generated.ts';
const directory=process.env.BONK_MODS_DIR||'mods';
const enabled=fs.existsSync(path.join(directory,'enabled.json'))?JSON.parse(fs.readFileSync(path.join(directory,'enabled.json'))).enabled||[]:[];
const imports=[],modules=[];
for(const [i,spec] of enabled.entries()){
  const separator=spec.lastIndexOf('@'),id=spec.slice(0,separator),version=spec.slice(separator+1);
  const file=path.resolve(directory,'installed',id,version,'.build/server.mjs');
  if(!fs.existsSync(file))continue;
  imports.push(`import * as module${i} from ${JSON.stringify('../'+path.relative(root,file).split(path.sep).join('/'))};`);
  modules.push(`${JSON.stringify(spec)}:module${i}`);
}
fs.writeFileSync(generated,imports.join('\n')+`\nexport const serverModules:Record<string,any>={${modules.join(',')}};\n`);
await build({entryPoints:['client/modding/workbench.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',outfile:'public/modding/workbench.js',sourcemap:true});
fs.copyFileSync('node_modules/esbuild-wasm/esbuild.wasm','public/modding/esbuild.wasm');
await build({entryPoints:['workers/index.ts'],bundle:true,platform:'node',target:'es2022',format:'esm',outfile:'dist/worker.mjs',sourcemap:true,
  external:['cloudflare:*','node:*',...builtinModules],
  banner:{js:'import { createRequire as __workerCreateRequire } from "node:module"; const require=__workerCreateRequire("/bundle/worker.mjs");'},
  define:{'process.env.NODE_ENV':'"production"'},
  plugins:[{name:'worker-platform-adapters',setup(builder){
    builder.onResolve({filter:/^(express|cors|moment|chalk|columnify|word-wrap)$/},args=>({path:require.resolve(args.path)}));
    builder.onResolve({filter:/^(?:node:sqlite|libsql|esbuild|socket\.io)$/},args=>({path:args.path,namespace:'worker-adapter'}));
    builder.onLoad({filter:/.*/,namespace:'worker-adapter'},args=>{
      if(args.path==='esbuild')return {contents:`export {build} from ${JSON.stringify(path.resolve('workers/compiler-shim.ts'))};`,resolveDir:root,loader:'ts'};
      if(args.path==='socket.io')return {contents:'export class Server { constructor(){throw Error("Supply the Worker WebSocket adapter")}}'};
      return {contents:fs.readFileSync('workers/database-shim.ts','utf8'),resolveDir:path.resolve('workers'),loader:'ts'};
    });
    builder.onResolve({filter:/\/database\.(?:ts|js)$|^\.\/database\.(?:ts|js)$|^\.\.\/database\.ts$/},args=>({path:path.resolve('workers/database-shim.ts')}));
    builder.onLoad({filter:/server\/(catalog|application)\.ts$/},args=>{
      let source=fs.readFileSync(args.path,'utf8');
      source=source.replace(/JSON\.parse\(readFileSync\(new URL\('\.\.\/evidence\/protocol\/([^']+)', import\.meta\.url\), 'utf8'\)\)/g,(_m,file)=>fs.readFileSync('evidence/protocol/'+file,'utf8'));
      source=source.replace(/JSON\.parse\(\s*fs\.readFileSync\(\s*new URL\("\.\.\/evidence\/protocol\/([^\"]+)", import\.meta\.url\),\s*"utf8",?\s*\),?\s*\)/g,(_m,file)=>fs.readFileSync('evidence/protocol/'+file,'utf8'));
      return {contents:source,resolveDir:path.dirname(args.path),loader:'ts'};
    });
  }}],
});
console.log('Built Cloudflare Worker with native game services and Supabase persistence.');
