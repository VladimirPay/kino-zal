-- Наш Кинозал — миграция №5: реакции-эмодзи и картинки в сообщениях (общий
-- чат и личные сообщения). Ничего не удаляет, можно спокойно выполнять на
-- сайте с реальными данными. Выполнять ПОСЛЕ social-upgrade.sql (использует
-- таблицы chat_messages/dm_messages/profiles). Supabase: SQL Editor -> New
-- query -> вставить целиком -> Run.

-- ========== 1. Реакции-эмодзи на сообщения ==========
-- Одна таблица на оба вида сообщений (общий чат и личные) — колонка kind
-- отличает, к какой из двух таблиц относится message_id (сами id могут
-- совпадать между chat_messages и dm_messages — это разные счётчики, поэтому
-- смотреть на message_id без kind нельзя). Один пользователь может поставить
-- под одним сообщением несколько РАЗНЫХ эмодзи, но одно и то же эмодзи —
-- только один раз (unique ниже) — повторный клик по уже стоящему эмодзи в
-- интерфейсе снимает реакцию, а не дублирует её.
create table if not exists message_reactions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('chat','dm')),
  message_id bigint not null,
  user_id uuid not null references profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  unique (kind, message_id, user_id, emoji)
);
create index if not exists message_reactions_msg_idx on message_reactions(kind, message_id);

-- По умолчанию Realtime присылает при DELETE только первичный ключ строки
-- (id) — а сайту при удалении реакции нужно знать ещё и kind/message_id/
-- user_id/emoji, чтобы понять, какую именно реакцию убрать у кого. REPLICA
-- IDENTITY FULL заставляет присылать все колонки старой строки.
alter table message_reactions replica identity full;

alter table message_reactions enable row level security;

-- Видеть реакции можно только там же, где видно и само сообщение: реакции на
-- общий чат — всем авторизованным, на личные сообщения — только двум
-- участникам конкретной переписки (проверяется через exists на dm_messages,
-- как и в политиках самих личных сообщений).
drop policy if exists "message_reactions: select" on message_reactions;
create policy "message_reactions: select" on message_reactions for select using (
  (kind = 'chat' and auth.role() = 'authenticated')
  or (kind = 'dm' and exists (
    select 1 from dm_messages d where d.id = message_reactions.message_id
      and (d.sender_id = auth.uid() or d.recipient_id = auth.uid())
  ))
);
drop policy if exists "message_reactions: insert own" on message_reactions;
create policy "message_reactions: insert own" on message_reactions for insert with check (
  auth.uid() = user_id and (
    (kind = 'chat' and auth.role() = 'authenticated')
    or (kind = 'dm' and exists (
      select 1 from dm_messages d where d.id = message_reactions.message_id
        and (d.sender_id = auth.uid() or d.recipient_id = auth.uid())
    ))
  )
);
drop policy if exists "message_reactions: delete own" on message_reactions;
create policy "message_reactions: delete own" on message_reactions for delete using (auth.uid() = user_id);

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table message_reactions;
  end if;
end $$;

-- ========== 2. Картинки в сообщениях ==========
-- Текст сообщения был обязательным (not null, 1-1000 символов) — теперь
-- разрешаем отправить только картинку без текста, но требуем, чтобы было
-- хотя бы что-то одно (новый constraint ниже). Старая проверка длины текста
-- (1-1000 символов), когда он всё-таки указан, никуда не делась — она просто
-- не срабатывает, если текста нет вовсе (NULL), это стандартное поведение
-- Postgres для CHECK-ограничений.
alter table chat_messages alter column text drop not null;
alter table chat_messages add column if not exists image_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_text_or_image') then
    alter table chat_messages add constraint chat_messages_text_or_image check (text is not null or image_url is not null);
  end if;
end $$;

alter table dm_messages alter column text drop not null;
alter table dm_messages add column if not exists image_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dm_messages_text_or_image') then
    alter table dm_messages add constraint dm_messages_text_or_image check (text is not null or image_url is not null);
  end if;
end $$;

-- Отдельное хранилище (bucket) для картинок из чата и личных сообщений —
-- публично читаемое по прямой ссылке (как и постеры фильмов — ссылка никому
-- не публикуется и не индексируется, но и не проверяется на членство в
-- сайте), а загружать в него может только авторизованный пользователь сайта.
insert into storage.buckets (id, name, public)
  values ('chat-images', 'chat-images', true)
  on conflict (id) do nothing;

drop policy if exists "chat-images: authenticated upload" on storage.objects;
create policy "chat-images: authenticated upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-images');

drop policy if exists "chat-images: public read" on storage.objects;
create policy "chat-images: public read" on storage.objects
  for select using (bucket_id = 'chat-images');
