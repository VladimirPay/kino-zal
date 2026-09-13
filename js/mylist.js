// Наш Кинозал — вкладка «Мой список»: приватный список пользователя и его
// карточки. Открытие карточки (постер/статус/оценка/комментарии) делегировано
// в titleDetail.js — он же используется из «Каталога» и рекомендаций, чтобы
// вид был одинаковым независимо от того, где кликнули на тайтл.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { STATUS_LABEL, TABS, TYPE_LABEL } from "./config.js";
import { escapeHtml, pluralRu, posterHtml, ratingAvg, showStatus, starsHtml, writeSessionValue } from "./utils.js";
import { registerSectionLoader } from "./router.js";
import { loadRecommendations } from "./catalog.js";
import { openTitleDetail, refreshOpenDetailIfAny } from "./titleDetail.js";

export async function loadMyList() {
  const { data, error } = await sb
    .from("user_titles")
    .select("*, titles!title_id(*, ratings(user_id,value), comments(id,text,created_at,user_id,profiles!user_id(display_name),comment_likes(user_id)))")
    .eq("user_id", state.myProfile.id)
    .order("created_at", { ascending: false });
  if (error) { showStatus("Не удалось загрузить список: " + error.message, true); return; }
  state.myTitles = (data || []).map(function (ut) { ut.titles = ut.titles || {}; return ut; });
  renderTabs();
  renderGrid();
  refreshOpenDetailIfAny();
  loadRecommendations();
}

function titleMatches(ut) {
  if (state.activeTab !== "all" && ut.status !== state.activeTab) return false;
  if (state.searchQuery && ut.titles.title.toLowerCase().indexOf(state.searchQuery.toLowerCase()) === -1) return false;
  return true;
}

function renderTabs() {
  var el = document.getElementById("tabs");
  el.innerHTML = TABS.map(function (t) {
    var n = t.key === "all" ? state.myTitles.length : state.myTitles.filter(function (ut) { return ut.status === t.key; }).length;
    return '<button data-tab="' + t.key + '" class="' + (state.activeTab === t.key ? "active" : "") + '">' + t.label + ' (' + n + ')</button>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () {
      state.activeTab = btn.getAttribute("data-tab");
      writeSessionValue("kz_tab", state.activeTab);
      renderTabs(); renderGrid();
    });
  });
}

function cardHtml(ut) {
  var t = ut.titles;
  var avg = ratingAvg(t);
  var ratingCount = (t.ratings || []).length;
  return '' +
    '<article class="card has-poster" data-title-id="' + t.id + '" style="border-left-color:var(--' + ut.status + ')">' +
      '<div class="poster-wrap">' + posterHtml(t.poster_url) + '</div>' +
      '<div class="top"><span class="badge">' + TYPE_LABEL[t.media_type] + '</span>' +
      '<span class="status-pill status-' + ut.status + '">' + STATUS_LABEL[ut.status] + '</span></div>' +
      '<h3>' + escapeHtml(t.title) + '</h3>' +
      '<div class="meta mono">' + (t.year || "—") + (t.genre ? ' · ' + escapeHtml(t.genre) : '') + '</div>' +
      '<div class="stars">' + (avg ? starsHtml(avg) + ' <span class="mono" style="color:var(--muted);font-size:0.78rem;">' + avg.toFixed(1) + ' (' + ratingCount + ' ' + pluralRu(ratingCount, ["оценка", "оценки", "оценок"]) + ')</span>' : '<span style="color:var(--muted);font-size:0.82rem;">без оценок</span>') + '</div>' +
    '</article>';
}

function renderGrid() {
  var grid = document.getElementById("grid");
  var list = state.myTitles.filter(titleMatches);
  document.getElementById("resultCount").textContent = list.length + " " + pluralRu(list.length, ["запись", "записи", "записей"]);
  if (!list.length) {
    grid.innerHTML = '<p class="empty-note" style="grid-column:1/-1;">Список пуст. Откройте вкладку «Каталог», найдите фильм или сериал и нажмите «Добавить в список».</p>';
    return;
  }
  grid.innerHTML = list.map(cardHtml).join("");
  Array.prototype.forEach.call(grid.querySelectorAll(".card"), function (card) {
    card.addEventListener("click", function () { openTitleDetail(parseInt(card.getAttribute("data-title-id"), 10)); });
  });
}

document.getElementById("searchInput").addEventListener("input", function (ev) {
  state.searchQuery = ev.target.value;
  renderGrid();
});

registerSectionLoader("mylist", loadMyList);
