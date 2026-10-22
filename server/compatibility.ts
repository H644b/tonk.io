import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { ServiceError, serviceStore, type Profile, type ServiceStore, sessionLifetime } from './store.js';
import { getRequestToken, sessionCookieName } from './services.js';
import { setupCatalogRoutes, findNativeCatalogMap, getCatalogMap, sourceVersion, nativeCatalogFavorites, nativeCatalogRow, nativeCatalog, trainingMapPacket } from './catalog.js';

const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const dateString = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const endpoints = new Set(['login_legacy.php', 'register_legacy.php', 'login_auto.php', 'login_clearauto.php',
  'account_savecontrols.php', 'account_changepassword.php', 'avatar_update.php', 'friends.php',
  'map_getfresh.php', 'map_getown.php', 'map_getfave.php', 'map_getsearch.php', 'map_save_pub.php', 'map_delete.php', 'map_fave.php',
  'replay_get.php', 'replay_submit.php', 'replay_report.php', 'matchmaking_maps.php']);

export function nativeFriendRows(store: ServiceStore, userId: string, roomForUser?: (userId: string) => string | null) {
  const relationships = store.listFriends(userId);
  const person = (entry: any) => ({ name: entry.user.username, id: store.nativeId('user', entry.user.id), roomid: roomForUser?.(entry.user.id) ?? null });
  return { requests: relationships.filter(entry => entry.status === 'pending' && entry.direction === 'incoming').map(person),
    friends: relationships.filter(entry => entry.status === 'accepted').map(person) };
}
/** Native wire schemas backed by this server's own accounts and community data. */
export function setupCompatibility(app: Express, options: { store?: ServiceStore; roomForUser?: (userId: string) => string | null; playerCount?: () => number;
  playerCounts?: () => { quick_classic?: number; quick_arrows?: number; quick_grapple?: number; quick_simple?: number; custom?: number } } = {}) {
  const store = options.store ?? serviceStore;
  setupCatalogRoutes(app, { store });
  const router = express.Router();
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const reporterSalt = store.serverSetting('replayReporterSalt', randomBytes(32).toString('hex'));
  const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/' });
  const nativeFriends = (userId: string) => {
    return nativeFriendRows(store, userId, options.roomForUser);
  };
  const nativeProfile = (user: Profile, token: string, remembered = false) => {
    const avatars = store.getSetting(user.id, 'nativeAvatars', ['', '', '', '', '']);
    const active = store.getSetting(user.id, 'nativeActiveAvatar', 1);
    return { r: 'success', token, id: store.nativeId('user', user.id), username: user.username,
      xp: store.getSetting(user.id, 'xp', 0), avatar: avatars[active - 1] || '',
      avatar1: avatars[0] || '', avatar2: avatars[1] || '', avatar3: avatars[2] || '', avatar4: avatars[3] || '', avatar5: avatars[4] || '',
      activeAvatarNumber: active, controls: store.getSetting(user.id, 'nativeControls', ''),
      ...nativeFriends(user.id), legacyFriends: '', rememberToken: remembered ? token : '', localRole: store.role(user.id) };
  };
  const sendSession = (req: Request, res: Response, user: Profile, remembered: boolean, previous?: string | null) => {
    store.revokeSession(previous || getRequestToken(req));
    const token = store.createSession(user.id);
    res.cookie(sessionCookieName, token, { ...cookieOptions(req), maxAge: sessionLifetime });
    res.json(nativeProfile(user, token, remembered));
  };
  router.use(express.json({ limit: '3mb' }), express.urlencoded({ extended: false, limit: '3mb' }));
  router.get('/combinedplayercount.txt', (_req, res) => {
    const counts = options.playerCounts?.() ?? { custom: options.playerCount?.() ?? 0 };
    const bonk: Record<string, any> = {};
    let total = 0;
    for (const key of ['quick_classic', 'quick_arrows', 'quick_grapple', 'quick_simple', 'custom'] as const) {
      const count = Math.max(0, Math.trunc(Number(counts[key]) || 0));
      bonk[key] = String(count); total += count;
    }
    bonk.total = total;
    res.type('text/plain').send(JSON.stringify({ car: { custom: '0' }, bonk }));
  });
  router.all('/:endpoint', (req, res, next) => {
    const endpoint = req.params.endpoint;
    if (!endpoints.has(endpoint)) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ r: 'fail', e: 'method' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.get('host')) throw new Error(); }
      catch { return res.status(403).json({ r: 'fail', e: 'origin' }); }
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const token = typeof body.token === 'string' && body.token ? body.token : getRequestToken(req);
    const user = store.getSession(token);
    const reporter = createHash('sha256').update(reporterSalt + (user ? `user:${user.id}` : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`)).digest('hex');
    const requireUser = () => { if (!user) throw new ServiceError(401, 'token', 'Local sign-in required.'); return user; };
    const mapId = () => {
      const id = store.entityId('map', body.mapid);
      if (!id) throw new ServiceError(404, 'map_not_found', 'Map not found.');
      return id;
    };
    const work = async () => {
      if (endpoint === 'replay_get.php') return res.json({ r: 'success', replays: store.listReplays({ ...body, reporter }) });
      if (endpoint === 'replay_submit.php' || endpoint === 'replay_report.php') {
        const key = `replay:${req.ip || req.socket.remoteAddress || 'unknown'}`, now = Date.now();
        let attempt = attempts.get(key);
        if (!attempt || attempt.expiresAt <= now) { attempt = { count: 0, expiresAt: now + 10 * 60_000 }; attempts.set(key, attempt); }
        if (++attempt.count > 60) return res.status(429).json({ r: 'fail', e: 'ratelimited' });
        if (endpoint === 'replay_submit.php') return res.json({ r: 'success', id: store.saveReplay(body) });
        store.reportReplay(body.replayid, reporter);
        return res.json({ r: 'success' });
      }
      if (endpoint === 'matchmaking_maps.php') return res.json(trainingMapPacket(store));
      if (['login_legacy.php', 'register_legacy.php', 'account_changepassword.php'].includes(endpoint)) {
        const key = req.ip || req.socket.remoteAddress || 'unknown', now = Date.now();
        if (attempts.size > 5000) for (const [ip, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(ip);
        let attempt = attempts.get(key);
        if (!attempt || attempt.expiresAt <= now) { attempt = { count: 0, expiresAt: now + 10 * 60_000 }; attempts.set(key, attempt); }
        if (++attempt.count > 30) return res.status(429).json({ r: 'fail', e: endpoint === 'register_legacy.php' ? 'rate_limited' : 'ratelimited' });
      }
      if (endpoint === 'register_legacy.php') {
        if (!body.username || !body.password) return res.json({ r: 'fail', e: 'data_missing' });
        const account = await store.register(body);
        return sendSession(req, res, account, truthy(body.remember));
      }
      if (endpoint === 'login_legacy.php') {
        const account = await store.login(body);
        return sendSession(req, res, account, truthy(body.remember));
      }
      if (endpoint === 'login_auto.php') {
        const remembered = typeof body.rememberToken === 'string' ? body.rememberToken : '';
        const account = store.getSession(remembered);
        if (!account) return res.json({ r: 'fail', e: 'token' });
        res.cookie(sessionCookieName, remembered, { ...cookieOptions(req), maxAge: sessionLifetime });
        return res.json(nativeProfile(account, remembered, true));
      }
      if (endpoint === 'login_clearauto.php') {
        store.revokeSession(typeof body.rememberToken === 'string' ? body.rememberToken : token);
        store.revokeSession(getRequestToken(req));
        res.clearCookie(sessionCookieName, cookieOptions(req));
        return res.json({ r: 'success' });
      }
      if (endpoint === 'account_savecontrols.php') {
        const account = requireUser();
        if (typeof body.controls !== 'string' || body.controls.length > 32_768) throw new ServiceError(400, 'invalid_controls', 'Invalid controls.');
        store.setSetting(account.id, 'nativeControls', body.controls);
        return res.json({ r: 'success' });
      }
      if (endpoint === 'account_changepassword.php') {
        const account = requireUser();
        await store.changePassword(account.id, body.oldpass, body.newpass, token);
        return res.json({ r: 'success' });
      }
      if (endpoint === 'avatar_update.php') {
        const account = requireUser();
        const slot = Number(body.task === 'updateslot' ? body.newactive : body.newavatarslot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 5) throw new ServiceError(400, 'invalid_slot', 'Avatar slot must be 1 through 5.');
        const avatars = store.getSetting(account.id, 'nativeAvatars', ['', '', '', '', '']);
        const skinIds = store.getSetting(account.id, 'nativeAvatarSkinIds', ['', '', '', '', '']);
        if (body.task === 'updateavatar') {
          if (typeof body.newavatar !== 'string' || body.newavatar.length > 131_000) throw new ServiceError(400, 'invalid_avatar', 'Invalid avatar.');
          avatars[slot - 1] = body.newavatar;
          const existing = store.listSkins(account.id).find(skin => skin.id === skinIds[slot - 1]);
          const skin = existing ? store.updateSkin(existing.id, account.id, { data: body.newavatar }) : store.createSkin(account.id, { name: `Avatar ${slot}`, data: body.newavatar });
          skinIds[slot - 1] = skin.id;
          store.setSetting(account.id, 'nativeAvatars', avatars);
          store.setSetting(account.id, 'nativeAvatarSkinIds', skinIds);
          if (store.getSetting(account.id, 'nativeActiveAvatar', 1) === slot) store.equipSkin(skin.id, account.id);
        } else if (body.task === 'updateslot') {
          store.setSetting(account.id, 'nativeActiveAvatar', slot);
          const selected = store.listSkins(account.id).find(skin => skin.id === skinIds[slot - 1]);
          store.equipSkin(selected?.id ?? null, account.id);
        } else throw new ServiceError(400, 'invalid_task', 'Unknown avatar task.');
        return res.json({ r: 'success' });
      }
      if (endpoint === 'friends.php') {
        const account = requireUser();
        if (body.task === 'getfriends') return res.json({ r: 'success', ...nativeFriends(account.id) });
        if (body.task === 'send') {
          const existing = store.listFriends(account.id).find(entry => entry.user.username.toLowerCase() === String(body.theirname).toLowerCase());
          if (existing?.status === 'accepted') return res.json({ r: 'fail', e: 'already_friends' });
          const incoming = existing?.direction === 'incoming' ? existing : undefined;
          if (incoming) { store.acceptFriend(incoming.id, account.id); return res.json({ r: 'accept_success' }); }
          store.requestFriend(account.id, body.theirname);
          return res.json({ r: 'send_success' });
        }
        const theirId = store.entityId('user', body.theirid);
        const relation = store.listFriends(account.id).find(entry => entry.user.id === theirId);
        if (!relation) throw new ServiceError(404, 'request_not_found', 'Friendship or request not found.');
        if (body.task === 'accept') store.acceptFriend(relation.id, account.id);
        else if (body.task === 'unfriend' || body.task === 'deleterequest') store.removeFriend(relation.id, account.id);
        else throw new ServiceError(400, 'invalid_task', 'Unknown friends task.');
        return res.json({ r: 'success' });
      }
      if (endpoint === 'map_save_pub.php') {
        const account = requireUser();
        if (typeof body.leveldata !== 'string' || !body.leveldata.length) throw new ServiceError(400, 'invalid_map', 'Encoded map data is required.');
        const previous = store.db.prepare('SELECT id FROM maps WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(account.id, String(body.mapname)) as { id: string } | undefined;
        if (previous && !truthy(body.overwriteok)) return res.json({ r: 'overwrite_confirm' });
        const input = { name: body.mapname, data: body.leveldata, visibility: truthy(body.public) ? 'public' as const : 'private' as const };
        const map = previous ? store.updateMap(previous.id, account.id, input) : store.createMap(account.id, input);
        store.setMapMetadata(map.id, account.id, { mode: body.mode ?? body.mo, remix: body.remix ?? Boolean(body.rxn || body.rxa), spawns: body.spawns });
        return res.json({ r: 'success', mapid: store.nativeId('map', map.id) });
      }
      if (endpoint === 'map_delete.php') { store.deleteMap(mapId(), requireUser().id); return res.json({ r: 'success' }); }
      if (endpoint === 'map_fave.php') {
        const account = requireUser(), id = store.entityId('map', body.mapid);
        if (!['f', 'u'].includes(body.action)) throw new ServiceError(400, 'invalid_action', 'Unknown favorite action.');
        if (id) {
          const map = store.getMap(id, account.id);
          if (map.visibility !== 'public') return res.json({ r: 'fail', e: 'map_unpublished' });
          if (map.favorite === (body.action === 'f')) return res.json({ r: 'fail', e: map.favorite ? 'already_faved' : 'not_faved' });
          store.favoriteMap(id, account.id, body.action === 'f');
        } else {
          const map = body.sourceDbv ? getCatalogMap(body.sourceDbv, body.mapid) : findNativeCatalogMap(body.mapid);
          if (!map) throw new ServiceError(404, 'map_not_found', 'Map not found.');
          const social = store.getCatalogSocial(sourceVersion(map), map.id, account.id);
          if (social.favorite === (body.action === 'f')) return res.json({ r: 'fail', e: social.favorite ? 'already_faved' : 'not_faved' });
          store.favoriteCatalogMap(sourceVersion(map), map.id, account.id, body.action === 'f');
        }
        return res.json({ r: 'success' });
      }
      const own = endpoint === 'map_getown.php', favorites = endpoint === 'map_getfave.php';
      if (own || favorites) requireUser();
      const pageSize = own ? 30 : 32;
      const nativeLocalRow = (map: any) => ({ id: String(store.nativeId('map', map.id)), name: map.name, authorname: map.owner.username,
        leveldata: map.data, creationdate: dateString(map.createdAt), publisheddate: dateString(map.updatedAt),
        vu: (map.ratingsCount + map.rating) / 2, vd: (map.ratingsCount - map.rating) / 2,
        published: map.visibility === 'public' ? 1 : 0, public: map.visibility === 'public' ? 1 : 0, ratingScope: 'local-server' });
      if (favorites || endpoint === 'map_getsearch.php') {
        let all: any[];
        if (favorites) {
          const local = store.listFavoriteMapIds(user!.id).map(id => store.getMap(id, user!.id)).filter(map => typeof map.data === 'string').map(nativeLocalRow);
          all = [...local, ...nativeCatalogFavorites(store, user!.id)];
        } else {
          const local: any[] = [];
          for (let offset = 0; ; offset += 50) {
            const batch = store.listMaps({ viewerId: user?.id, query: String(body.searchstring || ''), searchName: truthy(body.searchmapname),
              searchAuthor: truthy(body.searchauthor), sort: body.searchsort === 'ctr' ? 'rating' : 'recent', limit: 50, offset, nativeOnly: true });
            local.push(...batch.maps.map((entry: any) => nativeLocalRow(store.getMap(entry.id, user?.id))));
            if (offset + batch.maps.length >= batch.total || !batch.maps.length) break;
          }
          const query = String(body.searchstring || '').toLowerCase().slice(0, 100), seen = new Set<string>();
          const source = nativeCatalog.filter(map => {
            const key = `${sourceVersion(map)}:${map.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return !query || (truthy(body.searchmapname) && map.name.toLowerCase().includes(query)) || (truthy(body.searchauthor) && map.authorname.toLowerCase().includes(query));
          }).map(map => nativeCatalogRow(map, store, user?.id));
          all = [...local, ...source];
          if (body.searchsort === 'ctr') all.sort((a, b) => (b.vu - b.vd) - (a.vu - a.vd));
        }
        const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(body.startingfrom) || 0)));
        return res.json({ r: 'success', maps: all.slice(offset, offset + pageSize), more: offset + pageSize < all.length, ratingScope: 'local-server' });
      }
      const result = store.listMaps({ viewerId: user?.id, ownerId: own ? user!.id : undefined, favorites,
        query: endpoint === 'map_getsearch.php' ? String(body.searchstring || '') : '',
        searchName: endpoint !== 'map_getsearch.php' || truthy(body.searchmapname),
        searchAuthor: endpoint !== 'map_getsearch.php' || truthy(body.searchauthor),
        sort: body.searchsort === 'ctr' ? 'rating' : 'recent', limit: pageSize, offset: Number(body.startingfrom) || 0, nativeOnly: true });
      const maps = result.maps.map((entry: any) => nativeLocalRow(store.getMap(entry.id, user?.id)));
      return res.json({ r: 'success', maps, more: result.offset + maps.length < result.total });
    };
    work().catch((error: unknown) => {
      if (error instanceof ServiceError) {
        const legacy: Record<string, string> = { invalid_username: 'username_invalid', invalid_password: 'password_weak',
          invalid_credentials: endpoint === 'account_changepassword.php' ? 'oldpass_wrong' : 'password',
          invalid_input: 'username_invalid',
          user_not_found: 'username_not_found', self_friend: 'cant_friend_self', friendship_exists: 'already_sent_request',
          authentication_required: 'token' };
        if (endpoint === 'login_legacy.php' && ['invalid_credentials', 'invalid_input'].includes(error.code) &&
          !store.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String(body.username || ''))) return res.json({ r: 'fail', e: 'username_fail' });
        return res.json({ r: 'fail', e: legacy[error.code] ?? error.code, message: error.message });
      }
      console.error('Native compatibility service error:', error);
      res.status(500).json({ r: 'fail', e: 'server_error' });
    });
  });
  app.use('/compat', router);
}
