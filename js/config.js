// Наш Кинозал — настройки и общие справочники.
// Это единственное место, которое нужно трогать при смене проекта Supabase.

export const SUPABASE_URL = "https://fbewqeffdgrlyahetykx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_o-gkUyR979lyzb9w9W7i7g_463PhMki";
// Ключ Kinopoisk.dev сюда вставлять не нужно — он хранится в Supabase как секрет
// KP_API_KEY у Edge Function "kinopoisk-proxy". Сайт обращается к Kinopoisk.dev
// через эту функцию, а не напрямую из браузера. См. kinopoisk-proxy.ts.

export const KP_TYPES = ["movie", "tv-series", "cartoon", "anime", "animated-series", "tv-show"];

export const SECTIONS = [
  {key: "mylist", label: "Мой список"},
  {key: "catalog", label: "Каталог"},
  {key: "chat", label: "Чат"},
  {key: "messages", label: "Сообщения"},
  {key: "friends", label: "Друзья"}
];

export const TABS = [
  {key: "all", label: "Все"},
  {key: "want", label: "Хотим посмотреть"},
  {key: "watching", label: "Смотрим"},
  {key: "watched", label: "Посмотрели"}
];

export const STATUS_LABEL = {want: "Хотим посмотреть", watching: "Смотрим", watched: "Посмотрели"};
export const TYPE_LABEL = {
  movie: "Фильм", "tv-series": "Сериал", cartoon: "Мультфильм",
  anime: "Аниме", "animated-series": "Мультсериал", "tv-show": "Шоу"
};
