// Наш Кинозал — клиент Supabase. Импортируется только после того, как
// main.js проверил, что настройки заполнены и библиотека supabase-js
// загрузилась (см. main.js) — поэтому здесь мы просто создаём клиент.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
