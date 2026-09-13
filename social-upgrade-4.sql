-- Наш Кинозал — миграция №4: ссылка на трейлер тайтла. ДОБАВЛЯЕТ одну
-- колонку и одну служебную функцию, ничего не удаляет — можно спокойно
-- выполнять на сайте с реальными данными. Выполнять ПОСЛЕ social-upgrade.sql
-- (использует таблицу titles). Supabase: SQL Editor -> New query -> вставить
-- целиком -> Run.
--
-- Зачем нужна отдельная функция, а не обычное обновление строки: ссылку на
-- трейлер сайт узнаёт (через ApiGet.ru) не в момент добавления тайтла, а
-- позже, лениво — когда кто-то первым открывает его карточку. Но обычная
-- политика доступа разрешает менять тайтл только тому, кто его добавил, или
-- администратору (см. "titles: update own or admin" в social-upgrade.sql) —
-- иначе любой участник смог бы вслепую отредактировать чужую запись
-- каталога. Функция ниже — узкая "дырка" в этом ограничении: она способна
-- заполнить ТОЛЬКО поле trailer_url, и только если оно ещё пустое, кто бы
-- её ни вызвал.

alter table titles add column if not exists trailer_url text;

create or replace function set_title_trailer(p_title_id bigint, p_trailer_url text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update titles
  set trailer_url = p_trailer_url
  where id = p_title_id and trailer_url is null and p_trailer_url is not null;
end;
$$;

grant execute on function set_title_trailer(bigint, text) to authenticated;
