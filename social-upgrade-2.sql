-- Наш Кинозал — миграция №2: ДОБАВЛЯЕТ две новые таблицы, ничего не удаляет
-- и не трогает существующие данные.
--
-- Выполнять ПОСЛЕ auth-upgrade.sql и social-upgrade.sql (они уже должны
-- быть применены — этот скрипт использует profiles, is_admin() и titles,
-- которые создают те два файла).
--
-- В ОТЛИЧИЕ от social-upgrade.sql, этот скрипт НЕ разрушительный: в нём нет
-- ни одного "drop table" — можно спокойно выполнять на сайте с реальными
-- пользователями и данными. Supabase: SQL Editor -> New query -> вставить
-- целиком -> Run.
--
-- Что добавляется:
--  1) dismissed_recommendations — какие тайтлы из блока «Может понравиться»
--     пользователь отметил «Не интересно» (чтобы не предлагать их снова);
--  2) kp_api_log — по одной строке на каждое обращение к Kinopoisk.dev, для
--     раздела «Управление» → «Лимиты API» (бесплатный тариф ограничен
--     ~200 запросами в сутки на весь сайт);
--  3) kp_cache — общий кэш ответов Kinopoisk.dev на весь сайт (поиск и
--     рекомендации): если кто-то уже искал то же самое или у вас с другом
--     совпали любимые жанры в последние несколько часов, повторный запрос
--     берётся отсюда, а не тратит дневной лимит заново.

-- ========== 1. Скрытые рекомендации ==========

create table if not exists dismissed_recommendations (
  user_id uuid not null references profiles(id) on delete cascade,
  kp_id int not null,
  media_type text not null check (media_type in ('movie','tv-series','cartoon','anime','animated-series','tv-show')),
  created_at timestamptz not null default now(),
  primary key (user_id, kp_id, media_type)
);

alter table dismissed_recommendations enable row level security;

drop policy if exists "dismissed_recommendations: select own" on dismissed_recommendations;
create policy "dismissed_recommendations: select own" on dismissed_recommendations
  for select using (auth.uid() = user_id);

drop policy if exists "dismissed_recommendations: insert own" on dismissed_recommendations;
create policy "dismissed_recommendations: insert own" on dismissed_recommendations
  for insert with check (auth.uid() = user_id);

drop policy if exists "dismissed_recommendations: delete own" on dismissed_recommendations;
create policy "dismissed_recommendations: delete own" on dismissed_recommendations
  for delete using (auth.uid() = user_id);

-- ========== 2. Учёт обращений к Kinopoisk.dev ==========

create table if not exists kp_api_log (
  id bigint generated always as identity primary key,
  user_id uuid references profiles(id) on delete set null,
  path text not null,
  ok boolean not null,
  status int,
  created_at timestamptz not null default now()
);

alter table kp_api_log enable row level security;

-- Писать может любой вошедший пользователь, но только свою собственную
-- строку (от чужого имени подделать запись нельзя).
drop policy if exists "kp_api_log: insert own" on kp_api_log;
create policy "kp_api_log: insert own" on kp_api_log
  for insert with check (auth.uid() = user_id);

-- Читать (то есть видеть статистику по всем пользователям) может только
-- администратор — это только счётчик расхода общего дневного лимита,
-- а не что-то приватное, но обычным участникам сайта эта статистика ни к
-- чему.
drop policy if exists "kp_api_log: select admin only" on kp_api_log;
create policy "kp_api_log: select admin only" on kp_api_log
  for select using (is_admin());

-- Индекс для быстрой выборки "за сегодня" в разделе «Лимиты API».
create index if not exists kp_api_log_created_at_idx on kp_api_log (created_at desc);

-- ========== 3. Общий кэш ответов Kinopoisk.dev ==========
-- Ключ — путь + отсортированные параметры запроса (строит сайт), значение —
-- сырой ответ Kinopoisk.dev как есть. Это не приватные данные — те же самые
-- фильмы/сериалы виден всем через каталог — поэтому читать и обновлять кэш
-- может любой вошедший пользователь.

create table if not exists kp_cache (
  cache_key text primary key,
  response jsonb not null,
  created_at timestamptz not null default now()
);

alter table kp_cache enable row level security;

drop policy if exists "kp_cache: select (authenticated)" on kp_cache;
create policy "kp_cache: select (authenticated)" on kp_cache
  for select using (auth.role() = 'authenticated');

drop policy if exists "kp_cache: insert (authenticated)" on kp_cache;
create policy "kp_cache: insert (authenticated)" on kp_cache
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "kp_cache: update (authenticated)" on kp_cache;
create policy "kp_cache: update (authenticated)" on kp_cache
  for update using (auth.role() = 'authenticated');
