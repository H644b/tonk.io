import crypto from "node:crypto";
import ts from "typescript";

// These are deliberately insertion-only patches against the pinned shipped
// bundle. Native expressions, arithmetic, branches and call order stay intact.
// Every anchor is required exactly once; an upstream update fails the build.
export function applyNativeHooks(source) {
  const ast = ts.createSourceFile(
    "alpha2s.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const hooks = [];
  const add = (name, position, code) => hooks.push({ name, position, code });
  const event = (type, context) =>
    `;if(window.BonkMods)window.BonkMods.nativeEvent(${JSON.stringify(type)},${context});`;
  const context = (kind, engine, frame, extras = "") =>
    `{kind:${JSON.stringify(kind)},engine:${engine},simulation:this,state:${frame}[0][0],inputs:${frame}[0][1],admin:${frame}[0][2],dt:${frame}[0][3],settings:${frame}[0][4],args:${frame}[0]${extras}}`;
  let callback;
  function localVariable(node, name) {
    return node.body?.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        ),
    );
  }
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "requirejs"
    )
      callback = node.arguments[1];
    if (
      ts.isFunctionExpression(node) &&
      (localVariable(node, "z0M") || localVariable(node, "E82"))
    ) {
      const modern = localVariable(node, "z0M");
      const kind = modern ? "modern" : "football",
        frame = modern ? "z0M" : "E82",
        engine = modern ? "z" : "B";
      // Insert after the arguments array declaration, before native mutation.
      const declaration = node.body.statements.find(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (d) => d.name.getText(ast) === frame,
          ),
      );
      add(
        `${kind}:beforeStep`,
        declaration.end,
        event("beforeStep", context(kind, engine, frame)),
      );
      const returns = [];
      function findReturns(child) {
        if (
          child !== node &&
          (ts.isFunctionLike(child) || ts.isClassLike(child))
        )
          return;
        if (
          ts.isReturnStatement(child) &&
          child.expression?.getText(ast) ===
            `${frame}[${modern ? "720" : "71"}]`
        )
          returns.push(child);
        ts.forEachChild(child, findReturns);
      }
      findReturns(node);
      if (returns.length !== 1)
        throw new Error(`Native ${kind} result anchor changed`);
      add(
        `${kind}:afterStep`,
        returns[0].getStart(ast),
        event(
          "afterStep",
          context(
            kind,
            engine,
            frame,
            `,previousState:${frame}[0][0],state:${returns[0].expression.getText(ast)}`,
          ),
        ),
      );
    }
    if (
      ts.isFunctionExpression(node) &&
      (localVariable(node, "Y00") || localVariable(node, "V0Q"))
    ) {
      const modern = localVariable(node, "Y00"),
        frame = modern ? "Y00" : "V0Q",
        engine = modern ? "z" : "B";
      const result = `${frame}[${modern ? "5" : "2"}]`;
      function created(child) {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (
          ts.isReturnStatement(child) &&
          child.expression?.getText(ast) === result
        )
          add(
            `${modern ? "modern" : "football"}:createState`,
            child.getStart(ast),
            event(
              "createState",
              `{kind:'${modern ? "modern" : "football"}',engine:${engine},state:${result},players:${frame}[0][0],map:${frame}[0][1],seed:${frame}[0][2],settings:${frame}[0][5],args:${frame}[0]}`,
            ),
          );
        ts.forEachChild(child, created);
      }
      created(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isElementAccessExpression(node.expression)
    ) {
      const receiver = node.expression.expression.getText(ast),
        member = node.expression.argumentExpression.getText(ast);
      if (
        (receiver === "z0M[16]" && member === "z0M[2][327]") ||
        (receiver === "E82[4]" && member === "E82[3][327]")
      ) {
        const modern = receiver === "z0M[16]",
          kind = modern ? "modern" : "football",
          frame = modern ? "z0M" : "E82",
          engine = modern ? "z" : "B";
        const extras = modern
          ? ",world:z0M[16],discs:z0M[4],bodies:z0M[96],projectiles:z0M[19],joints:z0M[87]"
          : ",world:E82[4],discs:E82[9],ball:E82[1]";
        if (!ts.isExpressionStatement(node.parent))
          throw new Error(`Native ${kind} physics statement changed`);
        add(
          `${kind}:beforePhysics`,
          node.parent.getStart(ast),
          event("beforePhysics", context(kind, engine, frame, extras)),
        );
        add(
          `${kind}:afterPhysics`,
          node.parent.end,
          event("afterPhysics", context(kind, engine, frame, extras)),
        );
      }
    }
    if (
      ts.isMethodDeclaration(node) &&
      node.name?.getText(ast) === "render" &&
      node.parameters[0]?.name.getText(ast) === "A9L" &&
      node.parameters[1]?.name.getText(ast) === "S6e"
    ) {
      const renderContext =
        "{kind:'modern',renderer:this,stage:this.stage,environment:this.environmentContainer,discContainer:this.discContainer,state:S6e,previousState:A9L,interpolation:b5_,settings:m4e,args:arguments}";
      add(
        "modern:beforeRender",
        node.body.getStart(ast) + 1,
        event("beforeRender", renderContext),
      );
      add(
        "modern:afterRender",
        node.body.end - 1,
        event("afterRender", renderContext),
      );
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "M$" &&
      localVariable(node, "a5H")
    ) {
      add(
        "gameWorld:ready",
        node.body.end - 1,
        event(
          "worldReady",
          "{world:this,getFrame:()=>a5H[6],getState:()=>a5H[4][a5H[6]],getSettings:()=>a5H[60],adminAt:(f)=>a5H[9][f],submitAdmin:(extra,f=a5H[6])=>{const a=Object.assign({playersLeft:[],playersJoined:[]},a5H[9][f]||{},extra);this.recvAdmin({a:a,f:f});if(a5H[96])a5H[96].sendAdminInputs({a:a,f:f});return f;}}",
        ),
      );
    }
    // The legacy and Football renderers use per-instance closure methods.
    if (
      ts.isFunctionExpression(node) &&
      (localVariable(node, "x6Z") || localVariable(node, "R$4"))
    ) {
      const modern = localVariable(node, "x6Z"),
        frame = modern ? "x6Z" : "R$4",
        state = modern ? "w6s" : "H_E";
      // The first anchor is intentionally further constrained below; unrelated
      // obfuscated local variables must never become a render hook.
      const text = node.getText(ast);
      if (
        text.includes(`${state}[${modern ? "42" : "31"}]`) &&
        text.includes(`${state}[${modern ? "26" : "11"}]`)
      ) {
        const renderContext = `{kind:'${modern ? "legacy" : "football"}',renderer:this,nativeRenderer:${state}[${modern ? "42" : "31"}],stage:${state}[${modern ? "26" : "11"}],state:arguments[1],previousState:arguments[0],interpolation:arguments[2],args:arguments}`;
        add(
          `${modern ? "legacy" : "football"}:beforeRender`,
          node.body.getStart(ast) + 1,
          event("beforeRender", renderContext),
        );
        add(
          `${modern ? "legacy" : "football"}:afterRender`,
          node.body.end - 1,
          event("afterRender", renderContext),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!callback || !ts.isFunctionExpression(callback))
    throw new Error("Native AMD callback changed");
  const guard = callback.body.statements.find((n) => ts.isIfStatement(n));
  if (!guard || !ts.isBlock(guard.thenStatement))
    throw new Error("Native AMD guard changed");
  add(
    "engine:attach",
    guard.thenStatement.end - 1,
    ";if(window.BonkMods)window.BonkMods.attachNative({simulation:z,football:B,mapEncoder:Y,settings:t$e[97],mapList:t$e[95],renderer:t$e[49],legacyRenderer:I,footballRenderer:m3,Box2D:t$e[0][2],PIXI:window.PIXI,localPlayer:t$e[61],editor:X1,skinEditor:a9,replay:t$e[86],binary:t$e[76],avatar:t$e[80],constructors:t$e});",
  );
  const required = [
    "engine:attach",
    "gameWorld:ready",
    ...["modern", "football"].flatMap((kind) =>
      [
        "createState",
        "beforeStep",
        "afterStep",
        "beforePhysics",
        "afterPhysics",
      ].map((type) => `${kind}:${type}`),
    ),
    "modern:beforeRender",
    "modern:afterRender",
    "legacy:beforeRender",
    "legacy:afterRender",
    "football:beforeRender",
    "football:afterRender",
  ];
  for (const name of required)
    if (hooks.filter((hook) => hook.name === name).length !== 1)
      throw new Error(`Native mod hook anchor changed: ${name}`);
  for (const hook of [...hooks].sort((a, b) => b.position - a.position))
    source =
      source.slice(0, hook.position) + hook.code + source.slice(hook.position);
  return {
    source,
    evidence: {
      insertionOnly: true,
      hooks,
      patchedSha256: crypto.createHash("sha256").update(source).digest("hex"),
      physicsArithmeticChanged: false,
    },
  };
}
