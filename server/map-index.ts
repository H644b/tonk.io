import type { ServiceStore } from './store.ts';
import type { CatalogMap } from './catalog.ts';
type Entry={key:string;id:string;dbv:number;name:string;authorname:string;category:string;vu:number;vd:number;kind:'bundled'|'community'|'local';owner?:string;visibility?:string;map?:CatalogMap;updatedAt:number;nameLower:string;authorLower:string};
const grams=(text:string)=>[...new Set(Array.from({length:Math.max(0,text.length-2)},(_,i)=>text.slice(i,i+3)))];
const indexes=new WeakMap<ServiceStore,MapIndex>();
export function mapIndex(store:ServiceStore,bundled:CatalogMap[]){let index=indexes.get(store);if(!index){index=new MapIndex(store,bundled);indexes.set(store,index);}return index;}
/** Search uses metadata and trigram intersections, then fetches only the requested
 * page's geometry. Ratings/favorites are grouped once instead of queried per map.
 */
export class MapIndex {
  private revision=-1;
  private entries:Entry[]=[];
  private nameGrams=new Map<string,Set<number>>();
  private authorGrams=new Map<string,Set<number>>();
  private queries=new Map<string,Entry[]>();
  constructor(readonly store:ServiceStore,readonly bundled:CatalogMap[]){
    store.db.exec('CREATE TABLE IF NOT EXISTS _cache_catalog_revision(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL); INSERT OR IGNORE INTO _cache_catalog_revision VALUES(1,0);');
    for(const table of ['maps','map_ratings','map_favorites','community_maps','map_moderation','catalog_ratings','catalog_favorites','map_plays'])for(const phase of ['INSERT','UPDATE','DELETE'])
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS _cache_catalog_${table}_${phase} AFTER ${phase} ON ${table} BEGIN UPDATE _cache_catalog_revision SET revision=revision+1 WHERE id=1; END;`);
  }
  private sync(){
    const revision=Number((this.store.db.prepare('SELECT revision FROM _cache_catalog_revision WHERE id=1').get() as any).revision);
    if(revision===this.revision)return;
    const records=new Map<string,Entry>();
    for(const map of this.bundled){const dbv=map.sourceDbv??map.dbv,key=`${dbv}:${map.id}`;if(records.has(key))continue;records.set(key,{key,id:String(map.id),dbv,name:map.name,authorname:map.authorname,category:map.category,vu:0,vd:0,kind:'bundled',map,updatedAt:0,nameLower:map.name.toLowerCase(),authorLower:map.authorname.toLowerCase()});}
    const social=new Map<string,{vu:number;vd:number}>();
    for(const row of this.store.db.prepare('SELECT source_dbv,source_id,SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) AS vu,SUM(CASE WHEN rating=-1 THEN 1 ELSE 0 END) AS vd FROM catalog_ratings GROUP BY source_dbv,source_id').all() as any[])
      social.set(`${row.source_dbv}:${row.source_id}`,{vu:Number(row.vu),vd:Number(row.vd)});
    for(const row of this.store.db.prepare('SELECT id,dbv,source_id,name,authorname,category,vu,vd,updated_at FROM community_maps').all() as any[]){const key=`${row.dbv}:${row.source_id}`;records.set(key,{key,id:String(row.source_id),dbv:row.dbv,name:row.name,authorname:row.authorname,category:row.category,vu:row.vu,vd:row.vd,kind:'community',updatedAt:row.updated_at,nameLower:row.name.toLowerCase(),authorLower:row.authorname.toLowerCase()});}
    for(const entry of records.values()){const votes=social.get(entry.key);if(votes){entry.vu+=votes.vu;entry.vd+=votes.vd;}}
    for(const row of this.store.db.prepare(`SELECT m.id,m.owner_id,m.name,m.visibility,m.updated_at,u.username,
      COALESCE(SUM(CASE WHEN r.rating=1 THEN 1 ELSE 0 END),0) AS vu,COALESCE(SUM(CASE WHEN r.rating=-1 THEN 1 ELSE 0 END),0) AS vd
      FROM maps m JOIN users u ON u.id=m.owner_id LEFT JOIN map_ratings r ON r.map_id=m.id WHERE json_type(m.data)='text' GROUP BY m.id`).all() as any[]){
      const id=String(this.store.nativeId('map',row.id)),key='local:'+row.id;
      records.set(key,{key,id,dbv:2,name:row.name,authorname:row.username,category:'mapStrings',vu:Number(row.vu),vd:Number(row.vd),kind:'local',owner:row.owner_id,visibility:row.visibility,updatedAt:row.updated_at,nameLower:row.name.toLowerCase(),authorLower:row.username.toLowerCase()});
    }
    const hidden=new Set((this.store.db.prepare('SELECT map_key FROM map_moderation WHERE hidden=1').all() as any[]).map(row=>row.map_key));
    this.entries=[...records.values()].filter(row=>!hidden.has(row.key));
    this.nameGrams.clear();this.authorGrams.clear();this.queries.clear();
    this.entries.forEach((entry,index)=>{for(const [text,map] of [[entry.nameLower,this.nameGrams],[entry.authorLower,this.authorGrams]] as const)for(const gram of grams(text)){let ids=map.get(gram);if(!ids)map.set(gram,ids=new Set());ids.add(index);}});
    this.revision=revision;
  }
  private candidates(query:string,name:boolean,author:boolean){
    if(query.length<3)return this.entries;
    const terms=grams(query);
    const candidates=(index:Map<string,Set<number>>)=>{const sets=terms.map(term=>index.get(term)||new Set<number>()).sort((a,b)=>a.size-b.size);return [...sets[0]].filter(id=>sets.every(set=>set.has(id)));};
    const ids=new Set<number>([...(name?candidates(this.nameGrams):[]),...(author?candidates(this.authorGrams):[])]);
    return [...ids].map(id=>this.entries[id]);
  }
  search(options:{query?:string;name?:boolean;author?:boolean;sort?:string;offset?:number;limit?:number;viewerId?:string;category?:string;includeData?:boolean}={}){
    this.sync();
    const query=String(options.query||'').toLowerCase().trim().slice(0,100),name=options.name!==false,author=options.author!==false;
    const key=JSON.stringify([query,name,author,options.sort,options.viewerId,options.category]);
    let rows=this.queries.get(key);
    if(!rows){rows=this.candidates(query,name,author).filter(row=>(row.kind!=='local'||row.visibility==='public'||row.owner===options.viewerId)&&(!options.category||row.category===options.category)&&(!query||(name&&row.nameLower.includes(query))||(author&&row.authorLower.includes(query))));
      rows.sort(options.sort==='recent'?(a,b)=>b.updatedAt-a.updatedAt:(a,b)=>(b.vu-b.vd)-(a.vu-a.vd)||b.updatedAt-a.updatedAt||a.name.localeCompare(b.name));
      if(this.queries.size>=128)this.queries.delete(this.queries.keys().next().value!);this.queries.set(key,rows);
    }
    const offset=Math.max(0,Math.min(100000,Math.trunc(options.offset||0))),limit=Math.min(200,Math.max(1,options.limit||32));
    const selected=rows.slice(offset,offset+limit),community=new Map<string,any>();
    if(options.includeData!==false){const ids=selected.filter(row=>row.kind==='community').map(row=>row.key);for(let start=0;start<ids.length;start+=80){const chunk=ids.slice(start,start+80);for(const row of this.store.db.prepare(`SELECT * FROM community_maps WHERE id IN(${chunk.map(()=>'?').join(',')})`).all(...chunk) as any[])community.set(row.id,row);}}
    const maps=selected.map(entry=>{
      const base={id:entry.id,name:entry.name,authorname:entry.authorname,dbv:2,sourceDbv:entry.dbv,vu:entry.vu,vd:entry.vd,published:1,public:1,category:entry.category,creationdate:'',publisheddate:'',updatedAt:entry.updatedAt};
      if(options.includeData===false)return {...base,mapKey:entry.key,kind:entry.kind};
      if(entry.kind==='bundled')return {...entry.map,...base,source:{kind:'bundled-original-client',author:entry.authorname,url:'https://bonk.io/'}};
      if(entry.kind==='community'){const row=community.get(entry.key);return {...base,leveldata:row.leveldata,publisheddate:row.published_at,source:{kind:'bonk-community',author:row.authorname,url:row.source_url}};}
      const map=this.store.getMap(entry.key.slice(6),options.viewerId);return {...base,leveldata:map.data,public:map.visibility==='public'?1:0,source:{kind:'local-server',author:entry.authorname}};
    });
    return {maps,total:rows.length,more:offset+selected.length<rows.length};
  }
}

export function importedMap(store:ServiceStore,dbv:unknown,id:unknown):CatalogMap|undefined{
  const row=store.db.prepare('SELECT * FROM community_maps WHERE dbv=? AND source_id=?').get(Number(dbv),String(id)) as any;
  if(!row)return;
  if((store.db.prepare('SELECT hidden FROM map_moderation WHERE map_key=?').get(row.id) as any)?.hidden)return;
  return {id:String(row.source_id),dbv:2,sourceDbv:row.dbv,name:row.name,authorname:row.authorname,leveldata:row.leveldata,category:row.category};
}
