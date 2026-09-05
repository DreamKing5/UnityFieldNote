import { CONFIG } from './config.js';
let session = null;
let refreshPromise = null;
export const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(CONFIG.supabaseUrl) && /^(sb_publishable_|eyJ)/.test(CONFIG.publishableKey);
// localhost is allowed only for the packaged, explicit integration-test config.
const localTest = ['localhost', '127.0.0.1'].includes(location.hostname) && CONFIG.testOnly === true && CONFIG.supabaseUrl === location.origin;
export const ready = configured || localTest;
const base = CONFIG.supabaseUrl.replace(/\/$/, '');
if (CONFIG.publishableKey.startsWith('sb_secret_')) throw new Error('公開用キーだけを設定してください。secret keyは禁止です。');
if (CONFIG.publishableKey.startsWith('eyJ')) {
  try { if (JSON.parse(atob(CONFIG.publishableKey.split('.')[1])).role === 'service_role') throw new Error('service_roleキーは使用禁止です。'); }
  catch(e) { if (e.message.includes('使用禁止')) throw e; }
}
export class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
async function raw(path, body, token, method='POST') {
  if (!ready) throw new Error('Supabaseが未設定です。SETUP.mdに従ってconfig.jsを設定してください。');
  let response;
  try {
    response = await fetch(base + path, { method, headers: { apikey: CONFIG.publishableKey, 'Content-Type': 'application/json', ...((token || CONFIG.publishableKey.startsWith('eyJ')) ? {Authorization: `Bearer ${token || CONFIG.publishableKey}`} : {}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}), cache:'no-store', credentials:'omit', signal:AbortSignal.timeout(25000) });
  } catch { throw new Error('通信を確認してください。保存操作中の場合、反映済みの可能性があります。別タブで最新データを確認してから再操作してください。'); }
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { throw new ApiError('サーバーから想定外の応答がありました。',response.status); }
  if (!response.ok) {
    let message = data?.message || data?.msg || data?.error_description || data?.error || '接続に失敗しました。';
    if (String(message).includes('STALE_REVISION')) message = '別の操作・端末でデータが変更されています。入力内容を控え、閉じて最新データを読み込み直してください。変更は保存されていません。';
    if (String(message).includes('OWNER_ONLY')) message = 'このアカウントには編集権限がありません。本人のアカウントでログインしてください。';
    if (String(message).includes('DUPLICATE_ID')) message = '同じIDの記録が存在します。インポートは全件取り消されました。';
    if (String(message).includes('ORDER_SET_MISMATCH')) message = '並べ替え対象が変わっています。整理モードを開き直してください。';
    throw new ApiError(String(message), response.status, data?.code);
  }
  return data;
}
async function token() {
  if (!session) return null;
  if (session.expires_at > Date.now()/1000 + 60) return session.access_token;
  if (!refreshPromise) refreshPromise = raw('/auth/v1/token?grant_type=refresh_token', {refresh_token:session.refresh_token}).then(s => { session = {...s,expires_at:Date.now()/1000+s.expires_in}; return session.access_token; }).catch(e => { session=null; window.dispatchEvent(new Event('authlost')); throw e; }).finally(()=>refreshPromise=null);
  return refreshPromise;
}
export async function login(email,password) {
  const s = await raw('/auth/v1/token?grant_type=password',{email,password});
  session={...s,expires_at:Date.now()/1000+s.expires_in};
  try { if (!await rpc('is_owner',{})) throw new Error('本人として登録されたアカウントではありません。'); }
  catch(e) { await logout(); throw e; }
}
export async function logout() {
  const old=session; session=null;
  if(old) try { await raw('/auth/v1/logout',{},old.access_token); } catch { /* Local session is always cleared. Server access JWT expires naturally. */ }
}
export async function rpc(name,args={}) { return raw(`/rest/v1/rpc/${name}`,args,await token()); }
export function loggedIn(){return !!session;}
