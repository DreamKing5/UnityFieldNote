// Destructive integration tests ONLY against the packaged localhost contract double.
import { chromium, request } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const base=process.env.TEST_URL||'http://127.0.0.1:8765';
if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))throw Error('Tests are restricted to the local test double.');
const out=new URL('./test-output/',import.meta.url);await fs.mkdir(out,{recursive:true});
const results=[],errors=[];const api=await request.newContext({baseURL:base});
const health=await (await api.get('/health')).json();assert.match(health.mode,/CONTRACT DOUBLE/);
await api.post('/test/reset');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',args:['--no-sandbox']});
const desktop=await browser.newContext({viewport:{width:1440,height:980},acceptDownloads:true});
const isolated=await browser.newContext({viewport:{width:390,height:844}});
const page=await desktop.newPage(), other=await isolated.newPage();
for(const p of [page,other])p.on('pageerror',e=>errors.push(e.message));
async function check(name,fn){const start=Date.now();await fn();results.push({name,status:'PASS',ms:Date.now()-start});console.log('PASS',name);}
async function wait(p,fn){const until=Date.now()+15000;while(Date.now()<until){if(await p.evaluate(fn))return;await p.waitForTimeout(80);}throw Error('Timed out waiting: '+fn.toString());}
async function loaded(p=page){await wait(p,()=>document.querySelector('#connectionText').textContent.includes('接続済み')&&!document.querySelector('#listStatus').textContent);}
async function signIn(p=page,email='owner@example.test'){
 await p.locator('#authButton').click();await p.locator('#email').fill(email);await p.locator('#password').fill('local-test-only-password');await p.locator('#loginForm button[type=submit]').click();await p.locator('#loginDialog').waitFor({state:'hidden'});
}
async function close(p,selector){await p.locator(selector+' [data-close]').first().click();await p.locator(selector).waitFor({state:'hidden'});}
async function confirm(p=page){await p.locator('#confirmYes').click();await p.locator('#confirmDialog').waitFor({state:'hidden'});}
async function cards(p=page){return p.locator('.entry-card').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));}
async function shot(name,p=page){await p.screenshot({path:new URL(name+'.png',out).pathname});}
async function call(name,body={},token){return api.post('/rest/v1/rpc/'+name,{data:body,headers:token?{Authorization:'Bearer '+token}:{}});}
async function data(name,body={},token){const r=await call(name,body,token);if(!r.ok())throw Error(await r.text());return r.json();}
let newId,ownerToken;
try{
await check('Anonymous timeline; summaries only; no browser persistence',async()=>{
 let listResponse;page.on('response',async r=>{if(r.url().endsWith('/rpc/list_entries'))listResponse=await r.json();});
 await page.goto(base);await loaded();assert.equal((await cards()).length,8);await page.waitForTimeout(100);assert.ok(listResponse.items.every(v=>!Object.hasOwn(v,'body')));assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);await shot('desktop-timeline');
 await other.goto(base);await loaded(other);assert.equal((await cards(other)).length,8);assert.equal(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await shot('mobile-timeline',other);
});
await check('Reject wrong password and non-owner login',async()=>{
 await page.locator('#authButton').click();await page.locator('#email').fill('owner@example.test');await page.locator('#password').fill('wrong-password');await page.locator('#loginForm button[type=submit]').click();await wait(page,()=>document.querySelector('#loginDialog .form-error').textContent.length>0);assert.equal(await page.locator('#loginDialog').isVisible(),true);
 await page.locator('#email').fill('other@example.test');await page.locator('#password').fill('local-test-only-password');await page.locator('#loginForm button[type=submit]').click();await wait(page,()=>document.querySelector('#loginDialog .form-error').textContent.includes('本人'));await close(page,'#loginDialog');await signIn();
 ownerToken=(await (await api.post('/auth/v1/token?grant_type=password',{data:{email:'owner@example.test',password:'local-test-only-password'}})).json()).access_token;
});
await check('Add → save → independent browser session reload',async()=>{
 await page.locator('#addButton').click();await page.locator('#entryTitle').fill('検証：参照の設定を確認する');await page.locator('#entryCategory').fill('検証ジャンル');await page.locator('#entryTags').fill('Unity, 検証');await page.locator('#entryBody').fill('## 解決方法\n\nInspectorを確認する。\n\n```csharp\nDebug.Log("確認");\n```\n\n<img src=x onerror="window.XSS=1">\n\n[悪いリンク](javascript:alert(1))');await shot('desktop-editor');
 await page.locator('#editorForm button[type=submit]').click();await page.locator('#detailDialog').waitFor();assert.equal(await page.locator('#detailTitle').textContent(),'検証：参照の設定を確認する');assert.equal(await page.locator('#detailBody img').count(),0);assert.equal(await page.locator('#detailBody a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.XSS),undefined);
 await other.reload();await loaded(other);assert.match(await other.locator('.entry-card').first().textContent(),/検証：参照/);newId=(await cards(other))[0];await other.locator('.entry-card').first().click();await other.locator('#detailDialog').waitFor();assert.match(await other.locator('#detailBody').textContent(),/Inspector/);await shot('mobile-detail',other);await close(other,'#detailDialog');assert.match(await other.locator('#accessLabel').textContent(),/閲覧/);await close(page,'#detailDialog');
});
await check('Edit title, tags and category; preserve created time and ID',async()=>{
 const before=(await data('get_entry',{p_id:newId})).entry;await page.locator(`.entry-card[data-id="${newId}"]`).click();await page.locator('#editButton').click();await page.locator('#entryTitle').fill('検証：編集済みの記録');await page.locator('#entryCategory').fill('Gitの操作');await page.locator('#entryTags').fill('変更, Git');await page.locator('#editorForm button[type=submit]').click();await page.locator('#detailDialog').waitFor();await close(page,'#detailDialog');const after=(await data('get_entry',{p_id:newId})).entry;assert.equal(after.created_at,before.created_at);assert.equal(after.id,before.id);assert.equal(after.category,'Gitの操作');assert.deepEqual(after.tags,['変更','Git']);await other.reload();await loaded(other);assert.match(await other.locator('.entry-card').first().textContent(),/編集済み/);
});
await check('Global organization → save → isolated session order matches',async()=>{
 const before=await cards();await page.locator('#organizeButton').click();await page.locator('#organizeDialog').waitFor();await page.locator('.organize-row').first().locator('input').fill('4');await page.locator('.organize-row').first().locator('button').last().click();await shot('desktop-organize');const expected=[...before];expected.splice(3,0,expected.shift());await page.locator('#saveOrder').click();await page.locator('#organizeDialog').waitFor({state:'hidden'});await loaded();assert.deepEqual(await cards(),expected);await other.reload();await loaded(other);assert.deepEqual(await cards(other),expected);
});
await check('Category organization leaves all other category slots unchanged',async()=>{
 const before=(await data('list_entries',{p_limit:200})).items;await page.locator('#categoryNav button').filter({hasText:'Gitの操作'}).click();await loaded();await page.locator('#organizeButton').click();await page.locator('#organizeDialog').waitFor();assert.equal(await page.locator('#organizeScope').inputValue(),'Gitの操作');const expected=await page.locator('.organize-row').evaluateAll(rows=>rows.map(r=>r.dataset.id));await page.locator('.organize-row').first().getByRole('button',{name:/を下へ/}).click();[expected[0],expected[1]]=[expected[1],expected[0]];await page.locator('#saveOrder').click();await page.locator('#organizeDialog').waitFor({state:'hidden'});await loaded();await other.reload();await loaded(other);await other.locator('#mobileCategory').selectOption('Gitの操作');await loaded(other);assert.deepEqual(await cards(other),expected);const after=(await data('list_entries',{p_limit:200})).items;assert.deepEqual(after.filter(r=>r.category!=='Gitの操作').map(r=>[r.id,r.order]),before.filter(r=>r.category!=='Gitの操作').map(r=>[r.id,r.order]));
});
await check('Rename whole category; automatic navigation update',async()=>{
 await page.locator('#manageCategories').click();await page.locator('#newCategory').fill('Git・バージョン管理');await page.locator('#categoryForm button[type=submit]').click();await confirm();await page.locator('#categoryDialog').waitFor({state:'hidden'});await loaded();assert.ok((await data('library_info')).categories.some(c=>c.name==='Git・バージョン管理'));assert.ok(!(await data('library_info')).categories.some(c=>c.name==='Gitの操作'));await page.locator('#allCategory').click();await loaded();
});
await check('JSON import; unknown fields retained under extra; export full body',async()=>{
 await page.locator('#dataButton').click();await page.locator('#importText').fill(JSON.stringify([{title:'インポートA',category:'移行',body:'**太字**の移行テスト',difficulty:'beginner',tags:['移行']},{title:'インポートB',category:'移行',body:'追加の記録',order:10}]));await page.locator('#importButton').click();await confirm();await wait(page,()=>document.querySelector('#importText').value==='');
 const downloadPromise=page.waitForEvent('download');await page.locator('#exportButton').click();const download=await downloadPromise;await download.saveAs(new URL('export.json',out).pathname);const backup=JSON.parse(await fs.readFile(new URL('export.json',out),'utf8'));assert.equal(backup.entries.length,11);assert.equal(backup.entries.find(e=>e.title==='インポートA').extra.difficulty,'beginner');assert.ok(backup.entries.every(e=>e.body&&e.id&&e.created_at));await close(page,'#dataDialog');
});
await check('Duplicate import rolls back entire batch',async()=>{
 const info=await data('library_info');const sample={id:crypto.randomUUID(),title:'ROLLBACK sentinel',category:'移行',body:'not stored',tags:[],extra:{}};const r=await call('import_entries',{p_expected_revision:info.revision,p_entries:[sample,{...sample,id:newId}]},ownerToken);assert.equal(r.status(),409);assert.equal((await data('get_entry',{p_id:sample.id})).entry,null);assert.equal((await data('library_info')).revision,info.revision);
});
await check('Concurrent writes reject stale edit without losing typed draft',async()=>{
 await page.locator(`.entry-card[data-id="${newId}"]`).click();await page.locator('#editButton').click();await page.locator('#entryTitle').fill('競合しても残る下書き');const revision=(await data('library_info')).revision;await data('save_entry',{p_expected_revision:revision,p_is_new:true,p_entry:{id:crypto.randomUUID(),title:'別端末からの追加',category:'競合検証',body:'remote update',tags:[]}},ownerToken);await page.locator('#editorForm button[type=submit]').click();await wait(page,()=>document.querySelector('#editorDialog .form-error').textContent.includes('別の操作'));assert.equal(await page.locator('#entryTitle').inputValue(),'競合しても残る下書き');assert.equal((await data('get_entry',{p_id:newId})).entry.title,'検証：編集済みの記録');await shot('conflict-error');await page.locator('#editorDialog [data-close]').first().click();await confirm();await page.locator('#refreshButton').click();await loaded();
});
await check('Network failure never reports successful save; draft retained',async()=>{
 await page.locator('#addButton').click();await page.locator('#entryTitle').fill('通信失敗の下書き');await page.locator('#entryCategory').fill('テスト');await page.locator('#entryBody').fill('まだ保存されていません');await page.route('**/rest/v1/rpc/save_entry',route=>route.abort('failed'));await page.locator('#editorForm button[type=submit]').click();await wait(page,()=>document.querySelector('#editorDialog .form-error').textContent.includes('通信'));assert.equal(await page.locator('#entryTitle').inputValue(),'通信失敗の下書き');await page.unroute('**/rest/v1/rpc/save_entry');await page.locator('#editorDialog [data-close]').first().click();await confirm();
});
await check('All anonymous mutations and non-owner RPC calls rejected',async()=>{
 const info=await data('library_info');for(const name of ['save_entry','delete_entry','save_order','rename_category','import_entries']){const r=await call(name,{p_expected_revision:info.revision});assert.equal(r.status(),403,name);}
 const t=(await (await api.post('/auth/v1/token?grant_type=password',{data:{email:'other@example.test',password:'local-test-only-password'}})).json()).access_token;
 assert.equal((await call('delete_entry',{p_id:newId,p_expected_revision:info.revision},t)).status(),403);assert.equal((await data('library_info')).revision,info.revision);
});
await check('Delete confirmation and cross-session disappearance',async()=>{
 await page.locator(`.entry-card[data-id="${newId}"]`).click();await page.locator('#deleteButton').click();await page.locator('#confirmNo').click();assert.ok((await data('get_entry',{p_id:newId})).entry);await page.locator('#deleteButton').click();await confirm();await page.locator('#detailDialog').waitFor({state:'hidden'});assert.equal((await data('get_entry',{p_id:newId})).entry,null);await other.reload();await loaded(other);assert.ok(!(await cards(other)).includes(newId));
});
await check('216 records: bounded DOM, full backup pagination, move across organizer pages',async()=>{
 await page.locator('#dataButton').click();const imported=Array.from({length:205},(_,i)=>({title:`大量データ ${String(i+1).padStart(3,'0')}`,category:'大量データ',body:`本文 ${i+1}：本文検索マーカー${i+1}`,tags:['負荷検証']}));await page.locator('#importText').fill(JSON.stringify(imported));await page.locator('#importButton').click();await confirm();await wait(page,()=>document.querySelector('#importText').value==='');const downloadPromise=page.waitForEvent('download');await page.locator('#exportButton').click();const download=await downloadPromise;await download.saveAs(new URL('large-export.json',out).pathname);const all=JSON.parse(await fs.readFile(new URL('large-export.json',out),'utf8')).entries;assert.equal(all.length,216);await close(page,'#dataDialog');await page.locator('#allCategory').click();await loaded();assert.equal((await cards()).length,24);assert.equal(await page.locator('#nextPage').isEnabled(),true);await page.locator('#nextPage').click();await loaded();assert.equal((await cards()).length,24);await page.locator('#organizeButton').click();await page.locator('#organizeDialog').waitFor();assert.equal(await page.locator('.organize-row').count(),40);const moving=await page.locator('.organize-row').first().getAttribute('data-id');await page.locator('.organize-row').first().locator('input').fill('216');await page.locator('.organize-row').first().locator('button').last().click();assert.equal(await page.locator('.organize-row').last().getAttribute('data-id'),moving);await page.locator('#saveOrder').click();await page.locator('#organizeDialog').waitFor({state:'hidden'});assert.equal((await data('list_entries',{p_limit:200,p_after_order:(await data('get_entry',{p_id:moving})).entry.order-1,p_after_id:'00000000-0000-0000-0000-000000000000'})).items.at(-1).id,moving);
 await page.locator('#search').fill('本文検索マーカー205');await wait(page,()=>document.querySelectorAll('.entry-card').length===1);assert.match(await page.locator('.entry-card').textContent(),/205/);await page.locator('#search').fill('ゼロ件になる文字列');await page.locator('.empty-state').waitFor();await shot('empty-search');await page.locator('#search').fill('');await wait(page,()=>document.querySelectorAll('.entry-card').length===24);
});
await check('Mobile: login, editor, preview, organizer, menu and no horizontal overflow',async()=>{
 await other.reload();await loaded(other);await other.locator('#addButton').click();await other.locator('#email').fill('owner@example.test');await other.locator('#password').fill('local-test-only-password');await other.locator('#loginForm button[type=submit]').click();await other.locator('#editorDialog').waitFor();await other.locator('#entryTitle').fill('モバイル編集プレビュー');await other.locator('#entryCategory').fill('UI');await other.locator('#entryBody').fill('## モバイル\n\n**強調** と `コード`。\n\n- 確認1\n- 確認2');await shot('mobile-editor',other);await other.locator('#previewButton').click();assert.equal(await other.locator('#markdownPreview h2').textContent(),'モバイル');await shot('mobile-preview',other);await other.locator('#editorDialog [data-close]').first().click();await confirm(other);await other.locator('#organizeButton').click();await other.locator('#organizeDialog').waitFor();await shot('mobile-organize',other);assert.equal(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await close(other,'#organizeDialog');await other.locator('#mobileMenu').click();assert.equal(await other.locator('.sidebar').isVisible(),true);await shot('mobile-menu',other);
});
await check('No unhandled page errors; no localStorage/sessionStorage data',async()=>{assert.deepEqual(errors,[]);for(const p of [page,other])assert.equal(await p.evaluate(()=>localStorage.length+sessionStorage.length),0);});
await fs.writeFile(new URL('results.json',out),JSON.stringify({environment:'LOCAL SQLite-backed Supabase contract double; NOT hosted Supabase or PostgreSQL RLS',results,errors},null,2));
console.log(`${results.length} checks passed.`);
}catch(e){await shot('FAILURE');await fs.writeFile(new URL('results.json',out),JSON.stringify({results,errors,failure:e.stack},null,2));console.error(e);process.exitCode=1;}
finally{await desktop.close();await isolated.close();await browser.close();await api.dispose();}
