-- New Xero connection lease: fencing, atomic secret save and service-only permissions.
-- Fictional fixture only; run with scripts/test-db.sh against a disposable database.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values ('ed000000-0000-4000-8000-000000000001', 'owner@xero-fixture.test');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ed000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.create_company('Fictional Xero Test', 'general') as co \gset
reset role;

select public.xero_acquire_lease(:'co') as lease \gset
select public.xero_save_connection(:'co', :'lease', 'fictional_ciphertext_1', null, false);

-- Access checks also catch accidental EXECUTE grants via PUBLIC.
do $$ begin
  if has_function_privilege('authenticated', 'public.xero_acquire_lease(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.xero_acquire_lease(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.xero_save_connection(uuid,uuid,text,timestamptz,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.xero_release_lease(uuid,uuid)', 'EXECUTE')
  then raise exception 'Xero RPCs must be service-only'; end if;
  if not has_function_privilege('service_role', 'public.xero_acquire_lease(uuid)', 'EXECUTE')
  then raise exception 'Service role cannot obtain a lease'; end if;
end $$;

select set_config('test.xero_company', :'co', true);
select set_config('test.xero_lease', :'lease', true);
do $$ declare c uuid := current_setting('test.xero_company')::uuid; old_lease uuid := current_setting('test.xero_lease')::uuid; fresh uuid;
begin
  if public.xero_acquire_lease(c) is not null then raise exception 'Concurrent lease was granted'; end if;
  -- Expire the first worker and acquire a new fencing token.
  update private.xero_connection_leases set expires_at = clock_timestamp() - interval '1 second' where company_id = c;
  fresh := public.xero_acquire_lease(c);
  if fresh is null or fresh = old_lease then raise exception 'Expired lease was not replaced'; end if;
  begin
    perform public.xero_save_connection(c, old_lease, 'stale_ciphertext', null, true);
    raise exception 'Stale worker was allowed to save';
  exception when serialization_failure then null;
  end;
  perform public.xero_release_lease(c, old_lease);
  if not exists (select 1 from private.xero_connection_leases where company_id = c and lease = fresh)
  then raise exception 'Stale worker released a newer lease'; end if;
  perform public.xero_save_connection(c, fresh, 'fictional_ciphertext_2', null, true);
  if (select ciphertext from public.integration_secrets where company_id = c and provider = 'xero') <> 'fictional_ciphertext_2'
    or (select status from public.integrations where company_id = c and provider = 'xero') <> 'connected'
  then raise exception 'Connection and secret did not save together'; end if;
  if exists (select 1 from public.integrations where company_id = c and provider = 'xero' and external_account_id is not null)
  then raise exception 'Tenant identifiers must stay inside encrypted state'; end if;
  perform public.xero_release_lease(c, fresh);
end $$;
rollback;
