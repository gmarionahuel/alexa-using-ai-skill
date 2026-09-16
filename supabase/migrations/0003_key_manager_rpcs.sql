create or replace function public.pick_llm_route(p_provider text default null)
returns table (
  key_id uuid,
  provider text,
  model text,
  base_url text,
  api_key text,
  timeout_ms integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  picked record;
begin
  update key_manager.api_keys k
  set
    status = 'active',
    cooldown_until = null,
    consecutive_failures = 0,
    last_reset_at = clock_timestamp()
  where k.status in ('cooldown', 'exhausted')
    and (
      (k.cooldown_until is not null and k.cooldown_until <= clock_timestamp())
      or (k.reset_frequency = 'hourly' and k.last_reset_at <= clock_timestamp() - interval '1 hour')
      or (k.reset_frequency = 'daily' and k.last_reset_at <= clock_timestamp() - interval '1 day')
      or (k.reset_frequency = 'weekly' and k.last_reset_at <= clock_timestamp() - interval '7 days')
      or (k.reset_frequency = 'monthly' and k.last_reset_at <= clock_timestamp() - interval '1 month')
    );

  select
    k.id as key_id,
    p.code as provider,
    m.model,
    p.base_url,
    s.decrypted_secret as api_key,
    p.default_timeout_ms as timeout_ms
  into picked
  from key_manager.api_keys k
  join key_manager.llm_providers p on p.id = k.provider_id
  join lateral (
    select lm.model
    from key_manager.llm_models lm
    where lm.provider_id = p.id
      and lm.is_active
      and lm.voice_suitable
    order by lm.priority, lm.model
    limit 1
  ) m on true
  join vault.decrypted_secrets s on s.id = k.vault_secret_id
  where k.category = 'llm'
    and k.status = 'active'
    and p.is_active
    and (k.cooldown_until is null or k.cooldown_until <= clock_timestamp())
    and (p_provider is null or p.code = p_provider)
  order by p.priority, k.priority, k.last_used_at nulls first, k.request_count
  for update of k skip locked
  limit 1;

  if picked.key_id is null then
    return;
  end if;

  update key_manager.api_keys k
  set last_used_at = clock_timestamp(), request_count = request_count + 1
  where k.id = picked.key_id;

  return query select
    picked.key_id,
    picked.provider,
    picked.model,
    picked.base_url,
    picked.api_key,
    picked.timeout_ms;
end;
$$;

create or replace function public.report_llm_key_result(
  p_key_id uuid,
  p_succeeded boolean,
  p_http_status integer default null,
  p_cooldown_seconds integer default 60
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_succeeded then
    update key_manager.api_keys k
    set
      status = 'active',
      last_success_at = clock_timestamp(),
      consecutive_failures = 0,
      cooldown_until = null
    where k.id = p_key_id;
    return;
  end if;

  update key_manager.api_keys k
  set
    last_failure_at = clock_timestamp(),
    consecutive_failures = consecutive_failures + 1,
    status = case
      when p_http_status in (401, 403) then 'invalid'::public.llm_key_status
      when p_http_status in (402, 429) then 'cooldown'::public.llm_key_status
      else status
    end,
    cooldown_until = case
      when p_http_status in (402, 429)
        then clock_timestamp() + make_interval(secs => greatest(10, least(p_cooldown_seconds, 86400)))
      else cooldown_until
    end
  where k.id = p_key_id;
end;
$$;

revoke all on function public.pick_llm_route(text) from public, anon, authenticated;
revoke all on function public.report_llm_key_result(uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.pick_llm_route(text) to service_role;
grant execute on function public.report_llm_key_result(uuid, boolean, integer, integer) to service_role;
