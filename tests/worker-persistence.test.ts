import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {SupabasePersistence} from '../workers/persistence.ts';
test('Worker persistence excludes runtime metadata and recovers rejected writes from the canonical revision',async t=>{
 const db=new DatabaseSync(':memory:');let revision=1;let canonical:any[]=[{kind:'users',row_key:'["owner"]',payload:{id:'owner',name:'H644b'}}];const batches:any[]=[];let reject=false;
 const storage:any={sql:{exec(statement:string,...args:any[]){if(!args.length&&!/^\s*(SELECT|PRAGMA)\b/i.test(statement)){db.exec(statement);return [];}return db.prepare(statement).all(...args);}},transactionSync(fn:any){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value}catch(error){db.exec('ROLLBACK');throw error}}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;db.close()});
 globalThis.fetch=(async(url:any,init:any)=>{const path=String(url);if(path.includes('rpc/')){const body=JSON.parse(init.body);batches.push(body.changes);if(reject||body.expected_revision!==revision)return Response.json({error:'conflict'},{status:409});for(const change of body.changes){canonical=canonical.filter(row=>row.kind!==change.kind||row.row_key!==change.row_key);if(change.payload)canonical.push(change)}return Response.json(++revision)}if(path.includes('bonk_state'))return Response.json([{revision}]);return Response.json(canonical)}) as any;
 const persistence=new SupabasePersistence(storage,{SUPABASE_URL:'https://example.invalid',SUPABASE_SECRET_KEY:'test'});
 persistence.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE __miniflare_do_name(id TEXT PRIMARY KEY,name TEXT);INSERT INTO __miniflare_do_name VALUES('main','runtime only');");
 persistence.trackTables();await persistence.initialize();assert.equal(persistence.db.prepare('SELECT name FROM users').get().name,'H644b');assert.equal(persistence.db.prepare('SELECT name FROM __miniflare_do_name').get().name,'runtime only');
 persistence.db.prepare('UPDATE users SET name=? WHERE id=?').run('Saved','owner');await persistence.flush();assert.equal(canonical[0].payload.name,'Saved');assert.ok(batches.flat().every(row=>!row.kind.startsWith('_')));
 reject=true;persistence.db.prepare('UPDATE users SET name=? WHERE id=?').run('Uncommitted','owner');await assert.rejects(()=>persistence.flush());assert.equal(persistence.db.prepare('SELECT name FROM users').get().name,'Saved');assert.equal(persistence.db.prepare('SELECT COUNT(*) AS n FROM _mirror_outbox').get().n,0);
});
