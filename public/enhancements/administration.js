const frame=document.querySelector('#maingameframe'),drawer=document.querySelector('#drawer');
const node=(tag,text='',className='')=>{const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;};
const button=(text,action)=>{const element=node('button',text);element.type='button';element.addEventListener('click',action);return element;};
const tab=button('Admin',()=>load(section.dataset.view||'rooms'));tab.dataset.tab='admin';tab.setAttribute('role','tab');tab.hidden=true;
document.querySelector('#tabs').append(tab);
const section=node('section','','tab administration');section.id='admin';section.hidden=true;section.dataset.view='rooms';
const title=node('h2','Administration'),navigation=node('nav','','admin-navigation'),body=node('div','','admin-content'),status=node('output','','admin-status');status.setAttribute('aria-live','polite');
section.append(title,navigation,status,body);drawer.querySelector('footer').before(section);
let busy=false,overview,viewRevision=0;
async function request(route,body){const response=await fetch('/api/admin/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw Error(result.error?.message||result.error||'Request failed.');return result;}
async function action(route,data,success){if(busy)return;busy=true;section.setAttribute('aria-busy','true');status.textContent='Saving…';try{await request(route,data);await load(section.dataset.view);status.textContent=success;}catch(error){status.textContent=error.message;}finally{busy=false;section.removeAttribute('aria-busy');}}
for(const [id,label] of [['rooms','Rooms'],['users','Players'],['maps','Maps'],['reports','Reports'],['settings','Settings'],['audit','Activity']]){const control=button(label,()=>load(id));control.dataset.view=id;navigation.append(control);}
const row=(heading,description,actions=[])=>{const element=node('div','','admin-row'),text=node('div','','admin-row-copy');text.append(node('strong',heading),node('span',description));element.append(text);const controls=node('div','','admin-actions');controls.append(...actions);element.append(controls);return element;};
const empty=text=>body.append(node('p',text,'admin-empty'));
function searchForm(view,placeholder,query){const form=node('form','','admin-search'),input=node('input');input.type='search';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.value=query;const submit=node('button','Search');form.append(input,submit);form.onsubmit=event=>{event.preventDefault();void load(view,input.value);};body.append(form);}
async function load(view,query=''){
  const revision=++viewRevision;
  const fetchView=async route=>{const result=await request(route);if(revision!==viewRevision)throw new DOMException('View changed.','AbortError');return result;};
  section.dataset.view=view;for(const control of navigation.children)control.setAttribute('aria-current',String(control.dataset.view===view));
  body.replaceChildren();status.textContent='Loading…';
  try{
    if(view==='rooms'){
      const data=await fetchView('rooms');body.append(button('Refresh rooms',()=>load('rooms')));
      if(!data.rooms.length)empty('No rooms are open.');
      for(const room of data.rooms){const element=row(room.name,`${room.players.length}/${room.maxPlayers} players · ${room.mode} · ${room.playing?'Playing':'Lobby'}`,[button('Close room',()=>action(`rooms/${room.id}/close`,{},'Room closed.'))]);
        const players=node('div','','admin-players');for(const player of room.players)players.append(row(player.name,player.host?'Host':player.bot?'Bot':'Player',[button('Kick',()=>action(`rooms/${room.id}/kick`,{playerId:player.id},'Player removed.'))]));element.append(players);body.append(element);
      }
    }else if(view==='users'){
      searchForm(view,'Find a player',query);const data=await fetchView('users?q='+encodeURIComponent(query));
      if(!data.users.length)empty('No players match your search.');
      const moderation=node('div','','admin-user-options'),reason=node('input'),days=node('select');reason.placeholder='Suspension reason';reason.setAttribute('aria-label','Suspension reason');days.setAttribute('aria-label','Suspension duration');
      for(const [value,label] of [['1','1 day'],['7','7 days'],['30','30 days'],['0','Until lifted']]){const option=node('option',label);option.value=value;days.append(option);}moderation.append(reason,days);body.append(moderation);
      for(const user of data.users){const protectedUser=user.role==='owner',banned=!!user.banReason&&(!user.banExpires||user.banExpires>Date.now());const actions=protectedUser?[]:[
        button(banned?'Lift suspension':'Suspend',()=>action(`users/${user.id}/${banned?'unban':'ban'}`,{reason:reason.value,days:Number(days.value)},banned?'Suspension lifted.':'Player suspended.')),
        button('Sign out sessions',()=>action(`users/${user.id}/revoke-sessions`,{},'Sessions revoked.')),
        button(user.role==='curator'?'Remove curator':'Make curator',()=>action(`users/${user.id}/role`,{role:user.role==='curator'?'member':'curator'},'Role updated.')),
      ];body.append(row(user.username,protectedUser?'Owner':banned?'Suspended · '+user.banReason:user.role==='curator'?'Curator':'Player',actions));}
    }else if(view==='maps'){
      searchForm(view,'Find a map or creator',query);const data=await fetchView('maps?q='+encodeURIComponent(query));
      if(!data.maps.length)empty('No visible maps match your search.');
      for(const map of data.maps)body.append(row(map.name,`by ${map.authorname} · ${map.kind==='community'?'Community map':map.kind==='local'?'Player map':'Included map'}`,[button('Remove from picker',()=>action('maps/moderate',{key:map.mapKey,hidden:true},'Map removed from the picker.'))]));
      if(data.hidden.length){body.append(node('h3','Removed maps'));for(const map of data.hidden)body.append(row(map.map_key,map.reason||'Hidden from search and loading',[button('Restore map',()=>action('maps/moderate',{key:map.map_key,hidden:false},'Map restored.'))]));}
    }else if(view==='reports'){
      const data=await fetchView('reports');if(!data.reports.length)empty('No replay reports to review.');
      for(const report of data.reports){const id=report.id??report.replayId;body.append(row(`Replay ${id}`,`${report.reports??report.reportCount??1} reports`,[button('Hide replay',()=>action(`reports/${id}`,{hidden:true,reason:'Reviewed by administrator.'},'Replay hidden.')),button('Restore replay',()=>action(`reports/${id}`,{hidden:false,reason:''},'Replay restored.'))]));}
    }else if(view==='settings'){
      overview=await fetchView('overview');
      const form=node('form','','admin-settings');
      for(const [key,label,defaultValue] of [['registrationOpen','Allow new accounts',true],['maintenance','Pause room creation',false]]){const field=node('label',label),input=node('input');input.type='checkbox';input.name=key;input.checked=overview.settings[key]??defaultValue;field.prepend(input);form.append(field);}
      const save=node('button','Save settings');form.append(save);form.onsubmit=event=>{event.preventDefault();void action('settings',Object.fromEntries([...form.querySelectorAll('input')].map(input=>[input.name,input.checked])),'Settings saved.');};body.append(form);
    }else{
      const data=await fetchView('audit');if(!data.events.length)empty('No administrative actions yet.');
      for(const event of data.events)body.append(row(event.action,`${event.actor||'Administrator'} · ${event.target} · ${new Date(event.created_at).toLocaleString()}`));
    }
    status.textContent='';
  }catch(error){if(revision!==viewRevision)return;status.textContent=error.message;body.append(button('Try again',()=>load(view,query)));}
}
let checking=false;
async function updateAccess(){
  if(checking)return;checking=true;
  try{const response=await fetch('/api/profile'),data=await response.json(),owner=data.role==='owner';tab.hidden=!owner;
    const doc=frame.contentDocument,bar=doc?.querySelector('#pretty_top_bar');if(bar){let native=doc.querySelector('#pretty_top_admin');if(!native){native=doc.createElement('button');native.id='pretty_top_admin';native.type='button';native.className='native-workbench-button pretty_top_button niceborderleft';native.textContent='Admin';native.onclick=()=>{window.bonkWorkbench.open(native);tab.click();};bar.insertBefore(native,doc.querySelector('#pretty_top_workbench'));}native.hidden=!owner;}
    if(!owner&&!section.hidden){document.querySelector('[data-tab="rooms"]').click();}
  }catch{tab.hidden=true;}finally{checking=false;}
}
function bind(){const identity=frame.contentDocument?.querySelector('#pretty_top_identity');if(identity)new MutationObserver(()=>void updateAccess()).observe(identity,{childList:true,subtree:true,characterData:true});void updateAccess();}
frame.addEventListener('load',bind);window.addEventListener('bonk:frame-ready',bind);window.addEventListener('bonk:workbench-open',updateAccess);bind();
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow)return;if(event.data.type==='tonk-moderation'){const output=document.querySelector('#status');output.textContent=event.data.message;window.bonkWorkbench.open();}});
