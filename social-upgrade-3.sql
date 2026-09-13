-- Наш Кинозал — миграция №3: игра «Матч» (в духе Tinder). ДОБАВЛЯЕТ две
-- новые таблицы и одну функцию с триггером, ничего не удаляет и не трогает
-- существующие данные — можно спокойно выполнять на сайте с реальными
-- пользователями. Выполнять ПОСЛЕ auth-upgrade.sql и social-upgrade.sql
-- (использует profiles, titles, friend_requests, is_admin()).
-- Supabase: SQL Editor -> New query -> вставить целиком -> Run.
--
-- Как это работает:
--  1) swipes — по одной строке на каждую вашу отметку «нравится»/«не то» на
--     карточке в игре «Матч». Видна только вам самим — даже администратору
--     не показывается, кто что лайкнул (это личное, как и остальной личный
--     список);
--  2) когда вы отмечаете «нравится», срабатывает функция check_swipe_match():
--     она (с повышенными правами, в обход обычных ограничений доступа)
--     проверяет, не лайкнул ли уже тот же тайтл кто-то из ваших друзей —
--     и если да, создаёт запись в matches. Именно поэтому сайту не нужно
--     читать чужие свайпы напрямую: он только читает уже готовый результат
--     (совпадение или нет), что и сохраняет приватность самих лайков;
--  3) matches — совпадения: кто с кем и по какому тайтлу совпал. Видна
--     обоим участникам совпадения (и только им).

-- ========== 1. Свайпы ==========

create table if not exists swipes (
  user_id uuid not null references profiles(id) on delete cascade,
  title_id bigint not null references titles(id) on delete cascade,
  liked boolean not null,
  created_at timestamptz not null default now(),
  primary key (user_id, title_id)
);

alter table swipes enable row level security;

drop policy if exists "swipes: select own" on swipes;
create policy "swipes: select own" on swipes
  for select using (auth.uid() = user_id);

drop policy if exists "swipes: insert own" on swipes;
create policy "swipes: insert own" on swipes
  for insert with check (auth.uid() = user_id);

drop policy if exists "swipes: update own" on swipes;
create policy "swipes: update own" on swipes
  for update using (auth.uid() = user_id);

-- ========== 2. Совпадения ==========

create table if not exists matches (
  id bigint generated always as identity primary key,
  title_id bigint not null references titles(id) on delete cascade,
  user_a uuid not null references profiles(id) on delete cascade,
  user_b uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (title_id, user_a, user_b)
);

alter table matches enable row level security;

-- Читать может только сама пара — совпадение с чужим другом вас не касается.
drop policy if exists "matches: select own" on matches;
create policy "matches: select own" on matches
  for select using (auth.uid() = user_a or auth.uid() = user_b);

-- Вставлять напрямую не может никто (в т.ч. администратор) — только функция
-- check_swipe_match() ниже, у которой есть на это право (security definer).
-- Явной insert-политики намеренно нет: без неё RLS запрещает вставку от
-- имени обычного пользователя, а функции с security definer это не мешает —
-- ровно тот же приём, что уже используется для activity_log в auth-upgrade.sql.

-- ========== 3. Определение совпадения ==========

create or replace function check_swipe_match() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  friend_id uuid;
  a uuid;
  b uuid;
begin
  if new.liked then
    for friend_id in
      select case when fr.from_user = new.user_id then fr.to_user else fr.from_user end
      from friend_requests fr
      where fr.status = 'accepted'
        and (fr.from_user = new.user_id or fr.to_user = new.user_id)
    loop
      if exists (
        select 1 from swipes s
        where s.user_id = friend_id and s.title_id = new.title_id and s.liked
      ) then
        if new.user_id < friend_id then a := new.user_id; b := friend_id;
        else a := friend_id; b := new.user_id; end if;
        insert into matches (title_id, user_a, user_b)
        values (new.title_id, a, b)
        on conflict (title_id, user_a, user_b) do nothing;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_swipe_match on swipes;
create trigger trg_swipe_match after insert or update on swipes
  for each row execute function check_swipe_match();

-- ========== 4. Живые обновления ==========
-- Чтобы уведомление о совпадении приходило сразу, даже если вы в этот
-- момент не на вкладке «Матч» (см. realtime.js). Обёрнуто проверкой, чтобы
-- скрипт можно было безопасно выполнить повторно, если понадобится.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches'
  ) then
    alter publication supabase_realtime add table matches;
  end if;
end $$;
