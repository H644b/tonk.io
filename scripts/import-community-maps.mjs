import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createNativeHarness } from './native-harness.mjs';
const converter=createNativeHarness(fs.readFileSync('public/game/js/alpha2s.local.js','utf8'));converter.native.constructors[61].mapVersion=15;
const folder='.deployment';fs.mkdirSync(folder,{recursive:true});
const sources=['picks.txt'];
for(const period of [0,1,2,3,4,5,6])for(const mode of ['hot','ar','sp','ard'])sources.push(`cache3_${period}_${mode}.txt`);
const maps=new Map(),feeds=[],rejected=[];
for(const file of sources){
  const url='https://bonk2.io/scripts/hotmaps/'+file;
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok){feeds.push({url,status:response.status});continue;}
  const result=await response.json();
  if(result.r!=='success'||!Array.isArray(result.maps))throw Error('Unexpected public map feed: '+file);
  let accepted=0;
  for(const source of result.maps){
    if(!/^\d+$/.test(String(source.id))||typeof source.name!=='string'||typeof source.authorname!=='string'||typeof source.leveldata!=='string'||!source.leveldata||source.leveldata.length>2*1024*1024)continue;
    const dbv=Number(source.dbv)===1?1:2;
    converter.context.source=source;converter.context.sourceDbv=dbv;
    let leveldata;try{leveldata=converter.run(`(()=>{let map=sourceDbv===1?__native.mapEncoder.fromOldString(source.leveldata):__native.mapEncoder.decodeFromDatabase(source.leveldata);if(!map.physics?.shapes||!Array.isArray(map.spawns))throw Error('Invalid map geometry');return sourceDbv===1?__native.mapEncoder.encodeToDatabase(map):source.leveldata})()`);}catch(error){rejected.push({id:source.id,dbv,name:source.name,error:String(error)});continue;}
    const id=dbv+':'+source.id;
    const entry={id,dbv,source_id:String(source.id),name:source.name.slice(0,200),authorname:source.authorname.slice(0,100),leveldata,
      category:/_(?:ar|ard)\.txt$/.test(file)?'arrowMapStrings':/_sp\.txt$/.test(file)?'grappleMapStrings':'mapStrings',vu:Math.max(0,Number(source.vu)||0),vd:Math.max(0,Number(source.vd)||0),published_at:String(source.publisheddate||''),source_url:url,updated_at:Date.now()};
    const old=maps.get(id);if(!old||entry.vu>old.vu)maps.set(id,entry);accepted++;
  }
  feeds.push({url,status:response.status,maps:accepted});
  console.log(file,accepted,'maps;',maps.size,'unique');
  await new Promise(resolve=>setTimeout(resolve,800));
}
const entries=[...maps.values()];
fs.writeFileSync(folder+'/community-maps.json',JSON.stringify(entries));
fs.writeFileSync(folder+'/community-import-proof.json',JSON.stringify({at:new Date().toISOString(),maps:entries.length,feeds,rejected,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')},null,2));
if(process.argv.includes('--apply')){
  const env=JSON.parse(fs.readFileSync(folder+'/supabase-secrets.json'));
  const request=async(route,body)=>{const response=await fetch(env.SUPABASE_URL+'/rest/v1/'+route,{method:body?'POST':'GET',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('Supabase import failed '+response.status);return response.json();};
  let revision=Number((await request('bonk_state?select=revision&id=eq.main'))[0].revision);
  const existing=[];
  for(let offset=0;;offset+=500){const page=await request('bonk_records?select=kind,row_key&kind=eq.community_maps&order=row_key&offset='+offset+'&limit=500');existing.push(...page);if(page.length<500)break;}
  if(existing.length)revision=Number(await request('rpc/bonk_apply_changes',{expected_revision:revision,changes:existing.map(row=>({...row,payload:null}))}));
  for(let offset=0;offset<entries.length;offset+=50){revision=Number(await request('rpc/bonk_apply_changes',{expected_revision:revision,changes:entries.slice(offset,offset+50).map(payload=>({kind:'community_maps',row_key:JSON.stringify([payload.id]),payload}))}));}
  console.log('Imported',entries.length,'public maps into Supabase. Revision',revision);
}
