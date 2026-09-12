// Наш Кинозал — строка «Вы: …» в шапке, диалог профиля (имя/о себе/пароль/
// делиться активностью), достижения. Кнопка «Пользователи» открывает admin.js.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { showStatus } from "./utils.js";
import { escapeHtml } from "./utils.js";
import { openAdminDialog } from "./admin.js";

export function renderYouRow() {
  var el = document.getElementById("youRow");
  if (!state.myProfile) { el.innerHTML = ""; return; }
  var isAdmin = state.myProfile.role === "admin";
  el.innerHTML =
    'Вы: <strong>' + escapeHtml(state.myProfile.display_name) + '</strong> ' +
    '<span class="role-badge">' + (isAdmin ? "администратор" : "участник") + '</span> ' +
    '<button class="btn small" id="profileBtn" type="button">Профиль</button>' +
    (isAdmin ? '<button class="btn small" id="adminBtn" type="button">Пользователи</button>' : '');
  document.getElementById("profileBtn").addEventListener("click", openProfileDialog);
  if (isAdmin) document.getElementById("adminBtn").addEventListener("click", openAdminDialog);
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
