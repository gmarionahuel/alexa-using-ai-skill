drop function if exists public.pick_llm_route(text);
drop function if exists public.report_llm_key_result(uuid, boolean, integer, integer);
drop table if exists key_manager.api_keys;

create table key_manager.api_keys (
  id uuid not null default gen_random_uuid(),
  provider text not null,
  category text not null,
  key text not null,
  is_available boolean not null default true,
  reset_frequency text not null default 'daily'
    check (reset_frequency in ('hourly', 'daily', 'weekly', 'monthly', 'never')),
  reset_hour integer not null default 0 check (reset_hour between 0 and 23),
  reset_day integer check (reset_day is null or reset_day between 1 and 28),
  last_reset_at timestamptz not null default now(),
  last_used_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  suspended boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  constraint api_keys_pkey primary key (id),
  constraint api_keys_key_key unique (key),
  constraint api_keys_provider_key_key unique (provider, key)
);

create index api_keys_pick_idx
  on key_manager.api_keys (category, provider, is_available, suspended, last_used_at);

alter table key_manager.api_keys enable row level security;
revoke all on table key_manager.api_keys from public, anon, authenticated;
grant all on table key_manager.api_keys to service_role;

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
    is_available = true,
    last_reset_at = clock_timestamp()
  where not k.is_available
    and not k.suspended
    and (
      (k.reset_frequency = 'hourly' and k.last_reset_at <= clock_timestamp() - interval '1 hour')
      or (k.reset_frequency = 'daily' and k.last_reset_at <= clock_timestamp() - interval '1 day')
      or (k.reset_frequency = 'weekly' and k.last_reset_at <= clock_timestamp() - interval '7 days')
      or (k.reset_frequency = 'monthly' and k.last_reset_at <= clock_timestamp() - interval '1 month')
    );

  select
    k.id as key_id,
    p.code as provider,
    m.model,
    p.base_url,
    k.key as api_key,
    p.default_timeout_ms as timeout_ms
  into picked
  from key_manager.api_keys k
  join key_manager.llm_providers p on p.code = k.provider
  join lateral (
    select lm.model
    from key_manager.llm_models lm
    where lm.provider_id = p.id
      and lm.is_active
      and lm.voice_suitable
    order by lm.priority, lm.model
    limit 1
  ) m on true
  where k.category = 'llm'
    and k.is_available
    and not k.suspended
    and p.is_active
    and (p_provider is null or p.code = p_provider)
  order by p.priority, k.last_used_at nulls first, k.created_at
  for update of k skip locked
  limit 1;

  if picked.key_id is null then
    return;
  end if;

  update key_manager.api_keys k
  set last_used_at = clock_timestamp()
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
    set is_available = true, last_used_at = clock_timestamp()
    where k.id = p_key_id;
    return;
  end if;

  update key_manager.api_keys k
  set
    is_available = case
      when p_http_status in (401, 402, 403, 429) then false
      else is_available
    end,
    suspended = case
      when p_http_status in (401, 403) then true
      else suspended
    end,
    last_used_at = clock_timestamp()
  where k.id = p_key_id;
end;
$$;

revoke all on function public.pick_llm_route(text) from public, anon, authenticated;
revoke all on function public.report_llm_key_result(uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.pick_llm_route(text) to service_role;
grant execute on function public.report_llm_key_result(uuid, boolean, integer, integer) to service_role;

comment on table key_manager.api_keys is
  'Provider API keys stored directly as requested; backend-only access.';
