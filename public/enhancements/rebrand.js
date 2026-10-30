const replace=text=>text.replace(/\bBONK(?:\.IO)?\b/g,match=>match.includes('.')?'TONK.IO':'TONK').replace(/\bBonk(?:\.io)?\b/g,match=>match.includes('.')?'Tonk.io':'Tonk').replace(/\bbonk(?:\.io)?\b/g,match=>match.includes('.')?'tonk.io':'tonk');
function rebrand(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];
 while(walker.nextNode()){const node=walker.currentNode,parent=node.parentElement;if(!parent||parent.closest('script,style,code,pre,#newbonklobby_chatbox,#newbonklobby_playerbox,#newbonklobby_specbox,[data-map-author]'))continue;if(/\bbonk(?:\.io)?\b/i.test(node.data))nodes.push(node);}
 for(const node of nodes)node.data=replace(node.data);
}
document.title='Tonk.io';rebrand(document.body);
new MutationObserver(records=>{for(const record of records){if(record.type==='characterData'){const parent=record.target.parentElement;if(parent&&!parent.closest('script,style,code,pre,#newbonklobby_chatbox,#newbonklobby_playerbox,#newbonklobby_specbox')){const value=replace(record.target.data);if(value!==record.target.data)record.target.data=value;}}else for(const node of record.addedNodes)if(node.nodeType===1)rebrand(node);}}).observe(document.body,{subtree:true,childList:true,characterData:true});
