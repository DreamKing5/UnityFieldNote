-- Unity Field Notes v1. Run ONCE in a NEW Supabase project, as postgres.
-- Owner registration is a separate step: owner.sql.
-- Do not run against an unrelated/existing application database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE private.owner (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT
);
CREATE TABLE public.site_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 revision bigint NOT NULL DEFAULT 0
);
INSERT INTO public.site_state(singleton) VALUES(true);
CREATE TABLE public.entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 180),
 category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 60),
 body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 200000),
 tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 30),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 "order" bigint NOT NULL,
 extra jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object'),
 search_text text NOT NULL DEFAULT ''
);
CREATE INDEX entries_order_idx ON public.entries("order",id);
CREATE INDEX entries_category_order_idx ON public.entries(category,"order",id);
CREATE INDEX entries_search_idx ON public.entries USING gin(search_text extensions.gin_trgm_ops);

CREATE FUNCTION private.prepare_entry() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(NEW.tags) t WHERE t IS NULL OR char_length(btrim(t)) NOT BETWEEN 1 AND 60) THEN
  RAISE EXCEPTION 'INVALID_TAGS' USING ERRCODE='22023';
 END IF;
 NEW.title:=btrim(NEW.title); NEW.category:=btrim(NEW.category);
 NEW.search_text:=lower(NEW.title||' '||NEW.category||' '||NEW.body||' '||array_to_string(NEW.tags,' '));
 NEW.updated_at:=now();
 RETURN NEW;
END $$;
CREATE TRIGGER prepare_entry BEFORE INSERT OR UPDATE ON public.entries FOR EACH ROW EXECUTE FUNCTION private.prepare_entry();

CREATE FUNCTION public.is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM private.owner WHERE user_id=(SELECT auth.uid()));
$$;
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.owner ENABLE ROW LEVEL SECURITY;
CREATE POLICY entries_public_read ON public.entries FOR SELECT TO anon,authenticated USING(true);
CREATE POLICY state_public_read ON public.site_state FOR SELECT TO anon,authenticated USING(true);
-- Defense in depth: direct writes still have no table grants. Mutations go through RPCs.
CREATE POLICY entries_owner_insert ON public.entries FOR INSERT TO authenticated WITH CHECK((SELECT public.is_owner()));
CREATE POLICY entries_owner_update ON public.entries FOR UPDATE TO authenticated USING((SELECT public.is_owner())) WITH CHECK((SELECT public.is_owner()));
CREATE POLICY entries_owner_delete ON public.entries FOR DELETE TO authenticated USING((SELECT public.is_owner()));
REVOKE ALL ON TABLE public.entries, public.site_state FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.entries, public.site_state TO anon,authenticated;
REVOKE ALL ON TABLE private.owner FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.library_info() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'revision',(SELECT revision FROM public.site_state WHERE singleton),
  'total',(SELECT count(*) FROM public.entries),
  'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('name',category,'count',n) ORDER BY category) FROM (SELECT category,count(*) n FROM public.entries GROUP BY category)c),'[]'::jsonb)
 );
$$;

CREATE FUNCTION public.list_entries(
 p_category text DEFAULT NULL, p_query text DEFAULT '', p_after_order bigint DEFAULT NULL,
 p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 24, p_full boolean DEFAULT false
) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 WITH settings AS (
  SELECT greatest(1,least(coalesce(p_limit,24),200)) lim,
   '%'||replace(replace(replace(lower(btrim(coalesce(p_query,''))), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_')||'%' needle
 ),
 matched AS NOT MATERIALIZED (
  SELECT e.* FROM public.entries e,settings s
  WHERE (p_category IS NULL OR e.category=p_category)
  AND (btrim(coalesce(p_query,''))='' OR e.search_text LIKE s.needle ESCAPE E'\\')
 ),
 page_rows AS MATERIALIZED (
  SELECT m.* FROM matched m
  WHERE p_after_order IS NULL OR (m."order",m.id)>(p_after_order,p_after_id)
  ORDER BY m."order",m.id LIMIT (SELECT lim+1 FROM settings)
 ),
 visible AS MATERIALIZED (
  SELECT * FROM page_rows ORDER BY "order",id LIMIT (SELECT lim FROM settings)
 )
 SELECT jsonb_build_object(
  'revision',(SELECT revision FROM public.site_state WHERE singleton),
  'library',public.library_info(),
  'total',(SELECT count(*) FROM matched),
  'items',coalesce((SELECT jsonb_agg(
    CASE WHEN p_full THEN to_jsonb(v)-'search_text'
    ELSE jsonb_build_object('id',id,'title',title,'category',category,'summary',left(body,240),'tags',tags,'created_at',created_at,'order',"order") END
    ORDER BY "order",id) FROM visible v),'[]'::jsonb),
  'next_cursor',CASE WHEN (SELECT count(*) FROM page_rows)>(SELECT lim FROM settings)
    THEN (SELECT jsonb_build_object('order',"order",'id',id) FROM visible ORDER BY "order" DESC,id DESC LIMIT 1)
    ELSE NULL END
 );
$$;

CREATE FUNCTION public.get_entry(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('revision',(SELECT revision FROM public.site_state WHERE singleton),
  'entry',(SELECT to_jsonb(e)-'search_text' FROM public.entries e WHERE id=p_id));
$$;

-- Every mutation locks one revision row, then rechecks the expected revision.
-- This makes multi-row changes atomic and detects concurrent device edits.
CREATE FUNCTION private.assert_writer(p_expected_revision bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_revision bigint;
BEGIN
 IF NOT public.is_owner() THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE='42501'; END IF;
 SELECT revision INTO current_revision FROM public.site_state WHERE singleton FOR UPDATE;
 IF p_expected_revision IS NULL OR current_revision<>p_expected_revision THEN
  RAISE EXCEPTION 'STALE_REVISION' USING ERRCODE='40001';
 END IF;
END $$;
CREATE FUNCTION private.bump_revision() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE public.site_state SET revision=revision+1 WHERE singleton RETURNING revision;
$$;
CREATE FUNCTION private.validate_entry(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_ENTRY' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR char_length(btrim(p->>'title')) NOT BETWEEN 1 AND 180
 OR jsonb_typeof(p->'category') IS DISTINCT FROM 'string' OR char_length(btrim(p->>'category')) NOT BETWEEN 1 AND 60
 OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR char_length(btrim(p->>'body')) NOT BETWEEN 1 AND 200000
 THEN RAISE EXCEPTION 'INVALID_CONTENT' USING ERRCODE='22023'; END IF;
 IF p ? 'tags' THEN
  IF jsonb_typeof(p->'tags') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_TAGS' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p->'tags')>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'tags') t WHERE jsonb_typeof(t) IS DISTINCT FROM 'string' OR char_length(btrim(t#>>'{}')) NOT BETWEEN 1 AND 60) THEN RAISE EXCEPTION 'INVALID_TAGS' USING ERRCODE='22023'; END IF;
 END IF;
 IF p ? 'extra' AND jsonb_typeof(p->'extra') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_EXTRA' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION public.save_entry(p_entry jsonb,p_expected_revision bigint,p_is_new boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE entry_id uuid; new_order bigint;
BEGIN
 PERFORM private.assert_writer(p_expected_revision);
 PERFORM private.validate_entry(p_entry);
 entry_id:=(p_entry->>'id')::uuid;
 IF p_is_new THEN
  SELECT coalesce(min("order"),1024)-1024 INTO new_order FROM public.entries;
  INSERT INTO public.entries(id,title,category,body,tags,"order",extra)
   VALUES(entry_id,p_entry->>'title',p_entry->>'category',p_entry->>'body',ARRAY(SELECT jsonb_array_elements_text(coalesce(p_entry->'tags','[]'::jsonb))),new_order,coalesce(p_entry->'extra','{}'::jsonb));
 ELSE
  UPDATE public.entries SET title=p_entry->>'title',category=p_entry->>'category',body=p_entry->>'body',
   tags=ARRAY(SELECT jsonb_array_elements_text(coalesce(p_entry->'tags','[]'::jsonb))),extra=coalesce(p_entry->'extra','{}'::jsonb) WHERE id=entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN jsonb_build_object('id',entry_id,'revision',private.bump_revision());
END $$;
CREATE FUNCTION public.delete_entry(p_id uuid,p_expected_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.assert_writer(p_expected_revision);
 DELETE FROM public.entries WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('revision',private.bump_revision());
END $$;
CREATE FUNCTION public.save_order(p_ids uuid[],p_category text,p_expected_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE expected_count bigint;
BEGIN
 PERFORM private.assert_writer(p_expected_revision);
 SELECT count(*) INTO expected_count FROM public.entries WHERE p_category IS NULL OR category=p_category;
 IF p_ids IS NULL OR cardinality(p_ids)<>expected_count OR
 (SELECT count(DISTINCT x) FROM unnest(p_ids) x)<>expected_count OR
 EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.entries e WHERE e.id=x AND (p_category IS NULL OR e.category=p_category)))
 THEN RAISE EXCEPTION 'ORDER_SET_MISMATCH' USING ERRCODE='22023'; END IF;
 -- Reuse exactly the existing slots; unrelated categories do not move.
 WITH slots AS MATERIALIZED (
  SELECT "order",row_number() OVER(ORDER BY "order",id) AS n FROM public.entries WHERE p_category IS NULL OR category=p_category
 ), incoming AS (SELECT id,n FROM unnest(p_ids) WITH ORDINALITY AS t(id,n))
 UPDATE public.entries e SET "order"=s."order" FROM slots s JOIN incoming i ON i.n=s.n WHERE e.id=i.id;
 RETURN jsonb_build_object('revision',private.bump_revision());
END $$;
CREATE FUNCTION public.rename_category(p_old text,p_new text,p_expected_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.assert_writer(p_expected_revision);
 IF p_new IS NULL OR char_length(btrim(p_new)) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'INVALID_CATEGORY' USING ERRCODE='22023'; END IF;
 UPDATE public.entries SET category=btrim(p_new) WHERE category=p_old;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATEGORY_NOT_FOUND' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('revision',private.bump_revision());
END $$;
CREATE FUNCTION public.import_entries(p_entries jsonb,p_expected_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; next_order bigint; inserted integer:=0;
BEGIN
 PERFORM private.assert_writer(p_expected_revision);
 IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_IMPORT' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_entries) NOT BETWEEN 1 AND 500 OR octet_length(p_entries::text)>5242880 THEN RAISE EXCEPTION 'IMPORT_LIMIT' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max("order"),0) INTO next_order FROM public.entries;
 FOR item IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
  PERFORM private.validate_entry(item);
  IF EXISTS(SELECT 1 FROM public.entries WHERE id=(item->>'id')::uuid) THEN RAISE EXCEPTION 'DUPLICATE_ID' USING ERRCODE='23505'; END IF;
  next_order:=next_order+1024;
  INSERT INTO public.entries(id,title,category,body,tags,created_at,"order",extra)
   VALUES((item->>'id')::uuid,item->>'title',item->>'category',item->>'body',ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'tags','[]'::jsonb))),coalesce((item->>'created_at')::timestamptz,now()),next_order,coalesce(item->'extra','{}'::jsonb));
  inserted:=inserted+1;
 END LOOP;
 RETURN jsonb_build_object('count',inserted,'revision',private.bump_revision());
END $$;

-- PostgreSQL grants EXECUTE to PUBLIC by default: explicitly remove it.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.is_owner() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.library_info() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_entries(text,text,bigint,uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_entry(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_entry(jsonb,bigint,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.delete_entry(uuid,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_order(uuid[],text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.rename_category(text,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.import_entries(jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner(), public.library_info(), public.list_entries(text,text,bigint,uuid,integer,boolean), public.get_entry(uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_entry(jsonb,bigint,boolean), public.delete_entry(uuid,bigint), public.save_order(uuid[],text,bigint), public.rename_category(text,text,bigint), public.import_entries(jsonb,bigint) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
