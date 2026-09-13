-- Наш Кинозал — миграция №9: мэтчи теперь между ВСЕМИ пользователями, а не
-- только между друзьями. Меняет одну функцию (check_swipe_match), ничего не
-- удаляет и не трогает существующие данные — можно спокойно выполнять на
-- сайте с реальными данными, безопасно выполнить повторно.
-- Supabase: SQL Editor -> New query -> вставить целиком -> Run.
--
-- Было (social-upgrade-3.sql): при лайке карточки функция смотрела только
-- на свайпы ваших друзей (через friend_requests) — совпадение считалось,
-- только если тот же тайтл лайкнул именно друг.
-- Стало: функция смотрит на свайпы ВСЕХ пользователей сайта — совпадение
-- считается с любым, кто уже лайкнул тот же тайтл, независимо от того,
-- друзья вы или нет. friend_requests в этой функции больше не участвует.

create or replace function check_swipe_match() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  other_id uuid;
  a uuid;
  b uuid;
begin
  if new.liked then
    for other_id in
      select distinct s.user_id
      from swipes s
      where s.title_id = new.title_id
        and s.liked
        and s.user_id <> new.user_id
    loop
      if new.user_id < other_id then a := new.user_id; b := other_id;
      else a := other_id; b := new.user_id; end if;
      insert into matches (title_id, user_a, user_b)
      values (new.title_id, a, b)
      on conflict (title_id, user_a, user_b) do nothing;
    end loop;
  end if;
  return new;
end;
$$;

-- Триггер уже создан в social-upgrade-3.sql (trg_swipe_match on swipes) и
-- продолжает указывать на эту же функцию check_swipe_match() — пересоздавать
-- триггер не нужно, "create or replace function" меняет её поведение на лету.
