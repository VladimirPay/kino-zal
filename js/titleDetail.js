// Наш Кинозал — единая карточка тайтла (диалог с постером, описанием,
// статусом/оценкой/комментариями). Открывается и из «Моего списка» (тайтл уже
// в личном списке), и из «Каталога»/рекомендаций (тайтл ещё может быть не
// добавлен) — в обоих случаях показывает одно и то же: статус можно менять
// (для ещё не добавленного — любая кнопка статуса добавляет его), оценки и
// комментарии видны и доступны всем, независимо от того, в чьём личном списке
// тайтл состоит (это общая, не приватная часть данных).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { STATUS_LABEL, TYPE_LABEL } from "./config.js";
import { bindClose, escapeHtml, pluralRu, posterHtml, ratingAvg, showStatus, starsHtml } from "./utils.js";
import { loadMyList } from "./mylist.js";
import { openUserCard } from "./userCard.js";
import { ensureTrailerUrl } from "./catalog.js";

export async function openTitleDetail(titleId, opts) {
  state.openTitleId = titleId;
  var dlg = document.getElementById("detailDialog");
  // «spin» — небольшая анимация появления, когда карточка открыта случайным
  // выбором («Не знаю, что посмотреть») — чуть более праздничный вид, чем
  // обычное открытие диалога по клику.
  dlg.classList.toggle("roulette", !!(opts && opts.spin));
  dlg.showModal();
  await renderTitleDetail(titleId, { showLoading: true });
}

// Позволяет другим модулям (например, «Мой список» после перезагрузки данных)
// обновить уже открытый диалог тайтла, ничего не делая, если он закрыт.
export function refreshOpenDetailIfAny() {
  if (state.openTitleId == null) return;
  // Если это открытая нами же карточка и мы буквально только что сами
  // записали в неё изменение (статус/оценка/комментарий/лайк — см.
  // noteLocalWrite ниже), не перерисовываем её ещё раз по эху от Supabase
  // Realtime о нашей же собственной записи: сама карточка уже показывает
  // актуальное состояние, а повторная перерисовка только мерцала бы. Если
  // же карточку в это время поменял кто-то другой (общие комментарии и
  // оценки видны всем), это окно уже истечёт и обновление честно пройдёт.
  if (Date.now() - (lastLocalWriteAt[state.openTitleId] || 0) < 1500) return;
  renderTitleDetail(state.openTitleId, { showLoading: false });
}

document.getElementById("detailDialog").addEventListener("close", function () {
  state.openTitleId = null;
});

var lastLocalWriteAt = {};
function noteLocalWrite(titleId) { lastLocalWriteAt[titleId] = Date.now(); }

// Растёт на каждый вызов renderTitleDetail — если пока шёл запрос к базе
// запустился более новый перерендер того же тайтла (например, быстро друг
// за другом прилетели наш локальный вызов и эхо от Realtime), устаревший
// результат просто отбрасывается и не перезатирает уже показанное.
var renderGeneration = 0;

async function renderTitleDetail(titleId, opts) {
  var showLoading = !opts || opts.showLoading !== false;
  var inner = document.getElementById("detailInner");
  var myGen = ++renderGeneration;
  // «Загрузка…» показываем только при первом открытии карточки — на
  // обновлениях после своих же действий или по Realtime это стирало и
  // заново отрисовывало весь диалог, что и выглядело как мерцание.
  if (showLoading) {
    inner.innerHTML = '<button class="close-x" data-close="detailDialog">✕</button><p class="empty-note">Загрузка…</p>';
    bindClose(inner);
  }

  const [tRes, utRes] = await Promise.all([
    sb.from("titles")
      .select("*, ratings(user_id,value), comments(id,text,created_at,user_id,profiles!user_id(display_name),comment_likes(user_id))")
      .eq("id", titleId).limit(1),
    sb.from("user_titles").select("*").eq("title_id", titleId).eq("user_id", state.myProfile.id).limit(1)
  ]);
  // Диалог могли закрыть, открыть другой тайтл, или запустить более свежий
  // перерендер того же тайтла, пока шёл запрос.
  if (state.openTitleId !== titleId || myGen !== renderGeneration) return;
  if (tRes.error || !tRes.data || !tRes.data.length) {
    inner.innerHTML = '<button class="close-x" data-close="detailDialog">✕</button><p class="empty-note">Не удалось загрузить карточку' + (tRes.error ? ": " + escapeHtml(tRes.error.message) : "") + '.</p>';
    bindClose(inner);
    return;
  }
  var t = tRes.data[0];
  var ut = (utRes.data && utRes.data[0]) || null; // null = тайтла ещё нет в моём личном списке

  var avg = ratingAvg(t);
  var ratingCount = (t.ratings || []).length;
  var mine = (t.ratings || []).find(function (r) { return r.user_id === state.myProfile.id; });
  var myRating = mine ? mine.value : 0;

  var starsControl = "";
  for (var i = 1; i <= 5; i++) {
    starsControl += '<button type="button" data-star="' + i + '" class="' + (i <= myRating ? "on" : "") + '">★</button>';
  }
  var statusButtons = ["want", "watching", "watched"].map(function (s) {
    return '<button type="button" class="btn small ' + (ut && ut.status === s ? "active" : "") + '" data-status="' + s + '">' + STATUS_LABEL[s] + '</button>';
  }).join("");

  var sortedComments = (t.comments || []).slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  var commentsHtml = sortedComments.length
    ? sortedComments.map(function (c) {
        var who = (c.profiles && c.profiles.display_name) || "неизвестно";
        var canDel = state.myProfile && (c.user_id === state.myProfile.id || state.myProfile.role === "admin");
        var likeCount = (c.comment_likes || []).length;
        var liked = (c.comment_likes || []).some(function (l) { return l.user_id === state.myProfile.id; });
        return '<div class="comment"><div class="who"><button type="button" class="btn linklike small" data-open-user="' + c.user_id + '" style="padding:0;">' + escapeHtml(who) + '</button>' +
          '<button class="like-btn ' + (liked ? "liked" : "") + '" data-like-comment="' + c.id + '" type="button">♥ ' + likeCount + '</button>' +
          (canDel ? ' <button class="btn linklike small" data-del-comment="' + c.id + '" type="button">удалить</button>' : '') +
          '</div><div>' + escapeHtml(c.text) + '</div></div>';
      }).join("")
    : '<p class="empty-note">Комментариев пока нет.</p>';

  var notInListNote = !ut ? '<p class="catalog-hint" style="margin:6px 0 0;">Ещё не в вашем личном списке — выберите статус, чтобы добавить.</p>' : '';

  // Ссылку на трейлер ApiGet.ru отдаёт не сразу (см. ensureTrailerUrl) —
  // если её ещё нет в базе, запрашиваем в фоне и, если нашлась, дорисовываем
  // карточку заново (без повторного похода за остальными данными).
  if (!t.trailer_url && t.kp_id) {
    ensureTrailerUrl(t).then(function (url) {
      if (url && state.openTitleId === titleId) {
        t.trailer_url = url;
        noteLocalWrite(titleId);
        renderTitleDetail(titleId, { showLoading: false });
      }
    });
  }

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
    (t.trailer_url ? '<div style="margin:8px 0;"><a class="btn small" href="' + escapeHtml(t.trailer_url) + '" target="_blank" rel="noopener">▶ Смотреть трейлер</a></div>' : '') +
    (t.overview ? '<p class="detail-note">' + escapeHtml(t.overview) + '</p>' : '') +
    '<div class="status-switch">' + statusButtons + '</div>' +
    notInListNote +
    '<div class="rate-row"><span class="rate-stars">' + starsControl + '</span>' +
      '<span class="mono" style="color:var(--muted);font-size:0.85rem;">' + (avg ? avg.toFixed(1) + ' · ' + ratingCount + ' ' + pluralRu(ratingCount, ["оценка", "оценки", "оценок"]) : "пока нет оценок") + '</span></div>' +
    '<div class="share-row">' +
      '<button class="btn small" id="shareChatBtn" type="button">📤 Поделиться в общем чате</button>' +
      '<span class="select-wrap"><select id="shareFriendSelect" title="Отправить другу"><option value="">Отправить другу…</option></select></span>' +
    '</div>' +
    '<div class="comments"><h3 style="font-family:\'Bebas Neue\',sans-serif;font-size:1.15rem;letter-spacing:0.03em;margin:0 0 8px;">Комментарии</h3>' +
      commentsHtml +
      '<form id="commentForm" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
        '<input id="commentText" placeholder="Написать комментарий…" style="flex:1;min-width:160px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--ink);font:inherit;">' +
        '<button class="btn primary small" type="submit">Отправить</button>' +
      '</form>' +
    '</div>' +
    (ut ? '<div class="dialog-actions"><button class="btn danger small" id="removeBtn" type="button">Убрать из моего списка</button></div>' : '');

  bindClose(inner);

  // «Поделиться» — отправляет карточку тайтла как отдельное сообщение (без
  // текста/картинки, см. social-upgrade-7.sql: у chat_messages/dm_messages
  // теперь допустимо сообщение из одного только shared_title_id) в общий чат
  // или конкретному другу. Список друзей подтягивается отдельным лёгким
  // запросом (как в loadSocialRecs у catalog.js) — не полагаемся на то, что
  // вкладка «Друзья» уже открывалась в этой сессии.
  var shareChatBtn = inner.querySelector("#shareChatBtn");
  if (shareChatBtn) {
    shareChatBtn.addEventListener("click", async function () {
      shareChatBtn.disabled = true;
      const { error } = await sb.from("chat_messages").insert({ user_id: state.myProfile.id, shared_title_id: t.id });
      shareChatBtn.disabled = false;
      if (error) { showStatus("Не удалось поделиться: " + error.message, true); return; }
      showStatus('«' + t.title + '» отправлено в общий чат');
    });
  }
  var shareFriendSelect = inner.querySelector("#shareFriendSelect");
  if (shareFriendSelect) {
    (async function () {
      try {
        var frRes = await sb.from("friend_requests").select("from_user,to_user").eq("status", "accepted")
          .or("from_user.eq." + state.myProfile.id + ",to_user.eq." + state.myProfile.id);
        if (frRes.error) return;
        var friendIds = (frRes.data || []).map(function (r) { return r.from_user === state.myProfile.id ? r.to_user : r.from_user; });
        if (!friendIds.length) return;
        shareFriendSelect.innerHTML = '<option value="">Отправить другу…</option>' + friendIds.map(function (id) {
          var name = (state.profilesById[id] || {}).display_name || "…";
          return '<option value="' + id + '">' + escapeHtml(name) + '</option>';
        }).join("");
      } catch (e) { /* не критично — просто останется один пункт-заглушка */ }
    })();
    shareFriendSelect.addEventListener("change", async function () {
      var friendId = shareFriendSelect.value;
      if (!friendId) return;
      var friendName = shareFriendSelect.options[shareFriendSelect.selectedIndex].textContent;
      shareFriendSelect.disabled = true;
      const { error } = await sb.from("dm_messages").insert({ sender_id: state.myProfile.id, recipient_id: friendId, shared_title_id: t.id });
      shareFriendSelect.value = "";
      shareFriendSelect.disabled = false;
      if (error) { showStatus("Не удалось отправить: " + error.message, true); return; }
      showStatus('«' + t.title + '» отправлено ' + friendName);
    });
  }

  Array.prototype.forEach.call(inner.querySelectorAll("[data-status]"), function (btn) {
    btn.addEventListener("click", async function () {
      var newStatus = btn.getAttribute("data-status");
      if (ut) {
        const { error } = await sb.from("user_titles").update({status: newStatus}).eq("id", ut.id);
        if (error) { showStatus("Не удалось изменить статус: " + error.message, true); return; }
      } else {
        const { error } = await sb.from("user_titles").insert({user_id: state.myProfile.id, title_id: t.id, status: newStatus});
        if (error) { showStatus("Не удалось добавить: " + error.message, true); return; }
        showStatus('Добавлено в «' + STATUS_LABEL[newStatus] + '»');
      }
      noteLocalWrite(titleId);
      renderTitleDetail(titleId, { showLoading: false });
      loadMyList();
    });
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-star]"), function (btn) {
    btn.addEventListener("click", async function () {
      const val = parseInt(btn.getAttribute("data-star"), 10);
      const { error } = await sb.from("ratings").upsert({title_id: t.id, user_id: state.myProfile.id, value: val}, {onConflict: "title_id,user_id"});
      if (error) { showStatus("Не удалось сохранить оценку: " + error.message, true); return; }
      noteLocalWrite(titleId);
      renderTitleDetail(titleId, { showLoading: false });
    });
  });
  inner.querySelector("#commentForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var text = document.getElementById("commentText").value.trim();
    if (!text) return;
    const { error } = await sb.from("comments").insert({title_id: t.id, user_id: state.myProfile.id, text: text});
    if (error) { showStatus("Не удалось отправить комментарий: " + error.message, true); return; }
    noteLocalWrite(titleId);
    renderTitleDetail(titleId, { showLoading: false });
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-del-comment]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("comments").delete().eq("id", btn.getAttribute("data-del-comment"));
      if (error) { showStatus("Не удалось удалить комментарий: " + error.message, true); return; }
      noteLocalWrite(titleId);
      renderTitleDetail(titleId, { showLoading: false });
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
      noteLocalWrite(titleId);
      renderTitleDetail(titleId, { showLoading: false });
    });
  });
  Array.prototype.forEach.call(inner.querySelectorAll("[data-open-user]"), function (btn) {
    btn.addEventListener("click", function () { openUserCard(btn.getAttribute("data-open-user")); });
  });
  var removeBtn = inner.querySelector("#removeBtn");
  if (removeBtn) {
    removeBtn.addEventListener("click", async function () {
      if (!confirm('Убрать «' + t.title + '» из вашего личного списка? (Общая карточка, оценки и комментарии других людей останутся.)')) return;
      const { error } = await sb.from("user_titles").delete().eq("id", ut.id);
      if (error) { showStatus("Не удалось убрать: " + error.message, true); return; }
      document.getElementById("detailDialog").close();
      state.openTitleId = null;
      loadMyList();
    });
  }
}
