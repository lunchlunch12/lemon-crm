-- Fictional-only, rolled back. Actual RPC permissions, atomic matching and no import sends.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values('ec000000-0000-4000-8000-000000000001','owner@contact-fixture.test');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ec000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select public.create_company('Fictional contact sync','general') as co \gset
reset role;
select public.xero_acquire_lease(:'co') as lease \gset
select set_config('test.xero_company',:'co',true);
select set_config('test.xero_lease',:'lease',true);

do $$ declare c uuid:=current_setting('test.xero_company')::uuid; l uuid:=current_setting('test.xero_lease')::uuid;
  local_id uuid:='ec000000-0000-4000-8000-000000000010'; remote_id uuid:='ec000000-0000-4000-8000-000000000011'; tenant uuid:='ec000000-0000-4000-8000-000000000012';
  snapshot jsonb; next_snapshot jsonb; p jsonb:='{"display_name":"Fictional Import","company_name":null,"email":"import@example.test","phone":null,"billing_address":{},"payment_terms_days":30,"status":"active","people":[{"name":"Fictional Person","email":"person@example.test"}]}';
  before_activity bigint;
begin
  if has_function_privilege('authenticated','public.xero_sync_apply_contact(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,uuid,text,uuid[])','execute')
    or has_function_privilege('anon','public.xero_sync_read(uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.xero_ai_blocked(uuid)','execute')
    or has_function_privilege('authenticated','public.xero_sync_get_history(uuid,uuid)','execute')
  then raise exception 'Xero contact RPC must remain service-only'; end if;
  if has_table_privilege('authenticated','private.xero_contact_links','select') or has_table_privilege('authenticated','private.xero_import_privacy','delete')
  then raise exception 'Private Xero state exposed'; end if;
  if public.xero_ai_blocked(c) then raise exception 'Unrelated company AI unexpectedly blocked'; end if;
  select count(*) into before_activity from public.activity where company_id=c;
  snapshot:=public.xero_sync_apply_contact(c,l,tenant,local_id,remote_id,null,p,'fictional encrypted comparison','ec000000-0000-4000-8000-000000000020','xero');
  if snapshot->>'display_name'<>'Fictional Import' then raise exception 'Import snapshot missing'; end if;
  if (select count(*) from public.clients where company_id=c and id=local_id)<>1 then raise exception 'Import missing or duplicated'; end if;
  if (select count(*) from public.activity where company_id=c)<>before_activity then raise exception 'Import emitted automation activity'; end if;
  if exists(select 1 from public.automation_runs where company_id=c) then raise exception 'Import queued customer automation'; end if;
  if exists(select 1 from public.outbox where company_id=c) then raise exception 'Import queued outbox work'; end if;
  if exists(select 1 from public.client_contacts where company_id=c and client_id=local_id and (notify_email or notify_sms)) then raise exception 'Imported person opted into messages'; end if;
  if not exists(select 1 from public.clients where company_id=c and id=local_id and marketing_opt_out and review_opt_out) then raise exception 'Import granted marketing/review consent'; end if;
  if not public.xero_ai_blocked(c) then raise exception 'Imported data lacks sticky AI protection'; end if;
  perform set_config('request.jwt.claims','{"sub":"ec000000-0000-4000-8000-000000000001","role":"authenticated","client_id":"fictional_assistant"}',true);
  if private.assistant_switch()->>'state'<>'off' or public.assistant_switch()->>'state'<>'off' then raise exception 'Assistant bypassed imported-data protection'; end if;
  update public.companies set settings=settings||'{"assistants":{"enabled":true}}'::jsonb where id=c;
  if private.assistant_switch()->>'state'<>'off' then raise exception 'Ordinary settings cleared Xero privacy gate'; end if;
  perform set_config('request.jwt.claims','{"sub":"ec000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
  if private.assistant_switch()->>'state'<>'on' then raise exception 'Human owner was blocked'; end if;
  next_snapshot:=public.xero_sync_apply_contact(c,l,tenant,local_id,remote_id,snapshot,p,'fictional second encrypted comparison','ec000000-0000-4000-8000-000000000021','xero');
  if (select count(*) from private.xero_contact_links where company_id=c and tenant_id=tenant)<>1 then raise exception 'Mapping duplicated'; end if;
  if (select count(*) from public.client_contacts where company_id=c and client_id=local_id)<>1 then raise exception 'Contact person duplicated'; end if;
  begin
    perform public.xero_sync_apply_contact(c,l,tenant,'ec000000-0000-4000-8000-000000000090','ec000000-0000-4000-8000-000000000091',null,p,'fictional comparison',gen_random_uuid(),'xero');
    raise exception 'A new local identity bypassed existing customer matching';
  exception when serialization_failure then null; end;
  begin
    perform public.xero_sync_apply_contact(c,l,tenant,'ec000000-0000-4000-8000-000000000099',remote_id,null,p,'fictional comparison',gen_random_uuid(),'xero');
    raise exception 'Same remote identity mapped twice';
  exception when unique_violation then null; end;
  update public.clients set phone='fictional changed phone' where company_id=c and id=local_id;
  begin
    perform public.xero_sync_apply_contact(c,l,tenant,local_id,remote_id,next_snapshot,p,'fictional comparison',gen_random_uuid(),'xero');
    raise exception 'Stale preview overwrote a customer';
  exception when serialization_failure then null; end;
  -- Existing quiet import semantics and normal event creation must both survive this migration.
  perform set_config('crewtavo.quiet','off',true);
  insert into public.clients(company_id,display_name) values(c,'Fictional ordinary customer');
  if not exists(select 1 from public.activity where company_id=c and verb='client.created') then raise exception 'Ordinary customer activity was broken'; end if;
  update private.xero_connection_leases set expires_at=clock_timestamp()-interval '1 second' where company_id=c;
  begin
    perform public.xero_sync_read(c,l,tenant);
    raise exception 'Expired worker read/apply allowed';
  exception when serialization_failure then null; end;
end $$;
rollback;
