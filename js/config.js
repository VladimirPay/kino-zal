// Наш Кинозал — настройки и общие справочники.
// Это единственное место, которое нужно трогать при смене проекта Supabase.

export const SUPABASE_URL = "https://fbewqeffdgrlyahetykx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_o-gkUyR979lyzb9w9W7i7g_463PhMki";
// Ключ ApiGet.ru сюда вставлять не нужно — он хранится в Supabase как секрет
// APIGET_KEY у Edge Function "kinopoisk-proxy". Сайт обращается к ApiGet.ru
// через эту функцию, а не напрямую из браузера. См. kinopoisk-proxy.ts.

export const KP_TYPES = ["movie", "tv-series", "cartoon", "anime", "animated-series", "tv-show"];

export const SECTIONS = [
  {key: "mylist", label: "Мой список"},
  {key: "catalog", label: "Каталог"},
  {key: "match", label: "Мэтч"},
  {key: "chat", label: "Чат"},
  {key: "messages", label: "Сообщения"},
  {key: "friends", label: "Друзья"},
  {key: "admin", label: "Управление", adminOnly: true}
];

export const TABS = [
  {key: "all", label: "Все"},
  {key: "want", label: "Хочу посмотреть"},
  {key: "watching", label: "Смотрю"},
  {key: "watched", label: "Просмотрено"}
];

export const STATUS_LABEL = {want: "Хочу посмотреть", watching: "Смотрю", watched: "Просмотрено"};

export const ADMIN_TABS = [
  {key: "users", label: "Пользователи"},
  {key: "titles", label: "Фильмы"},
  {key: "reports", label: "Жалобы"},
  {key: "apiLimits", label: "Лимиты API"},
  {key: "activityLog", label: "Журнал действий"}
];
export const TYPE_LABEL = {
  movie: "Фильм", "tv-series": "Сериал", cartoon: "Мультфильм",
  anime: "Аниме", "animated-series": "Мультсериал", "tv-show": "Шоу"
};
