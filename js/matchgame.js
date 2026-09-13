// Наш Кинозал — вкладка «Мэтч»: игра в духе Tinder. Карточки тайтлов
// набираются НЕ из всего каталога, а только из тех, с которыми уже
// как-то взаимодействовали другие люди — оценили (ratings) или оставили
// комментарий (comments). Это единственные таблицы, которые видно всем
// авторизованным пользователям (в отличие от личных списков user_titles,
// они не приватны), поэтому именно они и служат сигналом «карточку уже
// смотрели/оценивали». Из этого набора убираются тайтлы, с которыми уже
// взаимодействовал сам текущий пользователь — свайпнул, оценил,
// прокомментировал или просто добавил в свой личный список в любом
// статусе (хочу посмотреть / смотрю / просмотрено), даже если сам он его
// не смотрел. Отмечаете «нравится»/«не то». Если тайтл, который вы
// отметили «нравится», уже точно так же отмечен одним из ваших друзей —
// это «совпадение», и вы оба сразу об этом узнаёте (совпадение вычисляет
// и запоминает сама база данных — функция check_swipe_match() из миграции
// social-upgrade-3.sql — поэтому сайт не должен читать чужие свайпы
// напрямую, только сам факт совпадения).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { registerSectionLoader } from "./router.js";
import { escapeHtml, fmtTime, posterHtml, showStatus } from "./utils.js";
import { openTitleDetail } from "./titleDetail.js";
import { openUserCard } from "./userCard.js";

var deck = [];
var deckPos = 0;
var swiping = false;

export async function loadMatchSection() {
  await loadMatchesList();
  await loadDeck();
}

export async function loadMatchesList() {
  var el = document.getElementById("matchesList");
  const { data, error } = await sb.from("matches")
    .select("*, titles!title_id(title,poster_url,media_type,year)")
    .or("user_a.eq." + state.myProfile.id + ",user_b.eq." + state.myProfile.id)
    .order("created_at", { ascending: false });
  if (error) {
    el.innerHTML = '<p class="empty-note">Не удалось загрузить совпадения' + (error.message ? ": " + escapeHtml(error.message) : "") + '. Возможно, ещё не выполнена миграция social-upgrade-3.sql.</p>';
    return;
  }
  if (!data || !data.length) {
    el.innerHTML = '<p class="empty-note">Пока совпадений нет — свайпайте карточки ниже вместе с друзьями.</p>';
    return;
  }
  el.innerHTML = data.map(function (m) {
    var otherId = m.user_a === state.myProfile.id ? m.user_b : m.user_a;
    var otherName = (state.profilesById[otherId] || {}).display_name || "…";
    var t = m.titles || {};
    return '<div class="match-row" data-open-title="' + m.title_id + '">' +
      posterHtml(t.poster_url) +
      '<div><div><strong>' + escapeHtml(t.title || "…") + '</strong> <span class="mono" style="color:var(--muted);">' + (t.year || "") + '</span></div>' +
      '<div class="mono" style="color:var(--muted);font-size:0.8rem;">🎉 совпадение с ' +
        '<button type="button" class="btn linklike" data-open-user="' + otherId + '">' + escapeHtml(otherName) + '</button>' +
        ' · ' + fmtTime(m.created_at) + '</div></div>' +
    '</div>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("[data-open-title]"), function (row) {
    row.addEventListener("click", function () { openTitleDetail(parseInt(row.getAttribute("data-open-title"), 10)); });
  });
  Array.prototype.forEach.call(el.querySelectorAll("[data-open-user]"), function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openUserCard(btn.getAttribute("data-open-user"));
    });
  });
}

async function loadDeck() {
  var wrap = document.getElementById("swipeDeck");
  wrap.innerHTML = '<p class="empty-note">Загрузка карточек…</p>';
  document.getElementById("swipeSkipBtn").parentElement.hidden = true;

  var myId = state.myProfile.id;
  // ratings/comments читаются целиком (эти таблицы открыты на чтение всем
  // авторизованным — в отличие от user_titles) — это и есть сигнал «карточку
  // кто-то уже посмотрел и как-то с ней взаимодействовал». Остальные четыре
  // запроса — про самого текущего пользователя, чтобы убрать из колоды то, с
  // чем он уже взаимодействовал сам (даже если не смотрел).
  const [ratingsRes, commentsRes, mySwipedRes, myListRes] = await Promise.all([
    sb.from("ratings").select("title_id,user_id"),
    sb.from("comments").select("title_id,user_id"),
    sb.from("swipes").select("title_id").eq("user_id", myId),
    sb.from("user_titles").select("title_id").eq("user_id", myId)
  ]);
  if (ratingsRes.error || commentsRes.error) {
    wrap.innerHTML = '<p class="empty-note">Не удалось загрузить карточки: ' + escapeHtml((ratingsRes.error || commentsRes.error).message) + '.</p>';
    return;
  }

  var interacted = {}; // id тайтла -> кто-то (не важно кто) оценил или прокомментировал
  var excluded = {}; // id тайтла -> сам пользователь уже как-то с ним взаимодействовал
  (ratingsRes.data || []).forEach(function (r) {
    interacted[r.title_id] = true;
    if (r.user_id === myId) excluded[r.title_id] = true;
  });
  (commentsRes.data || []).forEach(function (c) {
    interacted[c.title_id] = true;
    if (c.user_id === myId) excluded[c.title_id] = true;
  });
  (mySwipedRes.data || []).forEach(function (s) { excluded[s.title_id] = true; });
  (myListRes.data || []).forEach(function (u) { excluded[u.title_id] = true; });

  var candidateIds = Object.keys(interacted).map(Number).filter(function (id) { return !excluded[id]; });
  if (!candidateIds.length) {
    deck = [];
    deckPos = 0;
    renderDeck();
    return;
  }

  const titlesRes = await sb.from("titles").select("*").in("id", candidateIds);
  if (titlesRes.error) {
    wrap.innerHTML = '<p class="empty-note">Не удалось загрузить карточки: ' + escapeHtml(titlesRes.error.message) + '.</p>';
    return;
  }
  deck = titlesRes.data || [];
  // Перемешиваем (Fisher-Yates) — иначе все всегда видели бы карточки в одном
  // и том же порядке.
  for (var i = deck.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
  }
  deckPos = 0;
  renderDeck();
}

function renderDeck() {
  var wrap = document.getElementById("swipeDeck");
  var actions = document.getElementById("swipeSkipBtn").parentElement;
  if (!deck.length) {
    wrap.innerHTML = '<p class="empty-note">Пока нет карточек — сюда попадают только тайтлы, которые кто-то из пользователей уже оценил или прокомментировал (и с которыми вы сами ещё не взаимодействовали). Оцените что-нибудь в «Каталоге» — и у других появятся карточки для мэтча.</p>';
    actions.hidden = true;
    return;
  }
  if (deckPos >= deck.length) {
    wrap.innerHTML = '<p class="empty-note">Карточки закончились — загляните позже, когда кто-то оценит или прокомментирует что-то новое.</p>';
    actions.hidden = true;
    return;
  }
  actions.hidden = false;
  var t = deck[deckPos];
  wrap.innerHTML =
    '<div class="swipe-card">' +
      '<div class="poster-wrap">' + posterHtml(t.poster_url) + '</div>' +
      '<div class="swipe-card-info">' +
        '<h3>' + escapeHtml(t.title) + '</h3>' +
        '<div class="meta mono">' + (t.year || "—") + (t.genre ? ' · ' + escapeHtml(t.genre) : '') + '</div>' +
        (t.overview ? '<div class="overview-clip">' + escapeHtml(t.overview) + '</div>' : '') +
      '</div>' +
    '</div>';
}

async function swipe(liked) {
  if (swiping || deckPos >= deck.length) return;
  swiping = true;
  var t = deck[deckPos];
  var card = document.querySelector(".swipe-card");
  if (card) card.classList.add(liked ? "swiped-like" : "swiped-skip");

  const { error } = await sb.from("swipes")
    .upsert({ user_id: state.myProfile.id, title_id: t.id, liked: liked }, { onConflict: "user_id,title_id" });
  if (error) {
    showStatus("Не удалось сохранить: " + error.message, true);
  } else if (liked) {
    // Совпадение (если оно случилось) уже посчитано и сохранено триггером в
    // базе данных к моменту, когда upsert выше завершился успешно — здесь
    // только проверяем, не появилась ли для этого тайтла свежая запись.
    try {
      var mRes = await sb.from("matches").select("*")
        .eq("title_id", t.id)
        .or("user_a.eq." + state.myProfile.id + ",user_b.eq." + state.myProfile.id);
      if (!mRes.error && mRes.data) {
        var fresh = mRes.data.filter(function (m) { return (Date.now() - new Date(m.created_at).getTime()) < 8000; });
        if (fresh.length) {
          var otherId = fresh[0].user_a === state.myProfile.id ? fresh[0].user_b : fresh[0].user_a;
          var otherName = (state.profilesById[otherId] || {}).display_name || "друг";
          showStatus("🎉 Совпадение с " + otherName + ": «" + t.title + "»!");
          loadMatchesList();
        }
      }
    } catch (e) { /* необязательная проверка — молча пропускаем */ }
  }
  setTimeout(function () { deckPos++; swiping = false; renderDeck(); }, 260);
}

document.getElementById("swipeLikeBtn").addEventListener("click", function () { swipe(true); });
document.getElementById("swipeSkipBtn").addEventListener("click", function () { swipe(false); });

registerSectionLoader("match", loadMatchSection);
