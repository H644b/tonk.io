-- Return a conflict immediately instead of a serialization failure that API gateways may retry.
CREATE OR REPLACE FUNCTION public.bonk_apply_changes(expected_revision bigint, changes jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE current_revision bigint; item jsonb;
BEGIN
  IF jsonb_typeof(changes) <> 'array' OR jsonb_array_length(changes) > 20000 THEN
    RAISE EXCEPTION 'Invalid change batch';
  END IF;
  SELECT revision INTO current_revision FROM public.bonk_state WHERE id = 'main' FOR UPDATE;
  IF current_revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Concurrent writer or stale revision' USING ERRCODE = 'PT409';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(changes) LOOP
    IF item->>'kind' IS NULL OR item->>'row_key' IS NULL THEN RAISE EXCEPTION 'Invalid record'; END IF;
    IF item->'payload' IS NULL OR item->'payload' = 'null'::jsonb THEN
      DELETE FROM public.bonk_records WHERE kind = item->>'kind' AND row_key = item->>'row_key';
    ELSE
      INSERT INTO public.bonk_records(kind,row_key,payload) VALUES(item->>'kind',item->>'row_key',item->'payload')
      ON CONFLICT(kind,row_key) DO UPDATE SET payload = excluded.payload;
    END IF;
  END LOOP;
  UPDATE public.bonk_state SET revision=revision+1,updated_at=now() WHERE id='main' RETURNING revision INTO current_revision;
  RETURN current_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.bonk_apply_changes(bigint,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bonk_apply_changes(bigint,jsonb) TO service_role;
