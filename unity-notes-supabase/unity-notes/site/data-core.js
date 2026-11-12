// Firebase-independent application contract. Shared by production and tests.
export const compare = (a,b) => a.order-b.order || (a.id<b.id?-1:a.id>b.id?1:0);
const clean = e => { const {search_text,...v}=e; return v; };
const fail = message => {throw new Error(message);};
const searchText=e=>[e.title,e.category,e.body,...e.tags].join(' ').toLowerCase();
export function library(s){return {revision:s.revision,total:s.entries.length,favorites_count:s.entries.filter(e=>e.favorite).length,categories:[...new Set(s.entries.map(e=>e.category))].sort().map(name=>({name,count:s.entries.filter(e=>e.category===name).length}))};}
export function read(s,name,p={}){
 if(name==='library_info')return library(s);
 if(name==='get_entry'){const found=s.entries.find(e=>e.id===p.p_id);return {revision:s.revision,entry:found?clean(found):null};}
 if(!['list_entries','list_entries_display'].includes(name))fail('UNKNOWN_OPERATION');
 const reverse=name==='list_entries_display'&&p.p_reverse===true;
 const q=(p.p_query||'').trim().toLowerCase();
 let rows=s.entries.filter(e=>(!p.p_category||e.category===p.p_category)&&(!p.p_favorites_only||e.favorite)&&(!q||searchText(e).includes(q))).sort(compare);
 const total=rows.length;if(reverse)rows.reverse();
 if(p.p_after_order!==null&&p.p_after_order!==undefined){const cur={order:p.p_after_order,id:p.p_after_id};rows=rows.filter(e=>reverse?compare(e,cur)<0:compare(e,cur)>0);}
 const limit=Math.max(1,Math.min(200,p.p_limit||24)), visible=rows.slice(0,limit),last=visible.at(-1);
 return {revision:s.revision,library:library(s),total,items:visible.map(e=>p.p_full?clean(e):{id:e.id,title:e.title,category:e.category,summary:e.body.slice(0,240),tags:e.tags,favorite:e.favorite,created_at:e.created_at,order:e.order}),next_cursor:rows.length>limit?{order:last.order,id:last.id}:null};
}
export function validate(e){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.id))fail('IDはUUIDで指定してください。');
 for(const [k,n]of [['title',180],['category',60],['body',200000]])if(typeof e[k]!=='string'||!e[k].trim()||e[k].length>n)fail('タイトル・ジャンル・本文の長さを確認してください。');
 if(!Array.isArray(e.tags)||e.tags.length>30||e.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>60))fail('タグを確認してください。');
 if(!e.extra||typeof e.extra!=='object'||Array.isArray(e.extra))fail('extraを確認してください。');
 if(!Number.isSafeInteger(e.order)||typeof e.favorite!=='boolean')fail('順序・お気に入りの形式が不正です。');
 if(!Number.isFinite(Date.parse(e.created_at))||!Number.isFinite(Date.parse(e.updated_at)))fail('日時が不正です。');
 if(new TextEncoder().encode(JSON.stringify(e)).length>900000)fail('1件のデータサイズが大きすぎます。');
}
export function plan(s,name,p,now=new Date().toISOString()){
 if(s.revision!==p.p_expected_revision)fail('STALE_REVISION');
 const all=[...s.entries].sort(compare),map=new Map(all.map(e=>[e.id,e]));let changes=[],result={};
 const existing=id=>map.get(id)||fail('記録が見つかりません。');
 const set=e=>{validate(e);changes.push({id:e.id,value:e});};
 if(name==='save_entry'){
  const v=p.p_entry,old=map.get(v.id);
  if(p.p_is_new&&old)fail('DUPLICATE_ID');if(!p.p_is_new&&!old)fail('記録が見つかりません。');
  const e={id:v.id,title:v.title,category:v.category,body:v.body,tags:v.tags||[],created_at:old?.created_at||now,updated_at:now,order:old?.order??((all[0]?.order??1024)-1024),extra:v.extra||{},favorite:old?.favorite??false,search_text:''};e.search_text=searchText(e);set(e);result.id=e.id;
 }else if(name==='delete_entry'){existing(p.p_id);changes.push({id:p.p_id,value:null});
 }else if(name==='set_favorite'){if(typeof p.p_favorite!=='boolean')fail('お気に入りの形式が不正です。');set({...existing(p.p_id),favorite:p.p_favorite,updated_at:now});
 }else if(name==='save_order'){
  const target=all.filter(e=>!p.p_category||e.category===p.p_category),ids=p.p_ids;
  if(!Array.isArray(ids)||ids.length!==target.length||new Set(ids).size!==target.length||ids.some(id=>!target.some(e=>e.id===id)))fail('ORDER_SET_MISMATCH');
  ids.forEach((id,i)=>set({...existing(id),order:target[i].order,updated_at:now}));
 }else if(name==='rename_category'){
  if(typeof p.p_new!=='string'||!p.p_new.trim()||p.p_new.length>60)fail('ジャンル名を確認してください。');
  all.filter(e=>e.category===p.p_old).forEach(old=>{const e={...old,category:p.p_new.trim(),updated_at:now};e.search_text=searchText(e);set(e);});
 }else if(name==='import_entries'){
  if(!Array.isArray(p.p_entries)||!p.p_entries.length||p.p_entries.length>450)fail('一度のインポートは1〜450件です。');
  const ids=new Set(),v=[...p.p_entries].sort((a,b)=>(a.order??0)-(b.order??0)),start=(all.at(-1)?.order??0);
  v.forEach((x,i)=>{if(map.has(x.id)||ids.has(x.id))fail('DUPLICATE_ID');ids.add(x.id);const e={id:x.id,title:x.title,category:x.category,body:x.body,tags:x.tags||[],created_at:x.created_at||now,updated_at:x.updated_at||now,order:start+(i+1)*1024,extra:x.extra||{},favorite:x.favorite??false,search_text:''};e.search_text=searchText(e);set(e);});result.imported=v.length;
 }else fail('UNKNOWN_OPERATION');
 if(changes.length>450)fail('一度に変更できるのは450件までです。範囲を小さくしてください。');
 if(new TextEncoder().encode(JSON.stringify(changes)).length>7*1024*1024)fail('変更データが大きすぎます。分けて実行してください。');
 return {changes,result:{...result,revision:s.revision+1}};
}
