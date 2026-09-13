-- Наш Кинозал — миграция №7: обмен карточками фильмов/сериалов в сообщениях
-- (общий чат и личные сообщения) — кнопка «Поделиться» в карточке тайтла
-- (titleDetail.js) отправляет отдельное сообщение со ссылкой на тайтл (без
-- текста и без картинки — как самостоятельное сообщение), лента чата/ЛС
-- показывает это как компактную кликабельную мини-карточку (postер + год +
-- рейтинг), клик открывает ту же общую карточку тайтла. Ничего не удаляет,
-- можно спокойно выполнять на сайте с реальными данными. Выполнять ПОСЛЕ
-- social-upgrade-5.sql (использует тот же приём "текст не обязателен, если
-- есть что-то другое", там уже применён для image_url).
-- Supabase: SQL Editor -> New query -> вставить целиком -> Run.

alter table chat_messages add column if not exists shared_title_id bigint references titles(id) on delete set null;
alter table dm_messages add column if not exists shared_title_id bigint references titles(id) on delete set null;

create index if not exists chat_messages_shared_title_idx on chat_messages(shared_title_id) where shared_title_id is not null;
create index if not exists dm_messages_shared_title_idx on dm_messages(shared_title_id) where shared_title_id is not null;

-- Расширяем constraint из social-upgrade-5.sql (там было "текст ИЛИ
-- картинка") — теперь допустимо сообщение из одной только карточки тайтла,
-- без текста и без картинки.
alter table chat_messages drop constraint if exists chat_messages_text_or_image;
alter table chat_messages add constraint chat_messages_text_or_image
  check (text is not null or image_url is not null or shared_title_id is not null);

alter table dm_messages drop constraint if exists dm_messages_text_or_image;
alter table dm_messages add constraint dm_messages_text_or_image
  check (text is not null or image_url is not null or shared_title_id is not null);

-- Публикацию Realtime трогать не нужно — chat_messages/dm_messages уже в
-- ней (см. social-upgrade.sql), новая колонка реплицируется автоматически.
