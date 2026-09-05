-- Manual PostgreSQL/RLS smoke check, for Supabase SQL Editor as postgres.
-- Prerequisites: schema.sql + owner.sql succeeded. No browser token is needed.
-- All test mutations are rolled back. Run the WHOLE script, not fragments.
-- This file was PROVIDED, NOT executed against hosted Supabase during delivery.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.owner) THEN RAISE EXCEPTION 'Register owner.sql first'; END IF;
END $$;
SELECT set_config('test.owner_uid',(SELECT user_id::text FROM private.owner WHERE singleton),true);

-- 1. Anonymous users may read but cannot call mutations or directly insert.
SET LOCAL ROLE anon;
SELECT public.library_info() AS anonymous_can_read;
DO $$ BEGIN
 BEGIN
  PERFORM public.save_entry('{}'::jsonb,0,true);
  RAISE EXCEPTION 'FAIL: anon could execute mutation';
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anonymous RPC denied'; END;
 BEGIN
  INSERT INTO public.entries(title,category,body,"order") VALUES('security test','test','test',0);
  RAISE EXCEPTION 'FAIL: anon could write table';
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anonymous direct insert denied'; END;
END $$;
RESET ROLE;

-- 2. Authenticated but unrelated UID: even a direct RPC call must be denied.
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 IF public.is_owner() THEN RAISE EXCEPTION 'FAIL: test non-owner matches owner'; END IF;
 BEGIN
  PERFORM public.save_entry('{}'::jsonb,0,true);
  RAISE EXCEPTION 'FAIL: non-owner could write';
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: non-owner RPC denied'; END;
END $$;
RESET ROLE;

-- 3. Owner can create and delete through guarded RPCs; stale revision is denied.
SELECT set_config('request.jwt.claim.sub',current_setting('test.owner_uid'),true);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.owner_uid'),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_id uuid:=gen_random_uuid(); rev bigint; payload jsonb; result jsonb;
BEGIN
 IF NOT public.is_owner() THEN RAISE EXCEPTION 'FAIL: owner check'; END IF;
 rev:=(public.library_info()->>'revision')::bigint;
 payload:=jsonb_build_object('id',v_id,'title','ROLLBACK security smoke','category','test','body','temporary test','tags','[]'::jsonb);
 result:=public.save_entry(payload,rev,true);
 IF (public.get_entry(v_id)->'entry')='null'::jsonb THEN RAISE EXCEPTION 'FAIL: owner save not visible'; END IF;
 RAISE NOTICE 'PASS: owner save/read';
 BEGIN
  PERFORM public.save_entry(payload,rev,false);
  RAISE EXCEPTION 'FAIL: stale revision accepted';
 EXCEPTION WHEN serialization_failure THEN RAISE NOTICE 'PASS: stale revision rejected'; END;
 rev:=(public.library_info()->>'revision')::bigint;
 PERFORM public.delete_entry(v_id,rev);
 RAISE NOTICE 'PASS: owner delete';
 BEGIN
  UPDATE public.entries SET title=title WHERE false;
  RAISE EXCEPTION 'FAIL: owner bypassed RPC through direct update';
 EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: direct table update denied'; END;
END $$;
RESET ROLE;
ROLLBACK;
-- If anything fails, run ROLLBACK; fix setup before enabling public use.
