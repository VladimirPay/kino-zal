// Наш Кинозал — вкладка «Каталог» (Kinopoisk.dev, через прокси-функцию
// Supabase) и блок рекомендаций на вкладке «Мой список».
//
// Прямые запросы из браузера к api.kinopoisk.dev блокируются политикой CORS,
// поэтому сайт обращается к собственной Edge Function "kinopoisk-proxy" в
// Supabase, а она уже сама (сервер-сервер, без CORS) ходит в Kinopoisk.dev
// с секретным ключом. См. файл kinopoisk-proxy.ts и инструкцию по установке.
//
// Принцип рекомендаций: берём тайтлы из «Моего списка», которые пользователь
// оценил на 4-5 звёзд или отметил «Просмотрено», собираем их жанры и берём
// два самых частых — и просим у Kinopoisk.dev высокорейтинговые (6.5+) тайтлы
// этих жанров, которых ещё нет в личном списке. Если понравившихся жанров
// нет (список пуст или ничего не оценено высоко) — блок просто не показываем.
//
// ЭКОНОМИЯ ЛИМИТА ЗАПРОСОВ (бесплатный тариф Kinopoisk.dev — около 200
// запросов в сутки на весь сайт). Раньше он расходовался намного быстрее,
// чем кажется на глаз, по трём причинам — и все три здесь устранены:
//  1) поиск в каталоге раньше слался на каждое нажатие клавиши (с задержкой
//     350мс) — теперь только по кнопке «Искать»/Enter, плюс одинаковые
//     повторные запросы в рамках сессии берутся из памяти (catalogSearchCache);
//  2) блок рекомендаций пересчитывался заново при КАЖДОЙ загрузке «Моего
//     списка» — а loadMyList() вызывается очень часто: после любого действия
//     (оценка, статус, комментарий) и через Realtime при действиях ДРУГИХ
//     пользователей. Теперь рекомендации кэшируются в sessionStorage на 12
//     часов и пересчитываются заново только если реально изменился набор
//     любимых жанров;
//  3) ответы Kinopoisk.dev дополнительно кладутся в общую таблицу kp_cache —
//     если кто-то из друзей уже искал то же самое (или у вас совпали жанры
//     рекомендаций) в последние несколько часов, запрос вообще не уходит во
//     внешний API, а берётся из своей базы.
// Таблица kp_cache создаётся миграцией social-upgrade-2.sql; пока она не
// выполнена, весь код ниже просто работает как раньше (try/catch).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { KP_TYPES, TYPE_LABEL } from "./config.js";
import { escapeHtml, pluralRu, posterHtml, showStatus } from "./utils.js";
import { loadMyList } from "./mylist.js";
import { openTitleDetail } from "./titleDetail.js";

// Сколько времени считать кэшированный ответ Kinopoisk.dev ещё свежим —
// разное для поиска (люди ищут разное и часто) и для рекомендаций (список
// топ-жанров и так пересчитывается редко).
var KP_CACHE_TTL_MS = { "/movie/search": 6 * 60 * 60 * 1000, "/movie": 24 * 60 * 60 * 1000 };

function kpCacheKey(path, params) {
  var sorted = {};
  Object.keys(params || {}).sort().forEach(function (k) { sorted[k] = params[k]; });
  return path + "?" + JSON.stringify(sorted);
}

async function kpFetch(path, params) {
  var cacheKey = kpCacheKey(path, params);
  var ttl = KP_CACHE_TTL_MS[path] || 6 * 60 * 60 * 1000;

  // Сначала смотрим в общий кэш в базе — если кто-то (не обязательно вы)
  // уже делал такой же запрос недавно, Kinopoisk.dev вообще не трогаем.
  try {
    var cacheRes = await sb.from("kp_cache").select("response,created_at").eq("cache_key", cacheKey).limit(1);
    if (!cacheRes.error && cacheRes.data && cacheRes.data.length) {
      var cached = cacheRes.data[0];
      if (Date.now() - new Date(cached.created_at).getTime() < ttl) return cached.response;
    }
  } catch (e) { /* таблицы kp_cache ещё нет (миграция не выполнена) — просто идём дальше как раньше */ }

  var res = await sb.functions.invoke("kinopoisk-proxy", { body: { path: path, params: params || {} } });
  if (res.error) {
    logKpUsage(path, false, null);
    throw new Error("Kinopoisk.dev: не удалось обратиться к серверу (" + (res.error.message || res.error) + ")");
  }
  var data = res.data;
  logKpUsage(path, !!(data && data.ok), data ? data.status : null);
  if (!data || !data.ok) {
    var status = data ? data.status : "?";
    var extra = (status === 403 || status === 429) ? " (похоже, кончился дневной лимит запросов)" : "";
    var detail = (data && data.message) ? " — " + data.message : "";
    throw new Error("Kinopoisk.dev: код " + status + extra + detail);
  }
  // Сохраняем успешный ответ в общий кэш на будущее (для себя и для других).
  sb.from("kp_cache").upsert({ cache_key: cacheKey, response: data.body, created_at: new Date().toISOString() }, { onConflict: "cache_key" })
    .then(function (r) { if (r.error) console.warn("kp_cache:", r.error.message); });
  return data.body;
}

// Пишем счётчик обращений к Kinopoisk.dev для админского раздела «Лимиты
// API» — по одной строке на запрос. Если таблица kp_api_log ещё не создана
// (миграция social-upgrade-2.sql не выполнена) — просто молча пропускаем,
// это не должно мешать самому поиску.
function logKpUsage(path, ok, status) {
  sb.from("kp_api_log").insert({user_id: state.myProfile.id, path: path, ok: ok, status: status})
    .then(function (res) { if (res.error) console.warn("kp_api_log:", res.error.message); });
}

// Kinopoisk.dev отдаёт жанры сразу названиями (не числовыми id, как TMDB),
// поэтому отдельная загрузка «карты жанров» не нужна — этим и объясняется,
// почему тут нет функции наподобие ensureGenreMaps.
function normalizeKpItem(raw) {
  var posterUrl = null;
  if (raw.poster) {
    posterUrl = (typeof raw.poster === "string") ? raw.poster : (raw.poster.previewUrl || raw.poster.url || null);
  }
  var genreNames = [];
  if (Array.isArray(raw.genres)) {
    genreNames = raw.genres.map(function (g) { return typeof g === "string" ? g : (g && g.name); }).filter(Boolean);
  }
  var voteAverage = null;
  if (typeof raw.rating === "number") voteAverage = raw.rating;
  else if (raw.rating && typeof raw.rating.kp === "number") voteAverage = raw.rating.kp;
  if (voteAverage) voteAverage = Math.round(voteAverage * 10) / 10;
  var mediaType = KP_TYPES.indexOf(raw.type) !== -1 ? raw.type : "movie";
  return {
    kpId: raw.id,
    mediaType: mediaType,
    title: raw.name || raw.alternativeName || raw.enName || "Без названия",
    year: raw.year || null,
    genreNames: genreNames,
    genre: genreNames.slice(0, 3).join(", ") || null,
    overview: raw.description || raw.shortDescription || null,
    posterUrl: posterUrl,
    voteAverage: voteAverage || null
  };
}

// Поиск запускается кнопкой «Искать»/Enter, а не на каждое нажатие клавиши —
// это самая большая экономия дневного лимита запросов. Очистка поля сразу
// очищает результаты (без обращения к Kinopoisk.dev).
document.getElementById("catalogSearchForm").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var q = document.getElementById("catalogSearch").value.trim();
  if (!q) { state.catalogResults = []; renderCatalogGrid(); return; }
  searchKp(q);
});
document.getElementById("catalogSearch").addEventListener("input", function (ev) {
  if (!ev.target.value.trim()) { state.catalogResults = []; renderCatalogGrid(); }
});

// Одинаковый повторный поиск в рамках одной вкладки (например, случайно
// нажали «Искать» дважды, или вернулись к тому же запросу) берём из памяти,
// не тратя запрос повторно.
var catalogSearchCache = {};

async function searchKp(query) {
  var cacheKey = query.trim().toLowerCase();
  document.getElementById("catalogGrid").innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Ищем…</p>';
  if (catalogSearchCache[cacheKey]) {
    state.catalogResults = catalogSearchCache[cacheKey];
    renderCatalogGrid();
    return;
  }
  try {
    var res = await kpFetch("/movie/search", {query: query, limit: 20});
    state.catalogResults = (res.docs || []).map(normalizeKpItem);
    catalogSearchCache[cacheKey] = state.catalogResults;
  } catch (e) {
    state.catalogResults = [];
    showStatus("Не удалось обратиться к Kinopoisk.dev: " + e.message, true);
  }
  renderCatalogGrid();
}

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

function renderCatalogGrid() {
  var grid = document.getElementById("catalogGrid");
  document.getElementById("catalogCount").textContent = state.catalogResults.length
    ? state.catalogResults.length + " " + pluralRu(state.catalogResults.length, ["результат", "результата", "результатов"])
    : "";
  if (!state.catalogResults.length) {
    grid.innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Начните вводить название в поиске выше.</p>';
    return;
  }
  grid.innerHTML = state.catalogResults.map(catalogCardHtml).join("");
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

async function ensureTitleFromKp(item) {
  const existing = await sb.from("titles").select("*").eq("kp_id", item.kpId).eq("media_type", item.mediaType).limit(1);
  if (existing.error) throw existing.error;
  if (existing.data && existing.data.length) return existing.data[0];
  const payload = {
    kp_id: item.kpId, media_type: item.mediaType, title: item.title, year: item.year,
    genre: item.genre, genre_names: item.genreNames || [], overview: item.overview,
    poster_url: item.posterUrl, kp_rating: item.voteAverage, added_by: state.myProfile.id
  };
  const ins = await sb.from("titles").insert(payload).select().limit(1);
  if (ins.error) {
    var retry = await sb.from("titles").select("*").eq("kp_id", item.kpId).eq("media_type", item.mediaType).limit(1);
    if (!retry.error && retry.data && retry.data.length) return retry.data[0];
    throw ins.error;
  }
  return ins.data[0];
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

export async function loadRecommendations() {
  var row = document.getElementById("recsRow");
  var likedGenres = {};
  state.myTitles.forEach(function (ut) {
    var t = ut.titles;
    var mine = (t.ratings || []).find(function (r) { return r.user_id === state.myProfile.id; });
    var liked = (mine && mine.value >= 4) || ut.status === 'watched';
    if (liked && t.genre_names) {
      t.genre_names.forEach(function (g) { likedGenres[g] = (likedGenres[g] || 0) + 1; });
    }
  });
  var topGenres = Object.keys(likedGenres).sort(function (a, b) { return likedGenres[b] - likedGenres[a]; }).slice(0, 2);
  if (!topGenres.length) { row.hidden = true; return; }
  var signature = topGenres.slice().sort().join(",");

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
    return rawItems
      .filter(function (it) { return !haveIds[it.mediaType + ":" + it.kpId] && !dismissed[it.mediaType + ":" + it.kpId]; })
      .slice(0, 10);
  }

  var cache = readRecsCache();
  if (cache && cache.signature === signature && (Date.now() - cache.fetchedAt) < RECS_CACHE_TTL_MS) {
    var cachedItems = finalize(cache.items);
    if (!cachedItems.length) { row.hidden = true; return; }
    row.hidden = false;
    renderRecsStrip(cachedItems);
    return;
  }

  try {
    var res = await kpFetch("/movie", {
      "genres.name": topGenres, "rating.kp": "6.5-10", "poster.url": "!null",
      sortField: "rating.kp", sortType: -1, limit: 20
    });
    var rawItems = (res.docs || []).map(normalizeKpItem);
    writeRecsCache({ signature: signature, fetchedAt: Date.now(), items: rawItems });
    var items = finalize(rawItems);
    if (!items.length) { row.hidden = true; return; }
    row.hidden = false;
    renderRecsStrip(items);
  } catch (e) { row.hidden = true; }
}

function renderRecsStrip(items) {
  document.getElementById("recsStrip").innerHTML = items.map(function (item, idx) {
    return '<div class="rec-card" data-rec-idx="' + idx + '">' +
      posterHtml(item.posterUrl) +
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
