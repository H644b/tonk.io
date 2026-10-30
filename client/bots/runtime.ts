import { botDecision,botReactionFrames,type BotDifficulty } from '../../shared/bot-ai.ts';
export class NativeBots {
  private world:any;
  private timer:ReturnType<typeof setInterval>|undefined;
  private lastFrame=-1;
  private steps=new WeakMap<object,any>();
  observe(type:string,context:any){
    if(type==='worldReady'){
      this.world=context;this.lastFrame=-1;clearInterval(this.timer);
      this.timer=setInterval(()=>this.think(),40);return;
    }
    if(type==='beforeStep'){
      this.steps.delete(context.simulation);
      const previous=context.state?.__tonkBots,update=context.admin?.tonkBots;
      if(!previous&&!update)return;
      const controls={...(previous?.controls||{}),...(update||{})};
      for(const [sid,raw] of Object.entries(controls)){
        const id=Number(sid);if(!Number.isInteger(id)||id<0||id>63||!raw||typeof raw!=='object')continue;
        const input:any={};for(const key of ['left','right','up','down','action','action2'])input[key]=(raw as any)[key]===true;
        context.inputs[id]=input;
      }
      this.steps.set(context.simulation,{controls});
    }
    if(type==='afterStep'){
      const metadata=this.steps.get(context.simulation);if(metadata)context.state.__tonkBots=metadata;
    }
  }
  private think(){
    const native=(window as any).manifold,bots=native?.bots||[];
    if(!this.world||!native?.socket?.connected||!native.playing||native.localId!==native.hostId||!bots.length)return;
    const state=this.world.getState(),frame=this.world.getFrame();
    if(!state?.discs||frame===this.lastFrame)return;
    const controls:any={};
    for(const bot of bots){const difficulty=bot.difficulty as BotDifficulty;if(frame%botReactionFrames(difficulty)>1&&this.lastFrame>=0)continue;controls[bot.id]=botDecision(state,this.world.getSettings(),bot.id,difficulty,frame);}
    if(Object.keys(controls).length){this.world.submitAdmin({tonkBots:controls},frame+4);this.lastFrame=frame;}
  }
}
