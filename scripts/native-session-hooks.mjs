import crypto from 'node:crypto';
import ts from 'typescript';

/** Insertion-only native session helpers. The original 30-frame winner
 * confirmation, input rollback, score handling and leave cleanup remain intact.
 */
export function applyNativeSessionHooks(source) {
  const ast = ts.createSourceFile('alpha2s.session.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hooks = [];
  const localVariable = (node, name) => node.body?.statements.some(statement => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name));
  const confirmedExpression = 't$e[61][y4F[9][640]] == false && a5H[4][a5H[6] - 30] && a5H[60][y4F[9][714]] == k7V.w65(2850)';
  const compact = text => text.replace(/\s+/g, '');
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'F8' && localVariable(node, 'v$q') &&
      node.getText(ast).includes('function b2$(') && node.getText(ast).includes('v$q[33]=null')) {
      hooks.push({
        name: 'session:native-leave',
        position: node.body.end - 1,
        code: ';this.leaveRoom=function(){if(!v$q[33])return false;b2$("endSession");return true;};if(window.manifold)window.manifold.nativeSession=this;',
        nativePath: 'F8 b2$("endSession") -> f7E listener -> F8.destroy() -> network.destroy/socket.close + returnToMain/refreshIfNecessary',
      });
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'g7' && localVariable(node, 'j0e') &&
      node.getText(ast).includes('function P5i()') && node.getText(ast).includes('j0e[562]=-1')) {
      hooks.push({
        name: 'session:cancel-join',
        position: node.body.end - 1,
        // Native Cancel already destroys a pending session, calls P5i(), unblurs
        // menu replays and restores the classic menu. Make the overlay reset
        // synchronous and invalidate late address responses after consent decline.
        code: ';if(window.manifold)window.manifold.cancelNativeJoin=function(){const wbHadSession=!!j0e[451];if(j0e[451]){j0e[451].destroy();j0e[451]=null;}j0e[473]=false;j0e[562]=-1;j0e[285]="";P5i();if(typeof anime.remove==="function")anime.remove(j0e[538]);j0e[538].style.visibility="hidden";j0e[538].style.opacity="0";j0e[490]=[];j0e[624].innerHTML="";j0e[513].unblur();if(j0e[3].style.display==="none")j0e[9].returnToMain();if(t$e[61].classic)k3G();return wbHadSession;};',
        nativePath: 'g7 connecting Cancel -> pending F8.destroy + P5i/enableMouseEvents + replay.unblur + classic menu; invalidate K7s address ID and synchronously remove connecting fade',
      });
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'D70' && localVariable(node, 'd5h') &&
      node.getText(ast).includes('j0e[81][d5h[5][862]]')) {
      hooks.push({
        name: 'session:empty-replay-credit',
        position: node.body.getStart(ast) + 1,
        code: ';if(!j0e[81]){j0e[60].classList.remove("pretty_top_replay_fav_checked");j0e[60].classList.add("pretty_top_replay_fav_disabled");return;}',
        nativePath: 'D70 replay favorite button updater; independent servers can have no current menu replay',
      });
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'G_R' && localVariable(node, 'y4F')) {
      const matches = [];
      function findConfirmation(child) {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (ts.isIfStatement(child) && compact(child.expression.getText(ast)) === compact(confirmedExpression)) matches.push(child);
        ts.forEachChild(child, findConfirmation);
      }
      findConfirmation(node);
      if (matches.length !== 1) throw new Error('Native session confirmation anchor changed: G_R winner request guard');
      hooks.push({
        name: 'session:confirmed-round',
        position: matches[0].getStart(ast),
        // Deliberately outside the registered-player/winner-only branch. A guest
        // host and a losing host must still confirm another player's outcome.
        code: ';if(window.manifold&&window.manifold.confirmedRound&&a5H[96]&&a5H[96].hostID===a5H[96].getLSID()&&a5H[60].ga==="b"&&a5H[4][a5H[6]-30]&&a5H[4][a5H[6]-30].fte===z.fte-1){const wbConfirmedState=a5H[4][a5H[6]-30];const wbConfirmedMap=a5H[60].map&&a5H[60].map.m||{};window.manifold.confirmedRound({round:wbConfirmedState.rc,winner:wbConfirmedState.lscr,teams:!!a5H[60].tea,frame:a5H[6]-30,mapid:wbConfirmedMap.dbid,dbv:wbConfirmedMap.dbv,mode:a5H[60].mo});}',
        nativeCondition: confirmedExpression,
        confirmedFrameLag: 30,
        finishCounter: 'historicalState.fte === native z.fte - 1 (89 in pinned client)',
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of ['session:native-leave', 'session:cancel-join', 'session:empty-replay-credit', 'session:confirmed-round'])
    if (hooks.filter(hook => hook.name === name).length !== 1) throw new Error(`Native session anchor changed: ${name}`);
  const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
  for (const hook of [...hooks].sort((a, b) => b.position - a.position)) source = source.slice(0, hook.position) + hook.code + source.slice(hook.position);
  return { source, evidence: { sourceSha256, patchedSha256: crypto.createHash('sha256').update(source).digest('hex'), insertionOnly: true,
    nativePhysicsChanged: false, accountStateChanged: false, hooks,
    limitations: ['The native 30-frame settlement convention is preserved; this does not establish server-authoritative physics', 'Browser cleanup and consent navigation require separate UI verification'] } };
}
