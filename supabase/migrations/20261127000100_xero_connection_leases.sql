-- Xero OAuth/configuration only: no accounting triggers, sync or customer communication.
-- All connection state is encrypted in integration_secrets. A database lease serialises
-- token rotation AND disconnect/reconnect/config changes across processes/deployments.
create table private.xero_connection_leases (
  company_id uuid primary key references public.companies(id) on delete cascade,
  lease uuid not null,
  expires_at timestamptz not null
);
revoke all on private.xero_connection_leases from public, anon, authenticated;

create function public.xero_acquire_lease(p_company uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_lease uuid;
begin
  insert into private.xero_connection_leases(company_id, lease, expires_at)
  values (p_company, gen_random_uuid(), clock_timestamp() + interval '120 seconds')
  on conflict (company_id) do update
    set lease = excluded.lease, expires_at = excluded.expires_at
    where private.xero_connection_leases.expires_at < clock_timestamp()
  returning lease into v_lease;
  return v_lease;
end $$;

-- Verify the fencing token while holding the lease row lock. An expired worker cannot
-- overwrite a newer refresh token, resurrect a disconnected connection or change its tenant.
create function public.xero_save_connection(
  p_company uuid, p_lease uuid, p_ciphertext text, p_expires timestamptz, p_connected boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.xero_connection_leases
    where company_id = p_company and lease = p_lease and expires_at > clock_timestamp()
    for update;
  if not found then raise exception 'Xero connection lease expired' using errcode = '40001'; end if;
  insert into public.integrations(company_id, provider, status)
    values (p_company, 'xero', case when p_connected then 'connected' else 'disconnected' end)
    on conflict (company_id, provider) do update set status = excluded.status,
      account_label = null, external_account_id = null, last_error = null;
  insert into public.integration_secrets(company_id, provider, ciphertext, expires_at)
    values (p_company, 'xero', p_ciphertext, p_expires)
    on conflict (company_id, provider) do update set ciphertext = excluded.ciphertext,
      expires_at = excluded.expires_at, updated_at = clock_timestamp();
end $$;

create function public.xero_release_lease(p_company uuid, p_lease uuid) returns void
language sql security definer set search_path = '' as $$
  delete from private.xero_connection_leases where company_id = p_company and lease = p_lease;
$$;

revoke all on function public.xero_acquire_lease(uuid) from public, anon, authenticated;
revoke all on function public.xero_save_connection(uuid, uuid, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.xero_release_lease(uuid, uuid) from public, anon, authenticated;
grant execute on function public.xero_acquire_lease(uuid) to service_role;
grant execute on function public.xero_save_connection(uuid, uuid, text, timestamptz, boolean) to service_role;
grant execute on function public.xero_release_lease(uuid, uuid) to service_role;
