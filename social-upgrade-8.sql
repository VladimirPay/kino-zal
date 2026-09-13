-- Наш Кинозал — миграция №8: ответы на комментарии, жалобы на пользователей
-- и административный просмотр чужого профиля. Три независимые части, можно
-- выполнять целиком одним запуском. Ничего не удаляет и не переписывает
-- существующие данные, можно спокойно выполнять на сайте с реальными
-- данными, безопасно выполнить повторно (все проверки — "если ещё нет").
-- Supabase: SQL Editor -> New query -> вставить целиком -> Run.

-- ========== 1. Ответы на комментарии ==========
-- comments.parent_id — ссылка на другой комментарий этого же тайтла, на
-- который отвечают. NULL — обычный (не ответный) комментарий. "on delete
-- cascade" — если удаляют комментарий, вместе с ним удаляется и вся ветка
-- ответов на него (простое и предсказуемое поведение для небольшого сайта).

alter table comments add column if not exists parent_id uuid references comments(id) on delete cascade;
create index if not exists comments_parent_idx on comments(parent_id) where parent_id is not null;

-- ========== 2. Жалобы на пользователей ==========
-- Кнопка «🚩 Пожаловаться» в карточке профиля (userCard.js) отправляет сюда
-- причину. Видит жалобу сам автор (чтобы понимать, что она принята) и
-- администратор — вкладка «Управление -> Жалобы» (admin.js). Тот, на кого
-- жалуются, эту запись не видит вообще (RLS ниже это и обеспечивает).

create table if not exists user_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references profiles(id) on delete cascade,
  reported_id uuid not null references profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'new' check (status in ('new','reviewed','dismissed')),
  created_at timestamptz not null default now(),
  check (reporter_id <> reported_id)
);
create index if not exists user_reports_reported_idx on user_reports(reported_id);
create index if not exists user_reports_status_idx on user_reports(status);

alter table user_reports enable row level security;

drop policy if exists "user_reports: select own or admin" on user_reports;
create policy "user_reports: select own or admin" on user_reports
  for select using (auth.uid() = reporter_id or is_admin());

drop policy if exists "user_reports: insert own" on user_reports;
create policy "user_reports: insert own" on user_reports
  for insert with check (auth.uid() = reporter_id);

drop policy if exists "user_reports: update admin only" on user_reports;
create policy "user_reports: update admin only" on user_reports
  for update using (is_admin());

drop policy if exists "user_reports: delete admin only" on user_reports;
create policy "user_reports: delete admin only" on user_reports
  for delete using (is_admin());

-- Живые обновления — чтобы новая жалоба сразу показывалась администратору
-- (см. realtime.js), даже если он не находится на вкладке «Управление».
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_reports'
  ) then
    alter publication supabase_realtime add table user_reports;
  end if;
end $$;

-- ========== 3. Административный просмотр чужого профиля ==========
-- ВАЖНО, осознанное изменение модели приватности сайта (по прямому запросу
-- владельца сайта): до этой миграции личный список (user_titles), друзья
-- (friend_requests) и личные сообщения (dm_messages) были видны СТРОГО
-- только их владельцу — не показывались даже администратору (это специально
-- отмечено в комментариях исходного кода и в самом интерфейсе). Ниже —
-- ДОБАВОЧНЫЕ политики "…: admin read all" (в Postgres несколько разрешающих
-- select-политик на одной таблице складываются через OR, поэтому
-- существующие политики "видеть только своё" никак не меняются и не
-- удаляются — обычные пользователи как и раньше видят только свои строки).
-- После этой миграции администратор может открыть кнопкой «Просмотреть»
-- (admin.js) чужой личный список, список друзей и личную переписку.

drop policy if exists "user_titles: admin read all" on user_titles;
create policy "user_titles: admin read all" on user_titles
  for select using (is_admin());

drop policy if exists "friend_requests: admin read all" on friend_requests;
create policy "friend_requests: admin read all" on friend_requests
  for select using (is_admin());

drop policy if exists "dm_messages: admin read all" on dm_messages;
create policy "dm_messages: admin read all" on dm_messages
  for select using (is_admin());
