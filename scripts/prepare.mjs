import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { applyNativeHooks } from "./native-hooks.mjs";
import { applyNativeSessionHooks } from "./native-session-hooks.mjs";
import { patchNativeUI } from "./native-ui.mjs";
const original = fs.readFileSync("vendor/bonk/alpha2s.js", "utf8");
let source = original;
// The shipped obfuscator caches location solely for its hostname/hash guards.
// Keep that private compatibility cache canonical while real requests use the local service bridge.
const hostnameAnchor =
  '!C28 && (C28=typeof L$1 !== "undefined"?L$1[T7t([-7,0,4,5,-1,-14,-2,-10])] || \' \':"");';
const hrefAnchor =
  '!M31 && (M31=typeof L$1 !== "undefined"?L$1[T7t([-7,3,-10,-9])]:"");';
for (const [anchor, replacement] of [
  [hostnameAnchor, '!C28 && (C28="bonk.io");'],
  [hrefAnchor, '!M31 && (M31="https://bonk.io/gameframe-release.html");'],
]) {
  if (source.split(anchor).length !== 2)
    throw Error("Bonk hostname compatibility anchor changed");
  source = source.replace(anchor, replacement);
}
function guardProbe(input, hostname) {
  const context = {
    location: { hostname, href: `https://${hostname}/gameframe-release.html` },
    requirejs() {},
  };
  vm.createContext(context);
  // The AMD callback is deliberately never run by this inert bootstrap probe.
  vm.runInContext(input, context, { timeout: 4000 });
  return vm.runInContext(
    "[B3jF8.t$4(0,false,105006),B3jF8.t$4(0,false,314987),B3jF8.g7y(0,false,151982),B3jF8.g7y(0,false,314471),B3jF8.t$4(0,false,766911),B3jF8.g7y(0,false,993863)]",
    context,
    { timeout: 1000 },
  );
}
const originalGuard = guardProbe(original, "bonk.io");
const localGuard = guardProbe(source, "127.0.0.1");
if (
  JSON.stringify(originalGuard) !== JSON.stringify(localGuard) ||
  originalGuard[0] !== 349182763
)
  throw Error("Local hostname guard differs from original canonical runtime");
fs.writeFileSync(
  "evidence/domain-compatibility.json",
  JSON.stringify(
    {
      sourceSha256: crypto.createHash("sha256").update(original).digest("hex"),
      originalHostname: "bonk.io",
      localHostname: "127.0.0.1",
      originalGuard,
      localGuard,
      applicationCallbackExecuted: false,
      patchScope:
        "private obfuscator hostname and href caches; actual location and request URLs unchanged",
      anchors: [hostnameAnchor, hrefAnchor],
    },
    null,
    2,
  ),
);
const patches = [
  [
    /;(([^\]]{0,10}\])=\{\};)(.{0,1000}\2.{0,500}=\[\];.{0,500}=true.{0,500}=Date)/m,
    ";$1window.manifold.localPlayerData=$2;$3",
    "player data",
  ],
  [
    /;(([^\}\[]{0,10})[^;=]{0,100}=fun.{0,1000}gd:.{0,100}fl:false)/m,
    ";window.manifold.mapEncoder=$2;$1",
    "map encoder",
  ],
  [
    /([A-Za-z0-9_$]{3}\[[0-9]{0,10}\])(=class.{0,1000};)(\1.{0,200}\1.{0,200}lobbyName)/m,
    "$1$2window.manifold.modeList=$1;$3",
    "mode list",
  ],
  [
    /(requirejs.{0,100}function\(.{0,100}";)/m,
    "$1window.manifold.patchModules(arguments);",
    "transport",
  ],
  [
    /([}]+?([\)]+)?;?)(function .{5,8}\(\)\{retur|$)/,
    "window.manifold.init();$1$3",
    "initialization",
  ],
];
for (const [pattern, replacement, name] of patches) {
  if (!pattern.test(source))
    throw Error(`Bonk client compatibility changed: ${name}`);
  source = source.replace(pattern, replacement);
}
// Insert at AST block boundaries so shader strings or nested functions cannot
// accidentally become resize hooks. Each supported pinned renderer must match once.
const ast = ts.createSourceFile(
  "alpha2s.local.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const viewportHooks = [];
const completionHooks = [];
function localFrameVariable(node, name) {
  return node.body?.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === name,
      ),
  );
}
function inspectViewportNode(node) {
  if (
    ts.isMethodDeclaration(node) &&
    node.name?.getText(ast) === "resizeRenderer" &&
    localFrameVariable(node, "V_B")
  )
    viewportHooks.push({
      name: "modern",
      position: node.body.end - 1,
      code: ";window.bonkViewport.modern(this);",
    });
  if (ts.isFunctionExpression(node) && localFrameVariable(node, "a9t"))
    viewportHooks.push({
      name: "legacy",
      position: node.body.end - 1,
      code: ";window.bonkViewport.legacy({renderer:w6s[42],stage:w6s[26],container:w6s[0][0],thumbnail:w6s[73],editor:w6s[87],background:w6s[81],fader:w6s[58]});",
    });
  if (ts.isFunctionExpression(node) && localFrameVariable(node, "t8q"))
    viewportHooks.push({
      name: "football",
      position: node.body.end - 1,
      code: ";window.bonkViewport.football({renderer:H_E[31],stage:H_E[11],container:H_E[0][0],background:H_E[69]});",
    });
  if (
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "B8h" &&
    localFrameVariable(node, "Y5H")
  )
    completionHooks.push({
      name: "natural completion",
      position: node.body.end - 1,
      code: ";if(v$q[33].hostID===v$q[33].getLSID())window.manifold.matchComplete();",
    });
  ts.forEachChild(node, inspectViewportNode);
}
inspectViewportNode(ast);
for (const name of ["modern", "legacy", "football"])
  if (viewportHooks.filter((hook) => hook.name === name).length !== 1)
    throw Error(`Bonk viewport renderer anchor changed: ${name}`);
if (completionHooks.length !== 1)
  throw Error("Bonk natural completion callback anchor changed");
for (const hook of [...viewportHooks, ...completionHooks].sort(
  (a, b) => b.position - a.position,
))
  source =
    source.slice(0, hook.position) + hook.code + source.slice(hook.position);
new vm.Script(source);
fs.writeFileSync(
  "evidence/viewport-patches.json",
  JSON.stringify(
    {
      sourceSha256: crypto.createHash("sha256").update(original).digest("hex"),
      hooks: viewportHooks,
      projection:
        "Preserve original uniform scale, expand backing canvas, center horizontally and anchor native 500/ppm death plane to viewport bottom; extend background and fader",
      excluded: ["map editor pointer projection", "map thumbnails"],
      physicsChanged: false,
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  "evidence/match-completion-patch.json",
  JSON.stringify(
    {
      sourceSha256: crypto.createHash("sha256").update(original).digest("hex"),
      hooks: completionHooks,
      trigger:
        "Native simulation emits gameComplete only after its winner and winning-score checks; B8h handles cleanup and showing the lobby.",
      notification:
        "Only the host calls window.manifold.matchComplete(), which sends native return-to-lobby event14 to clear independent server metadata.",
      roundTelemetry:
        "Event47 reports individual map rounds; it cannot establish match completion.",
      usesTimeout: false,
      changesScore: false,
    },
    null,
    2,
  ),
);
const nativeHooks = applyNativeHooks(source);
source = nativeHooks.source;
fs.writeFileSync(
  "evidence/native-mod-hooks.json",
  JSON.stringify(nativeHooks.evidence, null, 2),
);
const sessionHooks = applyNativeSessionHooks(source);
source = sessionHooks.source;
fs.writeFileSync(
  "evidence/native-session-hooks.json",
  JSON.stringify(sessionHooks.evidence, null, 2),
);
new vm.Script(source);
fs.writeFileSync("public/game/js/alpha2s.local.js", source);
let html = fs.readFileSync("evidence/original/gameframe-release.html", "utf8");
html = html.replace(
  "<head>",
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tonk.io</title><link rel="stylesheet" href="/enhancements/game.css"><script src="/enhancements/network.js"></script>',
);
html = html.replace(/if \( self == top \) \{[\s\S]*?\}/, "");
html = html.replace(
  '<script data-main="js/alpha2s"',
  '<script src="/modding/runtime.js"></script><script src="/enhancements/viewport.js"></script><script src="/enhancements/bridge.js"></script><script data-main="js/alpha2s.local"',
);
html = patchNativeUI(html);
fs.writeFileSync("public/game/index.html", html);
fs.writeFileSync(
  "evidence/client-patches.json",
  JSON.stringify(
    {
      sha256: crypto.createHash("sha256").update(original).digest("hex"),
      patches: patches.map((x) => x[2]),
      source: "https://bonk.io/js/alpha2s.js",
      protocolReference: "https://github.com/SneezingCactus/manifold-client",
    },
    null,
    2,
  ),
);
console.log(
  "Prepared pinned Bonk engine; all 5 compatibility anchors matched.",
);
