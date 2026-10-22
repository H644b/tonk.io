import { readFileSync } from 'node:fs';
import express, { type Express, type Request, type Response } from 'express';
import { ServiceError, serviceStore, type ServiceStore } from './store.js';

export interface CatalogMap {
  category: string; dbv: 1 | 2; sourceDbv?: 1 | 2; name: string; authorname: string; id: string; leveldata: string; spawns?: number;
}
/** Source artifacts retain original attribution; converted data comes from the shipped map encoder. */
export const builtinCatalog: CatalogMap[] = JSON.parse(readFileSync(new URL('../evidence/protocol/builtin-maps.json', import.meta.url), 'utf8'));
export const nativeCatalog: CatalogMap[] = JSON.parse(readFileSync(new URL('../evidence/protocol/native-catalog.json', import.meta.url), 'utf8'));
export const sourceVersion = (map: CatalogMap): 1 | 2 => map.sourceDbv ?? map.dbv;
export const sourceInfo = (map: CatalogMap) => ({ kind: 'bundled-original-client', originalId: map.id, dbv: sourceVersion(map),
  sourceDbv: sourceVersion(map), encodedDbv: map.dbv, category: map.category, author: map.authorname, url: 'https://bonk.io/' });
export function getCatalogMap(sourceDbv: unknown, sourceId: unknown, converted = true): CatalogMap | undefined {
  return (converted ? nativeCatalog : builtinCatalog).find(map => sourceVersion(map) === Number(sourceDbv) && map.id === String(sourceId));
}
/** Native packets omit the source database version. Resolve only unambiguous bundled IDs. */
export function findNativeCatalogMap(sourceId: unknown): CatalogMap | undefined {
  const maps = nativeCatalog.filter(map => map.id === String(sourceId));
  return maps.length && maps.every(map => sourceVersion(map) === sourceVersion(maps[0])) ? maps[0] : undefined;
}
export function nativeCatalogRow(map: CatalogMap, store: ServiceStore, viewerId?: string) {
  const social = store.getCatalogSocial(sourceVersion(map), map.id, viewerId);
  return { ...map, sourceDbv: sourceVersion(map), id: String(map.id), vu: social.localVotesUp, vd: social.localVotesDown,
    creationdate: '', publisheddate: '', published: 1, public: 1, ...social, source: sourceInfo(map) };
}
export function nativeCatalogFavorites(store: ServiceStore, userId: string) {
  return store.listCatalogFavorites(userId).flatMap(entry => {
    const map = getCatalogMap(entry.sourceDbv, entry.sourceId);
    return map ? [nativeCatalogRow(map, store, userId)] : [];
  });
}
export function catalogForMode(mode?: string): CatalogMap[] {
  const category = mode === 'ar' || mode === 'ard' ? 'arrowMapStrings' : mode === 'sp' ? 'grappleMapStrings' : 'mapStrings';
  return nativeCatalog.filter(map => map.category === category);
}
const nativeDate = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
function localNativeRow(store: ServiceStore, map: any) {
  const metadata = store.getMapMetadata(map.id);
  return { id: String(store.nativeId('map', map.id)), dbv: 2, sourceDbv: 2, name: map.name, authorname: map.owner.username,
    leveldata: map.data, creationdate: nativeDate(map.createdAt), publisheddate: nativeDate(map.updatedAt), updatedAt: map.updatedAt,
    vu: (map.ratingsCount + map.rating) / 2, vd: (map.ratingsCount - map.rating) / 2,
    published: 1, public: 1, ratingScope: 'local-server', mode: metadata.mode, remix: Boolean(metadata.remix), spawns: metadata.spawns,
    source: { kind: 'local-server', author: map.owner.username } };
}
export function publicNativeMaps(store: ServiceStore, viewerId?: string): any[] {
  const result: any[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = store.listMaps({ limit: 50, offset, nativeOnly: true });
    for (const entry of page.maps) {
      const map = store.getMap(entry.id, viewerId);
      result.push(localNativeRow(store, map));
    }
    if (offset + page.maps.length >= page.total || !page.maps.length || offset >= 100_000) return result;
  }
}
export function curatedMapRows(store: ServiceStore, viewerId?: string): any[] {
  return store.listCurations().flatMap(curation => {
    const source = getCatalogMap(curation.dbv, curation.mapid), id = store.entityId('map', curation.mapid);
    let map: any;
    if (id) {
      try { const local = store.getMap(id); if (typeof local.data === 'string') map = localNativeRow(store, local); }
      catch (error) { if (!(error instanceof ServiceError)) throw error; }
    } else if (source) map = nativeCatalogRow(source, store, viewerId);
    if (!map) return [];
    return [{ ...map, dbv: 2, comment: curation.comment, addedby: curation.curator, mode: curation.mode, tier: curation.tier,
      curatedAt: curation.createdAt, publisheddate: nativeDate(curation.createdAt), curationScope: 'local-server' }];
  });
}
export function curateNativeMap(store: ServiceStore, userId: string, data: any) {
  if (!data || typeof data !== 'object') throw new ServiceError(400, 'invalid_mapid', 'Invalid map.');
  if (![1, 2].includes(Number(data.dbv))) throw new ServiceError(400, 'invalid_dbv', 'Database version must be 1 or 2.');
  const local = store.entityId('map', data.mapid), source = getCatalogMap(data.dbv, data.mapid) ?? (Number(data.dbv) === 2 ? findNativeCatalogMap(data.mapid) : undefined);
  if (!local && !source) throw new ServiceError(404, 'invalid_mapid', 'Map not found.');
  return store.curateMap(userId, { ...data, dbv: local ? 2 : sourceVersion(source!),
    mode: data.mode ?? (local ? store.getMapMetadata(local).mode : source!.category === 'arrowMapStrings' ? 'ar' : source!.category === 'grappleMapStrings' ? 'sp' : 'b') });
}
export function quickMapPool(store: ServiceStore, mode?: string): any[] {
  const curated = curatedMapRows(store).filter(map => map.mode === mode || map.mode === 'any' || (mode === 'ard' && map.mode === 'ar'));
  const unique = new Map<string, any>();
  for (const map of [...curated, ...catalogForMode(mode)]) unique.set(`${map.sourceDbv ?? map.dbv}:${map.id}`, map);
  return [...unique.values()];
}
export function quickMapPacket(mode?: string, startingFrom = 0, store: ServiceStore = serviceStore, pool = quickMapPool(store, mode)) {
  const maps = pool, offset = Number.isFinite(startingFrom) && maps.length ? Math.max(0, Math.trunc(startingFrom)) % maps.length : 0;
  return { size: maps.length, maps: Array.from({ length: Math.min(12, maps.length) }, (_, index) => {
    const id = (offset + index) % maps.length, map = maps[id];
    return { id, s: map.leveldata, v: map.dbv };
  }) };
}
export function trainingMapPacket(store: ServiceStore) {
  const rows = curatedMapRows(store).filter(map => map.mode === 'b' || map.mode === 'any');
  // Local curator choices take priority. The shipped Classic maps keep a fresh server playable.
  const fallback = catalogForMode('b').filter(map => (map.spawns ?? 0) > 0).slice(0, 12).map(map => nativeCatalogRow(map, store));
  return { r: 'success', t1: rows.filter(map => map.tier === 1).length ? rows.filter(map => map.tier === 1) : fallback,
    t2: rows.filter(map => map.tier === 2), scope: 'local-server' };
}
export function hotMapRows(store: ServiceStore, file: string, viewerId?: string, now = Date.now()) {
  const mode = /(?:_|-)(?:ar|ard)(?:\.|_|-)/.test(file) ? 'ar' : /(?:_|-)sp(?:\.|_|-)/.test(file) ? 'sp' : undefined;
  const edits = /^cache_edits_/.test(file), period = /(?:cache3_|cache_edits_)(\d+)/.exec(file);
  const days = [1, 7, 30, 90, 365, 3650, Infinity][Math.max(0, Math.min(6, Number(period?.[1] ?? 6)))];
  const local = publicNativeMaps(store, viewerId).filter(map => (!mode || map.mode === mode || map.mode === 'any' || (mode === 'ar' && map.mode === 'ard')) &&
    (!edits || map.remix) && now - map.updatedAt <= days * 86_400_000);
  const source = (edits ? [] : mode ? catalogForMode(mode) : nativeCatalog).map(map => nativeCatalogRow(map, store, viewerId));
  const seen = new Set<string>();
  return [...local, ...source].filter(map => { const key = `${map.sourceDbv}:${map.id}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(map => ({ ...map, rounds: store.mapPlays(map.sourceDbv ?? 2, map.id) }))
    .sort((a, b) => ((b.vu - b.vd) * 10 + Math.log2(1 + b.rounds)) - ((a.vu - a.vd) * 10 + Math.log2(1 + a.rounds)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
function viewer(req: Request, store: ServiceStore) {
  let token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    const raw = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('bonk_session='));
    try { token = raw ? decodeURIComponent(raw.slice('bonk_session='.length)) : ''; } catch { token = ''; }
  }
  return store.getSession(token);
}
export function setupCatalogRoutes(app: Express, options: { store?: ServiceStore } = {}) {
  const store = options.store ?? serviceStore, api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.get('host')) throw new Error(); }
      catch { return res.status(403).json({ error: { code: 'origin_rejected', message: 'Use this server\'s own page.' } }); }
    }
    next();
  });
  api.use(express.json({ limit: '32kb' }));
  api.get('/maps', (req, res) => {
    const query = String(req.query.q ?? '').toLowerCase().slice(0, 100), account = viewer(req, store);
    const category = req.query.mode ? catalogForMode(String(req.query.mode))[0]?.category : null;
    const favorites = req.query.favorites === '1';
    if (favorites && !account) throw new ServiceError(401, 'authentication_required', 'Sign in to see your source map favorites.');
    const maps = (req.query.native === '1' ? nativeCatalog : builtinCatalog).filter(map => (!query || map.name.toLowerCase().includes(query) || map.authorname.toLowerCase().includes(query)) &&
      (!category || map.category === category) && (!favorites || store.getCatalogSocial(sourceVersion(map), map.id, account?.id).favorite));
    res.json({ readOnly: true, socialScope: 'local-server', total: maps.length,
      maps: maps.map(map => ({ ...map, ...store.getCatalogSocial(sourceVersion(map), map.id, account?.id), source: sourceInfo(map) })) });
  });
  api.get('/maps/:sourceDbv/:sourceId', (req, res) => {
    const map = getCatalogMap(req.params.sourceDbv, req.params.sourceId);
    if (!map) throw new ServiceError(404, 'map_not_found', 'Source map not found.');
    res.json({ readOnly: true, map: nativeCatalogRow(map, store, viewer(req, store)?.id) });
  });
  const changeSocial = (kind: 'rating' | 'favorite') => (req: Request, res: Response) => {
    const account = viewer(req, store);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in to continue.');
    const map = getCatalogMap(req.params.sourceDbv, req.params.sourceId);
    if (!map) throw new ServiceError(404, 'map_not_found', 'Source map not found.');
    if (kind === 'rating') store.rateCatalogMap(sourceVersion(map), map.id, account.id, req.body?.rating);
    else {
      if (typeof req.body?.favorite !== 'boolean') throw new ServiceError(400, 'invalid_input', 'favorite must be true or false.');
      store.favoriteCatalogMap(sourceVersion(map), map.id, account.id, req.body.favorite);
    }
    res.json({ map: nativeCatalogRow(map, store, account.id) });
  };
  api.post('/maps/:sourceDbv/:sourceId/rating', changeSocial('rating'));
  api.post('/maps/:sourceDbv/:sourceId/favorite', changeSocial('favorite'));
  api.get('/curation', (req, res) => {
    const account = viewer(req, store);
    res.json({ role: account ? store.role(account.id) : null, scope: 'local-server', maps: curatedMapRows(store, account?.id) });
  });
  api.post('/curation', (req, res) => {
    const account = viewer(req, store);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    res.json({ curation: curateNativeMap(store, account.id, req.body) });
  });
  api.delete('/curation/:dbv/:id', (req, res) => {
    const account = viewer(req, store);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    store.removeCuration(account.id, req.params.dbv, req.params.id);
    res.json({ ok: true });
  });
  api.get('/replays/reports', (req, res) => {
    const account = viewer(req, store);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    res.json({ replays: store.listReplayReports(account.id) });
  });
  api.post('/replays/:id/moderation', (req, res) => {
    const account = viewer(req, store);
    if (!account) throw new ServiceError(401, 'authentication_required', 'Sign in first.');
    store.moderateReplay(account.id, req.params.id, req.body.hidden, req.body.reason);
    res.json({ ok: true });
  });
  api.use((error: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof ServiceError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Invalid JSON.' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'payload_too_large', message: 'JSON body exceeds 32 KB.' } });
    console.error('Source catalog service error:', error);
    res.status(500).json({ error: { code: 'internal_error', message: 'The local catalog service could not complete this request.' } });
  });
  app.use('/api/catalog', api);
  // The native client explicitly JSON.parse()s the text-file callbacks.
  app.all(/^\/compat\/(?:hotmaps\/)?([^/]+\.txt)$/, (req, res, next) => {
    const file = req.params[0];
    if (file === 'combinedplayercount.txt') return next();
    res.set('Cache-Control', 'no-store');
    const account = viewer(req, store);
    if (!/^(?:picks|cache3_\d+_(?:hot|ard|ar|sp)|cache_edits_\d+)\.txt$/.test(file)) return next();
    const maps = file === 'picks.txt' ? curatedMapRows(store, account?.id) : hotMapRows(store, file, account?.id);
    res.type('text/plain').send(JSON.stringify({ r: 'success', maps, readOnly: true, source: 'local-server-and-bundled-original-client', ratingScope: 'local-server' }));
  });
  app.post('/compat/:endpoint', express.urlencoded({ extended: false, limit: '3mb' }), express.json({ limit: '3mb' }), (req, res, next) => {
    if (!/^map_b1_(?:getbest|getsearch|getfave|getown)\.php$/.test(req.params.endpoint)) return next();
    res.set('Cache-Control', 'no-store');
    try {
      const body = req.body ?? {}, query = String(body.searchstring ?? '').toLowerCase().slice(0, 100), account = viewer(req, store);
      const favorites = /getfave/.test(req.params.endpoint);
      if (favorites && !account) return res.json({ r: 'fail', e: 'token' });
      const seenFavorites = new Set<string>();
      const matching = /getown/.test(req.params.endpoint) ? [] : builtinCatalog.filter(map => map.dbv === 1 && (!query ||
        ((body.searchmapname === 'true' || body.searchmapname === true) && map.name.toLowerCase().includes(query)) ||
        ((body.searchauthor === 'true' || body.searchauthor === true) && map.authorname.toLowerCase().includes(query))) &&
        (!favorites || store.getCatalogSocial(1, map.id, account?.id).favorite)).filter(map => {
          if (!favorites) return true;
          if (seenFavorites.has(map.id)) return false;
          seenFavorites.add(map.id);
          return true;
        });
      const offset = Math.max(0, Math.min(10_000, Math.trunc(Number(body.startingfrom) || 0)));
      const search = /getsearch/.test(req.params.endpoint), paginated = search || favorites, maps = paginated ? matching.slice(offset, offset + 32) : matching;
      const encoded = new URLSearchParams({ cant: String(maps.length), getrule: search ? 'search' : favorites ? 'favs' : 'hot' });
      maps.forEach((map, index) => {
        const social = store.getCatalogSocial(1, map.id, account?.id);
        encoded.set(`leveldata${index}`, map.leveldata); encoded.set(`mapname${index}`, map.name); encoded.set(`authorname${index}`, map.authorname);
        encoded.set(`mapid${index}`, map.id); encoded.set(`creationdate${index}`, '');
        encoded.set(`thumbsup${index}`, String(social.localVotesUp)); encoded.set(`thumbsdown${index}`, String(social.localVotesDown));
      });
      res.json({ r: 'success', maps: encoded.toString(), more: paginated && offset + maps.length < matching.length,
        readOnly: true, source: 'bundled-original-client', ratingScope: 'local-server' });
    } catch (error) {
      if (error instanceof ServiceError) return res.json({ r: 'fail', e: error.code });
      next(error);
    }
  });
}
