const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const code = (source) => `<pre><code>${escape(source.trim())}</code></pre>`;
const table = (headings, rows) =>
  `<div class="help-table-scroll"><table><thead><tr>${headings.map((value) => `<th scope="col">${escape(value)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

const topics = [
  {
    id: "getting-started",
    title: "Controls",
    content: `<h2>Controls</h2>
${table(
  ["Key", "Action"],
  [
    ["Arrow keys", "Move"],
    ["X (hold)", "Heavy"],
    ["Enter", "Chat"],
  ],
)}
<p>Change key bindings in Settings. Additional controls depend on the selected mode.</p>
<p><button type="button" class="brownButton brownButton_classic" data-help-topic="modding">Modding documentation</button></p>`,
  },
  {
    id: "modding",
    title: "Modding",
    content: `<h2>Modpacks</h2>
<p>A <code>.bonkmod</code> archive contains a <code>bonk.mod.json</code> manifest, JavaScript or TypeScript entrypoints, and assets.</p>
<h3>Client packs</h3>
<p>Upload a pack in Workbench → Mods while hosting a room. Players must accept the pack before joining. Changed content requires a new approval.</p>
<h3>Server entrypoints</h3>
<p>Install and enable packs with server entrypoints through the operator CLI, then restart the server. Room uploads accept client packs only.</p>
<p>Code mods can access the game and account data. Install only packs you trust.</p>
<p><button type="button" class="brownButton brownButton_classic" data-help-topic="create">Create a modpack</button></p>`,
  },
  {
    id: "create",
    title: "Create a modpack",
    content: `<h2>Create a modpack</h2>
<p>Use an ES module for client behavior and an optional server ES module for shared logic. Export <code>setup(api)</code> or a default function from each entrypoint. Keep a <code>bonk.mod.json</code> manifest at the root of the pack.</p>
${code(`my-mod/
  bonk.mod.json
  client.js
  server.js
  assets/
    orb.svg`)}
<h3>Installation</h3>
<p>Run mod commands from the Bonk Workbench project folder. Install a folder during development, then package it for distribution once it works.</p>
${code(`npm run mods -- install ./my-mod
npm run mods -- enable my-mod
npm run mods -- list`)}
<p>Enabled packs are loaded by the server after restart. Use Workbench → Mods to see packs and the room profile. Test changes in a private room before sharing them.</p>
<h3>Share a client pack as a room host</h3>
<p>Package your client entrypoint and assets as a <code>.bonkmod</code>, then use the host’s pack upload in Workbench → Mods. Peers choose whether to download and join. Uploading a pack with a server entrypoint requires the operator workflow instead.</p>
<p>Use <code>npm run mods -- disable my-mod</code> to disable a pack. A fresh server start and page reload give code modules a clean lifecycle after changing installed files.</p>
<h3>Package and share</h3>
${code(`npm run mods -- pack ./my-mod ./my-mod-1.0.0.bonkmod
npm run mods -- install ./my-mod-1.0.0.bonkmod`)}
<p>A <code>.bonkmod</code> is a ZIP archive with the manifest at its root. The installer accepts a folder or archive, up to 64 MB expanded and 2,048 files. It rejects symlinks and paths that escape the pack.</p>
<h3>JavaScript and TypeScript</h3>
<p>The installer bundles client and server entrypoints with esbuild. JavaScript and TypeScript entrypoints are supported, including relative imports from files inside the pack. Client code must use browser-compatible APIs. Include source dependencies in your pack; <code>node_modules</code> is excluded from archives.</p>`,
  },
  {
    id: "manifest",
    title: "Manifest & dependencies",
    content: `<h2>The pack manifest</h2>
<p><code>bonk.mod.json</code> declares identity, API version, entrypoints, dependencies, and named assets.</p>
${code(`{
  "schemaVersion": 2,
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "api": 2,
  "description": "Custom game content.",
  "entrypoints": {
    "client": "client.js",
    "server": "server.js"
  },
  "dependencies": {},
  "assets": {
    "orb": "assets/orb.svg"
  }
}`)}
${table(
  ["Field", "Meaning"],
  [
    [
      "<code>id</code>",
      "A stable unique identifier. Keep it unchanged when updating the same pack.",
    ],
    [
      "<code>name</code>, <code>description</code>",
      "Human-readable identity and purpose shown to players.",
    ],
    [
      "<code>version</code>",
      "A semantic version for the pack, separate from the SDK API version.",
    ],
    [
      "<code>schemaVersion</code>, <code>api</code>",
      "Both must be <code>2</code> for full code modpacks.",
    ],
    [
      "<code>entrypoints</code>",
      "Relative paths to the client and server module. Include the side or sides your pack uses.",
    ],
    [
      "<code>dependencies</code>",
      "Required pack IDs and compatible versions, for example <code>{ &quot;base-content&quot;: &quot;^1.0.0&quot; }</code>.",
    ],
    [
      "<code>assets</code>",
      "Files included in the pack. The runtime resolves these names to URLs for the client.",
    ],
  ],
)}
<h3>Keep identities stable</h3>
<p>Use namespaced registry keys such as <code>my-mod:orb</code> to avoid collisions. Pack files contribute to the content identity used for synchronization. Change the pack version when publishing changed behavior or data.</p>`,
  },
  {
    id: "assets",
    title: "Assets",
    content: `<h2>Add your own assets</h2>
<p>Keep images, audio, textures, and data files inside the pack. Add the names you want to reference to the manifest’s <code>assets</code> map.</p>
<h3>Asset paths</h3>
${code(`"assets": {
  "orb": "assets/orb.svg",
  "hit": "assets/hit.ogg",
  "settings": "data/settings.json"
}`)}
<p>Manifest paths are relative to the pack root. Include the referenced files when distributing the pack. Use a consistent namespace for content keys, and use the asset resolver rather than hard-coding a server’s filesystem path.</p>
<h3>Rendering and audio</h3>
<p>Assets become visible or audible when your client code uses them. Adding a file to the manifest alone does not create a game entity. Connect it to a renderer, component, or engine hook in your module.</p>
<p>Browser audio policies still apply. Start audio after the player interacts with the page. Keep large textures and loops out of per-frame loading paths; load once and release resources when the pack or scene ends.</p>`,
  },
  {
    id: "api",
    title: "Client API reference",
    content: `<h2>The client setup API</h2>
<p>A client entrypoint exports <code>setup(api)</code> or a default setup function. It can be asynchronous, and can return cleanup. The API belongs to your pack; content registrations must begin with <code>your-pack-id:</code>.</p>
${code(`export async function setup(api) {
  const texture = await api.assets.texture('orb');
  api.entities.register('my-mod:orb', {
    texture,
    body: { shape: 'circle', radius: 0.5 },
    width: 1,
    height: 1
  });
  api.on('createState', ({ world }) => {
    world.spawn('my-mod:orb', { x: 25, y: 6 });
  });
}`)}
${table(
  ["Member", "Purpose"],
  [
    [
      "<code>id</code>, <code>version</code>, <code>side</code>",
      "Pack identity; side is <code>client</code>.",
    ],
    [
      "<code>engine</code>",
      "Live native modules: simulation, Football simulation, map encoder/list, renderers, Box2D, PIXI, player, editors, replay, binary helpers, avatar, and raw constructors.",
    ],
    [
      "<code>game</code>",
      "Current native networked game object, when attached. Use it for raw frame/state/admin access with care.",
    ],
    [
      "<code>world</code>",
      "Current mod EntityWorld, or the latest native mod state. Can be null before a game exists.",
    ],
    [
      "<code>on(event, handler, priority?)</code>",
      "Register a lifecycle/native hook listener. Returns an unsubscribe function. Priorities run from lower to higher.",
    ],
    [
      "<code>entities</code>, <code>components</code>, <code>modes</code>, <code>properties</code>",
      "Registries with <code>register(id, definition)</code>, <code>get(id)</code>, and <code>values()</code>.",
    ],
    [
      "<code>registry(category)</code>",
      "Get the same registry interface for an additional content category.",
    ],
    [
      "<code>Entity</code>",
      "Optional base class with defaults, body, update, and render members. Plain definition objects also work.",
    ],
    [
      "<code>mixins.wrap(target, name, wrapper)</code>",
      "Wrap a method. The wrapper receives the original bound method first. Returns an undo function; tracked for cleanup.",
    ],
    [
      "<code>mixins.define(target, name, descriptor)</code>",
      "Define a property and record its prior descriptor for cleanup.",
    ],
    [
      "<code>input.on(code, handler)</code>",
      "Listen for a physical key code such as <code>KeyO</code>. Text inputs are excluded. Returns an unsubscribe function.",
    ],
    [
      "<code>ui.mount(element, { parent? })</code>",
      "Mount a DOM element, tracked for removal. Default parent is the game container.",
    ],
    ["<code>ui.style(css)</code>", "Add a stylesheet, tracked for removal."],
    [
      "<code>ui.notify(message)</code>",
      "Send a message to the Workbench’s mod status.",
    ],
    [
      "<code>dispose(cleanup)</code>",
      "Register your own resource cleanup callback.",
    ],
  ],
)}
<h3>Asset methods</h3>
${table(
  ["Method", "Returns"],
  [
    [
      "<code>assets.bytes(name)</code>",
      "A copy of a verified asset’s byte array.",
    ],
    ["<code>assets.url(name)</code>", "The server URL of a declared asset."],
    [
      "<code>assets.text(name)</code>, <code>assets.json(name)</code>",
      "Decoded text or parsed JSON.",
    ],
    [
      "<code>await assets.image(name)</code>",
      "A decoded Image from verified bytes.",
    ],
    [
      "<code>await assets.texture(name)</code>",
      "A cached PIXI texture from verified bytes, released during cleanup.",
    ],
    [
      "<code>assets.sound(name)</code>",
      "An Audio element backed by verified bytes. Browser interaction policies still apply.",
    ],
  ],
)}
<p><code>assets.image</code>, <code>texture</code>, and <code>sound</code> use downloaded, hash-checked bytes. A plain URL can be useful for other browser loaders; preserve the integrity and lifecycle expectations when adding your own loader.</p>
<h3>Custom properties</h3>
${code(`api.properties.register('my-mod:charge', {
  default: 0,
  validate(value) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Charge must be a nonnegative number.');
  }
});
api.on('createState', () => {
  api.properties.write('world', 'my-mod:charge', 1);
  const charge = api.properties.read('world', 'my-mod:charge');
});`)}
<p>The target is a string you choose, for example <code>world</code> or a player/entity key. Read falls back to the registered default. Write calls your validator, requires finite JSON data, and saves a cloned value in mod world state. A validator should throw to reject a value.</p>`,
  },
  {
    id: "content",
    title: "Content & properties",
    content: `<h2>Define new things</h2>
<p>Content registries hold named definitions. An entity definition supplies behavior; an entity state holds the data that changes during a game. Keep those roles separate so state can be copied and replayed.</p>
${table(
  ["Content", "Purpose"],
  [
    [
      "Entities",
      "New game objects with defaults and lifecycle behavior. Each spawned object has a stable ID and namespaced type.",
    ],
    [
      "Components",
      "Reusable behavior and data attached to entities, such as health, a timer, or a collectible effect.",
    ],
    [
      "Properties",
      "Additional fields that your code interprets. Prefer a namespace over overwriting an original field.",
    ],
    [
      "Modes",
      "Mode definitions and the lifecycle behavior needed to run them. A mode registration alone does not implement its rules.",
    ],
    [
      "Custom registries",
      "Packs can define further content categories and resolve each other’s namespaced definitions.",
    ],
  ],
)}
<h3>Entity state</h3>
<p>The shared entity model includes position, velocity, angle, custom properties, and component data. All values used in replayed or persistent state should remain serializable.</p>
${code(`{
  "id": "1",
  "type": "my-mod:orb",
  "x": 20,
  "y": 10,
  "vx": 0,
  "vy": 0,
  "angle": 0,
  "angularVelocity": 0,
  "properties": { "charge": 1 },
  "components": { "my-mod:lifetime": { "remaining": 180 } }
}`)}
<h3>Repeatable simulation</h3>
<p>Use the world’s seeded random generator for simulation decisions. Keep browser objects, textures, audio nodes, and callbacks outside game state. Treat rendering as a view of state, so rendering the same state twice does not advance the game.</p>
<p>Use <code>my-mod:orb</code> rather than a common name such as <code>orb</code>. Duplicate names are rejected to expose conflicts instead of silently replacing another pack’s content.</p>`,
  },
  {
    id: "modes",
    title: "Custom modes",
    content: `<h2>Choose your own rules</h2>
<p>A custom mode is a namespaced definition owned by an active code pack. It declares a native base, then extends round creation, simulation, and rendering through client lifecycle functions.</p>
<h3>Select a mode in a room</h3>
<ol><li>As host, return to the lobby and load the required pack in Workbench → Mods.</li><li>Under <strong>Custom mode</strong>, open <strong>Game rules</strong>. The list contains modes registered by this room’s active packs, with their native base shown beside the name.</li><li>Choose the mode and press <strong>Use mode</strong>. The server applies the native base and shares the custom mode ID with the room.</li><li>Start after all players finish loading. Select <strong>Default rules</strong> and press Use mode to clear custom mode hooks while keeping the current native base.</li></ol>
<h3>Declare a client mode</h3>
<p>Every mode must declare <code>base</code> as one of <code>b</code> (Classic), <code>ar</code> (Arrows), <code>ard</code> (Death Arrows), <code>bs</code> (Simple), <code>sp</code> (Grapple), <code>f</code> (Football), or <code>v</code> (VTOL).</p>
${code(`// Inside client setup, after registering my-mod:orb.
api.modes.register('my-mod:orb-arena', {
  name: 'Orb Arena',
  base: 'b',
  init({ world }) {
    world.spawn('my-mod:orb', { x: 25, y: 6 });
  },
  update({ world }) {
    for (const orb of world.query('my-mod:orb')) {
      if (orb.y > 60) world.remove(orb.id);
    }
  }
});`)}
<p><code>init(context)</code> runs when native round state is created, <code>update(context)</code> runs during the replayable simulation step, and <code>render(context)</code> runs after native rendering. Store shared results in world state. The selected mode ID is available in the room profile’s <code>mode</code> field.</p>
<h3>Operator-installed discovery</h3>
<p>A server entrypoint can also declare a mode and its native base. Use the same ID and base in the client implementation:</p>
${code(`export function setup(api) {
  api.modes.register('my-mod:orb-arena', {
    name: 'Orb Arena',
    base: 'b'
  });
}`)}
<p>Client-only packs can declare modes without server code. The host shares the declaration’s ID and base when selecting it; the server checks active pack ownership and the allowed native base. Operator declarations are validated against the server registry. Registering metadata alone does not implement custom game behavior—put the rules in client lifecycle hooks.</p>`,
  },
  {
    id: "physics",
    title: "Physics & rendering",
    content: `<h2>Give custom entities a body</h2>
<p>Entity body descriptors create real Box2D bodies in the native physics step. Transforms are captured back into serializable entity state before the native world is cleaned up. Position, dimensions, and velocity use native world units.</p>
${code(`const orb = {
  defaults: { properties: { charge: 1 } },
  body: {
    shape: 'circle',
    radius: 0.5,
    density: 1,
    friction: 0.3,
    restitution: 0.8
  },
  color: '#48cfad',
  outline: '#ffffff',
  outlineWidth: 0.05
};`)}
${table(
  ["Body option", "Behavior"],
  [
    ["<code>shape: 'circle'</code>", "Use a positive <code>radius</code>."],
    [
      "<code>shape: 'box'</code>",
      "Use positive full <code>width</code> and <code>height</code>.",
    ],
    [
      "<code>shape: 'polygon'</code>",
      "Supply 3–8 convex, nondegenerate <code>points</code> as <code>[x, y]</code> pairs or <code>{ x, y }</code> objects.",
    ],
    [
      "<code>fixtures</code>",
      "An array of shape descriptors for a compound body. Use multiple fixtures for concave objects.",
    ],
    [
      "<code>static</code>, <code>kinematic</code>",
      "Choose an immovable body or kinematic motion. Otherwise the body is dynamic.",
    ],
    [
      "<code>sensor</code>",
      "Receive contacts without a solid collision response.",
    ],
    [
      "<code>density</code>, <code>friction</code>, <code>restitution</code>",
      "Material values, with optional per-fixture overrides.",
    ],
    [
      "<code>categoryBits</code>, <code>maskBits</code>, <code>groupIndex</code>",
      "Box2D collision filtering.",
    ],
    [
      "<code>linearDamping</code>, <code>angularDamping</code>, <code>fixedRotation</code>, <code>bullet</code>",
      "Motion and collision behavior.",
    ],
  ],
)}
<p>A body descriptor can be a function of the entity and context. Set <code>bodyEnabled: false</code> on an entity to omit its body. A descriptor’s <code>created(entity, body, context)</code> callback can use the raw Box2D body for advanced behavior.</p>
<h3>Collisions</h3>
<p>Definitions can provide <code>collide</code>, <code>beginContact</code>, <code>endContact</code>, and <code>postSolve</code> callbacks. They receive the entity, its counterpart, and contact context. The counterpart can be another mod entity or a native object descriptor. Native collision callbacks are retained.</p>
<h3>Draw in the native camera</h3>
<p>The default view draws a body’s circle, box, or polygon. A definition can supply <code>color</code>, <code>alpha</code>, <code>outline</code>, <code>outlineWidth</code>, or a <code>texture</code>. Texture dimensions use <code>width</code> and <code>height</code>; tint can come from <code>entity.properties.tint</code>.</p>
<p>A definition’s <code>render(entity, container, context)</code> callback can add custom PIXI content. The context supplies PIXI, native objects, the world, the layer, and default graphic/sprite references. Use <code>defaultView: false</code> when your renderer supplies the whole appearance. Views are attached to the native camera and removed as entities or renderers are destroyed.</p>`,
  },
  {
    id: "engine",
    title: "Native engine hooks",
    content: `<h2>Work with the original engine</h2>
<p>The native integration exposes original simulation, rendering, map encoding, editor, and physics objects to trusted client code. This lets code mods go beyond presets and existing game rules.</p>
<h3>Hook phases</h3>
${table(
  ["Hook", "When it runs"],
  [
    [
      "<code>createState</code>",
      "A native state has been created for a map, player list, and seed.",
    ],
    [
      "<code>beforeStep</code>, <code>afterStep</code>",
      "Around a native simulation step. Context includes state, inputs, settings, arguments, and engine kind.",
    ],
    [
      "<code>beforePhysics</code>, <code>afterPhysics</code>",
      "Around the actual Box2D step. Physics context includes the world and the native bodies available for that engine.",
    ],
    [
      "<code>beforeRender</code>, <code>afterRender</code>",
      "Around drawing a frame. Context includes native renderer, stage, current/previous state, and interpolation.",
    ],
  ],
)}
<p>Modern and Football simulation paths have separate contexts. Modern, legacy, and Football rendering paths also differ. Inspect the context’s <code>kind</code> before using an engine-specific member.</p>
<h3>Raw access and mixins</h3>
<p>Raw objects retain the original engine’s behavior and object shapes. A mixin can wrap a method, call the original with its existing arguments, then extend the result. Restore wrapped methods and remove listeners during cleanup.</p>
<p>Changes inside physics and simulation can affect every round and must be deterministic across players. Use a shared pack profile for simulation changes. Visual-only changes should stay in render hooks.</p>
<h3>Version boundary</h3>
<p>These hooks are inserted at exact anchors in a pinned shipped engine. A build fails if a required anchor moves. That prevents silent hook drift; it does not make private engine fields a stable public API. Test raw integrations when updating the engine artifact.</p>`,
  },
  {
    id: "network",
    title: "Networking & synchronization",
    content: `<h2>Share behavior between players</h2>
<p>A room’s mod profile includes its packs and content hashes. Host-shared executable content requires the peer’s <strong>Download &amp; Join</strong> approval before it downloads and executes. <strong>Leave Room</strong> declines the pack. An approval is cached only for the exact approved hash; changed content is presented again.</p>
<p>Code and asset bytes travel through the server and are hash verified. Only the room host can change the profile, while in the lobby. Every participating client must finish loading and acknowledge the matching profile before the host can start.</p>
<h3>Server channels</h3>
<p>Register channels in your server entrypoint. A short channel name is automatically prefixed with your pack ID. Channels default to host-only input; opt into player messages explicitly.</p>
${code(`export function setup(api) {
  api.network.register('greet', {
    from: 'players',
    maxBytes: 1024
  }, (data, { room, playerId }) => {
    if (typeof data.text !== 'string' || data.text.length > 80)
      throw new Error('Send a greeting of at most 80 characters.');
    api.network.send(room.id, 'greeting', {
      playerId,
      text: data.text
    });
    return { delivered: true };
  });
}`)}
<p>The server handler receives <code>room</code>, <code>playerId</code>, <code>socket</code>, and <code>command(name, data)</code>. Messages carry finite JSON data. Enforce game-specific permission and value checks in your handler, in addition to the loader’s membership, host, and size checks.</p>
<p><code>api.network.send(roomId, name, data, target?)</code> broadcasts to the room, or targets a numeric native player ID. The default incoming message budget is 16 KB; a channel may set a limit up to 64 KB. Extension traffic is rate limited independently of native packets.</p>
<h3>Client messages</h3>
${code(`api.network.on('greeting', (data, { sender }) => {
  api.ui.notify(data.text);
});
await api.network.send('greet', { text: 'Hello from my mod' });`)}
<p><code>api.network.send(name, data)</code> returns a promise for the server’s acknowledgement. <code>api.network.on(name, handler)</code> receives payload and sender context. Send only after joining a room; handle rejected requests.</p>
<h3>Simulation commands</h3>
<p><code>api.commands.register(name, handler)</code> registers a server-side command handler. <code>api.commands.send(roomId, name, data)</code> schedules a command through the room host. A channel handler can call its supplied <code>command</code> function after validating a player request.</p>
${code(`api.commands.register('spawn', (data, { world, sender }) => {
  world.spawn('my-mod:orb', { x: data.x, y: data.y });
});
// Direct scheduling is host-only. Validate requests from other players server-side.
await api.commands.send('spawn', { x: 25, y: 6 });`)}
<p>The host inserts accepted commands into native administrative input at a future frame. Command handlers execute with mod world state during the replayable simulation step. Store results in that state rather than external mutable variables.</p>
<p>Commands distinguish shared simulation actions from asynchronous UI messages. The native physics engine still simulates on clients; a server-side mod handler is not a substitute for validating a custom competitive game’s rules.</p>`,
  },
  {
    id: "lifecycle",
    title: "Lifecycle & saved state",
    content: `<h2>Keep state in the right place</h2>
<p>Entry modules export <code>setup(api)</code> or a default setup function. Setup may be asynchronous and may return a cleanup function. Register definitions and listeners once, then keep room and simulation state separate from module-wide state.</p>
<h3>Server events</h3>
${table(
  ["Event", "Payload"],
  [
    [
      "<code>roomCreate</code>, <code>roomDispose</code>",
      "Room API object for a modded room’s lifecycle.",
    ],
    [
      "<code>matchStart</code>, <code>matchEnd</code>",
      "Room API object when the native room changes between match and lobby.",
    ],
    [
      "<code>playerJoin</code>",
      "<code>{ room, id, socket }</code> for a newly joined player.",
    ],
    [
      "<code>playerLeave</code>",
      "<code>{ room, socketId }</code> for a player who left.",
    ],
    [
      "<code>tick</code>",
      "<code>{ room, time }</code> at approximately 60 Hz. Server timer time is distinct from native deterministic simulation time.",
    ],
  ],
)}
<p><code>api.on(event, handler, priority?)</code> returns an unsubscribe function. Listeners run in ascending priority order. Enabled server modules share the event bus, so check that a room’s profile includes your pack when handling shared events.</p>
<h3>Room access</h3>
<p><code>api.rooms.get(id)</code> returns a room API, and <code>api.rooms.list()</code> lists rooms using your pack. A room API exposes <code>id</code>, <code>profile</code>, <code>settings</code>, <code>players</code>, and the raw <code>native</code> room. Raw room access depends on server internals.</p>
<h3>Persistent server data</h3>
${code(`export function setup(api) {
  const starts = api.storage.get('starts', 0);
  api.storage.set('starts', starts + 1);
  api.log('Pack started', starts + 1, 'times');
  return () => api.log('Pack stopped');
}`)}
<p><code>api.storage.get(key, fallback)</code> and <code>api.storage.set(key, value)</code> read and write your pack’s JSON file under <code>mods/data/</code>. Use finite numbers, strings, booleans, arrays, plain objects, and null. Do not store native engine objects, functions, DOM nodes, or circular data.</p>
<h3>Client state and cleanup</h3>
<p>Client <code>storage.get(key, fallback)</code> and <code>storage.set(key, value)</code> use per-pack browser localStorage. Browser preferences are separate from replicated game state and server storage.</p>
<p>The loader removes owned event listeners, registries, managed UI, textures, and asset URLs during unload. Mixins track restoration; <code>api.dispose</code> and a setup return function cover your own resources. Normal JavaScript can also make changes the loader cannot infer. Provide explicit cleanup for those changes; a page reload and server restart are the clean recovery for unsupported raw mutations.</p>
<p>Native mod entity/property data is stored with the native state under a pack hash, so replayed simulation steps can use matching content. Playback with a different profile is rejected rather than guessing at missing definitions.</p>
<h3>Updating a pack</h3>
<p>Installed versions are immutable. Change your version and reinstall instead of editing distributed files in place; the repository verifies their hashes. Restart the server after enabling or disabling code, and reload clients after an update. Preserve backward compatibility for saved data or migrate it explicitly in setup.</p>`,
  },
  {
    id: "examples",
    title: "Download an example",
    content: `<h2>Orb Kit</h2>
<p>A complete client code pack adds a textured bouncing physics entity, a component timer, a custom world property, and a synchronized host spawn command. Its manifest, code, and SVG asset are included.</p>
<p><a href="/help/examples/orb-kit-1.0.0.bonkmod" download>Download Orb Kit 1.0.0 (.bonkmod)</a></p>
<ol><li>Download the archive and inspect the source.</li><li>Open a custom room as host, then Workbench → Mods and upload the client pack. Alternatively install and enable it with the operator CLI.</li><li>Each player chooses <strong>Download &amp; Join</strong> for this exact pack profile.</li><li>Start a match on a native map. One orb spawns with the round; the host can press <strong>O</strong> to add another.</li><li>Check that both clients see the same orb, contacts, movement, and removal. The lifetime component removes each orb after 600 simulation steps.</li></ol>
<h3>Read the files</h3>
<ul><li><a href="/help/examples/orb-kit/bonk.mod.json" target="_blank" rel="noopener">bonk.mod.json</a> — identity, client entrypoint, and named asset.</li><li><a href="/help/examples/orb-kit/client.js" target="_blank" rel="noopener">client.js</a> — setup, entity/component/property registration, native creation event, host command, and input.</li><li><a href="/help/examples/orb-kit/assets/orb.svg" target="_blank" rel="noopener">assets/orb.svg</a> — a custom texture.</li></ul>
<h3>Install through the operator CLI</h3>
${code(`npm run mods -- install ./orb-kit-1.0.0.bonkmod
npm run mods -- enable orb-kit
# Restart the server, then reload clients.`)}
<p>Change the pack ID and its registration namespaces when creating your own pack. Increment the version before installing changed bytes.</p>`,
  },
  {
    id: "legacy",
    title: "Appearance & isolated scripts",
    content: `<h2>Appearance & scripts</h2>
<h3>Appearance JSON</h3>
${code(`{
  "version": 1,
  "name": "Teal controls",
  "description": "Teal action buttons.",
  "type": "css",
  "css": ".brownButton{background:#007f73!important}"
}`)}
<p>Import the JSON file under appearance mods and enable its checkbox. CSS imports and <code>url()</code> resource loads are rejected. Disable or remove the mod to restore the base styles.</p>
<h3>Isolated Worker script</h3>
${code(`api.on('ready', () => {
  api.notify('Moon gravity loaded');
  api.setRoomRules({ gravity: 6, rounds: 5 });
});`)}
<p>The limited script API is <code>api.on(event, handler)</code>, <code>api.notify(message)</code>, and <code>api.setRoomRules(rules)</code>. Events are <code>ready</code>, <code>room</code>, and <code>packet</code>. Rules accept <code>gravity</code>, <code>rounds</code>, and <code>teams</code>.</p>
<p>Only the current host can change room rules, while the room is in the lobby. Stop terminates the script; it does not undo room rules already applied. These scripts have no DOM, asset loading, or full-engine API. Choose a full code pack to add new content.</p>`,
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    content: `<h2>Find the cause</h2>
${table(
  ["Problem", "What to check"],
  [
    [
      "Pack does not appear",
      "Check the manifest filename, JSON syntax, pack ID, API version, and the operator’s enabled pack list. Restart after changing installed code.",
    ],
    [
      "Module does not load",
      "Inspect the browser console or server terminal. Check that entrypoints and all relative imports exist. Inspect the installer’s build error for unsupported imports or syntax.",
    ],
    [
      "Dependency cannot resolve",
      "Install the required pack and a compatible version. Resolve dependency cycles and version conflicts before enabling.",
    ],
    [
      "Players cannot start a modded game",
      "Every player must accept and finish loading the room’s pack profile. Check the Download &amp; Join prompt, download progress, identities, and hashes. Changed content requires a new approval.",
    ],
    [
      "Asset is missing",
      "Check manifest names, path case, included files, and browser network errors. Filesystem paths from your computer are not client asset URLs.",
    ],
    [
      "Room rules are rejected",
      "Use the current host while the room is in the lobby. Isolated scripts can change only the supported rule fields.",
    ],
    [
      "Hook runs twice",
      "Unsubscribe listeners and remove hooks during cleanup. Do not install a new hook on every frame or room update.",
    ],
    [
      "Custom state diverges",
      "Keep replicated state serializable and deterministic. Make shared decisions on the server and broadcast the result through the mod channel.",
    ],
    [
      "Game stops responding",
      "Disable the suspect code pack, restart the server, and reload the page. Check for an exception, an unbounded loop, or work repeated every frame.",
    ],
  ],
)}
<h3>Report a useful reproduction</h3>
<p>Record the pack IDs and versions, room profile, selected mode and map, steps, expected result, actual result, and the first console or terminal error. A small pack that demonstrates the problem is easier to debug than a collection of unrelated mods.</p>`,
  },
  {
    id: "compatibility",
    title: "Testing mods",
    content: `<h2>Test the behavior you change</h2>
<h3>A practical mod test</h3>
<ol><li>Start with a clean server, a clean client, and a known working native map.</li><li>Load the pack and check both client and server startup output.</li><li>Open two clients, join the same room, and verify the selected mod profile matches.</li><li>Exercise the new content, inputs, scoring, death, round transitions, and room cleanup.</li><li>Join late, spectate, change host, disconnect, and reconnect.</li><li>Check that state and assets are removed when leaving the room or disabling the pack.</li><li>Run the same scenario without mods to catch changes to native behavior.</li></ol>
<h3>Raw engine compatibility</h3>
<p>The shipped engine is obfuscated and pinned to a specific artifact. Raw hooks give more freedom but can depend on internal names and state shapes. Test them again when changing the engine version. Prefer stable SDK registries and lifecycle events where those cover your behavior.</p>
`,
  },
];

export function initializeHelp(root, initialTopic) {
  const navigation = root.querySelector("#workbench_help_topics");
  const article = root.querySelector("#workbench_help_article");
  function select(id, focus = false) {
    const topic = topics.find((candidate) => candidate.id === id) || topics[0];
    article.innerHTML = topic.content;
    article.scrollTop = 0;
    article.setAttribute("aria-label", topic.title);
    for (const button of navigation.children) {
      if (button.dataset.topic === topic.id)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (focus) article.focus({ preventScroll: true });
  }
  for (const topic of topics) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.topic = topic.id;
    button.textContent = topic.title;
    button.onclick = () => select(topic.id, true);
    navigation.append(button);
  }
  article.addEventListener("click", (event) => {
    const button = event.target.closest("[data-help-topic]");
    if (button) select(button.dataset.helpTopic, true);
  });
  root.addEventListener("help:topic", (event) => select(event.detail));
  select(initialTopic);
}
