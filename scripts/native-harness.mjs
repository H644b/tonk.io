import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/** Extract executable native simulation units, leaving DOM/audio/network unused.
 * Selected source ranges are copied byte-for-byte from the actual input bundle.
 * Both the original and instrumented builds go through this same harness.
 */
export function createNativeHarness(source, { nativeEvent = () => {} } = {}) {
  const ast = ts.createSourceFile(
    "alpha2s.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let callback;
  function find(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "requirejs"
    )
      callback = node.arguments[1];
    ts.forEachChild(node, find);
  }
  find(ast);
  if (!callback) throw new Error("Missing pinned AMD callback");
  const guard = callback.body.statements.find((node) => ts.isIfStatement(node));
  const statements = guard.thenStatement.statements;
  const selected = [];
  // Retain function declarations (not invoked by extraction), physics aliases,
  // serializers, map factories, native settings and all native constructor code.
  for (const node of statements) {
    const text = node.getText(ast);
    if (ts.isFunctionDeclaration(node)) selected.push(text);
    else if (
      node.getStart(ast) <
      statements.find((n) => n.getText(ast) === "t$e[61]={};")?.getStart(ast)
    ) {
      selected.push(text);
    }
  }
  selected.push(
    "t$e[61]={};globalThis.__native={simulation:z,football:B,mapEncoder:Y,settings:t$e[97],mapList:t$e[95],constructors:t$e,Box2D:t$e[0][2]};",
  );
  const prefix = source.slice(0, callback.parent.getStart(ast));
  const context = {
    location: {
      hostname: "bonk.io",
      href: "https://bonk.io/gameframe-release.html",
    },
    TextEncoder,
    TextDecoder,
    console,
    atob,
    btoa,
    BonkMods: { nativeEvent, attachNative() {} },
    // Compatibility/UI bridges are deliberately inert here: only the actual
    // extracted simulation/map/serializer units execute in this harness.
    manifold: {
      patchModules() {},
      init() {},
      confirmedRound() {},
      matchComplete() {},
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync("public/game/js/SafeTrig.js", "utf8"),
    context,
    { timeout: 4000 },
  );
  vm.runInContext(
    fs.readFileSync("public/game/js/lz-string.min.js", "utf8"),
    context,
    { timeout: 4000 },
  );
  vm.runInContext(
    fs.readFileSync("public/game/js/pson/long.js", "utf8"),
    context,
    { timeout: 4000 },
  );
  vm.runInContext("globalThis.dcodeIO={Long:Long};", context);
  for (const name of ["bytebuffer.min.js", "PSON.min.js"])
    vm.runInContext(
      fs.readFileSync(`public/game/js/pson/${name}`, "utf8"),
      context,
      { timeout: 4000 },
    );
  context.define = (factory) => {
    context.__box2d = factory();
  };
  vm.runInContext(
    fs.readFileSync(
      "public/game/js/physics/box2dweb/Box2DModuleGJMod.js",
      "utf8",
    ),
    context,
    { timeout: 4000 },
  );
  delete context.define;
  vm.runInContext(prefix, context, { timeout: 4000 });
  const head = callback.body.statements
    .filter((n) => n !== guard)
    .map((n) => n.getText(ast))
    .join("\n");
  const program = `(function(E3G,p5h,Q2K){${head}\n${selected.join("\n")}\n})({}, {peerjs:{Peer:function(){}}}, __box2d);`;
  vm.runInContext(program, context, { timeout: 5000 });
  return {
    native: context.__native,
    context,
    run(code, timeout = 5000) {
      return vm.runInContext(code, context, { timeout });
    },
  };
}
