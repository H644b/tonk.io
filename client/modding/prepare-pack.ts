import * as compiler from 'esbuild-wasm';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { validateManifest, validatePath } from '../../shared/modkit.ts';
let initialized: Promise<void> | undefined;
export async function prepareHostPack(archive: Blob, maxBytes = 64*1024*1024): Promise<Blob> {
  let total=0,count=0;
  const files=unzipSync(new Uint8Array(await archive.arrayBuffer()),{filter(file){
    if(file.name.endsWith('/'))return false;
    validatePath(file.name);total+=file.originalSize;
    if(total>maxBytes||++count>2048)throw Error('Expanded pack exceeds limits.');
    return true;
  }});
  files['bonk.mod.json']??=files['tonk.mod.json'];
  if(!files['bonk.mod.json'])throw Error('Archive root must contain tonk.mod.json.');
  const manifest=validateManifest(JSON.parse(strFromU8(files['bonk.mod.json'])));
  if(!manifest.entrypoints.client||manifest.entrypoints.server)throw Error('Room uploads require client-only packs.');
  initialized??=compiler.initialize({wasmURL:'/modding/esbuild.wasm',worker:true});
  await initialized;
  const normalize=(directory:string,file:string)=>{
    const parts:string[]=[];
    for(const part of (directory+'/'+file).split('/')){
      if(!part||part==='.')continue;
      if(part==='..'){if(!parts.length)throw Error('Import escapes the pack.');parts.pop();}
      else parts.push(part);
    }
    return parts.join('/');
  };
  const result=await compiler.build({
    entryPoints:[manifest.entrypoints.client],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',legalComments:'none',
    plugins:[{name:'pack-files',setup(build){
      build.onResolve({filter:/.*/},args=>{
        if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw Error('Bundle dependencies inside the pack.');
        const base=normalize(args.resolveDir||'',args.path);
        const resolved=[base,base+'.js',base+'.ts',base+'.tsx',base+'.jsx',base+'.json',base+'/index.js',base+'/index.ts'].find(name=>files[name]);
        if(!resolved)throw Error('Missing pack module: '+base);
        return {path:resolved,namespace:'pack'};
      });
      build.onLoad({filter:/.*/,namespace:'pack'},args=>({contents:files[args.path],resolveDir:args.path.split('/').slice(0,-1).join('/'),loader:({ts:'ts',tsx:'tsx',jsx:'jsx',json:'json'} as const)[args.path.split('.').pop() as 'ts']||'js'}));
    }}],
  });
  files['.build/client.js']=new Uint8Array(result.outputFiles![0].contents);
  files['.build/prepared.json']=new TextEncoder().encode(JSON.stringify({api:2,compiler:'esbuild',version:compiler.version}));
  return new Blob([zipSync(files)],{type:'application/octet-stream'});
}
