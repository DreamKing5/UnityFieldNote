import { rpc, login, logout, loggedIn, ready } from './api.js';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; };
const PAGE_SIZE=24, ORG_SIZE=40;
const state={category:'',query:'',revision:0,categories:[],total:0,items:[],cursors:[null],page:0,next:null,request:0,entry:null,edit:null,editRevision:0,org:[],orgAll:[],orgRevision:0,orgPage:0,orgDirty:false,editorDirty:false,categoryRevision:0};
const md=window.markdownit({html:false,linkify:false,breaks:true,typographer:false});
md.renderer.rules.image=(tokens,i)=>md.utils.escapeHtml(`[画像: ${tokens[i].content}]`);
const oldLink=md.renderer.rules.link_open || ((tokens,i,options,env,self)=>self.renderToken(tokens,i,options));
md.renderer.rules.link_open=(tokens,i,options,env,self)=>{tokens[i].attrSet('target','_blank');tokens[i].attrSet('rel','noopener noreferrer');return oldLink(tokens,i,options,env,self);};
function markdown(text){return md.render(text||'');}
let noticeTimer, pendingAction=null;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#toast').hidden=true,7000);}
function errorBox(dialog,error){const box=dialog?.querySelector('.form-error');if(box)box.textContent=error.message||String(error);else toast(error.message||String(error));}
async function task(dialog,fn){
 const nodes=dialog?[...dialog.querySelectorAll('button,input,textarea,select')]:[]; const old=nodes.map(n=>n.disabled);
 if(dialog?.dataset.busy==='true')return;
 if(dialog)dialog.dataset.busy='true';nodes.forEach(n=>n.disabled=true);dialog?.querySelector('.form-error')?.replaceChildren();
 try{return await fn();}catch(e){errorBox(dialog,e);}finally{nodes.forEach((n,i)=>n.disabled=old[i]);if(dialog)dialog.dataset.busy='false';}
}
function open(dialog){dialog.querySelector('.form-error')?.replaceChildren();if(!dialog.open)dialog.showModal();}
async function confirmAction(title,text){
 const d=$('#confirmDialog');$('#confirmTitle').textContent=title;$('#confirmText').textContent=text;d.showModal();
 return new Promise(resolve=>{let done=false;const finish=v=>{if(done)return;done=true;d.close();$('#confirmYes').onclick=null;$('#confirmNo').onclick=null;d.oncancel=null;resolve(v);};$('#confirmYes').onclick=()=>finish(true);$('#confirmNo').onclick=()=>finish(false);d.oncancel=e=>{e.preventDefault();finish(false);};});
}
async function requestClose(d){if(d.dataset.busy==='true')return;if((d.id==='editorDialog'&&state.editorDirty)||(d.id==='organizeDialog'&&state.orgDirty)){if(!await confirmAction('変更を破棄しますか？','まだ保存していない変更があります。閉じると元に戻せません。'))return;}if(d.id==='editorDialog')state.editorDirty=false;if(d.id==='organizeDialog')state.orgDirty=false;if(d.id==='loginDialog')$('#password').value='';d.close();}
for(const d of document.querySelectorAll('dialog:not(#confirmDialog)')){d.addEventListener('cancel',e=>{e.preventDefault();requestClose(d);});d.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>requestClose(d)));}
window.addEventListener('beforeunload',e=>{if(state.editorDirty||state.orgDirty||document.querySelector('dialog[data-busy="true"]')){e.preventDefault();e.returnValue='';}});
function requireOwner(action){if(!ready){toast('先にconfig.jsとSupabaseの初期設定を完了してください。');return;}if(!loggedIn()){pendingAction=action;open($('#loginDialog'));return;}action();}
function authUI(){const owner=loggedIn();$('#authButton').textContent=owner?'ログアウト':'管理者ログイン';$('#accessLabel').textContent=owner?'管理者モード':'閲覧モード';$('#deleteButton').hidden=!owner;$('#editButton').hidden=!owner;}
window.addEventListener('authlost',()=>{authUI();toast('ログインの有効期限が切れました。再ログインしてください。');});
$('#loginForm').addEventListener('submit',e=>{e.preventDefault();task($('#loginDialog'),async()=>{await login($('#email').value.trim(),$('#password').value);$('#password').value='';$('#loginDialog').close();authUI();toast('管理者としてログインしました');const action=pendingAction;pendingAction=null;if(action)await action();});});
$('#authButton').onclick=()=>task(null,async()=>{if(loggedIn()){await logout();authUI();toast('ログアウトしました');}else{pendingAction=null;open($('#loginDialog'));}});
function dateLabel(value){return new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
function option(value,label){const o=el('option','',label);o.value=value;return o;}
function updateLibrary(info){
 state.revision=info.revision;state.categories=info.categories;state.total=info.total;
 $('#allCount').textContent=info.total;$('#statTotal').textContent=String(info.total).padStart(2,'0');
 $('#allCategory').classList.toggle('active',!state.category);
 const nav=$('#categoryNav');nav.replaceChildren();
 for(const c of info.categories){const b=el('button','nav-item');b.classList.toggle('active',state.category===c.name);const left=el('span');left.append(el('i','category-dot'),document.createTextNode(c.name));b.append(left,el('span','count',c.count));b.onclick=()=>setFilter(c.name);nav.append(b);}
 if(!info.categories.length)nav.append(el('p','help','記録の追加時に作成できます'));
 const mobile=$('#mobileCategory');mobile.replaceChildren(option('','すべてのジャンル'));info.categories.forEach(c=>mobile.append(option(c.name,c.name)));mobile.value=state.category;
 $('#categoryOptions').replaceChildren(...info.categories.map(c=>option(c.name,c.name)));
 $('#connectionDot').classList.add('online');$('#connectionText').textContent='Supabase に接続済み';
}
function resetPaging(){state.cursors=[null];state.page=0;state.next=null;}
function makeCard(item){
 const card=el('button','entry-card');card.type='button';card.dataset.id=item.id;
 const top=el('div','card-top');top.append(el('span','category-pill',item.category),el('time','card-date',dateLabel(item.created_at)));top.lastChild.dateTime=item.created_at;
 const bottom=el('div','card-bottom');const tags=el('div','tags');(item.tags||[]).slice(0,4).forEach(t=>tags.append(el('span','tag','#'+t)));if(!item.tags?.length)tags.append(el('span','tag','LEARNING NOTE'));bottom.append(tags,el('span','card-arrow','↗'));
 card.append(top,el('h2','card-title',item.title),el('p','card-summary',(item.summary||'').replace(/[#*`>]/g,' ').replace(/\s+/g,' ').trim()),bottom);
 card.onclick=()=>task(null,()=>showDetail(item.id));return card;
}
function renderCards(){
 const list=$('#timeline');list.replaceChildren();
 if(!state.items.length){const empty=el('div','empty-state');empty.append(el('div','empty-icon','▤'),el('h2','',state.query?'該当する記録がありません':'まだ記録がありません'),el('p','',state.query?'別のキーワードやジャンルを試してみてください。':'右下の＋から、最初の学びを残しましょう。'));list.append(empty);}else list.append(...state.items.map(makeCard));
 $('#pageNumber').textContent=`${state.page+1} ページ`;$('#previousPage').disabled=state.page===0;$('#nextPage').disabled=!state.next;
}
async function loadList(){
 const request=++state.request;$('#listStatus').textContent='読み込み中…';$('#previousPage').disabled=true;$('#nextPage').disabled=true;
 const cursor=state.cursors[state.page];
 try{
  const data=await rpc('list_entries',{p_category:state.category||null,p_query:state.query,p_limit:PAGE_SIZE,p_after_order:cursor?.order??null,p_after_id:cursor?.id??null,p_full:false});
  if(request!==state.request)return;
  if(state.page>0&&data.revision!==state.revision){resetPaging();toast('データが更新されたため、先頭から表示します。');return loadList();}
  updateLibrary(data.library);state.items=data.items;state.next=data.next_cursor;
  $('#resultCount').textContent=`${data.total} 件の記録 · 手動の表示順`;$('#listStatus').textContent='';renderCards();
 }catch(e){if(request!==state.request)return;$('#listStatus').textContent='読み込めませんでした。上部の↻で再試行できます。 '+e.message;$('#connectionText').textContent='接続できません';$('#connectionDot').classList.remove('online');}
}
async function setFilter(category){state.category=category;resetPaging();$('#pageTitle').textContent=category||'すべての記録';$('#pageTitle').append(el('span','title-dot','.'));$('.sidebar').classList.remove('open');await loadList();}
$('#allCategory').onclick=()=>setFilter('');$('#mobileCategory').onchange=e=>setFilter(e.target.value);
let searchTimer;$('#search').oninput=e=>{clearTimeout(searchTimer);state.request++;searchTimer=setTimeout(()=>{state.query=e.target.value.trim();resetPaging();loadList();},250);};
$('#previousPage').onclick=()=>{if(state.page>0){state.page--;loadList();window.scrollTo({top:0});}};
$('#nextPage').onclick=()=>{if(state.next){state.cursors[++state.page]=state.next;loadList();window.scrollTo({top:0});}};
$('#refreshButton').onclick=()=>{resetPaging();loadList();};
$('#mobileMenu').onclick=()=>$('.sidebar').classList.toggle('open');document.addEventListener('click',e=>{if(!e.target.closest('.sidebar')&&!e.target.closest('#mobileMenu'))$('.sidebar').classList.remove('open');});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!document.querySelector('dialog[open]')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){e.preventDefault();$('#search').focus();}if(e.key==='Escape')$('.sidebar').classList.remove('open');});
async function showDetail(id){const result=await rpc('get_entry',{p_id:id});if(!result.entry)throw new Error('この記録は削除されたか、見つかりません。');state.entry=result.entry;state.editRevision=result.revision;$('#detailCategory').textContent=result.entry.category;$('#detailTitle').textContent=result.entry.title;$('#detailMeta').textContent=`作成 ${dateLabel(result.entry.created_at)}　·　${(result.entry.tags||[]).map(t=>'#'+t).join('  ')}`;$('#detailBody').innerHTML=markdown(result.entry.body);authUI();open($('#detailDialog'));}
function resetPreview(){$('#entryBody').required=true;$('#entryBody').hidden=false;$('#markdownPreview').hidden=true;$('#previewButton').textContent='プレビュー';}
async function editEntry(entry=null){
 const info=await rpc('library_info');updateLibrary(info);state.editRevision=info.revision;
 // Re-read existing content at the same revision instead of editing a stale open detail.
 if(entry){const data=await rpc('get_entry',{p_id:entry.id});if(!data.entry)throw new Error('記録が見つかりません。');entry=data.entry;state.editRevision=data.revision;}
 state.edit=entry;state.editorDirty=false;$('#editorTitle').textContent=entry?'記録を編集':'新しい記録';$('#entryTitle').value=entry?.title||'';$('#entryCategory').value=entry?.category||state.category||'';$('#entryTags').value=(entry?.tags||[]).join(', ');$('#entryBody').value=entry?.body||'';resetPreview();$('#detailDialog').close();open($('#editorDialog'));$('#entryTitle').focus();
}
$('#addButton').onclick=()=>requireOwner(()=>task(null,()=>editEntry()));$('#editButton').onclick=()=>requireOwner(()=>task(null,()=>editEntry(state.entry)));
$('#editorForm').oninput=()=>state.editorDirty=true;
$('#previewButton').onclick=()=>{const preview=$('#markdownPreview');const showing=preview.hidden;preview.innerHTML=showing?markdown($('#entryBody').value):'';preview.hidden=!showing;$('#entryBody').hidden=showing;$('#entryBody').required=!showing;$('#previewButton').textContent=showing?'編集に戻る':'プレビュー';};
function readTags(value){const tags=[...new Set(value.split(/[,、\n]/).map(s=>s.trim()).filter(Boolean))];if(tags.length>30||tags.some(t=>t.length>60))throw new Error('タグは30個まで、各60文字以内にしてください。');return tags;}
$('#editorForm').onsubmit=e=>{e.preventDefault();task($('#editorDialog'),async()=>{const entry={id:state.edit?.id||crypto.randomUUID(),title:$('#entryTitle').value.trim(),category:$('#entryCategory').value.trim(),body:$('#entryBody').value,tags:readTags($('#entryTags').value),extra:state.edit?.extra||{}};if(!entry.title||!entry.category||!entry.body.trim())throw new Error('タイトル・ジャンル・本文を入力してください。');await rpc('save_entry',{p_entry:entry,p_expected_revision:state.editRevision,p_is_new:!state.edit});state.editorDirty=false;$('#editorDialog').close();toast('Supabaseに保存しました');resetPaging();await loadList();await showDetail(entry.id);});};
$('#deleteButton').onclick=()=>requireOwner(()=>task($('#detailDialog'),async()=>{const e=state.entry;if(!await confirmAction('この記録を削除しますか？',`「${e.title}」を削除します。元に戻すには事前のJSONバックアップが必要です。`))return;await rpc('delete_entry',{p_id:e.id,p_expected_revision:state.editRevision});$('#detailDialog').close();toast('記録を削除しました');resetPaging();await loadList();}));
async function snapshot({category=null,full=false}={}){
 let result=[],cursor=null,revision=null;
 do {const data=await rpc('list_entries',{p_category:category,p_query:'',p_limit:200,p_after_order:cursor?.order??null,p_after_id:cursor?.id??null,p_full:full});if(revision!==null&&data.revision!==revision)throw new Error('読み込み中にデータが変わりました。もう一度実行してください。');revision=data.revision;result.push(...data.items);cursor=data.next_cursor;}while(cursor);
 return {items:result,revision};
}
function orgScope(){const scope=$('#organizeScope').value;state.org=state.orgAll.filter(e=>!scope||e.category===scope).map(e=>({...e}));state.orgPage=0;state.orgDirty=false;renderOrganize();}
async function startOrganize(){const all=await snapshot();state.orgAll=all.items;state.orgRevision=all.revision;const select=$('#organizeScope');select.replaceChildren(option('','すべてのジャンル'));[...new Set(all.items.map(e=>e.category))].sort().forEach(c=>select.append(option(c,c)));select.value=state.category;orgScope();state.orgScopePrevious=select.value;open($('#organizeDialog'));}
$('#organizeButton').onclick=()=>requireOwner(()=>task(null,startOrganize));
$('#organizeScope').onchange=async()=>{if(state.orgDirty&&!await confirmAction('現在の並べ替えを破棄しますか？','範囲を切り替えると、保存前の並べ替えが取り消されます。')){$('#organizeScope').value=state.orgScopePrevious||'';return;}orgScope();state.orgScopePrevious=$('#organizeScope').value;};
function moveOrg(from,to){if(from<0||to<0||from>=state.org.length||to>=state.org.length||from===to)return;const [item]=state.org.splice(from,1);state.org.splice(to,0,item);state.orgDirty=true;state.orgPage=Math.floor(to/ORG_SIZE);renderOrganize();const moved=[...$('#organizeList').children].find(n=>n.dataset.id===item.id);moved?.querySelector('input')?.focus();}
let dragged=null;
function renderOrganize(){const list=$('#organizeList');list.replaceChildren();const start=state.orgPage*ORG_SIZE;state.org.slice(start,start+ORG_SIZE).forEach((item,offset)=>{const i=start+offset,row=el('div','organize-row');row.draggable=true;row.dataset.id=item.id;const label=el('div');label.append(el('div','org-title',item.title),el('div','org-meta',item.category));const controls=el('div','org-controls');const up=el('button','icon-button','↑'),down=el('button','icon-button','↓');up.setAttribute('aria-label',item.title+' を上へ');down.setAttribute('aria-label',item.title+' を下へ');up.disabled=i===0;down.disabled=i===state.org.length-1;up.onclick=()=>moveOrg(i,i-1);down.onclick=()=>moveOrg(i,i+1);const pos=el('input');pos.type='number';pos.min='1';pos.max=String(state.org.length);pos.value=i+1;pos.setAttribute('aria-label',item.title+' の移動先番号');const go=el('button','icon-button','↵');go.setAttribute('aria-label',item.title+' を指定位置へ移動');go.onclick=()=>{const target=Number(pos.value);if(!Number.isInteger(target)||target<1||target>state.org.length){toast(`1〜${state.org.length}を入力してください`);return;}moveOrg(i,target-1);};pos.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();go.click();}};controls.append(up,down,pos,go);row.append(el('span','org-grip'),label,controls);row.ondragstart=e=>{if(e.target.closest('input,button')){e.preventDefault();return;}dragged=i;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',item.id);};row.ondragover=e=>{e.preventDefault();row.classList.add('dragover');};row.ondragleave=()=>row.classList.remove('dragover');row.ondrop=e=>{e.preventDefault();row.classList.remove('dragover');if(dragged!==null)moveOrg(dragged,i);dragged=null;};row.ondragend=()=>dragged=null;list.append(row);});if(!state.org.length)list.append(el('p','help','この範囲には記録がありません。'));$('#orgPageLabel').textContent=`${state.org.length} 件 · ${state.orgPage+1} / ${Math.max(1,Math.ceil(state.org.length/ORG_SIZE))}`;$('#orgPrevious').disabled=state.orgPage===0;$('#orgNext').disabled=(state.orgPage+1)*ORG_SIZE>=state.org.length;$('#saveOrder').disabled=!state.org.length;}
$('#orgPrevious').onclick=()=>{state.orgPage--;renderOrganize();};$('#orgNext').onclick=()=>{state.orgPage++;renderOrganize();};
$('#saveOrder').onclick=()=>task($('#organizeDialog'),async()=>{if(!state.orgDirty){$('#organizeDialog').close();return;}await rpc('save_order',{p_ids:state.org.map(e=>e.id),p_category:$('#organizeScope').value||null,p_expected_revision:state.orgRevision});state.orgDirty=false;$('#organizeDialog').close();toast('並び順を保存しました');resetPaging();await loadList();});
$('#manageCategories').onclick=()=>requireOwner(()=>task(null,async()=>{const info=await rpc('library_info');updateLibrary(info);state.categoryRevision=info.revision;if(!info.categories.length){toast('まず記録を追加してジャンルを作成してください。');return;}$('#oldCategory').replaceChildren(...info.categories.map(c=>option(c.name,c.name)));if(state.category)$('#oldCategory').value=state.category;$('#newCategory').value='';open($('#categoryDialog'));}));
$('#categoryForm').onsubmit=e=>{e.preventDefault();task($('#categoryDialog'),async()=>{const old=$('#oldCategory').value,name=$('#newCategory').value.trim();if(!name)throw new Error('新しいジャンル名を入力してください。');if(!await confirmAction('ジャンル名を変更しますか？',`「${old}」の全記録を「${name}」へ変更します。`))return;await rpc('rename_category',{p_old:old,p_new:name,p_expected_revision:state.categoryRevision});$('#categoryDialog').close();toast('ジャンル名を変更しました');await setFilter(state.category===old?name:state.category);});};
$('#dataButton').onclick=()=>{open($('#dataDialog'));$('.sidebar').classList.remove('open');};
$('#exportButton').onclick=()=>task($('#dataDialog'),async()=>{const data=await snapshot({full:true});const backup={schema_version:1,exported_at:new Date().toISOString(),revision:data.revision,entries:data.items};const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=`unity-notes-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`${data.items.length}件を書き出しました`);});
$('#importFile').onchange=e=>task($('#dataDialog'),async()=>{const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw new Error('ファイルは5MBまでです。');$('#importText').value=await file.text();});
function normalizeImport(parsed){const values=Array.isArray(parsed)?parsed:parsed.entries;if(!Array.isArray(values)||!values.length||values.length>500)throw new Error('1〜500件の配列を指定してください。');if(!Array.isArray(parsed)&&parsed.schema_version!==undefined&&parsed.schema_version!==1)throw new Error('未対応のバックアップ形式です。');const known=['id','title','category','body','tags','created_at','updated_at','order','extra','summary'];const ids=new Set();return values.map((value,i)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${i+1}件目がオブジェクトではありません。`);for(const [key,max] of [['title',180],['category',60],['body',200000]])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw new Error(`${i+1}件目の${key}を確認してください。`);const id=value.id||crypto.randomUUID();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||ids.has(id))throw new Error('IDは重複のないUUIDにしてください。省略時は自動生成します。');ids.add(id);const tags=value.tags??[];if(!Array.isArray(tags)||tags.length>30||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>60))throw new Error(`${i+1}件目のtagsを確認してください。`);const created=value.created_at||new Date().toISOString();if(!Number.isFinite(Date.parse(created)))throw new Error('created_atの日時形式を確認してください。');if(value.order!==undefined&&!Number.isSafeInteger(value.order))throw new Error('orderは安全な整数で指定してください。');if(value.extra!==undefined&&(!value.extra||typeof value.extra!=='object'||Array.isArray(value.extra)))throw new Error('extraはオブジェクトで指定してください。');const extra={...(value.extra||{})};for(const [k,v] of Object.entries(value))if(!known.includes(k))Object.defineProperty(extra,k,{value:v,enumerable:true,writable:true,configurable:true});return {id,title:value.title.trim(),category:value.category.trim(),body:value.body,tags:[...new Set(tags.map(t=>t.trim()))],created_at:new Date(created).toISOString(),order:value.order??i,extra};}).sort((a,b)=>a.order-b.order);}
$('#importButton').onclick=()=>requireOwner(()=>task($('#dataDialog'),async()=>{const text=$('#importText').value;if(new TextEncoder().encode(text).length>5*1024*1024)throw new Error('JSONは5MBまでです。');let parsed;try{parsed=JSON.parse(text);}catch{throw new Error('JSONの形式が正しくありません。');}const entries=normalizeImport(parsed);const info=await rpc('library_info');if(!await confirmAction(`${entries.length}件を追加しますか？`,'既存の記録は変更しません。全件が公開されます。同じIDがある場合は全件取り消します。'))return;await rpc('import_entries',{p_entries:entries,p_expected_revision:info.revision});$('#importText').value='';$('#importFile').value='';toast(`${entries.length}件を追加しました`);resetPaging();await loadList();}));
authUI();
if(ready){loadList();}else{const notice=$('#setupNotice');notice.hidden=false;notice.textContent='はじめに：Supabaseの初期設定が必要です。同梱のSETUP.mdに沿って、site/config.jsの2項目を設定してください。この画面はブラウザ内への仮保存は行いません。';$('#connectionText').textContent='Supabase 未設定';$('#resultCount').textContent='接続後に記録が表示されます';$('#listStatus').textContent='';renderCards();}
