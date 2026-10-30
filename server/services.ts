import express, { type Express, type Request, type RequestHandler } from 'express';
import { ServiceError, ServiceStore, serviceStore, sessionLifetime, type Profile } from './store.js';
import { randomUUID } from 'node:crypto';
import { quickMapPacket, quickMapPool, findNativeCatalogMap, getCatalogMap, sourceVersion, curateNativeMap } from './catalog.js';

export const sessionCookieName = 'bonk_session';
/** Also usable by the independent socket server. Never log this value. */
export function getRequestToken(request: Pick<Request, 'headers'>): string | null {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== sessionCookieName) continue;
    try { return decodeURIComponent(cookie.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

/** Original client formula: levelToXP(level) = ((level - 1) * 10) squared. */
export function levelFromXP(xp: unknown): number {
  return Math.floor(Math.sqrt(Math.max(0, Math.min(1e12, Number(xp) || 0))) / 10) + 1;
}
export function getVerifiedLevel(userId: string, store: ServiceStore = serviceStore): number {
  return levelFromXP(store.getSetting(userId, 'xp', 0));
}

/** Own-account adapter for the native room protocol; attach to onServiceEvent. */
export function makeNativeServiceHandler(options: { store?: ServiceStore; now?: () => number } = {}) {
  const store = options.store ?? serviceStore, now = options.now ?? Date.now;
  type Receipt = { round: number; winner: number; winners: Set<number>; key: string; at: number };
  type State = { game: number; nonce: string; receipt?: Receipt; pending: Map<any, number>; maps: Map<string, any[]>; lastCurate: Map<string, number>; played: Set<string> };
  const states = new WeakMap<object, State>();
  const stateFor = (room: any) => {
    let state = states.get(room);
    if (!state || state.game !== Number(room.gameStartTime)) {
      state = { game: Number(room.gameStartTime), nonce: randomUUID(), pending: new Map(), maps: state?.maps ?? new Map(), lastCurate: state?.lastCurate ?? new Map(), played: new Set() };
      states.set(room, state);
    }
    return state;
  };
  const member = (socket: any, room: any) => Number.isInteger(socket.data?.bonkId) && room.playerSockets?.[socket.data.bonkId]?.id === socket.id;
  const accountFor = (socket: any, room: any) => room.playerInfo?.[socket.data.bonkId]?.guest === true ? null :
    store.getSession(getRequestToken({ headers: socket.handshake?.headers ?? {} } as Request));
  const award = (socket: any, room: any, receipt?: Receipt) => {
    if (!member(socket, room)) return;
    const account = accountFor(socket, room), sid = socket.data.bonkId;
    if (!account) return;
    const before = getVerifiedLevel(account.id, store);
    const result = receipt?.winners.has(sid) ? store.awardRoundXP(account.id, receipt.key, now()) : { xp: store.getSetting(account.id, 'xp', 0), awarded: false };
    // Native g1n always animates +100 when event46 arrives, even if newXP did
    // not change. Rejected or duplicate requests must stay silent.
    if (result.awarded) socket.emit('46', { newXP: result.xp });
    const level = levelFromXP(result.xp);
    if (result.awarded && level !== before) {
      room.playerInfo[sid].level = level;
      room.io?.to('main').emit('45', { sid, lv: level });
    }
  };
  const handler = (event: string, data: any, socket: any, room: any) => {
    const sid = socket.data?.bonkId;
    if (!member(socket, room)) return;
    const state = stateFor(room);
    if (event === '42') {
      const mode = String(room.gameSettings?.mo || 'b');
      if (!state.maps.has(mode)) state.maps.set(mode, quickMapPool(store, mode));
      socket.emit('51', quickMapPacket(mode, Number(data?.sf) || 0, store, state.maps.get(mode)));
      return;
    }
    const account = accountFor(socket, room);
    if (event === '51') {
      if (!account) { socket.emit('57', false, 'not_logged_in'); return; }
      const last = state.lastCurate.get(account.id);
      if (last !== undefined && now() - last < 3000) { socket.emit('57', false, 'rate_limit'); return; }
      try {
        curateNativeMap(store, account.id, data);
        state.lastCurate.set(account.id, now());
        socket.emit('57', true, '');
      } catch (error) { if (error instanceof ServiceError) socket.emit('57', false, error.code); else throw error; }
      return;
    }
    if (event === '47') {
      // Native host telemetry counts map usage, not wins or XP. Host outcome receipts
      // are separately supplied by the exact simulation transition hook below.
      if (sid === room.hostId && room.gameStartTime > 0) {
        const id = store.entityId('map', data?.mid), source = id ? undefined : findNativeCatalogMap(data?.mid,store);
        const key = `${data?.mid}:${data?.mo}:${state.receipt?.round ?? 0}`;
        if ((id || source) && !state.played.has(key)) { store.recordMapRound(id ? 2 : sourceVersion(source!), data.mid, data.mo); state.played.add(key); }
      }
      return;
    }
    if (!account) return;
    if (event === '38') {
      for (const [pending, at] of state.pending) if (now() - at > 15_000 || !member(pending, room)) state.pending.delete(pending);
      const player = room.playerInfo?.[sid];
      const active = Number(room.gameStartTime) > 0 && room.gameSettings?.ga !== 'f' && player?.team > 0 && !player?.afk;
      if (!active) { award(socket, room); return; }
      state.pending.set(socket, now());
      if (state.receipt && now() - state.receipt.at < 15_000) award(socket, room, state.receipt);
      else award(socket, room);
      return;
    }
    if (event === '39' || event === '41') {
      const id = store.entityId('map', data?.mapid);
      try {
        const source = id ? undefined : findNativeCatalogMap(data?.mapid,store);
        if (!id && !source) return;
        const rating = data?.vote === 1 ? 1 : data?.vote === 0 ? -1 : NaN;
        const map = id ? (event === '39' ? store.rateMap(id, account.id, rating) : store.getMap(id, account.id)) :
          event === '39' ? store.rateCatalogMap(sourceVersion(source!), source!.id, account.id, rating) : store.getCatalogSocial(sourceVersion(source!), source!.id, account.id);
        if (map.myRating) socket.emit('50', Number(data.mapid), map.myRating === 1 ? 1 : 0);
      } catch (error) { if (!(error instanceof ServiceError)) throw error; }
    }
  };
  /** Verified room host supplies outcomes from the shipped simulation's fte transition.
   * This confirms native host agreement; it is not server-authoritative physics. */
  const recordRound = (data: any, socket: any, room: any): { ok?: true; duplicate?: true; error?: string } => {
    if (!member(socket, room) || socket.data.bonkId !== room.hostId) return { error: 'Only the current host can report outcomes.' };
    if (!(Number(room.gameStartTime) > 0) || room.gameSettings?.ga === 'f') return { error: 'No eligible active match.' };
    if (!data || !Number.isSafeInteger(data.round) || data.round < 0 || data.round > 1_000_000 || !Number.isInteger(data.winner) || data.winner < -1 || data.winner > 63 || typeof data.teams !== 'boolean' || data.teams !== Boolean(room.gameSettings?.tea)) return { error: 'Invalid native round outcome.' };
    const state = stateFor(room);
    if (state.receipt && data.round <= state.receipt.round) return data.round === state.receipt.round && data.winner === state.receipt.winner ? { ok: true, duplicate: true } : { error: 'Stale or conflicting round outcome.' };
    const activeIds: number[] = [];
    for (let id = 0; id < (room.playerSockets?.length ?? 0); id++) if (room.playerSockets[id] && room.playerInfo?.[id]?.team > 0 && !room.playerInfo[id].afk) activeIds.push(id);
    const winners = new Set(activeIds.length > 1 && data.winner >= 0 ? activeIds.filter(id => data.teams ? room.playerInfo[id].team === data.winner : id === data.winner) : []);
    if (data.winner >= 0 && activeIds.length > 1 && !winners.size) return { error: 'Winner is not an active participant.' };
    state.receipt = { round: data.round, winner: data.winner, winners, key: `${state.nonce}:${state.game}:${data.round}`, at: now() };
    const localMap = store.entityId('map', data.mapid), sourceMap = localMap ? undefined :
      getCatalogMap(data.dbv, data.mapid,true,store) ?? findNativeCatalogMap(data.mapid,store);
    const playKey = `${data.mapid}:${data.mode}:${data.round}`;
    if ((localMap || sourceMap) && !state.played.has(playKey)) {
      store.recordMapRound(localMap ? 2 : sourceVersion(sourceMap!), data.mapid, data.mode);
      state.played.add(playKey);
    }
    for (const [pending, at] of state.pending) { if (now() - at < 2000) award(pending, room, state.receipt); state.pending.delete(pending); }
    return { ok: true };
  };
  return Object.assign(handler, { recordRound });
}

export function setupServices(app: Express, options: { store?: ServiceStore } = {}) {
  const store = options.store ?? serviceStore;
  const api = express.Router();
  const asyncRoute = (handler: (req: Request, res: express.Response) => unknown): RequestHandler =>
    (req, res, next) => { Promise.resolve().then(() => handler(req, res)).catch(next); };
  const user = (res: express.Response): Profile => res.locals.user;
  const requireUser: RequestHandler = (_req, res, next) => {
    if (!res.locals.user) return next(new ServiceError(401, 'authentication_required', 'Sign in to continue.'));
    next();
  };
  const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/' });
  const establishSession = (req: Request, res: express.Response, account: Profile) => {
    store.revokeSession(getRequestToken(req));
    const token = store.createSession(account.id);
    res.cookie(sessionCookieName, token, { ...cookieOptions(req), maxAge: sessionLifetime });
  };
  // Bounded in-process throttling protects password hashing. Persistent deployment rate limits
  // should additionally be set at the reverse proxy if this local server is made public.
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const limitAuth: RequestHandler = (req, _res, next) => {
    const now = Date.now(), key = req.ip || req.socket.remoteAddress || 'unknown';
    if (attempts.size > 5000) for (const [ip, item] of attempts) if (item.expiresAt <= now) attempts.delete(ip);
    let attempt = attempts.get(key);
    if (!attempt || attempt.expiresAt <= now) { attempt = { count: 0, expiresAt: now + 10 * 60_000 }; attempts.set(key, attempt); }
    attempt.count++;
    if (attempt.count > 30) return next(new ServiceError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in 10 minutes.'));
    next();
  };
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.get('host')) throw new Error('Different origin');
      } catch { return next(new ServiceError(403, 'origin_rejected', 'Use this server\'s own page to change account data.')); }
    }
    next();
  });
  api.use(express.json({ limit: '3mb', strict: true }));
  api.use((req, res, next) => {
    if (req.body !== undefined && (req.body === null || Array.isArray(req.body) || typeof req.body !== 'object')) {
      return next(new ServiceError(400, 'invalid_input', 'Send a JSON object.'));
    }
    req.body ??= {};
    res.locals.user = store.getSession(getRequestToken(req));
    next();
  });
  api.get('/profile', (_req, res) => res.json({ user: res.locals.user ?? null, role: res.locals.user ? store.role(res.locals.user.id) : null }));
  api.post('/admin/roles', requireUser, (req, res) => {
    if (store.role(user(res).id) !== 'owner') throw new ServiceError(403, 'owner_required', 'Only the server owner can assign curator roles.');
    const target = store.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String(req.body.username || '')) as { id: string } | undefined;
    if (!target) throw new ServiceError(404, 'user_not_found', 'Account not found.');
    if (target.id === user(res).id) throw new ServiceError(400, 'invalid_role', 'Keep your owner role.');
    if (req.body.role !== 'curator' && req.body.role !== null) throw new ServiceError(400, 'invalid_role', 'Choose curator or null.');
    store.setRole(target.id, req.body.role);
    res.json({ ok: true });
  });
  api.post('/register', limitAuth, asyncRoute(async (req, res) => {
    const account = await store.register(req.body);
    establishSession(req, res, account);
    res.status(201).json({ user: account });
  }));
  api.post('/login', limitAuth, asyncRoute(async (req, res) => {
    const account = await store.login(req.body);
    establishSession(req, res, account);
    res.json({ user: account });
  }));
  api.post('/logout', (req, res) => {
    store.revokeSession(getRequestToken(req));
    res.clearCookie(sessionCookieName, cookieOptions(req));
    res.json({ ok: true });
  });

  api.get('/maps', (req, res, next) => {
    const viewerId = res.locals.user?.id;
    const favorites = req.query.favorites === '1';
    if ((req.query.owner === 'me' || favorites) && !viewerId) return next(new ServiceError(401, 'authentication_required', 'Sign in to see your maps and favorites.'));
    res.json(store.listMaps({ viewerId, ownerId: req.query.owner === 'me' ? viewerId : typeof req.query.owner === 'string' ? req.query.owner : undefined,
      query: typeof req.query.q === 'string' ? req.query.q : '', sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit), offset: req.query.offset === undefined ? undefined : Number(req.query.offset), favorites }));
  });
  api.post('/maps', requireUser, (req, res) => res.status(201).json({ map: store.createMap(user(res).id, req.body) }));
  api.post('/maps/import', requireUser, (req, res, next) => {
    if (req.body.format !== 'bonk-workbench-map' || req.body.version !== 1 || !req.body.map || Array.isArray(req.body.map)) {
      return next(new ServiceError(400, 'invalid_import', 'Import a bonk-workbench-map version 1 JSON export.'));
    }
    res.status(201).json({ map: store.createMap(user(res).id, req.body.map) });
  });
  api.get('/maps/:id/export', (req, res) => {
    const map = store.getMap(req.params.id, res.locals.user?.id);
    const name = map.name.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80) || 'map';
    res.attachment(`${name}.json`).json({ format: 'bonk-workbench-map', version: 1,
      map: { name: map.name, description: map.description, data: map.data, visibility: map.visibility } });
  });
  api.get('/maps/:id', (req, res) => res.json({ map: store.getMap(req.params.id, res.locals.user?.id) }));
  api.patch('/maps/:id', requireUser, (req, res) => res.json({ map: store.updateMap(req.params.id, user(res).id, req.body) }));
  api.delete('/maps/:id', requireUser, (req, res) => { store.deleteMap(req.params.id, user(res).id); res.json({ ok: true }); });
  api.post('/maps/:id/rating', requireUser, (req, res) => res.json({ map: store.rateMap(req.params.id, user(res).id, req.body.rating) }));
  api.post('/maps/:id/favorite', requireUser, (req, res, next) => {
    if (typeof req.body.favorite !== 'boolean') return next(new ServiceError(400, 'invalid_input', 'favorite must be true or false.'));
    res.json({ map: store.favoriteMap(req.params.id, user(res).id, req.body.favorite) });
  });

  api.get('/friends', requireUser, (_req, res) => res.json({ friends: store.listFriends(user(res).id) }));
  api.post('/friends', requireUser, (req, res) => res.status(201).json({ friend: store.requestFriend(user(res).id, req.body.username) }));
  api.post('/friends/:id/accept', requireUser, (req, res) => res.json({ friend: store.acceptFriend(req.params.id, user(res).id) }));
  api.delete('/friends/:id', requireUser, (req, res) => { store.removeFriend(req.params.id, user(res).id); res.json({ ok: true }); });

  api.get('/skins', requireUser, (_req, res) => res.json({ skins: store.listSkins(user(res).id), selectedSkinId: user(res).selectedSkinId }));
  api.post('/skins', requireUser, (req, res) => res.status(201).json({ skin: store.createSkin(user(res).id, req.body) }));
  api.patch('/skins/:id', requireUser, (req, res) => res.json({ skin: store.updateSkin(req.params.id, user(res).id, req.body) }));
  api.delete('/skins/:id', requireUser, (req, res) => { store.deleteSkin(req.params.id, user(res).id); res.json({ ok: true }); });
  api.post('/skins/:id/equip', requireUser, (req, res) => res.json({ user: store.equipSkin(req.params.id, user(res).id) }));
  api.delete('/profile/skin', requireUser, (_req, res) => res.json({ user: store.equipSkin(null, user(res).id) }));

  api.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ServiceError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'payload_too_large', message: 'JSON body exceeds 3 MB.' } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.' } });
    console.error('Independent account service error:', error);
    res.status(500).json({ error: { code: 'internal_error', message: 'Could not complete the request. Please try again.' } });
  });
  app.use('/api', api);
  return { store };
}
