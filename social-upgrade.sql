-- Наш Кинозал — большое обновление: общий каталог фильмов (Kinopoisk.dev), приватные
-- личные списки, друзья, чат и личные сообщения, лайки, лента активности.
--
-- ВЫПОЛНЯТЬ ПОСЛЕ auth-upgrade.sql (тот скрипт уже должен быть применён —
-- он создаёт profiles, is_admin(), log_activity() и activity_log; этот
-- скрипт их переиспользует и ничего в них не удаляет).
--
-- ВНИМАНИЕ, СКРИПТ РАЗРУШИТЕЛЬНЫЙ: таблицы movies/ratings/comments (в старом
-- виде) удаляются и заменяются на titles/user_titles/ratings/comments.
-- Весь текущий список фильмов, оценки и комментарии будут потеряны —
-- добавлять фильмы придётся заново уже через поиск по каталогу Kinopoisk.
--
-- Supabase: SQL Editor -> New query -> вставить целиком -> Run

create extension if not exists pgcrypto;

-- ========== 0. Профиль: настройки приватности ==========

alter table profiles add column if not exists share_activity boolean not null default false;
alter table profiles add column if not exists bio text check (bio is null or char_length(bio) <= 200);

-- ========== 1. Каталог: локальный кэш карточек Kinopoisk ==========
-- Когда кто-то находит фильм/сериал через поиск Kinopoisk и добавляет его в свой
-- список (или ставит оценку/пишет комментарий), карточка сохраняется сюда.
-- Это даёт стабильный внутренний id, не зависящий от внешнего API, — на нём
-- держатся оценки, комментарии и личные статусы.

-- Дропаем ВСЕ таблицы, которые ниже создаёт этот скрипт — так его можно
-- спокойно выполнить повторно (например, после обновления). Важно: "drop
-- table x cascade" убирает только внешний ключ в другой таблице, которая
-- ссылается на x, а не саму эту другую таблицу — поэтому каждая таблица
-- перечислена здесь явно, а не только "верхнеуровневые".
drop table if exists activity_feed cascade;
drop table if exists dm_messages cascade;
drop table if exists chat_messages cascade;
drop table if exists friend_requests cascade;
drop table if exists comment_likes cascade;
drop table if exists comments cascade;
drop table if exists ratings cascade;
drop table if exists user_titles cascade;
drop table if exists movies cascade;
drop table if exists titles cascade;

create table titles (
  id bigint generated always as identity primary key,
  kp_id int,                          -- id тайтла в Kinopoisk.dev (null для добавленных вручную)
  media_type text not null default 'movie'
    check (media_type in ('movie','tv-series','cartoon','anime','animated-series','tv-show')),
  title text not null check (char_length(title) between 1 and 200),
  year int check (year is null or (year between 1888 and 2100)),
  genre text check (genre is null or char_length(genre) <= 160),
  genre_names text[],                 -- названия жанров (для подбора рекомендаций)
  overview text check (overview is null or char_length(overview) <= 2000),
  poster_url text,
  kp_rating numeric(3,1),
  added_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Один и тот же тайтл Kinopoisk не должен задваиваться в кэше (но ручные
-- записи, где kp_id пустой, друг другу не мешают — индекс частичный).
create unique index titles_kp_uidx on titles (kp_id, media_type) where kp_id is not null;

alter table titles enable row level security;
create policy "titles: read (authenticated)" on titles for select using (auth.role() = 'authenticated');
create policy "titles: insert (authenticated)" on titles for insert with check (auth.role() = 'authenticated');
create policy "titles: update own or admin" on titles for update using (auth.uid() = added_by or is_admin());
create policy "titles: delete admin only" on titles for delete using (is_admin());

-- ========== 2. Личный список — ПРИВАТНЫЙ ==========
-- Статус «хочу посмотреть / смотрю / посмотрено» видит и меняет только сам
-- пользователь — ни другие участники, ни администратор его не видят.

create table user_titles (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  title_id bigint not null references titles(id) on delete cascade,
  status text not null default 'want' check (status in ('want','watching','watched')),
  note text check (note is null or char_length(note) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, title_id)
);

alter table user_titles enable row level security;
create policy "user_titles: select own" on user_titles for select using (auth.uid() = user_id);
create policy "user_titles: insert own" on user_titles for insert with check (auth.uid() = user_id);
create policy "user_titles: update own" on user_titles for update using (auth.uid() = user_id);
create policy "user_titles: delete own" on user_titles for delete using (auth.uid() = user_id);

create or replace function touch_user_titles_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_touch_user_titles before update on user_titles
  for each row execute function touch_user_titles_updated_at();

-- ========== 3. Оценки и комментарии — ОБЩИЕ (это и есть соц. часть) ==========

create table ratings (
  title_id bigint references titles(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  value int not null check (value between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (title_id, user_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  title_id bigint references titles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table ratings enable row level security;
alter table comments enable row level security;

create policy "ratings: read (authenticated)" on ratings for select using (auth.role() = 'authenticated');
create policy "ratings: upsert own" on ratings for insert with check (auth.uid() = user_id);
create policy "ratings: update own" on ratings for update using (auth.uid() = user_id);
create policy "ratings: delete own or admin" on ratings for delete using (auth.uid() = user_id or is_admin());

create policy "comments: read (authenticated)" on comments for select using (auth.role() = 'authenticated');
create policy "comments: insert own" on comments for insert with check (auth.uid() = user_id);
create policy "comments: delete own or admin" on comments for delete using (auth.uid() = user_id or is_admin());

-- ========== 4. Лайки на комментарии ==========

create table comment_likes (
  comment_id uuid references comments(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
alter table comment_likes enable row level security;
create policy "comment_likes: read (authenticated)" on comment_likes for select using (auth.role() = 'authenticated');
create policy "comment_likes: insert own" on comment_likes for insert with check (auth.uid() = user_id);
create policy "comment_likes: delete own" on comment_likes for delete using (auth.uid() = user_id);

-- ========== 5. Друзья ==========

create table friend_requests (
  id bigint generated always as identity primary key,
  from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user <> to_user),
  unique (from_user, to_user)
);
alter table friend_requests enable row level security;
create policy "friend_requests: select involved" on friend_requests
  for select using (auth.uid() = from_user or auth.uid() = to_user);
create policy "friend_requests: insert own" on friend_requests
  for insert with check (auth.uid() = from_user);
create policy "friend_requests: update recipient" on friend_requests
  for update using (auth.uid() = to_user) with check (auth.uid() = to_user);
create policy "friend_requests: delete involved" on friend_requests
  for delete using (auth.uid() = from_user or auth.uid() = to_user);

-- Вспомогательная функция: являются ли два пользователя друзьями (заявка принята)
create or replace function are_friends(a uuid, b uuid) returns boolean
language sql stable security definer
as $$
  select exists(
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user = a and to_user = b) or (from_user = b and to_user = a))
  );
$$;

-- ========== 6. Общий чат ==========

create table chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);
alter table chat_messages enable row level security;
create policy "chat_messages: read (authenticated)" on chat_messages for select using (auth.role() = 'authenticated');
create policy "chat_messages: insert own" on chat_messages for insert with check (auth.uid() = user_id);
create policy "chat_messages: delete own or admin" on chat_messages for delete using (auth.uid() = user_id or is_admin());

-- ========== 7. Личные сообщения ==========

create table dm_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 1000),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
create index dm_messages_sender_idx on dm_messages(sender_id, recipient_id, created_at);
create index dm_messages_recipient_idx on dm_messages(recipient_id, sender_id, created_at);

alter table dm_messages enable row level security;
create policy "dm_messages: select involved" on dm_messages
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "dm_messages: insert own" on dm_messages
  for insert with check (auth.uid() = sender_id);
create policy "dm_messages: update recipient marks read" on dm_messages
  for update using (auth.uid() = recipient_id) with check (auth.uid() = recipient_id);
create policy "dm_messages: delete involved" on dm_messages
  for delete using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- ========== 8. Лента активности друзей (только по желанию!) ==========
-- Пишется автоматически, но ТОЛЬКО если сам пользователь включил в профиле
-- «делиться активностью с друзьями» (share_activity). Видна только друзьям
-- (и самому пользователю) — не всем подряд.

create table activity_feed (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  title_id bigint references titles(id) on delete cascade,
  kind text not null check (kind in ('watched','rated','commented')),
  extra jsonb,
  created_at timestamptz not null default now()
);
alter table activity_feed enable row level security;
create policy "activity_feed: friends or self" on activity_feed
  for select using (auth.uid() = user_id or are_friends(auth.uid(), user_id));

create or replace function push_activity(p_user uuid, p_title bigint, p_kind text, p_extra jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select coalesce(share_activity,false) from profiles where id = p_user) then
    insert into activity_feed(user_id, title_id, kind, extra) values (p_user, p_title, p_kind, p_extra);
  end if;
end;
$$;

create or replace function trg_user_titles_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- tg_op проверяется первым отдельной веткой, чтобы никогда не обращаться
  -- к OLD при INSERT (для INSERT-триггера строка OLD попросту не существует).
  if tg_op = 'INSERT' then
    if new.status = 'watched' then
      perform push_activity(new.user_id, new.title_id, 'watched', null);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'watched' and old.status is distinct from 'watched' then
      perform push_activity(new.user_id, new.title_id, 'watched', null);
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_activity_user_titles after insert or update on user_titles
  for each row execute function trg_user_titles_activity();

create or replace function trg_ratings_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform push_activity(new.user_id, new.title_id, 'rated', jsonb_build_object('value', new.value));
  elsif tg_op = 'UPDATE' then
    if new.value is distinct from old.value then
      perform push_activity(new.user_id, new.title_id, 'rated', jsonb_build_object('value', new.value));
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_activity_ratings after insert or update on ratings
  for each row execute function trg_ratings_activity();

create or replace function trg_comments_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform push_activity(new.user_id, new.title_id, 'commented', null);
  return new;
end;
$$;
create trigger trg_activity_comments after insert on comments
  for each row execute function trg_comments_activity();

-- ========== 9. Журнал действий — расширяем на все новые таблицы ==========
-- (функция log_activity() уже создана в auth-upgrade.sql — переиспользуем)

create trigger trg_log_titles after insert or update or delete on titles for each row execute function log_activity();
create trigger trg_log_user_titles after insert or update or delete on user_titles for each row execute function log_activity();
create trigger trg_log_ratings after insert or update or delete on ratings for each row execute function log_activity();
create trigger trg_log_comments after insert or update or delete on comments for each row execute function log_activity();
create trigger trg_log_comment_likes after insert or delete on comment_likes for each row execute function log_activity();
create trigger trg_log_friend_requests after insert or update or delete on friend_requests for each row execute function log_activity();
create trigger trg_log_chat_messages after insert or delete on chat_messages for each row execute function log_activity();
create trigger trg_log_dm_messages after insert or update or delete on dm_messages for each row execute function log_activity();

-- ========== 10. Живые обновления (realtime) ==========

alter publication supabase_realtime add table
  titles, user_titles, ratings, comments, comment_likes,
  friend_requests, chat_messages, dm_messages, activity_feed;
