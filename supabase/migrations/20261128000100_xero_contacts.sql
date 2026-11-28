-- Demo-only customer synchronisation. No invoice/payment writes or background/sending triggers.
create table private.xero_contact_links (
  company_id uuid not null references public.companies(id) on delete cascade,
  tenant_id uuid not null,
  local_id uuid not null,
  remote_id uuid not null,
  baseline text not null,
  last_operation uuid not null,
  origin text not null check(origin in ('crm','xero','matched')),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(company_id,tenant_id,local_id),
  unique(company_id,tenant_id,remote_id),
  foreign key(company_id,local_id) references public.clients(company_id,id) on delete restrict
);
create table private.xero_sync_history (
  company_id uuid not null references public.companies(id) on delete cascade,
  tenant_id uuid not null,
  operation_id uuid not null,
  direction text not null check(direction in ('incoming','outgoing','match','settings')),
  outcome text not null check(outcome in ('applied','unchanged','failed','uncertain','conflict','reconciled')),
  code text not null check(code ~ '^[a-z_]{1,60}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(company_id,operation_id)
);
create table private.xero_import_privacy (
  company_id uuid primary key references public.companies(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on private.xero_contact_links, private.xero_sync_history, private.xero_import_privacy from public,anon,authenticated;

-- Serialize new customer identity checks with ordinary inserts, without a unique-email rule
-- (different people may legitimately share an email). No existing customer is auto-merged.
create function private.xero_customer_insert_lock() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform pg_advisory_xact_lock(hashtextextended('xero-customer:'||new.company_id::text,0)); return new; end $$;
revoke all on function private.xero_customer_insert_lock() from public,anon,authenticated;
create trigger xero_customer_insert_lock before insert on public.clients for each row execute function private.xero_customer_insert_lock();

create function private.xero_assert_lease(p_company uuid,p_lease uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from private.xero_connection_leases where company_id=p_company and lease=p_lease and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Xero operation expired' using errcode='40001'; end if;
end $$;
revoke all on function private.xero_assert_lease(uuid,uuid) from public,anon,authenticated;

create function private.xero_client_snapshot(p_company uuid,p_client uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'updated_at',c.updated_at,'display_name',c.display_name,'company_name',c.company_name,
    'email',c.email,'phone',c.phone,'billing_address',c.billing_address,'payment_terms_days',c.payment_terms_days,'status',c.status,
    'people',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,'phone',p.phone,'role',p.role,
      'updated_at',p.updated_at,'notify_email',p.notify_email,'notify_sms',p.notify_sms,'is_primary',p.is_primary) order by p.id)
      from public.client_contacts p where p.company_id=p_company and p.client_id=c.id),'[]'::jsonb))
  from public.clients c where c.company_id=p_company and c.id=p_client
$$;
revoke all on function private.xero_client_snapshot(uuid,uuid) from public,anon,authenticated;

create function public.xero_sync_read(p_company uuid,p_lease uuid,p_tenant uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform private.xero_assert_lease(p_company,p_lease);
  if (select count(*) from public.clients where company_id=p_company)>2000 then
    raise exception 'Customer preview limit exceeded' using errcode='22023';
  end if;
  return jsonb_build_object(
    'clients',coalesce((select jsonb_agg(private.xero_client_snapshot(p_company,c.id) order by c.id) from public.clients c where c.company_id=p_company),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(to_jsonb(l)) from private.xero_contact_links l where l.company_id=p_company and l.tenant_id=p_tenant),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(to_jsonb(h)) from (select operation_id,direction,outcome,code,created_at from private.xero_sync_history where company_id=p_company and tenant_id=p_tenant order by created_at desc limit 100) h),'[]'::jsonb)
  );
end $$;

create function public.xero_sync_history(p_company uuid,p_lease uuid,p_operation uuid,p_direction text,p_outcome text,p_code text,p_tenant uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.xero_assert_lease(p_company,p_lease);
  insert into private.xero_sync_history(company_id,tenant_id,operation_id,direction,outcome,code) values(p_company,p_tenant,p_operation,p_direction,p_outcome,p_code)
    on conflict(company_id,operation_id) do update set outcome=excluded.outcome,code=excluded.code,created_at=clock_timestamp();
end $$;

-- Every imported change runs in one transaction, checks the preview snapshot, saves the
-- one-to-one mapping and suppresses inherited activity->automation work before touching clients.
create function public.xero_sync_apply_contact(p_company uuid,p_lease uuid,p_tenant uuid,p_local uuid,p_remote uuid,
  p_expected jsonb,p_contact jsonb,p_baseline text,p_operation uuid,p_origin text,p_reviewed uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_current jsonb; v_person jsonb; v_id uuid; v_count integer;
begin
  perform private.xero_assert_lease(p_company,p_lease);
  if p_contact is not null then perform pg_advisory_xact_lock(hashtextextended('xero-customer:'||p_company::text,0)); end if;
  perform 1 from public.clients where company_id=p_company and id=p_local for update;
  perform 1 from public.client_contacts where company_id=p_company and client_id=p_local order by id for update;
  v_current:=private.xero_client_snapshot(p_company,p_local);
  if v_current is distinct from p_expected then raise exception 'Customer changed since preview' using errcode='40001'; end if;
  if exists(select 1 from private.xero_contact_links where company_id=p_company and tenant_id=p_tenant
    and ((local_id=p_local and remote_id<>p_remote) or (remote_id=p_remote and local_id<>p_local))) then
    raise exception 'Customer is already mapped' using errcode='23505';
  end if;
  if p_contact is not null then
    -- Sticky, private gate: an owner changing ordinary settings cannot re-enable AI over imports.
    insert into private.xero_import_privacy(company_id) values(p_company) on conflict do nothing;
    perform set_config('crewtavo.xero_import','on',true);
    perform set_config('crewtavo.quiet','on',true);
    if v_current is null then
      if exists(select 1 from public.clients c where c.company_id=p_company and not(c.id=any(p_reviewed)) and (
        (nullif(lower(trim(p_contact->>'email')),'') is not null and lower(trim(c.email))=lower(trim(p_contact->>'email')))
        or (nullif(regexp_replace(p_contact->>'phone','\D','','g'),'') is not null and regexp_replace(c.phone,'\D','','g')=regexp_replace(p_contact->>'phone','\D','','g'))
        or lower(regexp_replace(trim(c.display_name),'\s+',' ','g'))=lower(regexp_replace(trim(p_contact->>'display_name'),'\s+',' ','g'))
        or (nullif(lower(trim(p_contact->>'company_name')),'') is not null and lower(trim(c.company_name))=lower(trim(p_contact->>'company_name')))
      )) then raise exception 'A possible existing customer appeared after preview' using errcode='40001'; end if;
      insert into public.clients(id,company_id,status,display_name,company_name,email,phone,billing_address,payment_terms_days,marketing_opt_out,review_opt_out)
      values(p_local,p_company,p_contact->>'status',p_contact->>'display_name',p_contact->>'company_name',p_contact->>'email',p_contact->>'phone',
        p_contact->'billing_address',(p_contact->>'payment_terms_days')::integer,true,true);
    else
      update public.clients set status=p_contact->>'status',display_name=p_contact->>'display_name',company_name=p_contact->>'company_name',
        email=p_contact->>'email',phone=p_contact->>'phone',billing_address=p_contact->'billing_address',payment_terms_days=(p_contact->>'payment_terms_days')::integer
        where company_id=p_company and id=p_local;
    end if;
    for v_person in select value from jsonb_array_elements(p_contact->'people') loop
      select count(*),(array_agg(id))[1] into v_count,v_id from public.client_contacts where company_id=p_company and client_id=p_local
        and ((nullif(lower(trim(email)),'') is not null and lower(trim(email))=lower(trim(v_person->>'email'))) or lower(trim(name))=lower(trim(v_person->>'name')));
      if v_count>1 then raise exception 'Ambiguous contact person' using errcode='40001'; end if;
      if v_count=1 then
        update public.client_contacts set name=v_person->>'name',email=v_person->>'email' where company_id=p_company and id=v_id;
      else
        insert into public.client_contacts(company_id,client_id,name,email,notify_email,notify_sms)
          values(p_company,p_local,v_person->>'name',v_person->>'email',false,false);
      end if;
    end loop;
  elsif v_current is null then raise exception 'Customer missing' using errcode='40001';
  end if;
  insert into private.xero_contact_links(company_id,tenant_id,local_id,remote_id,baseline,last_operation,origin)
    values(p_company,p_tenant,p_local,p_remote,p_baseline,p_operation,p_origin)
    on conflict(company_id,tenant_id,local_id) do update set baseline=excluded.baseline,last_operation=excluded.last_operation,updated_at=clock_timestamp();
  insert into private.xero_sync_history(company_id,tenant_id,operation_id,direction,outcome,code)
    values(p_company,p_tenant,p_operation,case when p_contact is not null then 'incoming' else 'outgoing' end,'applied','contact_saved')
    on conflict(company_id,operation_id) do update set outcome='applied',code='contact_saved';
  return private.xero_client_snapshot(p_company,p_local);
end $$;

create function public.xero_ai_blocked(p_company uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.xero_import_privacy where company_id=p_company)
$$;
-- Preserve the existing switch's function identity/dependencies, with a stricter sticky gate.
create or replace function private.assistant_switch() returns jsonb
language sql stable security definer set search_path='' as $$
  select case when private.assistant_client() is null then '{"state":"on"}'::jsonb else coalesce((
    select jsonb_build_object('state',s.state,'company',s.name,'company_id',s.id) from (
      select c.id,c.name,case
        when exists(select 1 from private.xero_import_privacy x where x.company_id=c.id) then 'off'
        when c.settings->'assistants'->'enabled'='false'::jsonb then 'off'
        when c.settings->'assistants'->'read_only'='true'::jsonb then 'read_only' end as state
      from public.memberships m join public.companies c on c.id=m.company_id
      where m.user_id=(select auth.uid()) and m.active and m.role<>'subcontractor'
    ) s where s.state is not null order by (s.state='off') desc,s.name,s.id limit 1
  ),'{"state":"on"}'::jsonb) end
$$;
revoke all on function private.assistant_switch() from public,anon;
grant execute on function private.assistant_switch() to authenticated,service_role;

create function public.xero_sync_get_history(p_company uuid,p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) from (
    select operation_id,direction,outcome,code,created_at from private.xero_sync_history
    where company_id=p_company and (p_tenant is null or tenant_id=p_tenant) order by created_at desc limit 100
  ) h
$$;
revoke all on function public.xero_sync_get_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.xero_sync_get_history(uuid,uuid) to service_role;

revoke all on function public.xero_sync_read(uuid,uuid,uuid),public.xero_sync_history(uuid,uuid,uuid,text,text,text,uuid),
  public.xero_sync_apply_contact(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,uuid,text,uuid[]),public.xero_ai_blocked(uuid) from public,anon,authenticated;
grant execute on function public.xero_sync_read(uuid,uuid,uuid),public.xero_sync_history(uuid,uuid,uuid,text,text,text,uuid),
  public.xero_sync_apply_contact(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,uuid,text,uuid[]),public.xero_ai_blocked(uuid) to service_role;
notify pgrst,'reload schema';
