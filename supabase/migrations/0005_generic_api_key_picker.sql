create or replace function public.pick_api_key(
  p_category text,
  p_provider text
)
returns table (
  key_id uuid,
  provider text,
  api_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  picked record;
begin
  if nullif(btrim(p_category), '') is null or nullif(btrim(p_provider), '') is null then
    return;
  end if;

  update key_manager.api_keys k
  set is_available = true, last_reset_at = clock_timestamp()
  where not k.is_available
    and not k.suspended
    and (
      (k.reset_frequency = 'hourly' and k.last_reset_at <= clock_timestamp() - interval '1 hour')
      or (k.reset_frequency = 'daily' and k.last_reset_at <= clock_timestamp() - interval '1 day')
      or (k.reset_frequency = 'weekly' and k.last_reset_at <= clock_timestamp() - interval '7 days')
      or (k.reset_frequency = 'monthly' and k.last_reset_at <= clock_timestamp() - interval '1 month')
    );

  select k.id, k.provider, k.key
  into picked
  from key_manager.api_keys k
  where k.category = p_category
    and k.provider = p_provider
    and k.is_available
    and not k.suspended
  order by k.last_used_at nulls first, k.created_at
  for update skip locked
  limit 1;

  if picked.id is null then
    return;
  end if;

  update key_manager.api_keys k
  set last_used_at = clock_timestamp()
  where k.id = picked.id;

  return query select picked.id, picked.provider, picked.key;
end;
$$;

revoke all on function public.pick_api_key(text, text) from public, anon, authenticated;
grant execute on function public.pick_api_key(text, text) to service_role;
