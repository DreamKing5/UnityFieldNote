#!/usr/bin/env python3
"""Loopback-only Supabase CONTRACT DOUBLE, NOT a Supabase/Postgres/RLS server.
Persistence: SQLite on the server's disk; nothing in browser storage.
For frontend integration tests only. Never deploy this server publicly.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
import argparse, json, sqlite3, threading, uuid, datetime, sys
ROOT=Path(__file__).resolve().parents[1]
LOCK=threading.RLock()
DB=ROOT/'tests/.test-store.sqlite'
PASSWORD='local-test-only-password'
TOKENS={}

def connect():
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;return c

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def row(r):
 d=dict(r)
 for k in ('tags','extra'):d[k]=json.loads(d[k])
 return d

def seed():
 with LOCK,connect() as c:
  c.executescript('DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS state; CREATE TABLE state(revision integer); INSERT INTO state VALUES(0); CREATE TABLE entries(id text primary key,title text,category text,body text,tags text,created_at text,updated_at text,"order" integer,extra text);')
  values=json.loads((ROOT/'examples.json').read_text())['entries']
  for i,v in enumerate(values):
   c.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)',(v['id'],v['title'],v['category'],v['body'],json.dumps(v['tags']),v['created_at'],now(),(i+1)*1024,json.dumps(v.get('extra',{}))))

def info(c):
 return {'revision':c.execute('SELECT revision FROM state').fetchone()[0],'total':c.execute('SELECT count(*) FROM entries').fetchone()[0],'categories':[{'name':r[0],'count':r[1]} for r in c.execute('SELECT category,count(*) FROM entries GROUP BY category ORDER BY category')]}
class Failure(Exception):
 def __init__(self,msg,status=400,code='22023'):self.msg=msg;self.status=status;self.code=code

def validate(v):
 for k,n in [('title',180),('category',60),('body',200000)]:
  if not isinstance(v.get(k),str) or not 1<=len(v[k].strip())<=n:raise Failure('INVALID_CONTENT')
 if not isinstance(v.get('tags',[]),list) or len(v.get('tags',[]))>30 or any(not isinstance(t,str) or not 1<=len(t.strip())<=60 for t in v.get('tags',[])):raise Failure('INVALID_TAGS')
 if not isinstance(v.get('extra',{}),dict):raise Failure('INVALID_EXTRA')
 try:uuid.UUID(v['id'])
 except:raise Failure('INVALID_ID')

def dispatch(name,p,owner):
 with LOCK,connect() as c:
  lib=info(c)
  if name=='is_owner':return owner
  if name=='library_info':return lib
  if name=='list_entries':
   records=[row(r) for r in c.execute('SELECT * FROM entries ORDER BY "order",id')]
   category=p.get('p_category');q=p.get('p_query','').strip().lower()
   records=[r for r in records if (not category or r['category']==category) and (not q or q in (r['title']+' '+r['category']+' '+r['body']+' '+' '.join(r['tags'])).lower())]
   total=len(records)
   if p.get('p_after_order') is not None:records=[r for r in records if (r['order'],r['id'])>(p['p_after_order'],p['p_after_id'])]
   limit=max(1,min(p.get('p_limit',24),200));page=records[:limit]
   cursor={'order':page[-1]['order'],'id':page[-1]['id']} if len(records)>limit else None
   if not p.get('p_full'):page=[{**{k:r[k] for k in ('id','title','category','tags','created_at','order')},'summary':r['body'][:240]} for r in page]
   return {'revision':lib['revision'],'library':lib,'total':total,'items':page,'next_cursor':cursor}
  if name=='get_entry':
   r=c.execute('SELECT * FROM entries WHERE id=?',(p['p_id'],)).fetchone()
   return {'revision':lib['revision'],'entry':row(r) if r else None}
  if not owner:raise Failure('OWNER_ONLY',403,'42501')
  if p.get('p_expected_revision')!=lib['revision']:raise Failure('STALE_REVISION',409,'40001')
  if name=='save_entry':
   v=p['p_entry'];validate(v)
   if p['p_is_new']:
    order=c.execute('SELECT coalesce(min("order"),1024)-1024 FROM entries').fetchone()[0]
    c.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)',(v['id'],v['title'].strip(),v['category'].strip(),v['body'],json.dumps(v.get('tags',[])),now(),now(),order,json.dumps(v.get('extra',{}))))
   else:
    updated=c.execute('UPDATE entries SET title=?,category=?,body=?,tags=?,extra=?,updated_at=? WHERE id=?',(v['title'].strip(),v['category'].strip(),v['body'],json.dumps(v.get('tags',[])),json.dumps(v.get('extra',{})),now(),v['id'])).rowcount
    if not updated:raise Failure('ENTRY_NOT_FOUND')
  elif name=='delete_entry':
   if not c.execute('DELETE FROM entries WHERE id=?',(p['p_id'],)).rowcount:raise Failure('ENTRY_NOT_FOUND')
  elif name=='save_order':
   allrows=c.execute('SELECT id,"order",category FROM entries ORDER BY "order",id').fetchall()
   subset=[r for r in allrows if not p.get('p_category') or r['category']==p['p_category']]
   ids=p['p_ids']
   if len(ids)!=len(subset) or len(set(ids))!=len(ids) or set(ids)!={r['id'] for r in subset}:raise Failure('ORDER_SET_MISMATCH')
   for id,slot in zip(ids,subset):c.execute('UPDATE entries SET "order"=?,updated_at=? WHERE id=?',(slot['order'],now(),id))
  elif name=='rename_category':
   v=p['p_new'].strip()
   if not 1<=len(v)<=60:raise Failure('INVALID_CATEGORY')
   if not c.execute('UPDATE entries SET category=?,updated_at=? WHERE category=?',(v,now(),p['p_old'])).rowcount:raise Failure('CATEGORY_NOT_FOUND')
  elif name=='import_entries':
   values=p['p_entries']
   if not isinstance(values,list) or not 1<=len(values)<=500 or len(json.dumps(values).encode())>5242880:raise Failure('IMPORT_LIMIT')
   order=c.execute('SELECT coalesce(max("order"),0) FROM entries').fetchone()[0]
   for v in values:
    validate(v)
    if c.execute('SELECT 1 FROM entries WHERE id=?',(v['id'],)).fetchone():raise Failure('DUPLICATE_ID',409,'23505')
    order+=1024
    c.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)',(v['id'],v['title'],v['category'],v['body'],json.dumps(v.get('tags',[])),v.get('created_at',now()),now(),order,json.dumps(v.get('extra',{}))))
  else:raise Failure('UNKNOWN_RPC',404)
  c.execute('UPDATE state SET revision=revision+1')
  return {'revision':lib['revision']+1}

class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'site'),**kwargs)
 def log_message(self,fmt,*args):print(fmt%args,flush=True)
 def respond(self,status,value):
  content=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
 def do_GET(self):
  if self.path=='/config.js':
   content=f'export const CONFIG = {{supabaseUrl: location.origin,publishableKey:"sb_publishable_TEST_DOUBLE_ONLY",testOnly:true}};'.encode()
   self.send_response(200);self.send_header('Content-Type','text/javascript');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(content)
  elif self.path=='/health':self.respond(200,{'mode':'LOCAL CONTRACT DOUBLE; NOT SUPABASE','storage':'server-side SQLite'})
  else:super().do_GET()
 def do_POST(self):
  try:
   length=int(self.headers.get('Content-Length',0))
   if length>6*1024*1024:raise Failure('BODY_LIMIT',413)
   p=json.loads(self.rfile.read(length) or '{}');path=urlparse(self.path)
   if path.path=='/test/reset':seed();return self.respond(200,{'reset':True})
   if path.path=='/auth/v1/token':
    if 'refresh_token' in path.query:
     if p.get('refresh_token') not in TOKENS:raise Failure('Invalid refresh token',401)
     account=TOKENS[p['refresh_token']]
    else:
     if p.get('password')!=PASSWORD or p.get('email') not in ('owner@example.test','other@example.test'):raise Failure('Invalid login credentials',400)
     account=p['email']
    access=str(uuid.uuid4());refresh=str(uuid.uuid4());TOKENS[access]=account;TOKENS[refresh]=account
    return self.respond(200,{'access_token':access,'refresh_token':refresh,'expires_in':3600,'token_type':'bearer','user':{'id':account}})
   token=self.headers.get('Authorization','').removeprefix('Bearer ');owner=TOKENS.get(token)=='owner@example.test'
   if path.path=='/auth/v1/logout':TOKENS.pop(token,None);return self.respond(200,{})
   if path.path.startswith('/rest/v1/rpc/'):return self.respond(200,dispatch(path.path.rsplit('/',1)[-1],p,owner))
   raise Failure('Direct table writes denied',403,'42501')
  except Failure as e:self.respond(e.status,{'message':e.msg,'code':e.code})
  except sqlite3.IntegrityError:self.respond(409,{'message':'DUPLICATE_ID','code':'23505'})
  except Exception as e:self.respond(400,{'message':str(e),'code':'TEST_DOUBLE_ERROR'})
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765);parser.add_argument('--reset',action='store_true');args=parser.parse_args()
 if args.reset or not DB.exists():seed()
 print(f'LOCAL TEST DOUBLE ONLY: http://127.0.0.1:{args.port}',flush=True)
 ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
