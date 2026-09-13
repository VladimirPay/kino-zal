-- Наш Кинозал — переход на настоящие аккаунты (email + пароль), роли user/admin.
-- ВНИМАНИЕ: этот скрипт пересоздаёт таблицы movies/ratings/comments с нуля —
-- текущий список (в т.ч. стартовые примеры) будет удалён. После выполнения
-- скрипта нужно будет зарегистрироваться заново и добавить фильмы через сайт.
--
-- Выполняется целиком в Supabase: SQL Editor -> New query -> вставить -> Run

create extension if not exists pgcrypto;

-- ========== 1. Профили пользователей ==========

drop table if exists comments cascade;
drop table if exists ratings cascade;
drop table if exists movies cascade;
drop table if exists profiles cascade;

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Вспомогательная функция: является ли текущий пользователь администратором
create or replace function is_admin() returns boolean
language sql stable security definer
as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Читать профили (имена/роли) может любой вошедший пользователь
create policy "profiles: read by authenticated" on profiles
  for select using (auth.role() = 'authenticated');

-- Менять профиль может сам пользователь (своё имя) или администратор (роль любого)
create policy "profiles: update self or admin" on profiles
  for update using (auth.uid() = id or is_admin())
  with check (auth.uid() = id or is_admin());

-- Защита от самоповышения роли: обычный пользователь не может сам себе выдать admin.
-- Срабатывает только когда запрос идёт от залогиненного пользователя через сайт
-- (auth.role() = 'authenticated'); когда вы сами выполняете команду в SQL Editor
-- (там нет такой роли запроса), защита не мешает — это нужно для самого первого
-- назначения администратора.
create or replace function prevent_role_self_escalation() returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role
     and auth.role() = 'authenticated'
     and not is_admin() then
    new.role := old.role;
  end if;
  return new;
end;
$$;

create trigger trg_protect_role
before update on profiles
for each row execute function prevent_role_self_escalation();

-- Автосоздание профиля при регистрации (имя берётся из формы регистрации)
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)),
    'user'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();

-- ========== 2. Фильмы / оценки / комментарии ==========

create table movies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  type text not null default 'movie' check (type in ('movie','series')),
  year int check (year is null or (year between 1888 and 2100)),
  genre text check (genre is null or char_length(genre) <= 60),
  note text check (note is null or char_length(note) <= 400),
  status text not null default 'want' check (status in ('want','watching','watched')),
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table ratings (
  movie_id uuid references movies(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  value int not null check (value between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (movie_id, user_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid references movies(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table movies enable row level security;
alter table ratings enable row level security;
alter table comments enable row level security;

-- movies: читать могут все вошедшие; добавлять — от своего имени;
-- менять/удалять — автор записи или администратор
create policy "movies: read (authenticated)" on movies
  for select using (auth.role() = 'authenticated');
create policy "movies: insert own" on movies
  for insert with check (auth.uid() = user_id);
create policy "movies: update own or admin" on movies
  for update using (auth.uid() = user_id or is_admin());
create policy "movies: delete own or admin" on movies
  for delete using (auth.uid() = user_id or is_admin());

-- ratings: читать могут все вошедшие; ставить/менять только свою оценку
create policy "ratings: read (authenticated)" on ratings
  for select using (auth.role() = 'authenticated');
create policy "ratings: upsert own" on ratings
  for insert with check (auth.uid() = user_id);
create policy "ratings: update own" on ratings
  for update using (auth.uid() = user_id);
create policy "ratings: delete own or admin" on ratings
  for delete using (auth.uid() = user_id or is_admin());

-- comments: читать могут все вошедшие; писать от своего имени;
-- удалять — автор или администратор
create policy "comments: read (authenticated)" on comments
  for select using (auth.role() = 'authenticated');
create policy "comments: insert own" on comments
  for insert with check (auth.uid() = user_id);
create policy "comments: delete own or admin" on comments
  for delete using (auth.uid() = user_id or is_admin());

-- Живые обновления для всех таблиц
alter publication supabase_realtime add table movies, ratings, comments, profiles;

-- ========== 3. Журнал действий (для восстановления/переноса данных) ==========
-- Отдельная таблица, куда автоматически пишется КАЖДОЕ изменение
-- (кто, что, когда, старое и новое значение) по всем таблицам ниже.
-- Она не зависит от оформления сайта: если в будущем сайт будет переделан
-- или заменён на другой, вся история и данные всё равно останутся здесь,
-- в базе Supabase, и их можно будет прочитать или перенести на новый сайт.

create table activity_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor uuid references profiles(id) on delete set null,
  table_name text not null,
  action text not null check (action in ('insert','update','delete')),
  old_data jsonb,
  new_data jsonb
);

alter table activity_log enable row level security;

-- Читать журнал может только администратор (в нём попадаются старые версии
-- данных, показывать это всем подряд ни к чему)
create policy "activity_log: admin read only" on activity_log
  for select using (is_admin());

-- Писать в журнал может только сама система (через функцию ниже,
-- запускается с правами владельца и в обход обычных прав доступа) —
-- обычные пользователи и даже администратор не могут вставить или
-- подделать запись напрямую.
create or replace function log_activity() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (tg_op = 'DELETE') then
    insert into activity_log(actor, table_name, action, old_data)
    values (auth.uid(), tg_table_name, 'delete', to_jsonb(old));
    return old;
  elsif (tg_op = 'UPDATE') then
    insert into activity_log(actor, table_name, action, old_data, new_data)
    values (auth.uid(), tg_table_name, 'update', to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into activity_log(actor, table_name, action, new_data)
    values (auth.uid(), tg_table_name, 'insert', to_jsonb(new));
    return new;
  end if;
end;
$$;

create trigger trg_log_movies after insert or update or delete on movies
  for each row execute function log_activity();
create trigger trg_log_ratings after insert or update or delete on ratings
  for each row execute function log_activity();
create trigger trg_log_comments after insert or update or delete on comments
  for each row execute function log_activity();
create trigger trg_log_profiles after insert or update or delete on profiles
  for each row execute function log_activity();

-- ========== 4. Как назначить первого администратора ==========
-- 1) Зарегистрируйтесь на самом сайте обычным способом (email + пароль).
-- 2) Затем выполните здесь, подставив свою почту:
--    update profiles set role = 'admin'
--    where id = (select id from auth.users where email = 'ВАША_ПОЧТА@пример.com');
