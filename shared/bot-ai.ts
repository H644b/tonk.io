export type BotDifficulty='easy'|'normal'|'hard'|'expert';
export type BotInput={left:boolean;right:boolean;up:boolean;down:boolean;action:boolean;action2:boolean};
type Surface={left:number;right:number;top:number;bottom:number;hazard:boolean};
const surfaces=new WeakMap<object,Surface[]>();
const point=(value:any)=>({x:Number(value?.x??value?.p?.[0]??0),y:Number(value?.y??value?.p?.[1]??0)});
/** Prefer the current native physics state: it already includes map translation,
 * scaling and moving body positions. Editor geometry is the fallback. */
export function arenaSurfaces(map:any,meters=false):Surface[]{
  if(!map||!map.physics)return [];
  const cached=surfaces.get(map.physics);if(cached)return cached;
  const out:Surface[]=[],physics=map.physics,ppm=meters?1:Number(physics.ppm)||30;
  for(const body of physics.bodies||[]){
    if(body.s?.f_p===false)continue;
    const a=Number(body.a)||0,cos=Math.cos(a),sin=Math.sin(a);
    for(const id of body.fx||[]){const fixture=physics.fixtures?.[id],shape=physics.shapes?.[fixture?.sh];if(!shape||fixture.np||fixture.ig)continue;
      let points:number[][]=[];
      if(shape.type==='bx'){const ca=Number(shape.a)||0,c=Math.cos(ca),s=Math.sin(ca);points=[[-shape.w/2,-shape.h/2],[shape.w/2,-shape.h/2],[shape.w/2,shape.h/2],[-shape.w/2,shape.h/2]].map(([x,y])=>[x*c-y*s+(shape.c?.[0]||0),x*s+y*c+(shape.c?.[1]||0)]);}
      else if(shape.type==='ci'){const [x,y]=shape.c||[0,0];points=[[x-shape.r,y-shape.r],[x+shape.r,y+shape.r]];}
      else if(shape.type==='po'){const ca=Number(shape.a)||0,c=Math.cos(ca),s=Math.sin(ca);points=(shape.v||[]).map(([x,y]:number[])=>[shape.s*(x*c-y*s)+(shape.c?.[0]||0),shape.s*(x*s+y*c)+(shape.c?.[1]||0)]);}
      if(!points.length)continue;
      points=points.map(([x,y])=>[(x*cos-y*sin+(body.p?.[0]||0))/ppm,(x*sin+y*cos+(body.p?.[1]||0))/ppm]);
      out.push({left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1])),hazard:!!fixture.d});
    }
  }
  surfaces.set(map.physics,out);return out;
}
const settings={easy:{reaction:15,lead:0.05,look:1.2,noise:2.5},normal:{reaction:8,lead:0.15,look:2,noise:0.8},hard:{reaction:4,lead:0.3,look:3.2,noise:0.2},expert:{reaction:2,lead:0.5,look:4.5,noise:0}};
export function botDecision(state:any,gameSettings:any,id:number,difficulty:BotDifficulty,frame:number):BotInput{
  const input:BotInput={left:false,right:false,up:false,down:false,action:false,action2:false};
  const me=state?.discs?.[id];if(!me)return input;
  const rule=settings[difficulty]||settings.normal,pos=point(me),mode=gameSettings?.mo||'b';
  const enemies=(state.discs||[]).map((disc:any,index:number)=>({disc,index})).filter(({disc,index}:any)=>disc&&index!==id&&(!gameSettings?.tea||disc.team!==me.team));
  enemies.sort((a:any,b:any)=>Math.hypot(a.disc.x-pos.x,a.disc.y-pos.y)-Math.hypot(b.disc.x-pos.x,b.disc.y-pos.y));
  const enemy=enemies[0]?.disc;
  const terrain=state.physics?arenaSurfaces(state,true):arenaSurfaces(gameSettings?.map),safe=terrain.filter(s=>!s.hazard&&s.right-s.left>1);
  let target=enemy?{x:enemy.x+(enemy.xv||0)*rule.lead,y:enemy.y+(enemy.yv||0)*rule.lead}:{x:pos.x,y:pos.y};
  if(mode==='f'&&state.ball){const ball=point(state.ball),bounds=safe.length?{left:Math.min(...safe.map(s=>s.left)),right:Math.max(...safe.map(s=>s.right))}:{left:0,right:50};
    const attackRight=me.team===3;target={x:ball.x+(attackRight?-0.85:0.85),y:ball.y};
    if(Math.abs(ball.x-pos.x)<1.2)target.x=attackRight?bounds.right:bounds.left;
  }
  const noise=Math.sin((Math.floor(frame/rule.reaction)+id*37)*1.618)*rule.noise;
  target.x+=noise;
  const dx=target.x-pos.x,dy=target.y-pos.y,direction=Math.sign(dx)||1;
  input.left=dx<-.35;input.right=dx>.35;
  const support=safe.filter(s=>pos.x>=s.left-.4&&pos.x<=s.right+.4&&s.top>=pos.y-.5&&s.top<=pos.y+3).sort((a,b)=>a.top-b.top)[0];
  const ahead=pos.x+direction*rule.look+Number(me.xv||0)*.15;
  const landing=safe.filter(s=>ahead>=s.left&&ahead<=s.right&&s.top>=pos.y-5&&s.top<=pos.y+7).sort((a,b)=>Math.abs(a.top-pos.y)-Math.abs(b.top-pos.y))[0];
  const danger=terrain.some(s=>s.hazard&&ahead>s.left-.6&&ahead<s.right+.6&&pos.y>s.top-1.8&&pos.y<s.bottom+.8);
  const gap=!!support&&!landing;
  const wall=safe.some(s=>ahead>s.left&&ahead<s.right&&pos.y>s.top+.3&&pos.y<s.bottom-.3);
  input.up=dy<-1||gap||wall||danger||Number(me.yv)>5;
  if((gap||danger)&&support&&Math.abs(dx)>rule.look){
    const reachable=safe.filter(s=>Math.abs((s.left+s.right)/2-pos.x)<12&&s.top>pos.y-7&&s.top<pos.y+5&&Math.sign((s.left+s.right)/2-pos.x)===direction);
    if(!reachable.length){const center=(support.left+support.right)/2;input.left=pos.x>center;input.right=pos.x<center;}
  }
  const distance=enemy?Math.hypot(enemy.x-pos.x,enemy.y-pos.y):Infinity;
  input.action=distance<2.5&&(!input.up||pos.y<enemy.y-1);
  if(['ar','ard'].includes(mode)){
    input.up=dy<-.6||input.up;input.down=dy>.6&&!gap&&!danger;
    input.action2=!!enemy&&(difficulty!=='easy'||frame%30<10);
    if(difficulty==='hard'||difficulty==='expert')for(const projectile of state.projectiles||[]){if(!projectile)continue;const p=point(projectile);if(Math.hypot(p.x-pos.x,p.y-pos.y)<4){input.up=true;input.left=(projectile.xv||0)>0;input.right=!input.left;}}
  }else if(mode==='sp')input.action2=(gap||dy<-2||Number(me.yv)>4)&&Math.floor(frame/18)%3!==2;
  else if(mode==='v'){
    const angle=Math.atan2(dx,-dy),delta=Math.atan2(Math.sin(angle-(me.a||0)),Math.cos(angle-(me.a||0)));
    input.left=delta<-.15;input.right=delta>.15;input.up=dy<1||Math.abs(dx)>2;input.action2=distance<15;
  }
  if(difficulty==='easy'&&Math.floor(frame/90)%4===0){input.action=false;input.action2=false;}
  return input;
}
export function botReactionFrames(difficulty:BotDifficulty){return settings[difficulty]?.reaction||8;}
