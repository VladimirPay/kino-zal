// Наш Кинозал — вкладка «Друзья»: поиск, заявки, список друзей, лента активности.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader, showSection } from "./router.js";
import { openDmThread } from "./messages.js";

export async function loadFriends() {
  const { data, error } = await sb.from("friend_requests")
    .select("*, from_profile:profiles!from_user(display_name), to_profile:profiles!to_user(display_name)")
    .or("from_user.eq." + state.myProfile.id + ",to_user.eq." + state.myProfile.id);
  if (error) { showStatus("Не удалось загрузить друзей: " + error.message, true); return; }
  var all = data || [];
  state.friendRequestsIn = all.filter(function (r) { return r.status === 'pending' && r.to_user === state.myProfile.id; });
  state.friendRequestsOut = all.filter(function (r) { return r.status === 'pending' && r.from_user === state.myProfile.id; });
  state.friends = all.filter(function (r) { return r.status === 'accepted'; }).map(function (r) {
    var mineIsFrom = r.from_user === state.myProfile.id;
    return { id: mineIsFrom ? r.to_user : r.from_user, display_name: mineIsFrom ? (r.to_profile || {}).display_name : (r.from_profile || {}).display_name };
  });
  renderFriendsSection();
  loadFriendsFeed();
}

function friendStatusFor(id) {
  if (state.friends.some(function (f) { return f.id === id; })) return "friends";
  if (state.friendRequestsOut.some(function (r) { return r.to_user === id; })) return "pending_out";
  if (state.friendRequestsIn.some(function (r) { return r.from_user === id; })) return "pending_in";
  return "none";
}

document.getElementById("friendSearchForm").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var q = document.getElementById("friendSearchInput").value.trim();
  var results = document.getElementById("friendSearchResults");
  if (!q) { results.innerHTML = ""; return; }
  const { data, error } = await sb.from("profiles").select("id,display_name").ilike("display_name", "%" + q + "%").neq("id", state.myProfile.id).limit(20);
  if (error) { results.innerHTML = '<p class="empty-note">Ошибка поиска: ' + escapeHtml(error.message) + '</p>'; return; }
  if (!data || !data.length) { results.innerHTML = '<p class="empty-note">Никого не найдено.</p>'; return; }
  results.innerHTML = data.map(function (p) {
    var st = friendStatusFor(p.id);
    var action = st === "friends" ? '<span class="badge">уже друзья</span>'
      : st === "pending_out" ? '<button class="btn small" disabled>заявка отправлена</button>'
      : st === "pending_in" ? '<button class="btn small primary" data-accept-name="' + p.id + '">принять заявку</button>'
      : '<button class="btn small" data-send-req="' + p.id + '">добавить в друзья</button>';
    return '<div class="friend-row"><div>' + escapeHtml(p.display_name) + '</div><div class="friend-actions">' + action + '</div></div>';
  }).join("");
  Array.prototype.forEach.call(results.querySelectorAll("[data-send-req]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("friend_requests").insert({from_user: state.myProfile.id, to_user: btn.getAttribute("data-send-req")});
      if (error) showStatus("Не удалось отправить заявку: " + error.message, true);
      else { showStatus("Заявка отправлена"); loadFriends(); }
    });
  });
  Array.prototype.forEach.call(results.querySelectorAll("[data-accept-name]"), function (btn) {
    btn.addEventListener("click", async function () {
      var otherId = btn.getAttribute("data-accept-name");
      var req = state.friendRequestsIn.find(function (r) { return r.from_user === otherId; });
      if (!req) return;
      const { error } = await sb.from("friend_requests").update({status: "accepted", responded_at: new Date().toISOString()}).eq("id", req.id);
      if (error) showStatus("Ошибка: " + error.message, true);
      else loadFriends();
    });
  });
});

function renderFriendsSection() {
  var inEl = document.getElementById("friendRequestsIn");
  inEl.innerHTML = state.friendRequestsIn.length ? state.friendRequestsIn.map(function (r) {
    var name = (r.from_profile || {}).display_name || "…";
    return '<div class="friend-row"><div>' + escapeHtml(name) + '</div><div class="friend-actions">' +
      '<button class="btn small primary" data-accept="' + r.id + '">Принять</button>' +
      '<button class="btn small" data-decline="' + r.id + '">Отклонить</button>' +
    '</div></div>';
  }).join("") : '<p class="empty-note">Заявок нет.</p>';
  Array.prototype.forEach.call(inEl.querySelectorAll("[data-accept]"), function (btn) {
    btn.addEventListener("click", async function () {
      await sb.from("friend_requests").update({status: "accepted", responded_at: new Date().toISOString()}).eq("id", btn.getAttribute("data-accept"));
      loadFriends();
    });
  });
  Array.prototype.forEach.call(inEl.querySelectorAll("[data-decline]"), function (btn) {
    btn.addEventListener("click", async function () {
      // Отклонённую заявку удаляем целиком (а не помечаем статусом), чтобы
      // тот же человек мог отправить новую заявку позже — этому мешал бы
      // уникальный индекс (from_user, to_user), если бы старая строка осталась.
      await sb.from("friend_requests").delete().eq("id", btn.getAttribute("data-decline"));
      loadFriends();
    });
  });

  var outEl = document.getElementById("friendRequestsOut");
  outEl.innerHTML = state.friendRequestsOut.length ? state.friendRequestsOut.map(function (r) {
    var name = (r.to_profile || {}).display_name || "…";
    return '<div class="friend-row"><div>' + escapeHtml(name) + '</div><div class="friend-actions">' +
      '<button class="btn small" data-cancel="' + r.id + '">Отменить</button>' +
    '</div></div>';
  }).join("") : '<p class="empty-note">Нет отправленных заявок.</p>';
  Array.prototype.forEach.call(outEl.querySelectorAll("[data-cancel]"), function (btn) {
    btn.addEventListener("click", async function () {
      await sb.from("friend_requests").delete().eq("id", btn.getAttribute("data-cancel"));
      loadFriends();
    });
  });

  var listEl = document.getElementById("friendsList");
  listEl.innerHTML = state.friends.length ? state.friends.map(function (f) {
    return '<div class="friend-row"><div>' + escapeHtml(f.display_name || "…") + '</div><div class="friend-actions">' +
      '<button class="btn small" data-dm="' + f.id + '">Написать</button>' +
      '<button class="btn small danger" data-unfriend="' + f.id + '">Удалить из друзей</button>' +
    '</div></div>';
  }).join("") : '<p class="empty-note">Пока никого не добавили.</p>';
  Array.prototype.forEach.call(listEl.querySelectorAll("[data-dm]"), function (btn) {
    btn.addEventListener("click", function () { showSection("messages"); openDmThread(btn.getAttribute("data-dm")); });
  });
  Array.prototype.forEach.call(listEl.querySelectorAll("[data-unfriend]"), function (btn) {
    btn.addEventListener("click", async function () {
      var otherId = btn.getAttribute("data-unfriend");
      if (!confirm("Удалить из друзей?")) return;
      await sb.from("friend_requests").delete().or("and(from_user.eq." + state.myProfile.id + ",to_user.eq." + otherId + "),and(from_user.eq." + otherId + ",to_user.eq." + state.myProfile.id + ")");
      loadFriends();
    });
  });
}

export async function loadFriendsFeed() {
  const { data, error } = await sb.from("activity_feed")
    .select("*, profiles!user_id(display_name), titles!title_id(title, media_type)")
    .order("created_at", {ascending: false}).limit(30);
  var el = document.getElementById("friendsFeed");
  if (error) { el.innerHTML = '<p class="empty-note">Не удалось загрузить ленту.</p>'; return; }
  if (!data || !data.length) { el.innerHTML = '<p class="empty-note">Пока тихо.</p>'; return; }
  el.innerHTML = data.map(function (a) {
    var name = (a.profiles || {}).display_name || "…";
    var t = a.titles || {};
    var verb = a.kind === "watched" ? "посмотрел(а)" : a.kind === "rated" ? ("оценил(а) на " + ((a.extra || {}).value || "?") + "★") : "написал(а) отзыв к";
    return '<div class="activity-item"><strong>' + escapeHtml(name) + '</strong> ' + verb + ' «' + escapeHtml(t.title || "…") + '» <span class="mono" style="color:var(--muted);font-size:0.75rem;">' + fmtTime(a.created_at) + '</span></div>';
  }).join("");
}

registerSectionLoader("friends", loadFriends);
