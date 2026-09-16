create schema if not exists key_manager;
revoke all on schema key_manager from public, anon, authenticated;

create type public.reminder_status as enum ('pending', 'completed', 'cancelled');
create type public.llm_key_status as enum ('active', 'cooldown', 'exhausted', 'invalid', 'suspended');
create type public.execution_status as enum ('started', 'succeeded', 'failed', 'timed_out');

create table public.alexa_users (
  id uuid primary key default gen_random_uuid(),
  amazon_user_hash text not null unique,
  locale text not null default 'es-ES',
  timezone text not null default 'America/Argentina/Buenos_Aires',
  preferred_provider text,
  preferred_model text,
  memory_enabled boolean not null default true,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.alexa_users(id) on delete cascade,
  alexa_session_id text,
  status text not null default 'active' check (status in ('active', 'closed')),
  summary text,
  message_count integer not null default 0 check (message_count >= 0),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index conversations_user_activity_idx
  on public.conversations (user_id, last_activity_at desc);
create unique index conversations_session_idx
  on public.conversations (alexa_session_id)
  where alexa_session_id is not null;

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content text not null,
  provider text,
  model text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  tool_calls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.alexa_users(id) on delete cascade,
  title text,
  content text not null check (char_length(content) between 1 and 4000),
  tags text[] not null default '{}',
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_user_created_idx on public.notes (user_id, created_at desc);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.alexa_users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  description text,
  remind_at timestamptz not null,
  timezone text not null default 'America/Argentina/Buenos_Aires',
  status public.reminder_status not null default 'pending',
  source text not null default 'internal',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index reminders_due_idx
  on public.reminders (remind_at)
  where status = 'pending';
create index reminders_user_idx on public.reminders (user_id, created_at desc);

create table public.alexa_request_receipts (
  request_id text primary key,
  request_timestamp timestamptz not null,
  received_at timestamptz not null default now()
);

create index alexa_request_receipts_received_idx
  on public.alexa_request_receipts (received_at);

create table public.execution_logs (
  id bigint generated always as identity primary key,
  request_id text,
  user_id uuid references public.alexa_users(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  request_type text,
  provider text,
  model text,
  status public.execution_status not null default 'started',
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_code text,
  error_detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index execution_logs_created_idx on public.execution_logs (created_at desc);
create index execution_logs_request_idx on public.execution_logs (request_id);

create table key_manager.llm_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  base_url text not null,
  is_active boolean not null default true,
  priority smallint not null default 100,
  default_timeout_ms integer not null default 4000 check (default_timeout_ms between 250 and 7000),
  supports_tools boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table key_manager.llm_models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references key_manager.llm_providers(id) on delete cascade,
  model text not null,
  is_active boolean not null default true,
  priority smallint not null default 100,
  supports_tools boolean not null default true,
  max_output_tokens integer not null default 300 check (max_output_tokens between 32 and 4096),
  voice_suitable boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (provider_id, model)
);

create table key_manager.api_keys (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references key_manager.llm_providers(id) on delete cascade,
  vault_secret_id uuid not null unique,
  category text not null default 'llm',
  status public.llm_key_status not null default 'active',
  priority smallint not null default 100,
  weight smallint not null default 1 check (weight between 1 and 100),
  reset_frequency text not null default 'daily' check (reset_frequency in ('never', 'hourly', 'daily', 'weekly', 'monthly')),
  reset_hour smallint not null default 0 check (reset_hour between 0 and 23),
  reset_day smallint check (reset_day is null or reset_day between 1 and 28),
  cooldown_until timestamptz,
  last_reset_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  request_count bigint not null default 0 check (request_count >= 0),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index api_keys_pick_idx
  on key_manager.api_keys (provider_id, status, priority, last_used_at);

insert into key_manager.llm_providers
  (code, base_url, priority, default_timeout_ms, supports_tools)
values
  ('groq', 'https://api.groq.com/openai/v1/chat/completions', 10, 4000, true),
  ('cerebras', 'https://api.cerebras.ai/v1/chat/completions', 20, 4000, true),
  ('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 30, 4500, true);

insert into key_manager.llm_models (provider_id, model, priority, supports_tools, max_output_tokens)
select id, 'openai/gpt-oss-120b', 10, true, 220 from key_manager.llm_providers where code = 'groq'
union all
select id, 'gpt-oss-120b', 10, true, 300 from key_manager.llm_providers where code = 'cerebras'
union all
select id, 'gemini-2.5-flash', 10, true, 300 from key_manager.llm_providers where code = 'gemini';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger alexa_users_set_updated_at before update on public.alexa_users
for each row execute function public.set_updated_at();
create trigger notes_set_updated_at before update on public.notes
for each row execute function public.set_updated_at();
create trigger reminders_set_updated_at before update on public.reminders
for each row execute function public.set_updated_at();
create trigger llm_providers_set_updated_at before update on key_manager.llm_providers
for each row execute function public.set_updated_at();
create trigger api_keys_set_updated_at before update on key_manager.api_keys
for each row execute function public.set_updated_at();

alter table public.alexa_users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.notes enable row level security;
alter table public.reminders enable row level security;
alter table public.alexa_request_receipts enable row level security;
alter table public.execution_logs enable row level security;
alter table key_manager.llm_providers enable row level security;
alter table key_manager.llm_models enable row level security;
alter table key_manager.api_keys enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema key_manager from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on schema key_manager to service_role;
grant all on all tables in schema key_manager to service_role;

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
  insert into public.alexa_request_receipts(request_id, request_timestamp)
  values (p_request_id, p_request_timestamp)
  on conflict do nothing;
  return found;
end;
$$;

revoke all on function public.register_alexa_request(text, timestamptz) from public, anon, authenticated;
grant execute on function public.register_alexa_request(text, timestamptz) to service_role;

comment on table key_manager.api_keys is
  'Metadata for provider credentials. Secret material is stored in Supabase Vault and referenced by vault_secret_id.';
