create index execution_logs_user_idx
  on public.execution_logs (user_id)
  where user_id is not null;

create index execution_logs_conversation_idx
  on public.execution_logs (conversation_id)
  where conversation_id is not null;
