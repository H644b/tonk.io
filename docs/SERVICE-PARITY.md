# Independent native services

This server implements native features using its own accounts and community data. The pinned shipped client establishes the request/response contracts. The original private backend is unavailable, so original reward eligibility, anti-abuse rules, hot-map ranking and moderation decisions cannot honestly be called proven 1:1.

The static source evidence is indexed in `evidence/protocol/service-parity-anchors.json`. Its original artifact is `vendor/bonk/alpha2s.js`, SHA-256 `e549ed7b6840a908bc0e9c595321aa5e9dcfa787190bae9b60938e32dfa65c8e`. Decoded offsets below refer to `evidence/protocol/alpha2s.decoded.js`; decoding is a derivative used for inspection. REA parent Evidence: `ev_e7d19dd1caf6abd1173cd8fb5b83f0997d464e9b43c624d43f78412899cc9999`. Static source observations are separate from tests and browser observations.

| Native feature | Independent implementation and testing | Original-client anchor | Evidence boundary |
| --- | --- | --- | --- |
| Register/login/remember/logout | Persisted hashed credentials, hashed revocable sessions, native cookies/token response, remembered login, username errors; HTTP tests | `M4p` 2798871, `j7l` 2807040, `t$N` 2831623 | Local accounts; original account records and password policy are not copied |
| Password/controls | Change password with current token preserved and other sessions revoked; native opaque controls persist; tested | `Q7b` 2810034; account HTTP request consumers | Independent strength and throttling policy |
| Five skin slots | Native serialized avatars, active 1-based slot, underlying local skin collection; save/relogin tests | `avatar_update.php` 3088013 | Renderer/editor retain original implementation; visual editor QA is separate |
| Friends | Incoming requests, reciprocal acceptance, accepted duplicate errors, unfriend/delete request, room presence; HTTP ownership tests | `friends.php` 2811930, `q9m` 2889141 | Local social graph; presence callback is supplied by room server |
| Native publish/overwrite/delete | Stable independent IDs, public/private ownership, overwrite confirmation, original `mo/rxn/rxa` metadata, author/name search and pagination; HTTP tests | `map_save_pub.php` 3193149 | Opaque level data preserves native format; private maps excluded from public catalogs |
| Favorites and votes | Public local maps and original bundled maps; per-account replaceable votes, favorites, native previous-vote reply, modern/B1/REST schemas; tests | send39/get41 methods 2704653/2704795, map consumers3054682 | Votes and favorites belong to this independent server; no invented original counts |
| Fresh/hot/mode/remix maps | Local publication list plus bundled catalog, mode/remix classification, hotness periods, local vote/round ranking; category and remix tests | native hot loader3041588 and row consumer3054682 | Functional hotness control; original private ranking formula is unknown. Public cache fetches returned403 during this pass |
| Curator picks | Native `/curate comment`, `/curateyes`, `/curateno`; persisted local curator/comment/mode, exact native success/failure vocabulary, rate limits; protocol and HTTP tests | `sendCurate`2705662, result handler1718868, picks renderer3071280 | Picks are actual local curator decisions. An empty new server has no fabricated picks |
| Training map tier | Populated native t1, configurable curator tiers1/2, native Classic fallback on a fresh server; tested | `matchmaking_maps.php`3376967 | Native pinned build consumes t1. It receives t2 but does not append it to trainingTwoStrings |
| Quick map rotation | Per-room stable map pool, native indexed pages/wraparound, mode-specific bundled maps and curator-approved published local maps; tested | request42 method2704917, consumer2712904 | Stable pool remains consistent when curations change while a room exists; private original pool ordering is unknown |
| XP/levels | Native winner requests receive100 XP only after the current host's native simulation outcome agrees, once per account/game/round. Level45 broadcasts and response46; FFA/team/draw/solo/duplicate/forgery tests | native winner request3355884, hardcoded+100 animation1724025, response2698277 | Host agreement is not server-authoritative physics. Original backend eligibility and anti-cheat are unknown. Active competitive participants only; Football does not request XP in pinned client |
| Replays | Opaque native data, dedupe, version/mode filter, stable pagination, persistent per-reporter hiding, moderation queue and reversible global hide; HTTP tests | get1871464, report1875567, submit3342870/3344592 | Actual native-produced242-frame replay also submitted/retrieved through real HTTP, decoded and simulated again to1:0; customstate/admin bytes retained |
| Header/player counts | Native combined counts split Classic/Arrows/Grapple/Simple/custom; tested callback adapter | playercount2896934 | Room enumeration and quick-matching allocation are supplied by root room server |

## Local catalog administration

The first account registered on a **fresh database** owns that local instance. Existing databases are not silently promoted by migration. For an existing installation, set `BONK_CURATORS=YourLocalUsername,AnotherCurator` when starting the server to grant those accounts catalog/replay moderation privileges. The native `/curate` flow is available to curators in any joined room.

While signed in, these JSON APIs use the normal HttpOnly local session cookie:

- `GET /api/catalog/curation`: local role and current picks.
- `POST /api/catalog/curation`: `{ "mapid": 1000000002, "dbv": 2, "comment": "A new arena", "mode": "sp", "tier": 0 }`. Supported modes: `b`, `v`, `sp`, `ar`, `ard`, `bs`, `f`, `any`. Tier1/2 classify training maps;0 is a normal pick.
- `DELETE /api/catalog/curation/:dbv/:id`: remove a local pick. Bundled source maps use their original source database version; rows expose `sourceDbv`.
- `POST /api/admin/roles`: `{ "username": "LocalPlayer", "role": "curator" }` or `role:null`; server owner only. The owner cannot remove their own role through this route.
- `GET /api/catalog/replays/reports`: local replay reports for curators.
- `POST /api/catalog/replays/:id/moderation`: `{ "hidden": true, "reason": "Local moderation decision" }`; set false to restore. Reporting hides only the reporter's copy until a curator makes a global decision.

A local map must be published before it can become a pick or enter a quick-play rotation. Deleting or making a map private removes it from public picks immediately. Bundled authors retain their original names and provenance; curating a map does not assign ownership to the curator.

## Outcome receipt integration

`makeNativeServiceHandler()` returns the native packet handler with `recordRound(data,socket,room)`. The root room server invokes it for `wb:round` from the original simulation's confirmed finish transition:

```ts
nativeServices.recordRound({
  round: state.rc,
  winner: state.lscr,       // -1 draw, player ID in FFA, team ID in teams
  teams: gameSettings.tea,
  mapid: gameSettings.map.m.dbid, // optional usage telemetry
  dbv: gameSettings.map.m.dbv,
  mode: gameSettings.mo,
}, socket, room);
```

Only the current joined host can submit an active-game receipt. Repeated receipt/XP messages cannot award again; conflicting/stale outcomes are rejected. Native winner request 38, a bare client XP value, elapsed playtime, map telemetry 47 and spectators grant no XP by themselves. The adapter keeps the native formula `floor(sqrt(xp)/10)+1`.

## Checks

Run `node --import tsx --test tests/service-parity.test.ts tests/services.test.ts tests/compatibility.test.ts tests/native-replay-service.test.ts` for the focused service suite, and `npm run check` for types. The full build/engine/browser acceptance remains necessary before claiming overall game parity. The service suite covers real HTTP requests and in-process native packet callbacks; it does not impersonate an original public account or claim access to the original private server.


## Confirmed outcome and native leave hooks

`applyNativeSessionHooks(source)` in `scripts/native-session-hooks.mjs` adds four exact, required AST insertions. It composes with the engine mod hooks. Removing its inserted strings restores the input bundle byte for byte; mismatched upstream anchors fail the build.

- The native game loop uses `history[currentFrame-30].fte === z.fte-1` as its settled round-win checkpoint. The new receipt runs at that same point, before the original registered-winner-only XP branch. It therefore works when a guest or losing player hosts the room. It does not submit a speculative `afterStep` result. `manifold.confirmedRound(receipt)` is the bridge callback; receipt fields are `round,winner,teams,frame,mapid,dbv,mode`.
- `manifold.nativeSession.leaveRoom()` invokes the original session's `endSession` path. Native controller destruction closes the socket, destroys renderers and map helpers, clears chat, returns to the main menu and refreshes the room list. It preserves login/account state and returns false when already destroyed. For room-pack cancellation prefer `manifold.cancelNativeJoin()` when available; it also handles consent before a session exists. Merely disconnecting the socket misses the native UI cleanup.
- Consent/download negotiation should finish before native join packet 13/server inform 3. The native 6-second initial-data timer starts after inform 3 and is cleared by lobby 21 or in-game 48. Holding 21 while a user reads a consent prompt can trigger a native join timeout.

`tests/native-session-hooks.test.ts` checks the exact insertion anchors, composes transformations, evaluates original replay history at the native confirmed-frame guard, rejects a current speculative finish and non-host/Football reports, and executes the original decoded controller/network/menu cleanup functions with instrumented dependencies. Browser consent navigation and real DOM cleanup remain root integration checks. Source anchors: `evidence/protocol/native-session-anchors.json`; test evidence: `evidence/verification/native-session-hooks.json`.


`manifold.cancelNativeJoin()` follows native Cancel cleanup, invalidates pending address responses, clears the connecting status/animation, and restores the menu. It works before socket creation and preserves account state. The fourth insertion guards an absent current replay before the native favorite-icon updater reads its map ID; valid replay and guest branches are unchanged. Five native-session tests cover these insertions. Browser checks verified that declining a late-join pack leaves zero loaded mods, hides the connecting overlay, clears its logs, and preserves the player identity.
