-- Keep replay protection bounded and retain diagnostic logs for only 24 hours.

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.register_alexa_request(
  p_request_id text,
  p_request_timestamp timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.alexa_request_receipts
  where received_at < now() - interval '15 minutes';

  insert into public.alexa_request_receipts(request_id, request_timestamp)
  values (p_request_id, p_request_timestamp)
  on conflict do nothing;

  return found;
end;
$$;

revoke all on function public.register_alexa_request(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_alexa_request(text, timestamptz)
  to service_role;

-- Initial purge for installations that already accumulated records.
delete from public.alexa_request_receipts
where received_at < now() - interval '15 minutes';

delete from public.execution_logs
where created_at < now() - interval '1 day';

-- Reusing the job name makes this migration idempotent: pg_cron updates the
-- existing job instead of creating duplicates.
select cron.schedule(
  'alexa-observability-retention',
  '17 3 * * *',
  $job$
    delete from public.alexa_request_receipts
    where received_at < now() - interval '15 minutes';

    delete from public.execution_logs
    where created_at < now() - interval '1 day';

    delete from cron.job_run_details
    where end_time < now() - interval '7 days';
  $job$
);
