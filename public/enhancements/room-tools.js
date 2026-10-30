const frame=document.querySelector('#maingameframe'),native=()=>frame.contentWindow?.manifold;
const section=document.createElement('section');section.className='room-bots';section.id='room-bots';
const heading=document.createElement('h2');heading.textContent='Bots';const form=document.createElement('form');form.className='fields';
const countLabel=document.createElement('label');countLabel.textContent='Bot count';const count=document.createElement('input');count.type='number';count.min='0';count.max='7';count.value='0';countLabel.append(count);
const difficultyLabel=document.createElement('label');difficultyLabel.textContent='Difficulty';const difficulty=document.createElement('select');for(const [value,label] of [['easy','Easy'],['normal','Normal'],['hard','Hard'],['expert','Expert']]){const option=document.createElement('option');option.value=value;option.textContent=label;difficulty.append(option);}difficulty.value='normal';difficultyLabel.append(difficulty);
const apply=document.createElement('button');apply.textContent='Apply bots';const status=document.createElement('output');status.setAttribute('aria-live','polite');
form.append(countLabel,difficultyLabel,apply);section.append(heading,form,status);const create=document.querySelector('#create');create.previousElementSibling.before(section);
form.onsubmit=event=>{
  event.preventDefault();const state=native();if(!state?.socket?.connected)return;apply.disabled=true;status.textContent='Updating bots…';
  const timeout=setTimeout(()=>{status.textContent='Could not update bots. Please try again.';apply.disabled=false;},10000);
  state.socket.emit('wb:bots',{count:Number(count.value),difficulty:difficulty.value},result=>{clearTimeout(timeout);apply.disabled=false;if(result?.error)status.textContent=result.error;else{status.textContent=`${result.bots.length} ${result.bots.length===1?'bot':'bots'} · ${difficulty.selectedOptions[0].textContent}`;count.value=String(result.bots.length);}});
};
function update(){const state=native(),host=state?.socket?.connected&&state.localId===state.hostId;for(const control of [count,difficulty,apply])control.disabled=!host||!!state.playing;status.textContent=!state?.socket?.connected?'Join a room to add bots.':!host?'Only the host can change bots.':state.playing?'Return to the lobby to change bots.':'';}
window.addEventListener('bonk:workbench-open',update);window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow)return;if(event.data.type==='bonk-host')update();if(event.data.type==='tonk-bots'){count.value=String(event.data.bots.length);difficulty.value=event.data.difficulty;}});update();
