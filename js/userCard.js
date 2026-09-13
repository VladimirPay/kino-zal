// Наш Кинозал — карточка профиля человека: открывается по клику на имя в чате,
// в комментариях или в личных сообщениях. Показывает имя/роль/о себе и даёт
// сразу же добавить в друзья или написать — не нужно искать человека отдельно
// на вкладке «Друзья» (это и есть самый частый вопрос — «как добавить в
// друзья», если просто знаешь ник, но не искал его вручную).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { bindClose, escapeHtml, showStatus } from "./utils.js";
import { showSection } from "./router.js";
import { openDmThread } from "./messages.js";

export async function openUserCard(userId) {
  var dlg = document.getElementById("userCardDialog");
  var inner = dlg.querySelector(".dialog-inner");
  inner.innerHTML = '<button class="close-x" data-close="userCardDialog">✕</button><p class="empty-note">Загрузка…</p>';
  bindClose(inner);
  if (!dlg.open) dlg.showModal();
  await renderUserCard(userId);
}

async function renderUserCard(userId) {
  var dlg = document.getElementById("userCardDialog");
  var inner = dlg.querySelector(".dialog-inner");

  const [{data: profRows, error: profErr}, {data: reqRows, error: reqErr}] = await Promise.all([
    sb.from("profiles").select("*").eq("id", userId).limit(1),
    userId === state.myProfile.id
      ? Promise.resolve({data: [], error: null})
      : sb.from("friend_requests").select("*").or(
          "and(from_user.eq." + state.myProfile.id + ",to_user.eq." + userId + ")," +
          "and(from_user.eq." + userId + ",to_user.eq." + state.myProfile.id + ")"
        )
  ]);
  if (profErr || !profRows || !profRows.length) {
    inner.innerHTML = '<button class="close-x" data-close="userCardDialog">✕</button><p class="empty-note">Не удалось загрузить профиль' + (profErr ? ": " + escapeHtml(profErr.message) : "") + '.</p>';
    bindClose(inner);
    return;
  }
  var p = profRows[0];
  var isMe = userId === state.myProfile.id;
  var req = (reqRows || [])[0] || null;

  var actionsHtml;
  if (isMe) {
    actionsHtml = '<p class="catalog-hint" style="margin:10px 0 0;">Это ваш профиль.</p>';
  } else if (reqErr) {
    actionsHtml = '<p class="empty-note">Не удалось проверить статус дружбы: ' + escapeHtml(reqErr.message) + '</p>';
  } else if (req && req.status === "accepted") {
    actionsHtml =
      '<div class="dialog-actions" style="justify-content:flex-start;margin-top:14px;">' +
        '<button class="btn small" id="ucMsgBtn" type="button">Написать</button>' +
        '<button class="btn small danger" id="ucUnfriendBtn" type="button">Удалить из друзей</button>' +
      '</div>';
  } else if (req && req.status === "pending" && req.from_user === state.myProfile.id) {
    actionsHtml = '<div class="dialog-actions" style="justify-content:flex-start;margin-top:14px;"><button class="btn small" disabled>Заявка отправлена</button></div>';
  } else if (req && req.status === "pending" && req.to_user === state.myProfile.id) {
    actionsHtml =
      '<div class="dialog-actions" style="justify-content:flex-start;margin-top:14px;">' +
        '<button class="btn small primary" id="ucAcceptBtn" type="button">Принять заявку</button>' +
        '<button class="btn small" id="ucDeclineBtn" type="button">Отклонить</button>' +
      '</div>';
  } else {
    actionsHtml = '<div class="dialog-actions" style="justify-content:flex-start;margin-top:14px;"><button class="btn small primary" id="ucAddBtn" type="button">Добавить в друзья</button></div>';
  }

  inner.innerHTML =
    '<button class="close-x" data-close="userCardDialog">✕</button>' +
    '<h2>' + escapeHtml(p.display_name) + '</h2>' +
    (p.role === "admin" ? '<span class="role-badge">администратор</span>' : '') +
    (p.bio ? '<p class="detail-note">' + escapeHtml(p.bio) + '</p>' : '<p class="catalog-hint" style="margin:8px 0 0;">Пользователь пока ничего не написал о себе.</p>') +
    actionsHtml;
  bindClose(inner);

  var addBtn = inner.querySelector("#ucAddBtn");
  if (addBtn) addBtn.addEventListener("click", async function () {
    const { error } = await sb.from("friend_requests").insert({from_user: state.myProfile.id, to_user: userId});
    if (error) { showStatus("Не удалось отправить заявку: " + error.message, true); return; }
    showStatus("Заявка отправлена");
    renderUserCard(userId);
  });
  var acceptBtn = inner.querySelector("#ucAcceptBtn");
  if (acceptBtn) acceptBtn.addEventListener("click", async function () {
    const { error } = await sb.from("friend_requests").update({status: "accepted", responded_at: new Date().toISOString()}).eq("id", req.id);
    if (error) { showStatus("Ошибка: " + error.message, true); return; }
    renderUserCard(userId);
  });
  var declineBtn = inner.querySelector("#ucDeclineBtn");
  if (declineBtn) declineBtn.addEventListener("click", async function () {
    await sb.from("friend_requests").delete().eq("id", req.id);
    renderUserCard(userId);
  });
  var unfriendBtn = inner.querySelector("#ucUnfriendBtn");
  if (unfriendBtn) unfriendBtn.addEventListener("click", async function () {
    if (!confirm("Удалить из друзей?")) return;
    await sb.from("friend_requests").delete().eq("id", req.id);
    renderUserCard(userId);
  });
  var msgBtn = inner.querySelector("#ucMsgBtn");
  if (msgBtn) msgBtn.addEventListener("click", function () {
    dlg.close();
    showSection("messages");
    openDmThread(userId);
  });
}
