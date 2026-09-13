// Наш Кинозал — строка «Вы: …» в шапке, диалог профиля (имя/о себе/пароль/
// делиться активностью), достижения. Управление пользователями/каталогом
// вынесено в отдельную вкладку «Управление» (см. admin.js, config.js SECTIONS)
// — здесь для неё ничего открывать не нужно.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { showStatus } from "./utils.js";
import { escapeHtml } from "./utils.js";

export function renderYouRow() {
  var el = document.getElementById("youRow");
  if (!state.myProfile) { el.innerHTML = ""; return; }
  var isAdmin = state.myProfile.role === "admin";
  el.innerHTML =
    'Вы: <strong>' + escapeHtml(state.myProfile.display_name) + '</strong> ' +
    '<span class="role-badge">' + (isAdmin ? "администратор" : "участник") + '</span> ' +
    '<button class="btn small" id="profileBtn" type="button">Профиль</button>';
  document.getElementById("profileBtn").addEventListener("click", openProfileDialog);
}

async function openProfileDialog() {
  document.getElementById("p-name").value = state.myProfile.display_name;
  document.getElementById("p-bio").value = state.myProfile.bio || "";
  document.getElementById("p-share-activity").checked = !!state.myProfile.share_activity;
  document.getElementById("p-password").value = "";
  document.getElementById("profileMsg").hidden = true;
  document.getElementById("achvList").innerHTML = '<span class="mono" style="color:var(--muted);font-size:0.8rem;">считаем…</span>';
  document.getElementById("profileDialog").showModal();
  renderAchievements();
  activeRecapKind = "month";
  Array.prototype.forEach.call(document.querySelectorAll("[data-recap]"), function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-recap") === activeRecapKind);
  });
  renderRecap(activeRecapKind);
}

document.getElementById("saveNameBtn2").addEventListener("click", async function () {
  var v = document.getElementById("p-name").value.trim();
  var bio = document.getElementById("p-bio").value.trim();
  if (!v) return;
  const { error } = await sb.from("profiles").update({display_name: v, bio: bio || null}).eq("id", state.myProfile.id);
  var msg = document.getElementById("profileMsg");
  msg.hidden = false;
  if (error) { msg.textContent = "Ошибка: " + error.message; msg.className = "auth-msg error"; return; }
  state.myProfile.display_name = v; state.myProfile.bio = bio;
  renderYouRow();
  msg.textContent = "Сохранено"; msg.className = "auth-msg ok";
});

document.getElementById("p-share-activity").addEventListener("change", async function (ev) {
  const { error } = await sb.from("profiles").update({share_activity: ev.target.checked}).eq("id", state.myProfile.id);
  if (error) { showStatus("Не удалось сохранить настройку: " + error.message, true); ev.target.checked = !ev.target.checked; return; }
  state.myProfile.share_activity = ev.target.checked;
});

document.getElementById("changePassBtn").addEventListener("click", async function () {
  var v = document.getElementById("p-password").value;
  var msg = document.getElementById("profileMsg");
  if (!v || v.length < 6) { msg.hidden = false; msg.textContent = "Пароль должен быть не короче 6 символов"; msg.className = "auth-msg error"; return; }
  const { error } = await sb.auth.updateUser({ password: v });
  msg.hidden = false;
  if (error) { msg.textContent = "Ошибка: " + error.message; msg.className = "auth-msg error"; return; }
  document.getElementById("p-password").value = "";
  msg.textContent = "Пароль изменён"; msg.className = "auth-msg ok";
});

document.getElementById("signOutBtn").addEventListener("click", async function () {
  document.getElementById("profileDialog").close();
  await sb.auth.signOut();
});

async function renderAchievements() {
  var watchedCount = state.myTitles.filter(function (ut) { return ut.status === 'watched'; }).length;
  var ratingsCount = 0, commentsCount = 0;
  state.myTitles.forEach(function (ut) {
    if ((ut.titles.ratings || []).some(function (r) { return r.user_id === state.myProfile.id; })) ratingsCount++;
    commentsCount += (ut.titles.comments || []).filter(function (c) { return c.user_id === state.myProfile.id; }).length;
  });
  var friendsCount = state.friends.length;
  var chatCount = 0;
  try {
    var res = await sb.from("chat_messages").select("id", {count: "exact", head: true}).eq("user_id", state.myProfile.id);
    chatCount = res.count || 0;
  } catch (e) {}

  var defs = [
    {label: "Первый отзыв", on: commentsCount >= 1},
    {label: "Киноман (10+ просмотрено)", on: watchedCount >= 10},
    {label: "Синефил (50+ просмотрено)", on: watchedCount >= 50},
    {label: "Активный критик (20+ отзывов)", on: commentsCount >= 20},
    {label: "Придирчивый (25+ оценок)", on: ratingsCount >= 25},
    {label: "Душа компании (5+ друзей)", on: friendsCount >= 5},
    {label: "Болтун (50+ сообщений в чате)", on: chatCount >= 50}
  ];
  document.getElementById("achvList").innerHTML = defs.map(function (d) {
    return '<span class="achv' + (d.on ? "" : " locked") + '">' + (d.on ? "✓ " : "") + d.label + '</span>';
  }).join("");
}

// ---------- Итоги месяца/года ----------
// Считается целиком из уже загруженных данных (state.myTitles, которые
// содержит и свои оценки/отзывы с датами) — ни одного лишнего запроса к
// базе, не говоря уже о Kinopoisk.dev.

var activeRecapKind = "month";

function periodRange(kind) {
  var now = new Date();
  if (kind === "year") {
    return {
      start: new Date(now.getFullYear(), 0, 1),
      prevStart: new Date(now.getFullYear() - 1, 0, 1),
      prevEnd: new Date(now.getFullYear(), 0, 1)
    };
  }
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    prevEnd: new Date(now.getFullYear(), now.getMonth(), 1)
  };
}

function inRange(iso, start, end) {
  if (!iso) return false;
  var t = new Date(iso).getTime();
  return t >= start.getTime() && (!end || t < end.getTime());
}

function computeRecap(kind) {
  var r = periodRange(kind);
  var watchedNow = 0, watchedPrev = 0;
  var ratingsNow = [], commentsNow = 0;
  var genreCount = {};
  state.myTitles.forEach(function (ut) {
    var t = ut.titles;
    if (ut.status === "watched") {
      if (inRange(ut.updated_at, r.start, null)) {
        watchedNow++;
        (t.genre_names || []).forEach(function (g) { genreCount[g] = (genreCount[g] || 0) + 1; });
      } else if (inRange(ut.updated_at, r.prevStart, r.prevEnd)) {
        watchedPrev++;
      }
    }
    (t.ratings || []).forEach(function (rt) {
      if (rt.user_id === state.myProfile.id && inRange(rt.created_at, r.start, null)) ratingsNow.push(rt.value);
    });
    (t.comments || []).forEach(function (c) {
      if (c.user_id === state.myProfile.id && inRange(c.created_at, r.start, null)) commentsNow++;
    });
  });
  var topGenre = Object.keys(genreCount).sort(function (a, b) { return genreCount[b] - genreCount[a]; })[0] || null;
  var avgRating = ratingsNow.length ? ratingsNow.reduce(function (a, b) { return a + b; }, 0) / ratingsNow.length : null;
  return { watchedNow: watchedNow, watchedPrev: watchedPrev, ratingsCount: ratingsNow.length, commentsNow: commentsNow, topGenre: topGenre, avgRating: avgRating };
}

function renderRecap(kind) {
  var box = document.getElementById("recapBox");
  var r = computeRecap(kind);
  var periodWord = kind === "year" ? "в этом году" : "в этом месяце";
  var prevWord = kind === "year" ? "в прошлом году" : "в прошлом месяце";
  var diff = r.watchedNow - r.watchedPrev;
  var diffNote = "";
  if (r.watchedPrev || r.watchedNow) {
    diffNote = diff > 0 ? (" (на " + diff + " больше, чем " + prevWord + ")")
      : diff < 0 ? (" (на " + Math.abs(diff) + " меньше, чем " + prevWord + ")")
      : (" (столько же, сколько " + prevWord + ")");
  }
  if (!r.watchedNow && !r.ratingsCount && !r.commentsNow) {
    box.innerHTML = '<p class="empty-note">Пока не за что зацепиться' + (kind === "year" ? " в этом году" : " в этом месяце") + ' — самое время что-нибудь посмотреть 🍿</p>';
    return;
  }
  box.innerHTML =
    '<p style="margin:4px 0;">Просмотрено ' + periodWord + ': <strong class="mono">' + r.watchedNow + '</strong>' +
      '<span class="mono" style="color:var(--muted);font-size:0.8rem;">' + escapeHtml(diffNote) + '</span></p>' +
    (r.ratingsCount ? '<p style="margin:4px 0;">Оценок поставлено: <strong class="mono">' + r.ratingsCount + '</strong>' + (r.avgRating ? ' — в среднем ' + r.avgRating.toFixed(1) + '★' : '') + '</p>' : '') +
    (r.commentsNow ? '<p style="margin:4px 0;">Отзывов написано: <strong class="mono">' + r.commentsNow + '</strong></p>' : '') +
    (r.topGenre ? '<p style="margin:4px 0;">Любимый жанр периода: <strong>' + escapeHtml(r.topGenre) + '</strong></p>' : '');
}

Array.prototype.forEach.call(document.querySelectorAll("[data-recap]"), function (btn) {
  btn.addEventListener("click", function () {
    activeRecapKind = btn.getAttribute("data-recap");
    Array.prototype.forEach.call(document.querySelectorAll("[data-recap]"), function (b) { b.classList.toggle("active", b === btn); });
    renderRecap(activeRecapKind);
  });
});
