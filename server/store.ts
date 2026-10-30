import { DatabaseSync } from 'node:sqlite';
import { cloudDatabase, closeDatabase, withTransaction, type Database } from './database.ts';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface Profile {
  id: string;
  username: string;
  createdAt: number;
  selectedSkinId: string | null;
}
export interface MapInput { name: string; description?: string; data: unknown; visibility?: 'public' | 'private'; }
export interface SkinInput { name: string; data: unknown; }
type Row = Record<string, any>;
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ServiceError(400, 'invalid_input', `${field} must contain ${min} to ${max} characters.`);
  }
  return value.trim();
}
function json(value: unknown, maxBytes: number): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { /* Return the same validation error below. */ }
  if (encoded === undefined || value === null || Buffer.byteLength(encoded) > maxBytes) {
    throw new ServiceError(400, 'invalid_data', `Data must be JSON and no larger than ${maxBytes} bytes.`);
  }
  return encoded;
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 256) {
    throw new ServiceError(400, 'invalid_password', 'Password must contain at least 8 characters and at most 256 bytes.');
  }
  return value;
}
async function derive(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolveKey(key);
    });
  });
}
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const profile = (row: Row): Profile => ({ id: row.id, username: row.username, createdAt: row.created_at, selectedSkinId: row.selected_skin_id });

/** Independent local account/map storage. This is not a connection to Bonk.io accounts. */
export class ServiceStore {
  readonly db: Database;
  constructor(filename = resolve(process.cwd(), 'data/bonk.sqlite'), database?: Database) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    const remote = database ?? (filename !== ':memory:' ? cloudDatabase() : undefined);
    this.db = remote || new DatabaseSync(filename);
    if (!remote) this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, selected_skin_id TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS maps (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS maps_owner ON maps(owner_id);
      CREATE TABLE IF NOT EXISTS map_ratings (
        map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating IN (-1, 1)), PRIMARY KEY(map_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS map_favorites (
        map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(map_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_ratings (
        source_dbv INTEGER NOT NULL CHECK(source_dbv IN (1, 2)), source_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating IN (-1, 1)), PRIMARY KEY(source_dbv, source_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_favorites (
        source_dbv INTEGER NOT NULL CHECK(source_dbv IN (1, 2)), source_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
        PRIMARY KEY(source_dbv, source_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS catalog_favorites_user ON catalog_favorites(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted')), created_at INTEGER NOT NULL,
        CHECK(requester_id <> recipient_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS friendship_pair ON friendships(
        MIN(requester_id, recipient_id), MAX(requester_id, recipient_id)
      );
      CREATE TABLE IF NOT EXISTS skins (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skins_owner ON skins(owner_id);
      CREATE TABLE IF NOT EXISTS native_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        UNIQUE(kind, entity_id)
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, key)
      );
      CREATE TABLE IF NOT EXISTS replays (
        id INTEGER PRIMARY KEY AUTOINCREMENT, replaydata TEXT NOT NULL, data_hash TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL, mode TEXT NOT NULL, map_native_id INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replay_reports (
        replay_id INTEGER NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
        reporter TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(replay_id, reporter)
      );
      CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_roles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'curator'))
      );
      CREATE TABLE IF NOT EXISTS map_metadata (
        map_id TEXT PRIMARY KEY REFERENCES maps(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'b', remix INTEGER NOT NULL DEFAULT 0,
        spawns INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS map_curations (
        map_key TEXT PRIMARY KEY, dbv INTEGER NOT NULL CHECK(dbv IN (1, 2)),
        map_id TEXT NOT NULL, curator_id TEXT NOT NULL REFERENCES users(id),
        comment TEXT NOT NULL, mode TEXT NOT NULL, tier INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS map_plays (
        map_key TEXT NOT NULL, mode TEXT NOT NULL, rounds INTEGER NOT NULL DEFAULT 0,
        last_played_at INTEGER NOT NULL, PRIMARY KEY(map_key, mode)
      );
      CREATE TABLE IF NOT EXISTS xp_awards (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        round_key TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, round_key)
      );
      CREATE TABLE IF NOT EXISTS replay_moderation (
        replay_id INTEGER PRIMARY KEY REFERENCES replays(id) ON DELETE CASCADE,
        moderator_id TEXT NOT NULL REFERENCES users(id), hidden INTEGER NOT NULL,
        reason TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS community_maps (
        id TEXT PRIMARY KEY, dbv INTEGER NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL,
        authorname TEXT NOT NULL, leveldata TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'mapStrings',
        vu INTEGER NOT NULL DEFAULT 0, vd INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(dbv, source_id)
      );
      CREATE INDEX IF NOT EXISTS community_maps_popular ON community_maps(vu DESC, vd);
      CREATE TABLE IF NOT EXISTS map_moderation (
        map_key TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
        moderator_id TEXT NOT NULL REFERENCES users(id), updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_bans (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL,
        expires_at INTEGER, moderator_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moderation_audit (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
        details TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS moderation_audit_date ON moderation_audit(created_at DESC);
    `);
    // Keep local protocol IDs outside the bundled upstream map namespace.
    const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'native_ids'").get() as Row | undefined;
    if (!sequence) this.db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('native_ids', 1000000000)").run();
    else if (Number(sequence.seq) < 1000000000) this.db.prepare("UPDATE sqlite_sequence SET seq = 1000000000 WHERE name = 'native_ids'").run();
  }
  close() { closeDatabase(this.db); }
  getUser(id: string): Profile | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? profile(row) : null;
  }
  async register(input: { username?: unknown; password?: unknown }): Promise<Profile> {
    const registration = this.db.prepare("SELECT value FROM server_settings WHERE key='registrationOpen'").get() as Row | undefined;
    if (registration && JSON.parse(registration.value) === false) throw new ServiceError(403, 'registration_closed', 'Registration is currently closed.');
    const username = text(input.username, 'Username', 3, 20);
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new ServiceError(400, 'invalid_username', 'Username may contain letters, numbers, underscores, and hyphens.');
    const secret = password(input.password);
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(secret, salt)).toString('hex');
    const id = randomUUID();
    try {
      this.db.prepare('INSERT INTO users(id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, salt, hash, Date.now());
      // The first account on a fresh independent installation owns its local catalog.
      // Existing installations are never silently promoted during schema migration.
      if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as Row).count) === 1) this.setRole(id, 'owner');
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ServiceError(409, 'username_taken', 'That username is already registered on this server.');
      throw error;
    }
    return this.getUser(id)!;
  }
  async login(input: { username?: unknown; password?: unknown }): Promise<Profile> {
    const username = text(input.username, 'Username', 1, 20);
    const secret = typeof input.password === 'string' && Buffer.byteLength(input.password) <= 256 ? input.password : '';
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as Row | undefined;
    const actual = await derive(secret, row?.password_salt ?? 'no-such-account');
    const expected = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(32);
    if (!row || !timingSafeEqual(actual, expected)) throw new ServiceError(401, 'invalid_credentials', 'Incorrect username or password.');
    const ban = this.db.prepare('SELECT reason FROM account_bans WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)').get(row.id, Date.now()) as Row | undefined;
    if(ban) throw new ServiceError(403,'account_banned','This account is suspended. '+ban.reason);
    return profile(row);
  }
  createSession(userId: string): string {
    if (!this.getUser(userId)) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, Date.now() + SESSION_LIFETIME);
    return token;
  }
  getSession(token?: string | null): Profile | null {
    if (!token || token.length > 128) return null;
    const row = this.db.prepare("SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ? AND NOT EXISTS(SELECT 1 FROM account_bans b WHERE b.user_id=u.id AND (b.expires_at IS NULL OR b.expires_at > CAST(strftime('%s','now') AS INTEGER)*1000))")
      .get(hashToken(token), Date.now()) as Row | undefined;
    return row ? profile(row) : null;
  }
  revokeSession(token?: string | null) { if (token && token.length <= 128) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); }
  nativeId(kind: 'user' | 'map' | 'skin', id: string): number {
    this.db.prepare('INSERT OR IGNORE INTO native_ids(kind, entity_id) VALUES (?, ?)').run(kind, id);
    return Number((this.db.prepare('SELECT id FROM native_ids WHERE kind = ? AND entity_id = ?').get(kind, id) as Row).id);
  }
  entityId(kind: 'user' | 'map' | 'skin', id: unknown): string | null {
    if (!/^\d+$/.test(String(id))) return null;
    return (this.db.prepare('SELECT entity_id FROM native_ids WHERE kind = ? AND id = ?').get(kind, Number(id)) as Row | undefined)?.entity_id ?? null;
  }
  getSetting(userId: string, key: string, fallback: any = null): any {
    const row = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as Row | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(userId: string, key: string, value: unknown) {
    this.db.prepare('INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
      .run(userId, key, json(value, 256 * 1024));
  }
  serverSetting(key: string, fallback: unknown): any {
    this.db.prepare('INSERT OR IGNORE INTO server_settings(key, value) VALUES (?, ?)').run(key, json(fallback, 256 * 1024));
    return JSON.parse((this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as Row).value);
  }
  role(userId: string): 'owner' | 'curator' | null {
    const user = this.getUser(userId);
    if (!user) return null;
    const configured = (process.env.BONK_CURATORS || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    return (this.db.prepare('SELECT role FROM server_roles WHERE user_id = ?').get(userId) as Row | undefined)?.role ??
      (configured.includes(user.username.toLowerCase()) ? 'curator' : null);
  }
  setRole(userId: string, role: 'owner' | 'curator' | null) {
    if (!this.getUser(userId)) throw new ServiceError(404, 'user_not_found', 'Account not found.');
    if (role === null) this.db.prepare('DELETE FROM server_roles WHERE user_id = ?').run(userId);
    else if (role === 'owner' || role === 'curator') this.db.prepare('INSERT INTO server_roles(user_id, role) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role').run(userId, role);
    else throw new ServiceError(400, 'invalid_role', 'Role must be owner or curator.');
  }
  awardRoundXP(userId: string, roundKey: string, createdAt = Date.now()): { xp: number; awarded: boolean } {
    return withTransaction(this.db, () => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO xp_awards(user_id, round_key, amount, created_at) VALUES (?, ?, 100, ?)').run(userId, roundKey, createdAt);
      const awarded = Number(inserted.changes) === 1, xp = Math.max(0, Number(this.getSetting(userId, 'xp', 0)) || 0) + (awarded ? 100 : 0);
      if (awarded) this.setSetting(userId, 'xp', xp);
      return { xp, awarded };
    });
  }
  setMapMetadata(mapId: string, ownerId: string, input: { mode?: unknown; remix?: unknown; spawns?: unknown }) {
    const map = this.getMap(mapId, ownerId);
    if (map.owner.id !== ownerId && !this.role(ownerId)) throw new ServiceError(403, 'owner_required', 'Only the owner or a curator can classify this map.');
    const mode = typeof input.mode === 'string' && ['b', 'v', 'sp', 'ar', 'ard', 'bs', 'f', 'any'].includes(input.mode) ? input.mode : 'b';
    const spawns = Math.max(0, Math.min(64, Math.trunc(Number(input.spawns) || 0)));
    this.db.prepare('INSERT INTO map_metadata(map_id, mode, remix, spawns) VALUES (?, ?, ?, ?) ON CONFLICT(map_id) DO UPDATE SET mode = excluded.mode, remix = excluded.remix, spawns = excluded.spawns')
      .run(mapId, mode, input.remix === true || input.remix === 'true' || input.remix === 1 || input.remix === '1' ? 1 : 0, spawns);
  }
  getMapMetadata(mapId: string): Row {
    return this.db.prepare('SELECT mode, remix, spawns FROM map_metadata WHERE map_id = ?').get(mapId) as Row ?? { mode: 'b', remix: 0, spawns: 0 };
  }
  curateMap(userId: string, input: { mapid?: unknown; dbv?: unknown; comment?: unknown; mode?: unknown; tier?: unknown }) {
    if (!this.role(userId)) throw new ServiceError(403, 'unauthorised', 'Local curator privileges are required.');
    const dbv = Number(input.dbv);
    if (![1, 2].includes(dbv)) throw new ServiceError(400, 'invalid_dbv', 'Database version must be 1 or 2.');
    if (!/^\d{1,15}$/.test(String(input.mapid))) throw new ServiceError(400, 'invalid_mapid', 'Invalid map identity.');
    if (typeof input.comment !== 'string') throw new ServiceError(400, 'invalid_comment', 'A curation comment is required.');
    if (input.comment.length > 500) throw new ServiceError(400, 'comment_too_long', 'Curation comments may contain at most 500 characters.');
    const localId = this.entityId('map', input.mapid), mapid = String(input.mapid);
    if (localId) {
      const map = this.db.prepare('SELECT visibility FROM maps WHERE id = ?').get(localId) as Row | undefined;
      if (!map) throw new ServiceError(404, 'invalid_mapid', 'Map not found.');
      if (dbv !== 2) throw new ServiceError(400, 'invalid_dbv', 'Maps must use the current database version.');
      if (map.visibility !== 'public') throw new ServiceError(400, 'map_private', 'Publish this map before curating it.');
    }
    const mode = typeof input.mode === 'string' && ['b', 'v', 'sp', 'ar', 'ard', 'bs', 'f', 'any'].includes(input.mode) ? input.mode : localId ? this.getMapMetadata(localId).mode : 'b';
    const tier = Number(input.tier || 0);
    if (![0, 1, 2].includes(tier)) throw new ServiceError(400, 'invalid_tier', 'Training tier must be 0, 1, or 2.');
    this.db.prepare(`INSERT INTO map_curations(map_key, dbv, map_id, curator_id, comment, mode, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(map_key) DO UPDATE SET curator_id = excluded.curator_id, comment = excluded.comment, mode = excluded.mode, tier = excluded.tier, created_at = excluded.created_at`)
      .run(`${dbv}:${mapid}`, dbv, mapid, userId, input.comment, mode, tier, Date.now());
    return this.listCurations().find(item => item.dbv === dbv && item.mapid === mapid)!;
  }
  listCurations(): Row[] {
    return this.db.prepare(`SELECT c.map_key AS mapKey, c.dbv, c.map_id AS mapid, c.comment, c.mode, c.tier, c.created_at AS createdAt,
      u.username AS curator FROM map_curations c JOIN users u ON u.id = c.curator_id ORDER BY c.created_at DESC, c.map_key`).all() as Row[];
  }
  removeCuration(userId: string, dbv: unknown, mapid: unknown) {
    if (!this.role(userId)) throw new ServiceError(403, 'unauthorised', 'Local curator privileges are required.');
    this.db.prepare('DELETE FROM map_curations WHERE map_key = ?').run(`${Number(dbv)}:${String(mapid)}`);
  }
  recordMapRound(dbv: number, mapid: unknown, mode: string) {
    if (![1, 2].includes(dbv) || !/^\d{1,15}$/.test(String(mapid)) || !['b', 'v', 'sp', 'ar', 'ard', 'bs', 'f'].includes(mode)) return;
    this.db.prepare('INSERT INTO map_plays(map_key, mode, rounds, last_played_at) VALUES (?, ?, 1, ?) ON CONFLICT(map_key, mode) DO UPDATE SET rounds = rounds + 1, last_played_at = excluded.last_played_at')
      .run(`${dbv}:${String(mapid)}`, mode, Date.now());
  }
  mapPlays(dbv: number, mapid: unknown): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(rounds), 0) AS rounds FROM map_plays WHERE map_key = ?').get(`${dbv}:${String(mapid)}`) as Row).rounds);
  }
  async changePassword(userId: string, oldPassword: unknown, newPassword: unknown, preserveToken?: string | null) {
    const account = this.getUser(userId);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    await this.login({ username: account.username, password: oldPassword });
    const secret = password(newPassword), salt = randomBytes(16).toString('hex');
    const hash = (await derive(secret, salt)).toString('hex');
    withTransaction(this.db, () => {
      this.db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(salt, hash, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, preserveToken ? hashToken(preserveToken) : '');
    });
  }
  private mapRow(id: string, viewerId?: string): Row {
    const row = this.db.prepare(`SELECT m.*, u.username AS owner_name,
      COALESCE((SELECT SUM(rating) FROM map_ratings WHERE map_id = m.id), 0) AS rating,
      (SELECT COUNT(*) FROM map_ratings WHERE map_id = m.id) AS ratings_count,
      COALESCE((SELECT rating FROM map_ratings WHERE map_id = m.id AND user_id = ?), 0) AS my_rating,
      EXISTS(SELECT 1 FROM map_favorites WHERE map_id = m.id AND user_id = ?) AS favorite
      FROM maps m JOIN users u ON u.id = m.owner_id WHERE m.id = ?`)
      .get(viewerId ?? '', viewerId ?? '', id) as Row | undefined;
    if ((this.db.prepare('SELECT hidden FROM map_moderation WHERE map_key=?').get('local:'+id) as Row | undefined)?.hidden && (!viewerId || !this.role(viewerId))) throw new ServiceError(404,'map_not_found','Map not found.');
    if (!row || (row.visibility === 'private' && row.owner_id !== viewerId)) throw new ServiceError(404, 'map_not_found', 'Map not found.');
    return row;
  }
  private mapResult(row: Row, includeData = true): Row {
    return { id: row.id, name: row.name, description: row.description,
      owner: { id: row.owner_id, username: row.owner_name }, visibility: row.visibility,
      createdAt: row.created_at, updatedAt: row.updated_at, rating: row.rating,
      ratingsCount: row.ratings_count, myRating: row.my_rating, favorite: Boolean(row.favorite),
      ...(includeData ? { data: JSON.parse(row.data) } : {}) };
  }
  getMap(id: string, viewerId?: string): Row { return this.mapResult(this.mapRow(id, viewerId)); }
  listMaps(options: { viewerId?: string; ownerId?: string; query?: string; sort?: string; favorites?: boolean; limit?: number; offset?: number; nativeOnly?: boolean; searchName?: boolean; searchAuthor?: boolean } = {}): Row {
    const viewer = options.viewerId ?? '';
    const query = (options.query ?? '').slice(0, 100);
    const limit = Math.max(1, Math.min(50, Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 20));
    const offset = Math.max(0, Math.min(100_000, Number.isFinite(options.offset) ? Math.trunc(options.offset!) : 0));
    const criteria = `WHERE (m.visibility = 'public' OR m.owner_id = ?) AND (? = '' OR m.owner_id = ?) AND NOT EXISTS(SELECT 1 FROM map_moderation mm WHERE mm.map_key='local:'||m.id AND mm.hidden=1)
      AND (? = '' OR (? = 1 AND instr(lower(m.name), lower(?)) > 0) OR (? = 1 AND instr(lower(u.username), lower(?)) > 0))
      AND (? = 0 OR EXISTS(SELECT 1 FROM map_favorites WHERE map_id = m.id AND user_id = ?))
      AND (? = 0 OR json_type(m.data) = 'text')`;
    const args = [viewer, options.ownerId ?? '', options.ownerId ?? '', query, options.searchName === false ? 0 : 1, query,
      options.searchAuthor === false ? 0 : 1, query, options.favorites ? 1 : 0, viewer, options.nativeOnly ? 1 : 0];
    const sort = options.sort === 'rating' ? 'rating DESC, m.updated_at DESC' : 'm.updated_at DESC, m.id';
    const rows = this.db.prepare(`SELECT m.*, u.username AS owner_name,
      COALESCE((SELECT SUM(rating) FROM map_ratings WHERE map_id = m.id), 0) AS rating,
      (SELECT COUNT(*) FROM map_ratings WHERE map_id = m.id) AS ratings_count,
      COALESCE((SELECT rating FROM map_ratings WHERE map_id = m.id AND user_id = ?), 0) AS my_rating,
      EXISTS(SELECT 1 FROM map_favorites WHERE map_id = m.id AND user_id = ?) AS favorite
      FROM maps m JOIN users u ON u.id = m.owner_id ${criteria} ORDER BY ${sort} LIMIT ? OFFSET ?`)
      .all(viewer, viewer, ...args, limit, offset) as Row[];
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM maps m JOIN users u ON u.id = m.owner_id ${criteria}`).get(...args) as Row;
    return { maps: rows.map(row => this.mapResult(row, false)), total: count.count, limit, offset };
  }
  private validateMap(input: MapInput) {
    const name = text(input.name, 'Map name', 1, 100);
    const description = input.description === undefined ? '' : text(input.description, 'Description', 0, 2000);
    const data = json(input.data, 2 * 1024 * 1024);
    const visibility = input.visibility ?? 'public';
    if (!['public', 'private'].includes(visibility)) throw new ServiceError(400, 'invalid_visibility', 'Visibility must be public or private.');
    return { name, description, data, visibility };
  }
  createMap(ownerId: string, input: MapInput): Row {
    const value = this.validateMap(input), id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO maps(id, owner_id, name, description, data, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, value.name, value.description, value.data, value.visibility, now, now);
    return this.getMap(id, ownerId);
  }
  updateMap(id: string, ownerId: string, input: Partial<MapInput>): Row {
    const existing = this.mapRow(id, ownerId);
    if (existing.owner_id !== ownerId) throw new ServiceError(403, 'owner_required', 'Only the map owner can edit this map.');
    const value = this.validateMap({ name: input.name ?? existing.name, description: input.description ?? existing.description,
      data: input.data === undefined ? JSON.parse(existing.data) : input.data, visibility: input.visibility ?? existing.visibility });
    this.db.prepare('UPDATE maps SET name = ?, description = ?, data = ?, visibility = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
      .run(value.name, value.description, value.data, value.visibility, Date.now(), id, ownerId);
    return this.getMap(id, ownerId);
  }
  deleteMap(id: string, ownerId: string) {
    const existing = this.mapRow(id, ownerId);
    if (existing.owner_id !== ownerId) throw new ServiceError(403, 'owner_required', 'Only the map owner can delete this map.');
    this.db.prepare('DELETE FROM maps WHERE id = ? AND owner_id = ?').run(id, ownerId);
  }
  rateMap(id: string, userId: string, rating: unknown): Row {
    this.mapRow(id, userId);
    if (![1, 0, -1].includes(rating as number)) throw new ServiceError(400, 'invalid_rating', 'Rating must be -1, 0 (remove vote), or 1.');
    if (rating === 0) this.db.prepare('DELETE FROM map_ratings WHERE map_id = ? AND user_id = ?').run(id, userId);
    else this.db.prepare('INSERT INTO map_ratings(map_id, user_id, rating) VALUES (?, ?, ?) ON CONFLICT(map_id, user_id) DO UPDATE SET rating = excluded.rating').run(id, userId, rating as number);
    return this.getMap(id, userId);
  }
  favoriteMap(id: string, userId: string, favorite: boolean): Row {
    this.mapRow(id, userId);
    if (favorite) this.db.prepare('INSERT OR IGNORE INTO map_favorites(map_id, user_id) VALUES (?, ?)').run(id, userId);
    else this.db.prepare('DELETE FROM map_favorites WHERE map_id = ? AND user_id = ?').run(id, userId);
    return this.getMap(id, userId);
  }
  listFavoriteMapIds(userId: string): string[] {
    return (this.db.prepare(`SELECT m.id FROM map_favorites f JOIN maps m ON m.id = f.map_id
      WHERE f.user_id = ? AND (m.visibility = 'public' OR m.owner_id = ?) ORDER BY m.updated_at DESC, m.id`).all(userId, userId) as Row[]).map(row => row.id);
  }
  private catalogKey(sourceDbv: unknown, sourceId: unknown): { dbv: number; id: string } {
    const dbv = Number(sourceDbv), id = String(sourceId);
    if (![1, 2].includes(dbv) || !/^\d{1,15}$/.test(id)) throw new ServiceError(400, 'invalid_source_map', 'Invalid source map identity.');
    return { dbv, id };
  }
  getCatalogSocial(sourceDbv: unknown, sourceId: unknown, viewerId?: string): Row {
    const { dbv, id } = this.catalogKey(sourceDbv, sourceId);
    const aggregate = this.db.prepare(`SELECT COALESCE(SUM(rating), 0) AS rating, COUNT(*) AS ratings_count,
      COALESCE(SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END), 0) AS votes_up,
      COALESCE(SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END), 0) AS votes_down FROM catalog_ratings WHERE source_dbv = ? AND source_id = ?`).get(dbv, id) as Row;
    const mine = viewerId ? this.db.prepare('SELECT rating FROM catalog_ratings WHERE source_dbv = ? AND source_id = ? AND user_id = ?').get(dbv, id, viewerId) as Row | undefined : undefined;
    const favorite = viewerId ? this.db.prepare('SELECT 1 FROM catalog_favorites WHERE source_dbv = ? AND source_id = ? AND user_id = ?').get(dbv, id, viewerId) : undefined;
    return { sourceDbv: dbv, sourceId: id, ratingScope: 'local-server', rating: aggregate.rating, ratingsCount: aggregate.ratings_count,
      localVotesUp: aggregate.votes_up, localVotesDown: aggregate.votes_down, myRating: mine?.rating ?? 0, favorite: Boolean(favorite) };
  }
  rateCatalogMap(sourceDbv: unknown, sourceId: unknown, userId: string, rating: unknown): Row {
    const { dbv, id } = this.catalogKey(sourceDbv, sourceId);
    if (![1, 0, -1].includes(rating as number)) throw new ServiceError(400, 'invalid_rating', 'Rating must be -1, 0 (remove vote), or 1.');
    if (rating === 0) this.db.prepare('DELETE FROM catalog_ratings WHERE source_dbv = ? AND source_id = ? AND user_id = ?').run(dbv, id, userId);
    else this.db.prepare(`INSERT INTO catalog_ratings(source_dbv, source_id, user_id, rating) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_dbv, source_id, user_id) DO UPDATE SET rating = excluded.rating`).run(dbv, id, userId, rating as number);
    return this.getCatalogSocial(dbv, id, userId);
  }
  favoriteCatalogMap(sourceDbv: unknown, sourceId: unknown, userId: string, favorite: boolean): Row {
    const { dbv, id } = this.catalogKey(sourceDbv, sourceId);
    if (favorite) this.db.prepare('INSERT OR IGNORE INTO catalog_favorites(source_dbv, source_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(dbv, id, userId, Date.now());
    else this.db.prepare('DELETE FROM catalog_favorites WHERE source_dbv = ? AND source_id = ? AND user_id = ?').run(dbv, id, userId);
    return this.getCatalogSocial(dbv, id, userId);
  }
  listCatalogFavorites(userId: string, sourceDbv?: 1 | 2): Row[] {
    return (this.db.prepare(`SELECT source_dbv AS sourceDbv, source_id AS sourceId, created_at AS createdAt
      FROM catalog_favorites WHERE user_id = ? AND (? = 0 OR source_dbv = ?) ORDER BY created_at DESC, source_dbv, source_id`)
      .all(userId, sourceDbv ?? 0, sourceDbv ?? 0) as Row[]);
  }
  listFriends(userId: string): Row[] {
    const rows = this.db.prepare(`SELECT f.*, u.id AS friend_id, u.username AS friend_name FROM friendships f JOIN users u
      ON u.id = CASE WHEN f.requester_id = ? THEN f.recipient_id ELSE f.requester_id END
      WHERE f.requester_id = ? OR f.recipient_id = ? ORDER BY f.created_at DESC`).all(userId, userId, userId) as Row[];
    return rows.map(row => ({ id: row.id, user: { id: row.friend_id, username: row.friend_name }, status: row.status,
      direction: row.requester_id === userId ? 'outgoing' : 'incoming', createdAt: row.created_at }));
  }
  requestFriend(userId: string, username: unknown): Row {
    const name = text(username, 'Username', 1, 20);
    const recipient = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name) as Row | undefined;
    if (!recipient) throw new ServiceError(404, 'user_not_found', 'No account has that username.');
    if (recipient.id === userId) throw new ServiceError(400, 'self_friend', 'Choose another player.');
    const existing = this.db.prepare('SELECT * FROM friendships WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)')
      .get(userId, recipient.id, recipient.id, userId) as Row | undefined;
    if (existing) throw new ServiceError(409, 'friendship_exists', 'A friendship or request already exists.');
    const id = randomUUID();
    this.db.prepare('INSERT INTO friendships(id, requester_id, recipient_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, recipient.id, 'pending', Date.now());
    return this.listFriends(userId).find(friend => friend.id === id)!;
  }
  acceptFriend(id: string, userId: string): Row {
    const row = this.db.prepare('SELECT * FROM friendships WHERE id = ?').get(id) as Row | undefined;
    if (!row || (row.recipient_id !== userId && row.requester_id !== userId)) throw new ServiceError(404, 'request_not_found', 'Friend request not found.');
    if (row.recipient_id !== userId) throw new ServiceError(403, 'recipient_required', 'Only the recipient can accept this request.');
    this.db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ? AND recipient_id = ?").run(id, userId);
    return this.listFriends(userId).find(friend => friend.id === id)!;
  }
  removeFriend(id: string, userId: string) {
    const result = this.db.prepare('DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR recipient_id = ?)').run(id, userId, userId);
    if (!result.changes) throw new ServiceError(404, 'request_not_found', 'Friendship or request not found.');
  }
  private skinResult(row: Row): Row { return { id: row.id, name: row.name, data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at }; }
  listSkins(userId: string): Row[] { return (this.db.prepare('SELECT * FROM skins WHERE owner_id = ? ORDER BY updated_at DESC, id').all(userId) as Row[]).map(row => this.skinResult(row)); }
  private ownedSkin(id: string, userId: string): Row {
    const row = this.db.prepare('SELECT * FROM skins WHERE id = ? AND owner_id = ?').get(id, userId) as Row | undefined;
    if (!row) throw new ServiceError(404, 'skin_not_found', 'Skin not found.');
    return row;
  }
  createSkin(userId: string, input: SkinInput): Row {
    const name = text(input.name, 'Skin name', 1, 80), data = json(input.data, 128 * 1024), id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO skins(id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, name, data, now, now);
    return this.skinResult(this.ownedSkin(id, userId));
  }
  updateSkin(id: string, userId: string, input: Partial<SkinInput>): Row {
    const previous = this.ownedSkin(id, userId);
    const name = text(input.name ?? previous.name, 'Skin name', 1, 80), data = json(input.data === undefined ? JSON.parse(previous.data) : input.data, 128 * 1024);
    this.db.prepare('UPDATE skins SET name = ?, data = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(name, data, Date.now(), id, userId);
    return this.skinResult(this.ownedSkin(id, userId));
  }
  equipSkin(id: string | null, userId: string): Profile {
    if (id !== null) this.ownedSkin(id, userId);
    this.db.prepare('UPDATE users SET selected_skin_id = ? WHERE id = ?').run(id, userId);
    return this.getUser(userId)!;
  }
  deleteSkin(id: string, userId: string) {
    this.ownedSkin(id, userId);
    withTransaction(this.db, () => {
      this.db.prepare('UPDATE users SET selected_skin_id = NULL WHERE id = ? AND selected_skin_id = ?').run(userId, id);
      this.db.prepare('DELETE FROM skins WHERE id = ? AND owner_id = ?').run(id, userId);
    });
  }
  saveReplay(input: { replaydata?: unknown; version?: unknown; mode?: unknown; mapid?: unknown }): number {
    if (typeof input.replaydata !== 'string' || !input.replaydata.length || Buffer.byteLength(input.replaydata) > 2 * 1024 * 1024) {
      throw new ServiceError(400, 'invalid_replay', 'Encoded replay data is required and must be smaller than 2 MB.');
    }
    const version = Number(input.version);
    if (!Number.isInteger(version) || version < 1 || version > 1000) throw new ServiceError(400, 'invalid_version', 'Invalid replay version.');
    const mode = typeof input.mode === 'string' && /^[a-zA-Z0-9_-]{1,16}$/.test(input.mode) ? input.mode : 'b';
    const nativeId = Number(input.mapid), hash = createHash('sha256').update(input.replaydata).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO replays(replaydata, data_hash, version, mode, map_native_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.replaydata, hash, version, mode, Number.isSafeInteger(nativeId) && nativeId > 0 ? nativeId : null, Date.now());
    const id = Number((this.db.prepare('SELECT id FROM replays WHERE data_hash = ?').get(hash) as Row).id);
    return id;
  }
  listReplays(input: { version?: unknown; mode?: unknown; offset?: unknown; startingFrom?: unknown; reporter?: string } = {}): Row[] {
    const version = Number(input.version), mode = typeof input.mode === 'string' ? input.mode : '';
    const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(input.offset) || 0)));
    const startingFrom = Number(input.startingFrom);
    return this.db.prepare(`SELECT id, replaydata FROM replays WHERE (? = 0 OR version = ?) AND (? = '' OR mode = ?)
      AND (? = 0 OR id <= ?) AND NOT EXISTS(SELECT 1 FROM replay_moderation m WHERE m.replay_id = replays.id AND m.hidden = 1)
      AND NOT EXISTS(SELECT 1 FROM replay_reports r WHERE r.replay_id = replays.id AND r.reporter = ?) ORDER BY id DESC LIMIT 4 OFFSET ?`)
      .all(Number.isInteger(version) ? version : 0, Number.isInteger(version) ? version : 0, mode, mode,
        Number.isSafeInteger(startingFrom) && startingFrom > 0 ? startingFrom : 0,
        Number.isSafeInteger(startingFrom) && startingFrom > 0 ? startingFrom : 0, input.reporter ?? '', offset) as Row[];
  }
  reportReplay(id: unknown, reporter: string) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || !this.db.prepare('SELECT id FROM replays WHERE id = ?').get(numericId)) {
      throw new ServiceError(404, 'replay_not_found', 'Replay not found.');
    }
    this.db.prepare('INSERT OR IGNORE INTO replay_reports(replay_id, reporter, created_at) VALUES (?, ?, ?)').run(numericId, reporter, Date.now());
  }
  listReplayReports(userId: string): Row[] {
    if (!this.role(userId)) throw new ServiceError(403, 'unauthorised', 'Local curator privileges are required.');
    return this.db.prepare(`SELECT p.id, p.mode, p.version, p.map_native_id AS mapid, COUNT(r.reporter) AS reports,
      COALESCE(m.hidden, 0) AS hidden, m.reason FROM replays p JOIN replay_reports r ON r.replay_id = p.id
      LEFT JOIN replay_moderation m ON m.replay_id = p.id GROUP BY p.id ORDER BY reports DESC, p.id DESC LIMIT 100`).all() as Row[];
  }
  moderateReplay(userId: string, replayId: unknown, hidden: unknown, reason: unknown) {
    if (!this.role(userId)) throw new ServiceError(403, 'unauthorised', 'Local curator privileges are required.');
    const id = Number(replayId);
    if (!Number.isSafeInteger(id) || !this.db.prepare('SELECT id FROM replays WHERE id = ?').get(id)) throw new ServiceError(404, 'replay_not_found', 'Replay not found.');
    if (typeof hidden !== 'boolean') throw new ServiceError(400, 'invalid_input', 'hidden must be true or false.');
    const message = typeof reason === 'string' ? reason.slice(0, 500) : '';
    this.db.prepare('INSERT INTO replay_moderation(replay_id, moderator_id, hidden, reason, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(replay_id) DO UPDATE SET moderator_id = excluded.moderator_id, hidden = excluded.hidden, reason = excluded.reason, updated_at = excluded.updated_at')
      .run(id, userId, hidden ? 1 : 0, message, Date.now());
  }
}

// Node's test workers must never open or migrate the running application's database.
let defaultStore: ServiceStore | undefined;
export const serviceStore = new Proxy({} as ServiceStore, { get(_target, key) { defaultStore ??= new ServiceStore(process.env.NODE_TEST_CONTEXT ? ':memory:' : process.env.BONK_DATA_PATH || undefined); const value = (defaultStore as any)[key]; return typeof value === 'function' ? value.bind(defaultStore) : value; } });
export const sessionLifetime = SESSION_LIFETIME;
