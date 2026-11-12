import {firebaseConfig} from './config.js';
import * as driver from './firebase-driver.js';
import {read,plan} from './data-core.js';
export const configured=!!(firebaseConfig?.projectId && firebaseConfig?.apiKey && !firebaseConfig.projectId.includes('YOUR_'));
export const ready=configured;
let authenticated=false;
export class ApiError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}}
function message(e){
 const m=String(e.message||e);
 if(m.includes('STALE_REVISION'))return '別の操作・端末でデータが変更されています。入力内容を控え、閉じて最新データを読み込み直してください。変更は保存されていません。';
 if(m.includes('DUPLICATE_ID'))return '同じIDの記録が存在します。インポートは全件取り消されました。';
 if(m.includes('ORDER_SET_MISMATCH'))return '並べ替え対象が変わっています。整理モードを開き直してください。';
 if(e.code==='permission-denied')return 'Firestoreの権限で拒否されました。ルールとaccess_control/ownerの設定を確認してください。';
 if(['auth/invalid-credential','auth/wrong-password','auth/user-not-found','auth/invalid-login-credentials'].includes(e.code))return 'メールアドレスまたはパスワードが違います。';
 if(e.code==='auth/operation-not-allowed')return 'Firebase Authenticationでメール／パスワードを有効にしてください。';
 if(e.code==='auth/too-many-requests')return '試行回数が多いため、時間をおいて再試行してください。';
 if(e.code==='unavailable'||e.code==='deadline-exceeded'||m.includes('Failed to fetch'))return '接続を確認してください。保存中の場合は反映済みの可能性があるため、別タブで最新データを確認してから再操作してください。';
 return m;
}
export async function login(email,password){try{await driver.signIn(email,password);if(!await driver.owner()){await driver.signOutUser();throw new Error('本人として登録されたアカウントではありません。管理者登録手順を確認してください。');}authenticated=true;}catch(e){authenticated=false;try{await driver.signOutUser();}catch{}throw new ApiError(message(e),403,e.code);}}
export async function logout(){await driver.signOutUser();authenticated=false;}
export function loggedIn(){return authenticated;}
export async function rpc(name,args={}){
 try{
  if(!ready)throw new Error('Firebaseが未設定です。site/config.jsを確認してください。');
  if(name==='is_owner')return authenticated&&await driver.owner();
  const s=await driver.snapshot();
  if(['library_info','get_entry','list_entries','list_entries_display'].includes(name))return read(s,name,args);
  if(!authenticated||!await driver.owner())throw new Error('このアカウントには編集権限がありません。');
  const p=plan(s,name,args);await driver.commit(s.revision,p.changes);return p.result;
 }catch(e){throw new ApiError(message(e),400,e.code);}
}
