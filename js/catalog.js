// Наш Кинозал — вкладка «Каталог» (Kinopoisk.dev, через прокси-функцию
// Supabase) и блок рекомендаций на вкладке «Мой список».
//
// Прямые запросы из браузера к api.kinopoisk.dev блокируются политикой CORS,
// поэтому сайт обращается к собственной Edge Function "kinopoisk-proxy" в
// Supabase, а она уже сама (сервер-сервер, без CORS) ходит в Kinopoisk.dev
// с секретным ключом. См. файл kinopoisk-proxy.ts и инструкцию по установке.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { KP_TYPES, TYPE_LABEL } from "./config.js";
import { escapeHtml, pluralRu, posterHtml, showStatus } from "./utils.js";
import { loadMyList } from "./mylist.js";

async function kpFetch(path, params) {
  var res = await sb.functions.invoke("kinopoisk-proxy", { body: { path: path, params: params || {} } });
  if (res.error) {
    throw new Error("Kinopoisk.dev: не удалось обратиться к серверу (" + (res.error.message || res.error) + ")");
  }
  var data = res.data;
  if (!data || !data.ok) {
    var status = data ? data.status : "?";
    var extra = (status === 403 || status === 429) ? " (похоже, кончился дневной лимит запросов)" : "";
    var detail = (data && data.message) ? " — " + data.message : "";
    throw new Error("Kinopoisk.dev: код " + status + extra + detail);
  }
  return data.body;
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

var catalogSearchTimer = null;
document.getElementById("catalogSearch").addEventListener("input", function (ev) {
  var q = ev.target.value.trim();
  clearTimeout(catalogSearchTimer);
  if (!q) { state.catalogResults = []; renderCatalogGrid(); return; }
  catalogSearchTimer = setTimeout(function () { searchKp(q); }, 350);
});

async function searchKp(query) {
  document.getElementById("catalogGrid").innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Ищем…</p>';
  try {
    var res = await kpFetch("/movie/search", {query: query, limit: 20});
    state.catalogResults = (res.docs || []).map(normalizeKpItem);
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
  Array.prototype.forEach.call(grid.querySelectorAll("[data-add-idx]"), function (btn) {
    btn.addEventListener("click", async function () {
      var item = state.catalogResults[parseInt(btn.getAttribute("data-add-idx"), 10)];
      btn.disabled = true; btn.textContent = "Добавляем…";
      try {
        await addFromKp(item);
        btn.textContent = "Добавлено ✓";
        showStatus('«' + item.title + '» добавлено в «Хотим посмотреть»');
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
  var haveIds = {};
  state.myTitles.forEach(function (ut) { if (ut.titles.kp_id) haveIds[ut.titles.media_type + ":" + ut.titles.kp_id] = true; });
  try {
    var res = await kpFetch("/movie", {
      "genres.name": topGenres, "rating.kp": "6.5-10", "poster.url": "!null",
      sortField: "rating.kp", sortType: -1, limit: 15
    });
    var items = (res.docs || []).map(normalizeKpItem)
      .filter(function (it) { return !haveIds[it.mediaType + ":" + it.kpId]; });
    items = items.slice(0, 10);
    if (!items.length) { row.hidden = true; return; }
    row.hidden = false;
    document.getElementById("recsStrip").innerHTML = items.map(function (item, idx) {
      return '<div class="rec-card">' +
        posterHtml(item.posterUrl) +
        '<div class="rec-title">' + escapeHtml(item.title) + '</div>' +
        '<button class="btn small" type="button" data-rec-idx="' + idx + '">+ В список</button>' +
      '</div>';
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("[data-rec-idx]"), function (btn) {
      btn.addEventListener("click", async function () {
        var item = items[parseInt(btn.getAttribute("data-rec-idx"), 10)];
        btn.disabled = true; btn.textContent = "…";
        try { await addFromKp(item); btn.textContent = "Добавлено ✓"; }
        catch (e) { btn.disabled = false; btn.textContent = "+ В список"; showStatus("Ошибка: " + e.message, true); }
      });
    });
  } catch (e) { row.hidden = true; }
}
