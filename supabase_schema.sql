-- 数学の発想ノート：Supabase 用スキーマ＆アクセス制御（RLS）
-- Supabase の SQL Editor に貼り付けて実行してください。

create table if not exists public.problems (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  material text not null,
  problem_number text not null,
  unit text default '',
  review_state text not null default 'untouched' check (review_state in ('untouched', 'reviewing', 'done')),
  problem_images jsonb not null default '[]'::jsonb,
  answer_images jsonb not null default '[]'::jsonb,
  memo_tried text default '',
  memo_idea text default '',
  memo_clue text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.problems enable row level security;

create policy "Users can view their own problems"
  on public.problems for select
  using (auth.uid() = user_id);

create policy "Users can insert their own problems"
  on public.problems for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own problems"
  on public.problems for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own problems"
  on public.problems for delete
  using (auth.uid() = user_id);

-- Storage バケット作成（非公開バケット）
insert into storage.buckets (id, name, public)
values ('math-review-images', 'math-review-images', false)
on conflict (id) do nothing;

-- 自分のフォルダ（user_id/...）のみ読み書き可能にするポリシー
create policy "Users can upload their own images"
  on storage.objects for insert
  with check (
    bucket_id = 'math-review-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can view their own images"
  on storage.objects for select
  using (
    bucket_id = 'math-review-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can update their own images"
  on storage.objects for update
  using (
    bucket_id = 'math-review-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own images"
  on storage.objects for delete
  using (
    bucket_id = 'math-review-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
