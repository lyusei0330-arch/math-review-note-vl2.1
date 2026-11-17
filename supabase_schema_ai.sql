-- 数学の発想ノート：AI機能（読み取り・分析・類題・学習の整理）用 追加スキーマ
-- すでに supabase_schema.sql を実行済みの場合は、このSQLだけを追加で実行してください。

alter table public.problems
  add column if not exists problem_text text default '',
  add column if not exists ai_ocr_result jsonb,
  add column if not exists user_verified_text text default '',
  add column if not exists ai_analysis jsonb,
  add column if not exists ai_similar_problems jsonb not null default '[]'::jsonb,
  add column if not exists source_problem_id uuid;

create table if not exists public.learning_summaries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  analysis jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.learning_summaries enable row level security;

drop policy if exists "Users can view their own learning summary" on public.learning_summaries;
create policy "Users can view their own learning summary"
  on public.learning_summaries for select
  using (auth.uid() = user_id);

drop policy if exists "Users can upsert their own learning summary" on public.learning_summaries;
create policy "Users can upsert their own learning summary"
  on public.learning_summaries for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own learning summary" on public.learning_summaries;
create policy "Users can update their own learning summary"
  on public.learning_summaries for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
