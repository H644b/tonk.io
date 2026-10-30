import { Buffer } from 'node:buffer';
import type { DurableObjectStorage } from '@cloudflare/workers-types';

type Row = Record<string, any>;
type Change = { kind: string; row_key: string; payload: Row | null };
export interface PersistenceEnv { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string; }
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const decode = (value: any): any => value && typeof value === 'object' && typeof value.$bytes === 'string' ? Buffer.from(value.$bytes, 'hex') : value;

/** Synchronous SQL query cache; only Supabase-committed rows survive recovery.
 * One Durable Object serializes writers. A revision check prevents split writers.
 * Row triggers capture cascades and deletes, without scanning entire tables.
 */
export class SupabasePersistence {
  readonly db: any;
  private revision = 0;
  constructor(readonly storage: DurableObjectStorage, readonly env: PersistenceEnv) {
    const sql = storage.sql;
    this.db = {
      exec: (statement: string) => { sql.exec(statement); },
      prepare: (statement: string) => ({
        all: (...args: any[]) => [...sql.exec(statement, ...args.map(this.binding))].map(this.row),
        get: (...args: any[]) => { const rows = [...sql.exec(statement, ...args.map(this.binding))]; return rows.length ? this.row(rows[0]) : undefined; },
        run: (...args: any[]) => { sql.exec(statement, ...args.map(this.binding)); const row = [...sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')][0]; return row; },
      }),
      close() {},
      transactionSync: <T>(fn: () => T): T => storage.transactionSync(fn),
    };
    sql.exec(`CREATE TABLE IF NOT EXISTS _mirror_meta(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _mirror_control(id INTEGER PRIMARY KEY, restoring INTEGER NOT NULL);
      INSERT OR IGNORE INTO _mirror_control VALUES(1, 0);
      CREATE TABLE IF NOT EXISTS _mirror_outbox(kind TEXT NOT NULL, row_key TEXT NOT NULL, payload TEXT, PRIMARY KEY(kind,row_key));`);
  }
  private binding(value: any) { return value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value; }
  private row(row: Row): Row { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? Buffer.from(value) : value])); }
  private tables(): string[] { return [...this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_*' ORDER BY rowid")].map(row => String(row.name)); }
  trackTables() {
    for (const table of this.tables()) {
      const columns = [...this.storage.sql.exec(`PRAGMA table_info(${quote(table)})`)];
      const keys = columns.filter(column => Number(column.pk) > 0).sort((a,b) => Number(a.pk)-Number(b.pk));
      if (!keys.length) throw Error('Persistent table needs a primary key: ' + table);
      const rowKey = (prefix: string) => `json_array(${keys.map(column => prefix + '.' + quote(String(column.name))).join(',')})`;
      const payload = `json_object(${columns.map(column => {
        const field = 'NEW.' + quote(String(column.name));
        return `${literal(String(column.name))},CASE WHEN typeof(${field})='blob' THEN json_object('$bytes',hex(${field})) ELSE ${field} END`;
      }).join(',')})`;
      for (const phase of ['INSERT','UPDATE','DELETE']) {
        const prefix = phase === 'DELETE' ? 'OLD' : 'NEW';
        this.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${quote('_mirror_' + table + '_' + phase)} AFTER ${phase} ON ${quote(table)}
          WHEN (SELECT restoring FROM _mirror_control WHERE id=1)=0 BEGIN
          INSERT INTO _mirror_outbox(kind,row_key,payload) VALUES(${literal(table)},${rowKey(prefix)},${phase === 'DELETE' ? 'NULL' : payload})
          ON CONFLICT(kind,row_key) DO UPDATE SET payload=excluded.payload;
          END;`);
      }
    }
  }
  private async request(route: string, init: RequestInit = {}) {
    const response = await fetch(this.env.SUPABASE_URL + '/rest/v1/' + route, {
      ...init, headers: { apikey: this.env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) { console.error('Supabase request failed', response.status, route.split('?')[0]); throw Error('Saved content is temporarily unavailable.'); }
    return response.status === 204 ? undefined : await response.json() as any;
  }
  async initialize() {
    const rows = await this.request('bonk_state?select=revision&id=eq.main');
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('Supabase persistence has not been provisioned.');
    const revision = Number(rows[0].revision);
    const local = this.db.prepare('SELECT revision FROM _mirror_meta WHERE id=1').get();
    const pending = this.db.prepare('SELECT count(*) AS n FROM _mirror_outbox').get().n;
    if (!local || Number(local.revision) !== revision || pending) await this.restore(revision);
    else this.revision = revision;
  }
  private async restore(revision: number) {
    const rows: Change[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.request(`bonk_records?select=kind,row_key,payload&order=kind,row_key&offset=${offset}&limit=500`);
      if (!Array.isArray(page)) throw Error('Invalid saved content response.');
      rows.push(...page); if (page.length < 500) break;
    }
    const after = await this.request('bonk_state?select=revision&id=eq.main');
    if (Number(after?.[0]?.revision) !== revision) throw Error('Saved content changed during recovery. Retry shortly.');
    const tables = this.tables();
    const allowed = new Set(tables);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('PRAGMA defer_foreign_keys=ON; UPDATE _mirror_control SET restoring=1 WHERE id=1;');
      for (const table of [...tables].reverse()) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      for (const table of tables) for (const row of rows.filter(row => row.kind === table)) {
        if (!row.payload || !allowed.has(row.kind)) throw Error('Unknown saved content table.');
        const columns = Object.keys(row.payload);
        this.storage.sql.exec(`INSERT INTO ${quote(table)}(${columns.map(quote).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,
          ...columns.map(column => this.binding(decode(row.payload![column]))));
      }
      if (rows.some(row => !allowed.has(row.kind))) throw Error('This server version cannot restore newer saved content.');
      this.storage.sql.exec('UPDATE _mirror_control SET restoring=0 WHERE id=1; DELETE FROM _mirror_outbox;');
      this.storage.sql.exec('INSERT INTO _mirror_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',revision);
    });
    this.revision=revision;
  }
  async flush() {
    const changes: Change[] = this.db.prepare('SELECT kind,row_key,payload FROM _mirror_outbox ORDER BY kind,row_key').all().map((row: Row) => ({...row,payload:row.payload===null?null:JSON.parse(row.payload)}));
    if (!changes.length) return;
    try {
      const revision = await this.request('rpc/bonk_apply_changes', { method:'POST',body:JSON.stringify({expected_revision:this.revision,changes}) });
      if (Number(revision) !== this.revision + 1) throw Error('Unexpected saved content revision.');
      this.revision=Number(revision);
      this.storage.transactionSync(() => {
        this.storage.sql.exec('DELETE FROM _mirror_outbox');
        this.storage.sql.exec('INSERT INTO _mirror_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision',this.revision);
      });
    } catch(error) {
      const state = await this.request('bonk_state?select=revision&id=eq.main');
      await this.restore(Number(state[0].revision));
      throw error;
    }
  }
}
