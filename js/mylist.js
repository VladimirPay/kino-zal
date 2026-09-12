// Наш Кинозал — вкладка «Мой список»: приватный список пользователя,
// карточка тайтла (детальный диалог), статус/оценка/комментарии/лайки.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { STATUS_LABEL, TABS, TYPE_LABEL } from "./config.js";
import { bindClose, escapeHtml, pluralRu, posterHtml, ratingAvg, showStatus, starsHtml, writeSessionValue } from "./utils.js";
import { registerSectionLoader } from "./router.js";
import { loadRecommendations } from "./catalog.js";

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
  if (state.openTitleId) renderDetail();
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
    '<article class="card has-poster" data-id="' + ut.id + '" style="border-left-color:var(--' + ut.status + ')">' +
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
    card.addEventListener("click", function () { openDetail(card.getAttribute("data-id")); });
  });
}

document.getElementById("searchInput").addEventListener("input", function (ev) {
  state.searchQuery = ev.target.value;
  renderGrid();
});

function openDetail(id) {
  state.openTitleId = String(id);
  renderDetail();
  document.getElementById("detailDialog").showModal();
}

function renderDetail() {
  var ut = state.myTitles.find(function (x) { return String(x.id) === String(state.openTitleId); });
  var inner = document.getElementById("detailInner");
  if (!ut) { inner.innerHTML = ""; return; }
  var t = ut.titles;
  var avg = ratingAvg(t);
  var ratingCount = (t.ratings || []).length;
  var mine = (t.ratings || []).find(function (r) { return r.user_id === state.myProfile.id; });
  var myRating = mine ? mine.value : 0;

  var starsControl = "";
  for (var i = 1; i <= 5; i++) {
    starsControl += '<button type="button" data-star="' + i + '" class="' + (i <= myRating ? "on" : "") + '">★</button>';
  }
  var statusButtons = ["want", "watching", "watched"].map(function (s) {
    return '<button type="button" class="btn small ' + (ut.status === s ? "active" : "") + '" data-status="' + s + '">' + STATUS_LABEL[s] + '</button>';
  }).join("");

  var sortedComments = (t.comments || []).slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  var commentsHtml = sortedComments.length
    ? sortedComments.map(function (c) {
        var who = (c.profiles && c.profiles.display_name) || "неизвестно";
        var canDel = state.myProfile && (c.user_id === state.myProfile.id || state.myProfile.role === "admin");
        var likeCount = (c.comment_likes || []).length;
        var liked = (c.comment_likes || []).some(function (l) { return l.user_id === state.myProfile.id; });
        return '<div class="comment"><div class="who">' + escapeHtml(who) +
          '<button class="like-btn ' + (liked ? "liked" : "") + '" data-like-comment="' + c.id + '" type="button">♥ ' + likeCount + '</button>' +
          (canDel ? ' <button class="btn linklike small" data-del-comment="' + c.id + '" type="button">удалить</button>' : '') +
          '</div><div>' + escapeHtml(c.text) + '</div></div>';
      }).join("")
    : '<p class="empty-note">Комментариев пока нет.</p>';

  inner.innerHTML =
    '<button class="close-x" data-close="detailDialog">✕</button>' +
    '<div class="detail-poster">' + posterHtml(t.poster_url) + '</div>' +
    '<h2>' + escapeHtml(t.title) + '</h2>' +
    '<div class="detail-meta mono">' +
      '<span class="badge">' + TYPE_LABEL[t.media_type] + '</span>' +
      '<span>' + (t.year || "—") + '</span>' +
      (t.genre ? '<span>· ' + escapeHtml(t.genre) + '</span>' : '') +
      (t.kp_rating ? '<span>· Kinopoisk ' + t.kp_rating + '</span>' : '') +
    '</div>' +
    (t.overview ? '<p class="detail-note">' + escapeHtml(t.overview) + '</p>' : '') +
    '<div class="status-switch">' + statusButtons + '</div>' +
    '<div class="rate-row"><span class="rate-stars">' + starsControl + '</span>' +
      '<span class="mono" style="color:var(--muted);font-size:0.85rem;">' + (avg ? avg.toFixed(1) + ' · ' + ratingCount + ' ' + pluralRu(ratingCount, ["оценка", "оценки", "оценок"]) : "пока нет оценок") + '</span></div>' +
    '<div class="comments"><h3 style="font-family:\'Bebas Neue\',sans-serif;font-size:1.15rem;letter-spacing:0.03em;margin:0 0 8px;">Комментарии</h3>' +
      commentsHtml +
      '<form id="commentForm" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
        '<input id="commentText" placeholder="Написать комментарий…" style="flex:1;min-width:160px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--ink);font:inherit;">' +
        '<button class="btn primary small" type="submit">Отправить</button>' +
      '</form>' +
    '</div>' +
    '<div class="dialog-actions"><button class="btn danger small" id="removeBtn" type="button">Убрать из моего списка</button></div>';

  Array.prototype.forEach.call(inner.querySelectorAll("[data-status]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("user_titles").update({status: btn.getAttribute("data-status")}).eq("id", ut.id);
      if (error) showStatus("Не удалось изменить статус: " + error.message, true);
    });
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-star]"), function (btn) {
    btn.addEventListener("click", async function () {
      const val = parseInt(btn.getAttribute("data-star"), 10);
      const { error } = await sb.from("ratings").upsert({title_id: t.id, user_id: state.myProfile.id, value: val}, {onConflict: "title_id,user_id"});
      if (error) showStatus("Не удалось сохранить оценку: " + error.message, true);
    });
  });
  inner.querySelector("#commentForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var text = document.getElementById("commentText").value.trim();
    if (!text) return;
    const { error } = await sb.from("comments").insert({title_id: t.id, user_id: state.myProfile.id, text: text});
    if (error) { showStatus("Не удалось отправить комментарий: " + error.message, true); return; }
    document.getElementById("commentText").value = "";
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-del-comment]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("comments").delete().eq("id", btn.getAttribute("data-del-comment"));
      if (error) showStatus("Не удалось удалить комментарий: " + error.message, true);
    });
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-like-comment]"), function (btn) {
    btn.addEventListener("click", async function () {
      var cid = btn.getAttribute("data-like-comment");
      var liked = btn.classList.contains("liked");
      if (liked) {
        await sb.from("comment_likes").delete().eq("comment_id", cid).eq("user_id", state.myProfile.id);
      } else {
        await sb.from("comment_likes").insert({comment_id: cid, user_id: state.myProfile.id});
      }
    });
  });
  var removeBtn = inner.querySelector("#removeBtn");
  removeBtn.addEventListener("click", async function () {
    if (!confirm('Убрать «' + t.title + '» из вашего личного списка? (Общая карточка, оценки и комментарии других людей останутся.)')) return;
    const { error } = await sb.from("user_titles").delete().eq("id", ut.id);
    if (error) { showStatus("Не удалось убрать: " + error.message, true); return; }
    document.getElementById("detailDialog").close();
    state.openTitleId = null;
  });
  bindClose(inner);
}

registerSectionLoader("mylist", loadMyList);
