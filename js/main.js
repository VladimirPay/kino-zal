// Наш Кинозал — самая первая точка входа (подключена из index.html).
// Проверяет, что настройки Supabase заполнены и библиотека supabase-js
// загрузилась, и только после этого подключает остальной сайт (app.js).
// Так воспроизводится поведение старого однофайлового index.html, где при
// незаполненных настройках весь скрипт молча останавливался в начале.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

function showSetupNotice(text) {
  document.getElementById("setupNotice").hidden = false;
  if (text) document.querySelector("#setupNotice p").textContent = text;
}

if (!SUPABASE_URL || SUPABASE_URL.indexOf("ВСТАВЬТЕ") !== -1 ||
    !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.indexOf("ВСТАВЬТЕ") !== -1) {
  showSetupNotice();
} else if (!window.supabase || !window.supabase.createClient) {
  showSetupNotice("Не удалось загрузить библиотеку Supabase (проверьте интернет-соединение или отключите блокировщик скриптов) — обновите страницу.");
} else {
  import("./app.js").catch(function (e) {
    console.error(e);
    showSetupNotice("Ошибка загрузки сайта (" + e.message + ") — обновите страницу.");
  });
}
