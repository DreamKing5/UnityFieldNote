import { firebaseConfig } from './config.js';
const version='12.0.0';
let contextPromise;
async function context(){
 if(!contextPromise)contextPromise=(async()=>{
  const base='https://www.gstatic.com/firebasejs/12.0.0/'; const [appSdk,authSdk,fs]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
  const app=appSdk.initializeApp(firebaseConfig),auth=authSdk.getAuth(app),db=fs.getFirestore(app);
  await authSdk.setPersistence(auth,authSdk.inMemoryPersistence);
  return {authSdk,fs,auth,db};
 })().catch(e=>{contextPromise=null;throw e;});
 return contextPromise;
}
export async function signIn(email,password){const {authSdk,auth}=await context();return (await authSdk.signInWithEmailAndPassword(auth,email,password)).user;}
export async function signOutUser(){const {authSdk,auth}=await context();await authSdk.signOut(auth);}
export async function owner(){const {fs,db,auth}=await context();const d=await fs.getDocFromServer(fs.doc(db,'access_control','owner'));return !!auth.currentUser&&d.exists()&&d.data().uid===auth.currentUser.uid;}
export async function snapshot(){
 const {fs,db}=await context();
 for(let attempt=0;attempt<3;attempt++){
  const stateRef=fs.doc(db,'site_state','library');
  const before=await fs.getDocFromServer(stateRef);
  if(!before.exists())throw new Error('Firestoreのsite_state/libraryがありません。バックアップ復元を先に実行してください。');
  const docs=await fs.getDocsFromServer(fs.collection(db,'entries'));
  const after=await fs.getDocFromServer(stateRef);
  if(after.exists()&&before.data().revision===after.data().revision)return {revision:after.data().revision,entries:docs.docs.map(d=>d.data())};
 }
 throw new Error('読み込み中にデータが変わりました。再読み込みしてください。');
}
export async function commit(expected,changes){
 const {fs,db}=await context();
 await fs.runTransaction(db,async tx=>{
  const state=fs.doc(db,'site_state','library'),d=await tx.get(state);
  if(!d.exists()||d.data().revision!==expected)throw new Error('STALE_REVISION');
  for(const c of changes){const ref=fs.doc(db,'entries',c.id);if(c.value===null)tx.delete(ref);else tx.set(ref,c.value);}
  tx.update(state,{revision:expected+1});
 });
}
