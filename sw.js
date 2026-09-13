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

var CACHE_NAME = "kinozal-shell-v1";
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

  // Свои статические файлы — сначала кэш (быстрее), затем сеть, с записью
  // свежего ответа в кэш на будущее.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
