// Наш Кинозал — вкладка «Каталог» (данные Кинопоиска через сервис ApiGet.ru,
// подключённый через прокси-функцию Supabase) и блок рекомендаций на
// вкладке «Мой список».
//
// Прямые запросы из браузера к apiget.ru блокируются политикой CORS, поэтому
// сайт обращается к собственной Edge Function "kinopoisk-proxy" в Supabase,
// а она уже сама (сервер-сервер, без CORS) ходит в ApiGet.ru с секретным
// ключом. См. файл kinopoisk-proxy.ts и инструкцию по установке. Раньше
// здесь стоял Kinopoisk.dev — перешли на ApiGet.ru, чтобы не упираться в
// дневной лимит запросов (см. ниже).
//
// Принцип рекомендаций (два источника, показываются вместе, дубликаты
// убираются):
//  1) «Социальный» сигнал (см. loadSocialRecs) — тайтлы, которые уже есть в
//     общей таблице titles и которые ваши друзья оценили на 4-5★ или
//     отметили «Просмотрено», а у вас их ещё нет. Ноль обращений к
//     ApiGet.ru — только свои данные в Supabase, поэтому этот источник
//     показывается даже если ApiGet.ru недоступен;
//  2) Жанровая эвристика — берём тайтлы из «Моего списка», которые сам
//     пользователь оценил на 4-5★ или отметил «Просмотрено», собираем их
//     жанры, берём самый частый — и просим у ApiGet.ru случайную подборку
//     этого жанра, из которой оставляем самые высокорейтинговые тайтлы,
//     которых ещё нет в личном списке.
// Если оба источника пусты — блок просто не показываем.
//
// ЭКОНОМИЯ ЗАПРОСОВ. У ApiGet.ru нет дневного лимита, но каждый успешный
// запрос стоит небольшую, но не нулевую сумму (0.01₽) — поэтому все три
// экономии, добавленные ещё во времена Kinopoisk.dev, здесь так же важны,
// просто цель сменилась с «не упереться в лимит» на «не тратить лишнее»:
//  1) поиск в каталоге запускается только по кнопке «Искать»/Enter (не на
//     каждое нажатие клавиши), плюс одинаковые повторные запросы в рамках
//     сессии берутся из памяти (catalogSearchCache);
//  2) блок рекомендаций пересчитывался бы заново при КАЖДОЙ загрузке «Моего
//     списка» — а loadMyList() вызывается очень часто: после любого своего
//     действия и через Realtime при действиях ДРУГИХ пользователей. Вместо
//     этого рекомендации кэшируются в sessionStorage на 12 часов и
//     пересчитываются заново только если реально изменился набор любимых
//     жанров;
//  3) успешные ответы ApiGet.ru дополнительно кладутся в общую таблицу
//     kp_cache — если кто-то из друзей уже искал то же самое (или у вас
//     совпали жанры рекомендаций) в последние несколько часов, запрос вообще
//     не уходит во внешний API, а берётся из своей базы (и не тратит деньги
//     повторно).
// Таблица kp_cache создаётся миграцией social-upgrade-2.sql; пока она не
// выполнена, весь код ниже просто работает как раньше (try/catch).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { KP_TYPES, TYPE_LABEL } from "./config.js";
import { escapeHtml, pluralRu, posterHtml, showStatus, writeSessionValue } from "./utils.js";
import { loadMyList } from "./mylist.js";
import { openTitleDetail } from "./titleDetail.js";
import { registerSectionLoader } from "./router.js";

// Сколько времени считать кэшированный ответ ApiGet.ru ещё свежим — разное
// для поиска (люди ищут разное и часто), для жанровой подборки (список
// топ-жанров и так пересчитывается редко) и для карточки одного тайтла
// (метаданные фильма практически не меняются).
var KP_CACHE_TTL_MS = { "search": 6 * 60 * 60 * 1000, "get-random": 24 * 60 * 60 * 1000, "get-info": 7 * 24 * 60 * 60 * 1000 };

function kpCacheKey(method, params) {
  var sorted = {};
  Object.keys(params || {}).sort().forEach(function (k) { sorted[k] = params[k]; });
  return method + "?" + JSON.stringify(sorted);
}

async function kpFetch(method, params) {
  var cacheKey = kpCacheKey(method, params);
  var ttl = KP_CACHE_TTL_MS[method] || 6 * 60 * 60 * 1000;

  // Сначала смотрим в общий кэш в базе — если кто-то (не обязательно вы)
  // уже делал такой же запрос недавно, ApiGet.ru вообще не трогаем (и не
  // тратим деньги повторно).
  try {
    var cacheRes = await sb.from("kp_cache").select("response,created_at").eq("cache_key", cacheKey).limit(1);
    if (!cacheRes.error && cacheRes.data && cacheRes.data.length) {
      var cached = cacheRes.data[0];
      if (Date.now() - new Date(cached.created_at).getTime() < ttl) return cached.response;
    }
  } catch (e) { /* таблицы kp_cache ещё нет (миграция не выполнена) — просто идём дальше как раньше */ }

  var res = await sb.functions.invoke("kinopoisk-proxy", { body: { method: method, params: params || {} } });
  if (res.error) {
    await logKpUsage(method, false, null);
    throw new Error("ApiGet.ru: не удалось обратиться к серверу (" + (res.error.message || res.error) + ")");
  }
  var data = res.data;
  await logKpUsage(method, !!(data && data.ok), data ? data.status : null);
  if (!data || !data.ok) {
    var detail = (data && data.message) ? " — " + data.message : "";
    throw new Error("ApiGet.ru: ошибка" + (data && data.status != null ? " (код " + data.status + ")" : "") + detail);
  }
  // Сохраняем успешный ответ в общий кэш на будущее (для себя и для других —
  // это не только быстрее, но и буквально экономит деньги на счету).
  sb.from("kp_cache").upsert({ cache_key: cacheKey, response: data.body, created_at: new Date().toISOString() }, { onConflict: "cache_key" })
    .then(function (r) { if (r.error) console.warn("kp_cache:", r.error.message); });
  return data.body;
}

// Пишем счётчик обращений к ApiGet.ru для админского раздела «Лимиты API»
// (там же выводится примерная сумма — 0.01₽ за успешный запрос) — по одной
// строке на запрос. ВАЖНО: дожидаемся завершения записи (await), а не
// "запустил и забыл" — иначе если сразу после запроса закрыть вкладку или
// перезагрузить страницу, запись может не успеть сохраниться, и счётчик в
// «Управление» покажет МЕНЬШЕ реальных запросов, чем было на самом деле.
// Если таблица kp_api_log ещё не создана (миграция social-upgrade-2.sql не
// выполнена) — просто молча пропускаем, это не должно мешать самому поиску.
async function logKpUsage(method, ok, status) {
  try {
    var res = await sb.from("kp_api_log").insert({user_id: state.myProfile.id, path: method, ok: ok, status: status});
    if (res.error) console.warn("kp_api_log:", res.error.message);
  } catch (e) { console.warn("kp_api_log:", e.message); }
}

// ApiGet.ru отдаёт жанры сразу названиями по-русски (не числовыми id), но
// ТОЛЬКО в ответе метода get-info (подробная карточка одного тайтла) — в
// облегчённых списках (search/get-random/list) поля жанра нет вовсе. Поэтому
// у только что найденных, но ещё не добавленных тайтлов жанр может быть
// пустым — он подтягивается отдельным запросом get-info в момент реального
// добавления в список (см. ensureTitleFromKp), и с этого момента живёт в
// таблице titles уже навсегда, не требуя повторных запросов.
// У сериалов ApiGet.ru (вслед за Кинопоиском) год нередко отдаёт не одним
// числом, а диапазоном строкой ("2019-2021", "2019-…" для ещё идущих
// сериалов) — если положить такую строку в year как есть, сортировка «Сначала
// новые» (арифметическое вычитание b.year - a.year) на подобных значениях
// превращается в NaN и перестаёт что-либо упорядочивать: смешанные в одной
// подборке фильмы (чистое число) и сериалы (диапазон) выглядят так, будто
// сортировка по году вообще не работает. Поэтому всегда вытаскиваем из
// значения года первое 4-значное число, а не полагаемся на то, что оно уже
// число.
function parseYearValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  var m = String(raw).match(/\d{4}/);
  return m ? parseInt(m[0], 10) : null;
}

// Разбивка «Фильмы»/«Сериалы» в каталоге — грубая эвристика по нашему полю
// mediaType (см. normalizeApiGetItem ниже): не отдельный запрос к ApiGet.ru,
// просто переключатель отображения уже загруженной подборки.
function isSeriesMediaType(mediaType) {
  return mediaType === "tv-series" || mediaType === "animated-series" || mediaType === "tv-show";
}

function normalizeApiGetItem(raw) {
  var posterUrl = raw.poster_big || raw.poster_small || null;
  var genreNames = Array.isArray(raw.genre) ? raw.genre.filter(Boolean) : [];
  var voteAverage = (raw.rating && raw.rating.kinopoisk && typeof raw.rating.kinopoisk.value === "number")
    ? raw.rating.kinopoisk.value : null;
  if (voteAverage) voteAverage = Math.round(voteAverage * 10) / 10;
  var mediaType = raw.type === "series" ? "tv-series" : (KP_TYPES.indexOf(raw.type) !== -1 ? raw.type : "movie");
  return {
    kpId: raw.kinopoisk_id,
    mediaType: mediaType,
    title: raw.title_ru || raw.title_en || "Без названия",
    year: parseYearValue(raw.year),
    genreNames: genreNames,
    genre: genreNames.slice(0, 3).join(", ") || null,
    overview: raw.description || raw.tagline || null,
    posterUrl: posterUrl,
    voteAverage: voteAverage || null
  };
}

// Поиск запускается кнопкой «Искать»/Enter, а не на каждое нажатие клавиши —
// это самая большая экономия запросов (и денег). Очистка поля возвращает
// случайную подборку по умолчанию (см. loadCatalogDefault ниже) — каталог
// больше не остаётся пустым, пока не начнёшь искать.
document.getElementById("catalogSearchForm").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var q = document.getElementById("catalogSearch").value.trim();
  if (!q) { loadCatalogDefault(); return; }
  searchKp(q);
});
document.getElementById("catalogSearch").addEventListener("input", function (ev) {
  if (!ev.target.value.trim()) loadCatalogDefault();
});

// Одинаковый повторный поиск в рамках одной вкладки (например, случайно
// нажали «Искать» дважды, или вернулись к тому же запросу) берём из памяти,
// не тратя запрос повторно.
var catalogSearchCache = {};

async function searchKp(query) {
  state.catalogMode = "search";
  var cacheKey = query.trim().toLowerCase();
  document.getElementById("catalogGrid").innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Ищем…</p>';
  if (catalogSearchCache[cacheKey]) {
    state.catalogResults = catalogSearchCache[cacheKey];
    applyCatalogSortAndRender();
    return;
  }
  try {
    var res = await kpFetch("search", {query: query, limit: 20});
    state.catalogResults = (res.results || []).map(normalizeApiGetItem);
    catalogSearchCache[cacheKey] = state.catalogResults;
  } catch (e) {
    state.catalogResults = [];
    showStatus("Не удалось обратиться к ApiGet.ru: " + e.message, true);
  }
  applyCatalogSortAndRender();
}

// ---------- Подборка по умолчанию (каталог больше не пустует) ----------
// Раньше вкладка «Каталог» показывала только приглашение «начните искать» —
// теперь при открытии сразу подгружается подборка, чтобы было что
// посмотреть/пролистать, не печатая запрос.
//
// ПОЧЕМУ НЕ ПРОСТО get-random БЕЗ ФИЛЬТРОВ. Первая версия делала один запрос
// get-random без фильтров — а без фильтра он тянет случайные тайтлы из ВСЕЙ
// базы Кинопоиска (сотни тысяч штук), включая крайне нишевые и
// малорейтинговые — отсюда и жалоба «выпадают какие-то не пойми какие
// фильмы». Кроме того, у ApiGet.ru жёсткий лимит count 1–20 за один запрос
// (раньше здесь стояло 30 — с превышением документированного максимума
// нельзя быть уверенным, что сервис не обрежет или не отклонит запрос).
//
// У ApiGet.ru нет отдельного метода «популярное»/«тренды» (только
// list/search/get-random/get-updates — без сортировки по рейтингу или
// количеству голосов на стороне сервера). Поэтому подборку «на что все
// сейчас смотрят» имитируем сами: делаем НЕСКОЛЬКО запросов get-random по
// самым массовым жанрам (по одному на жанр, в пределах лимита count=20
// каждый), объединяем результаты и оставляем только тайтлы с реальным и
// достаточно высоким рейтингом Кинопоиска — это и есть прокси «популярности»
// при отсутствии готового рейтинга просмотров/поиска у самого ApiGet.ru.
//
// ЭКОНОМИЯ. Каждая жанровая комбинация кэшируется в общей таблице kp_cache
// отдельно (см. kpCacheKey) на 24 часа (KP_CACHE_TTL_MS["get-random"]) и это
// кэш ОБЩИЙ для всех пользователей сайта — то есть по факту это всего
// ~5 успешных запросов (5 копеек) на весь сайт раз в сутки, а не при каждом
// открытии вкладки каждым человеком. sessionStorage-кэш ниже — просто чтобы
// не дёргать даже Supabase-кэш при каждом повторном открытии вкладки в
// рамках одной сессии браузера.
var CATALOG_DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
var CATALOG_POPULAR_GENRES = ["драма", "боевик", "комедия", "фантастика", "триллер", "мультфильм"];
var CATALOG_POPULAR_MIN_RATING = 6.5;

function readCatalogDefaultCache() {
  try { return JSON.parse(sessionStorage.getItem("kz_catalog_default_cache") || "null"); } catch (e) { return null; }
}
function writeCatalogDefaultCache(items) {
  try { sessionStorage.setItem("kz_catalog_default_cache", JSON.stringify({ fetchedAt: Date.now(), items: items })); } catch (e) {}
}

async function loadCatalogDefault() {
  state.catalogMode = "browse";
  document.getElementById("catalogSearch").value = "";
  var cache = readCatalogDefaultCache();
  if (cache && (Date.now() - cache.fetchedAt) < CATALOG_DEFAULT_CACHE_TTL_MS) {
    state.catalogResults = cache.items;
    applyCatalogSortAndRender();
    return;
  }
  document.getElementById("catalogGrid").innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Загружаем подборку…</p>';
  try {
    // Каждый жанр запрашивается отдельно — если один запрос не удался
    // (например, именно эта жанровая связка ни разу не кэширована и
    // ApiGet.ru прямо сейчас недоступен), остальные жанры всё равно
    // подгрузятся, просто подборка выйдет чуть меньше.
    var responses = await Promise.all(CATALOG_POPULAR_GENRES.map(function (g) {
      return kpFetch("get-random", { genre: g, count: 20 }).catch(function () { return null; });
    }));
    var seen = {};
    var pool = [];
    responses.forEach(function (res) {
      if (!res || !res.results) return;
      res.results.map(normalizeApiGetItem).forEach(function (item) {
        var key = item.mediaType + ":" + item.kpId;
        if (!seen[key]) { seen[key] = true; pool.push(item); }
      });
    });
    if (!pool.length) {
      state.catalogResults = [];
      showStatus("Не удалось загрузить подборку из ApiGet.ru — попробуйте открыть вкладку заново чуть позже.", true);
      applyCatalogSortAndRender();
      return;
    }
    // Оставляем только достаточно высокорейтинговые тайтлы — это и есть
    // «популярное» при отсутствии отдельного метода у ApiGet.ru. Если
    // фильтр слишком жёсткий (мало что кэшировано с высоким рейтингом прямо
    // сейчас) — постепенно смягчаем его, лишь бы каталог не остался пустым.
    var popular = pool.filter(function (it) { return it.voteAverage != null && it.voteAverage >= CATALOG_POPULAR_MIN_RATING; });
    if (popular.length < 10) popular = pool.filter(function (it) { return it.voteAverage != null; });
    if (popular.length < 5) popular = pool;
    popular.sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); });
    var items = popular.slice(0, 40);
    state.catalogResults = items;
    writeCatalogDefaultCache(items);
  } catch (e) {
    state.catalogResults = [];
    showStatus("Не удалось загрузить подборку из ApiGet.ru: " + e.message, true);
  }
  applyCatalogSortAndRender();
}

registerSectionLoader("catalog", function () {
  // Не сбрасываем молча уже показанный активный поиск (например, если
  // человек что-то искал, ушёл на другую вкладку и вернулся обратно) —
  // подборка по умолчанию грузится только если каталог сейчас пуст и это не
  // осознанный поиск с нулевым результатом.
  if (!state.catalogResults.length && state.catalogMode !== "search") loadCatalogDefault();
});

// ---------- Сортировка (полностью на клиенте, без обращений к ApiGet.ru) ----------
function sortCatalogResults() {
  var sortKey = document.getElementById("catalogSort").value;
  var arr = state.catalogResults;
  if (sortKey === "rating") {
    arr.sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); });
  } else if (sortKey === "year") {
    arr.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
  } else if (sortKey === "alpha") {
    arr.sort(function (a, b) { return a.title.localeCompare(b.title, "ru"); });
  } else if (sortKey === "shuffle") {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
  }
}
function applyCatalogSortAndRender() {
  sortCatalogResults();
  renderCatalogGrid();
}
document.getElementById("catalogSort").addEventListener("change", function () {
  document.getElementById("catalogShuffleBtn").hidden = (this.value !== "shuffle");
  applyCatalogSortAndRender();
});
document.getElementById("catalogShuffleBtn").addEventListener("click", function () {
  applyCatalogSortAndRender();
});

function catalogCardHtml(item, idx) {
  return '' +
    '<article class="card has-poster" data-idx="' + idx + '">' +
      '<div class="poster-wrap">' + posterHtml(item.posterUrl) + '</div>' +
      '<div class="top"><span class="badge">' + TYPE_LABEL[item.mediaType] + '</span>' +
      (item.voteAverage ? '<span class="badge mono">★ ' + item.voteAverage + '</span>' : '') +
      '</div>' +
      '<h3>' + escapeHtml(item.title) + '</h3>' +
      '<div class="meta mono">' + (item.year || "—") + (item.genre ? ' · ' + escapeHtml(item.genre) : '') + '</div>' +
      (item.overview ? '<div class="overview-clip">' + escapeHtml(item.overview) + '</div>' : '') +
      '<button class="btn primary small" type="button" data-add-idx="' + idx + '" style="margin-top:auto;">Добавить в список</button>' +
    '</article>';
}

// Вкладки «Все/Фильмы/Сериалы» — только фильтр отображения уже загруженной
// подборки (см. isSeriesMediaType), без обращений к ApiGet.ru. Счётчики в
// скобках считаются от текущего state.catalogResults, поэтому обновляются
// сами при каждой перерисовке (новый поиск/подборка, смена сортировки).
function renderCatalogTypeTabs() {
  var el = document.getElementById("catalogTypeTabs");
  if (!el) return;
  var seriesCount = state.catalogResults.filter(function (it) { return isSeriesMediaType(it.mediaType); }).length;
  var defs = [
    { key: "all", label: "Все", count: state.catalogResults.length },
    { key: "movie", label: "Фильмы", count: state.catalogResults.length - seriesCount },
    { key: "series", label: "Сериалы", count: seriesCount }
  ];
  el.innerHTML = defs.map(function (d) {
    return '<button type="button" data-catalog-type="' + d.key + '" class="' + (state.catalogTypeFilter === d.key ? "active" : "") + '">' + d.label + ' (' + d.count + ')</button>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () {
      state.catalogTypeFilter = btn.getAttribute("data-catalog-type");
      writeSessionValue("kz_catalog_type", state.catalogTypeFilter);
      renderCatalogGrid();
    });
  });
}

function catalogTypeMatches(item) {
  if (state.catalogTypeFilter === "movie") return !isSeriesMediaType(item.mediaType);
  if (state.catalogTypeFilter === "series") return isSeriesMediaType(item.mediaType);
  return true;
}

function renderCatalogGrid() {
  var grid = document.getElementById("catalogGrid");
  renderCatalogTypeTabs();
  // Индекс каждой карточки (data-idx) должен указывать на позицию тайтла в
  // ПОЛНОМ state.catalogResults (а не в отфильтрованном по типу списке) —
  // иначе клики "Добавить"/открыть карточку после включения фильтра
  // "Фильмы"/"Сериалы" попадут не в тот тайтл.
  var visible = [];
  state.catalogResults.forEach(function (item, idx) {
    if (catalogTypeMatches(item)) visible.push({ item: item, idx: idx });
  });
  document.getElementById("catalogCount").textContent = visible.length
    ? visible.length + " " + pluralRu(visible.length, ["результат", "результата", "результатов"])
    : "";
  if (!state.catalogResults.length) {
    grid.innerHTML = '<p class="empty-note" style="grid-column:1/-1;">' +
      (state.catalogMode === "search" ? "Ничего не нашлось — попробуйте другой запрос." : "Не удалось загрузить подборку — попробуйте открыть вкладку заново чуть позже.") +
      '</p>';
    return;
  }
  if (!visible.length) {
    grid.innerHTML = '<p class="empty-note" style="grid-column:1/-1;">В текущей подборке нет тайтлов такого типа — попробуйте другой фильтр «Все/Фильмы/Сериалы».</p>';
    return;
  }
  grid.innerHTML = visible.map(function (pair) { return catalogCardHtml(pair.item, pair.idx); }).join("");
  // Клик по карточке целиком открывает подробную карточку тайтла (как в
  // «Моём списке»); клик по самой кнопке — быстрое добавление без открытия
  // диалога, поэтому у кнопки отдельный обработчик со stopPropagation.
  Array.prototype.forEach.call(grid.querySelectorAll(".card"), function (card) {
    card.addEventListener("click", async function () {
      var item = state.catalogResults[parseInt(card.getAttribute("data-idx"), 10)];
      if (!item) return;
      try {
        var row = await ensureTitleFromKp(item);
        openTitleDetail(row.id);
      } catch (e) {
        showStatus("Не удалось открыть карточку: " + e.message, true);
      }
    });
  });
  Array.prototype.forEach.call(grid.querySelectorAll("[data-add-idx]"), function (btn) {
    btn.addEventListener("click", async function (ev) {
      ev.stopPropagation();
      var item = state.catalogResults[parseInt(btn.getAttribute("data-add-idx"), 10)];
      btn.disabled = true; btn.textContent = "Добавляем…";
      try {
        await addFromKp(item);
        btn.textContent = "Добавлено ✓";
        showStatus('«' + item.title + '» добавлено в «Хочу посмотреть»');
      } catch (e) {
        btn.disabled = false; btn.textContent = "Добавить в список";
        showStatus("Не удалось добавить: " + e.message, true);
      }
    });
  });
}

// Если тайтл впервые добавляется в общий каталог сайта (ещё не было ни у
// кого), а исходная карточка item пришла из облегчённого списка (поиск,
// подборка по жанру) — жанра в ней ещё нет (см. комментарий у
// normalizeApiGetItem). Тогда один раз досылаем get-info за полной
// карточкой, чтобы жанр сохранился в общей таблице titles навсегда и не
// пришлось запрашивать его снова — ни вам, ни другим участникам сайта,
// которые впоследствии откроют этот же тайтл. Раз уж всё равно запрашиваем
// полную карточку — заодно забираем и ссылку на трейлер (см. ensureTrailerUrl
// ниже), чтобы при первом же открытии карточки тайтла не пришлось делать для
// неё ещё один отдельный (и платный) запрос get-info.
async function enrichWithGenreIfMissing(item) {
  if (item.genreNames && item.genreNames.length) return item;
  try {
    var full = await kpFetch("get-info", { kinopoisk_id: item.kpId });
    var enriched = normalizeApiGetItem(full);
    var trailerUrl = (full.trailers && full.trailers[0] && full.trailers[0].url) || null;
    return Object.assign({}, item, {
      genreNames: enriched.genreNames.length ? enriched.genreNames : item.genreNames,
      genre: enriched.genre || item.genre,
      overview: item.overview || enriched.overview,
      posterUrl: item.posterUrl || enriched.posterUrl,
      trailerUrl: trailerUrl
    });
  } catch (e) {
    // Не удалось получить полную карточку (например, обращение к ApiGet.ru
    // прямо сейчас не удалось) — не страшно, добавляем без жанра и трейлера,
    // жанр просто не будет учитываться в рекомендациях, а трейлер (как и для
    // любого тайтла, добавленного раньше этой функции) подтянется позже, при
    // первом открытии карточки — см. ensureTrailerUrl.
    return item;
  }
}

async function ensureTitleFromKp(item) {
  const existing = await sb.from("titles").select("*").eq("kp_id", item.kpId).eq("media_type", item.mediaType).limit(1);
  if (existing.error) throw existing.error;
  if (existing.data && existing.data.length) return existing.data[0];
  var full = await enrichWithGenreIfMissing(item);
  const payload = {
    kp_id: full.kpId, media_type: full.mediaType, title: full.title, year: full.year,
    genre: full.genre, genre_names: full.genreNames || [], overview: full.overview,
    poster_url: full.posterUrl, kp_rating: full.voteAverage, trailer_url: full.trailerUrl || null,
    added_by: state.myProfile.id
  };
  const ins = await sb.from("titles").insert(payload).select().limit(1);
  if (ins.error) {
    var retry = await sb.from("titles").select("*").eq("kp_id", item.kpId).eq("media_type", item.mediaType).limit(1);
    if (!retry.error && retry.data && retry.data.length) return retry.data[0];
    throw ins.error;
  }
  return ins.data[0];
}

// Ссылка на трейлер — как и жанр (см. enrichWithGenreIfMissing), ApiGet.ru
// отдаёт её только в подробной карточке get-info, а не в облегчённых
// списках поиска/подборки. Поэтому запрашиваем её один раз, лениво — только
// когда кто-то реально открывает карточку тайтла, у которого ссылки ещё нет
// (см. titleDetail.js) — и сохраняем в titles.trailer_url навсегда через
// узкую RPC-функцию set_title_trailer (см. social-upgrade-4.sql): она умеет
// заполнить только это одно поле, даже если сам тайтл в своё время добавил
// не текущий пользователь.
export async function ensureTrailerUrl(titleRow) {
  if (titleRow.trailer_url || !titleRow.kp_id) return titleRow.trailer_url || null;
  try {
    var full = await kpFetch("get-info", { kinopoisk_id: titleRow.kp_id });
    var trailerUrl = (full.trailers && full.trailers[0] && full.trailers[0].url) || null;
    if (trailerUrl) {
      var rpcRes = await sb.rpc("set_title_trailer", { p_title_id: titleRow.id, p_trailer_url: trailerUrl });
      if (rpcRes.error) console.warn("set_title_trailer:", rpcRes.error.message);
    }
    return trailerUrl;
  } catch (e) {
    return null; // ApiGet.ru недоступен прямо сейчас — не страшно, просто нет ссылки на трейлер пока что.
  }
}

async function addFromKp(item) {
  var row = await ensureTitleFromKp(item);
  const { error } = await sb.from("user_titles").upsert(
    {user_id: state.myProfile.id, title_id: row.id, status: "want"},
    {onConflict: "user_id,title_id", ignoreDuplicates: true}
  );
  if (error) throw error;
  loadMyList();
}

// ---------- Рекомендации ----------

// loadMyList() (а значит и loadRecommendations()) вызывается очень часто —
// после любого своего действия и через Realtime при действиях ДРУГИХ
// пользователей. Без кэша это означало обращение к Kinopoisk.dev почти на
// каждый чих. Кэшируем на 12 часов в sessionStorage и помечаем "сигнатурой"
// набора любимых жанров — как только вкус пользователя реально меняется
// (например, оценил ещё один фильм нового жанра), кэш сам инвалидируется.
var RECS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
function readRecsCache() {
  try { return JSON.parse(sessionStorage.getItem("kz_recs_cache") || "null"); } catch (e) { return null; }
}
function writeRecsCache(obj) {
  try { sessionStorage.setItem("kz_recs_cache", JSON.stringify(obj)); } catch (e) {}
}

// «Социальный» сигнал — тайтлы, которые уже есть в общей таблице titles
// (то есть кто-то из вас их уже искал и добавлял — ни одного нового запроса
// к Kinopoisk.dev), которые ваши друзья оценили на 4-5★ или отметили
// «Просмотрено», а у вас в списке их ещё нет. Это самая надёжная и самая
// дешёвая (ноль запросов к внешнему API) рекомендация — свой круг людей со
// схожими вкусами обычно советует точнее, чем жанровая эвристика ниже.
async function loadSocialRecs(haveIds, dismissed) {
  try {
    var frRes = await sb.from("friend_requests").select("from_user,to_user").eq("status", "accepted")
      .or("from_user.eq." + state.myProfile.id + ",to_user.eq." + state.myProfile.id);
    if (frRes.error) return [];
    var friendIds = (frRes.data || []).map(function (r) { return r.from_user === state.myProfile.id ? r.to_user : r.from_user; });
    if (!friendIds.length) return [];

    var [ratingsRes, utRes] = await Promise.all([
      sb.from("ratings").select("title_id,user_id,value").in("user_id", friendIds).gte("value", 4),
      sb.from("user_titles").select("title_id,user_id").in("user_id", friendIds).eq("status", "watched")
    ]);
    if (ratingsRes.error || utRes.error) return [];

    var likedBy = {}; // title_id -> {userId: true}
    (ratingsRes.data || []).forEach(function (r) { (likedBy[r.title_id] = likedBy[r.title_id] || {})[r.user_id] = true; });
    (utRes.data || []).forEach(function (r) { (likedBy[r.title_id] = likedBy[r.title_id] || {})[r.user_id] = true; });
    var titleIds = Object.keys(likedBy);
    if (!titleIds.length) return [];

    var tRes = await sb.from("titles").select("*").in("id", titleIds);
    if (tRes.error) return [];
    return (tRes.data || [])
      .filter(function (t) { return t.kp_id; })
      .map(function (t) {
        var friendIdsForTitle = Object.keys(likedBy[t.id] || {});
        var friendNames = friendIdsForTitle.map(function (uid) { return (state.profilesById[uid] || {}).display_name; }).filter(Boolean);
        var item = normalizeKpItemFromTitleRow(t);
        item.social = { count: friendIdsForTitle.length, names: friendNames };
        return item;
      })
      .filter(function (it) { return !haveIds[it.mediaType + ":" + it.kpId] && !dismissed[it.mediaType + ":" + it.kpId]; })
      .sort(function (a, b) { return b.social.count - a.social.count; });
  } catch (e) { return []; }
}

function normalizeKpItemFromTitleRow(t) {
  return {
    kpId: t.kp_id, mediaType: t.media_type, title: t.title, year: parseYearValue(t.year),
    genreNames: t.genre_names || [], genre: t.genre, overview: t.overview,
    posterUrl: t.poster_url, voteAverage: t.kp_rating
  };
}

export async function loadRecommendations() {
  var row = document.getElementById("recsRow");
  var haveIds = {};
  state.myTitles.forEach(function (ut) { if (ut.titles.kp_id) haveIds[ut.titles.media_type + ":" + ut.titles.kp_id] = true; });

  // Тайтлы, которые пользователь явно скрыл кнопкой «Не интересно» — не
  // предлагаем их снова. Если таблицы ещё нет (миграция не выполнена),
  // просто считаем, что скрытых нет.
  var dismissed = {};
  try {
    var dRes = await sb.from("dismissed_recommendations").select("kp_id,media_type").eq("user_id", state.myProfile.id);
    (dRes.data || []).forEach(function (d) { dismissed[d.media_type + ":" + d.kp_id] = true; });
  } catch (e) {}

  function finalize(rawItems) {
    return rawItems.filter(function (it) { return !haveIds[it.mediaType + ":" + it.kpId] && !dismissed[it.mediaType + ":" + it.kpId]; });
  }

  function mergeAndRender(socialItems, genreItems) {
    var seen = {}, merged = [];
    socialItems.forEach(function (it) { var k = it.mediaType + ":" + it.kpId; if (!seen[k]) { seen[k] = true; merged.push(it); } });
    genreItems.forEach(function (it) { var k = it.mediaType + ":" + it.kpId; if (!seen[k]) { seen[k] = true; merged.push(it); } });
    merged = merged.slice(0, 10);
    if (!merged.length) { row.hidden = true; return; }
    row.hidden = false;
    renderRecsStrip(merged);
  }

  var socialItems = await loadSocialRecs(haveIds, dismissed);

  var likedGenres = {};
  state.myTitles.forEach(function (ut) {
    var t = ut.titles;
    var mine = (t.ratings || []).find(function (r) { return r.user_id === state.myProfile.id; });
    var liked = (mine && mine.value >= 4) || ut.status === 'watched';
    if (liked && t.genre_names) {
      t.genre_names.forEach(function (g) { likedGenres[g] = (likedGenres[g] || 0) + 1; });
    }
  });
  // ApiGet.ru принимает только один жанр за раз в get-random — берём самый
  // частый среди понравившихся, второй по частоте в этом запросе не участвует
  // (он всё равно почти всегда перекрывается социальными рекомендациями).
  var topGenres = Object.keys(likedGenres).sort(function (a, b) { return likedGenres[b] - likedGenres[a]; }).slice(0, 2);

  if (!topGenres.length) {
    // Нет данных для жанровой эвристики (список пуст или ничего не оценено
    // высоко) — но социальные рекомендации от друзей от этого не зависят.
    mergeAndRender(socialItems, []);
    return;
  }
  var signature = topGenres.slice().sort().join(",");

  var cache = readRecsCache();
  if (cache && cache.signature === signature && (Date.now() - cache.fetchedAt) < RECS_CACHE_TTL_MS) {
    mergeAndRender(socialItems, finalize(cache.items));
    return;
  }

  try {
    // get-random отдаёт случайную выборку (не отсортированную по рейтингу),
    // поэтому просим с запасом и сортируем сами, оставляя самые
    // высокорейтинговые — как раньше делал Kinopoisk.dev через sortField.
    var res = await kpFetch("get-random", { genre: topGenres[0], count: 20 });
    var rawItems = (res.results || [])
      .map(normalizeApiGetItem)
      .sort(function (a, b) { return (b.voteAverage || 0) - (a.voteAverage || 0); });
    writeRecsCache({ signature: signature, fetchedAt: Date.now(), items: rawItems });
    mergeAndRender(socialItems, finalize(rawItems));
  } catch (e) {
    // ApiGet.ru недоступен — социальные рекомендации всё равно можно
    // показать, они не зависят от внешнего API.
    mergeAndRender(socialItems, []);
  }
}

function renderRecsStrip(items) {
  document.getElementById("recsStrip").innerHTML = items.map(function (item, idx) {
    var socialBadge = "";
    if (item.social && item.social.count) {
      var names = item.social.names.slice(0, 2).join(", ");
      var extra = item.social.count > item.social.names.length ? (" +" + (item.social.count - item.social.names.length)) : "";
      socialBadge = '<div class="rec-social">❤ ' + escapeHtml(names || "друзьям") + escapeHtml(extra) + '</div>';
    }
    return '<div class="rec-card" data-rec-idx="' + idx + '">' +
      posterHtml(item.posterUrl) +
      socialBadge +
      '<div class="rec-title">' + escapeHtml(item.title) + '</div>' +
      '<button class="btn small" type="button" data-rec-add="' + idx + '">+ В список</button>' +
      '<button class="btn small linklike" type="button" data-rec-dismiss="' + idx + '" style="width:100%;">Не интересно ✕</button>' +
    '</div>';
  }).join("");
  var strip = document.getElementById("recsStrip");
  Array.prototype.forEach.call(strip.querySelectorAll(".rec-card"), function (card) {
    card.addEventListener("click", async function () {
      var item = items[parseInt(card.getAttribute("data-rec-idx"), 10)];
      try {
        var titleRow = await ensureTitleFromKp(item);
        openTitleDetail(titleRow.id);
      } catch (e) {
        showStatus("Не удалось открыть карточку: " + e.message, true);
      }
    });
  });
  Array.prototype.forEach.call(strip.querySelectorAll("[data-rec-add]"), function (btn) {
    btn.addEventListener("click", async function (ev) {
      ev.stopPropagation();
      var item = items[parseInt(btn.getAttribute("data-rec-add"), 10)];
      btn.disabled = true; btn.textContent = "…";
      try { await addFromKp(item); btn.textContent = "Добавлено ✓"; }
      catch (e) { btn.disabled = false; btn.textContent = "+ В список"; showStatus("Ошибка: " + e.message, true); }
    });
  });
  Array.prototype.forEach.call(strip.querySelectorAll("[data-rec-dismiss]"), function (btn) {
    btn.addEventListener("click", async function (ev) {
      ev.stopPropagation();
      var item = items[parseInt(btn.getAttribute("data-rec-dismiss"), 10)];
      var card = btn.closest(".rec-card");
      card.style.opacity = "0.4"; btn.disabled = true;
      const { error } = await sb.from("dismissed_recommendations")
        .upsert({user_id: state.myProfile.id, kp_id: item.kpId, media_type: item.mediaType}, {onConflict: "user_id,kp_id,media_type"});
      if (error) { showStatus("Не удалось скрыть рекомендацию: " + error.message, true); card.style.opacity = ""; btn.disabled = false; return; }
      card.remove();
      if (!strip.querySelector(".rec-card")) document.getElementById("recsRow").hidden = true;
    });
  });
}
