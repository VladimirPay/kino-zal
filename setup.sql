-- Наш Кинозал — схема базы данных для Supabase
-- Выполните целиком в Supabase: раздел "SQL Editor" → New query → вставить → Run

create extension if not exists pgcrypto;

create table if not exists movies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null default 'movie',
  year int,
  genre text,
  note text,
  status text not null default 'want',
  added_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists ratings (
  movie_id uuid references movies(id) on delete cascade,
  name text not null,
  value int not null check (value between 1 and 5),
  primary key (movie_id, name)
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid references movies(id) on delete cascade,
  name text not null,
  text text not null,
  created_at timestamptz not null default now()
);

alter table movies enable row level security;
alter table ratings enable row level security;
alter table comments enable row level security;

-- Открытый доступ на чтение/запись для всех, у кого есть ссылка на сайт
-- (без аккаунтов и паролей — это осознанный компромисс для небольшого списка друзей)
create policy "public read movies" on movies for select using (true);
create policy "public insert movies" on movies for insert with check (true);
create policy "public update movies" on movies for update using (true);
create policy "public delete movies" on movies for delete using (true);

create policy "public read ratings" on ratings for select using (true);
create policy "public insert ratings" on ratings for insert with check (true);
create policy "public update ratings" on ratings for update using (true);
create policy "public delete ratings" on ratings for delete using (true);

create policy "public read comments" on comments for select using (true);
create policy "public insert comments" on comments for insert with check (true);
create policy "public update comments" on comments for update using (true);
create policy "public delete comments" on comments for delete using (true);

-- Включаем "живые" обновления, чтобы все видели изменения друг друга сразу
alter publication supabase_realtime add table movies, ratings, comments;

-- Несколько примеров для начала (можно удалить прямо на сайте)
insert into movies (title, type, year, genre, note, status, added_by) values
  ('Интерстеллар', 'movie', 2014, 'фантастика', 'Стартовый список — можно удалить или дополнить.', 'watched', 'Стартовый список'),
  ('Достать ножи', 'movie', 2019, 'детектив', 'Лёгкий вечер с друзьями.', 'want', 'Стартовый список'),
  ('Во все тяжкие', 'series', 2008, 'драма', null, 'watching', 'Стартовый список'),
  ('Твоё имя', 'movie', 2016, 'аниме', null, 'want', 'Стартовый список');
