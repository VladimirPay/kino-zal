// Наш Кинозал — минимальный service worker. Две задачи:
//  1) Формальное требование Chrome/Android для показа «Добавить на экран» —
//     без зарегистрированного service worker с обработчиком fetch сайт не
//     считается устанавливаемым PWA.
//  2) Кэширует СВОИ статические файлы (HTML/CSS/JS/иконки) — сайт открывается
//     заметно быстрее при повторных визитах и не остаётся совсем белым
//     экраном при плохой связи.
// Данные Supabase (список, чат, каталог и т.п.) НЕ кэшируются — это живые
// данные, их всегда нужно брать из сети. Сюда же относятся сторонние хосты
// (шрифты, cdn.jsdelivr) — сервис-воркер их не трогает вовсе, браузер
// обрабатывает их как обычно.
//
// ВАЖНО про обновления (было исправлено): раньше свои JS/CSS отдавались
// "сначала кэш, потом сеть" — значит, после деплоя новой версии открытая
// страница (и тем более установленное на телефон PWA-приложение, где нет
// привычки делать жёсткое обновление Ctrl+Shift+R, как на компьютере)
// продолжала выполнять СТАРЫЙ закэшированный код ещё один визит, пока кэш
// не обновится в фоне для СЛЕДУЮЩЕГО раза. Теперь свои файлы тоже отдаются
// "сначала сеть, при неудаче — кэш" (как index.html уже делал) — значит,
// как только есть связь, всегда выполняется самый свежий код без ручной
// очистки кэша/переустановки приложения. Плюс CACHE_NAME увеличен на единицу
// при каждом таком изменении логики кэша — это сразу подчищает старые,
// уже "залипшие" кэши у всех, кто их накопил до этого исправления.
var CACHE_NAME = "kinozal-shell-v2";
var SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // всё, что меняет данные — всегда напрямую в сеть

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // чужие хосты (шрифты, Supabase, cdn) — не трогаем

  // Переход по ссылке/обновление страницы — сеть в приоритете (чтобы сразу
  // видеть актуальный код после деплоя), а кэшированная версия — только как
  // запасной вариант при отсутствии связи.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(function () { return caches.match("./index.html"); })
    );
    return;
  }

  // Свои статические файлы — сначала сеть (чтобы после деплоя новый код
  // подхватывался сразу же, без ручной очистки кэша — см. комментарий про
  // CACHE_NAME выше), кэш — только запасной вариант, если сети нет вовсе.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
