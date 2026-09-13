// Наш Кинозал — вкладка «Сообщения» (личные сообщения между двумя пользователями).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";
import { openUserCard } from "./userCard.js";
import { toggleEmojiPanel, reactionBarHtml, bindReactionHandlers } from "./emoji.js";
import { uploadChatImage } from "./chatMedia.js";

export async function loadDmConversations() {
  const { data, error } = await sb.from("dm_messages")
    .select("*")
    .or("sender_id.eq." + state.myProfile.id + ",recipient_id.eq." + state.myProfile.id)
    .order("created_at", {ascending: true});
  if (error) { showStatus("Не удалось загрузить сообщения: " + error.message, true); return; }
  var byPartner = {};
  (data || []).forEach(function (m) {
    var partner = m.sender_id === state.myProfile.id ? m.recipient_id : m.sender_id;
    if (!byPartner[partner]) byPartner[partner] = [];
    byPartner[partner].push(m);
  });
  state.dmConversations = byPartner;
  await loadDmReactions(data || []);
  renderDmNewSelect();
  renderDmList();
  if (state.activeDmUser) renderDmThread();
}

// См. комментарий у одноимённой функции в chat.js — тот же приём, только для
// личных сообщений (kind='dm').
async function loadDmReactions(messages) {
  var ids = messages.map(function (m) { return m.id; });
  state.dmReactions = {};
  if (!ids.length) return;
  try {
    var res = await sb.from("message_reactions").select("message_id,user_id,emoji").eq("kind", "dm").in("message_id", ids);
    (res.data || []).forEach(function (r) {
      (state.dmReactions[r.message_id] = state.dmReactions[r.message_id] || []).push({ user_id: r.user_id, emoji: r.emoji });
    });
  } catch (e) { /* миграция social-upgrade-5.sql ещё не выполнена — просто без реакций */ }
}

function renderDmNewSelect() {
  var sel = document.getElementById("dmNewSelect");
  var current = sel.value;
  sel.innerHTML = '<option value="">Написать кому-то новому…</option>' +
    state.allProfilesList.filter(function (p) { return p.id !== state.myProfile.id; })
      .map(function (p) { return '<option value="' + p.id + '">' + escapeHtml(p.display_name) + '</option>'; }).join("");
  sel.value = current;
}
document.getElementById("dmNewSelect").addEventListener("change", function (ev) {
  if (!ev.target.value) return;
  openDmThread(ev.target.value);
  ev.target.value = "";
});

function renderDmList() {
  var el = document.getElementById("dmListItems");
  var partners = Object.keys(state.dmConversations);
  if (!partners.length) { el.innerHTML = '<p class="dm-empty">Пока нет переписок.</p>'; return; }
  // Свежесозданная переписка (например, через «Написать» из списка друзей или
  // через выпадающий список выше) на этот момент ещё пуста — msgs может быть
  // [], поэтому "последнее сообщение" ниже везде проверяем на существование,
  // а не считаем, что оно всегда есть.
  partners.sort(function (a, b) {
    var la = state.dmConversations[a][state.dmConversations[a].length - 1], lb = state.dmConversations[b][state.dmConversations[b].length - 1];
    var ta = la ? new Date(la.created_at).getTime() : 0;
    var tb = lb ? new Date(lb.created_at).getTime() : 0;
    return tb - ta;
  });
  el.innerHTML = partners.map(function (pid) {
    var msgs = state.dmConversations[pid];
    var last = msgs[msgs.length - 1];
    var unread = msgs.filter(function (m) { return m.recipient_id === state.myProfile.id && !m.read_at; }).length;
    var name = (state.profilesById[pid] || {}).display_name || "…";
    var lastPreview = last ? (last.text ? escapeHtml(last.text) : (last.image_url ? "📷 Картинка" : "")) : "Новая переписка";
    return '<div class="dm-list-item' + (state.activeDmUser === pid ? " active" : "") + '" data-partner="' + pid + '">' +
      '<div><div>' + escapeHtml(name) + '</div><div class="preview">' + lastPreview + '</div></div>' +
      (unread ? '<span class="unread">' + unread + '</span>' : '') +
    '</div>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("[data-partner]"), function (row) {
    row.addEventListener("click", function () { openDmThread(row.getAttribute("data-partner")); });
  });
}

export async function openDmThread(partnerId) {
  state.activeDmUser = partnerId;
  if (!state.dmConversations[partnerId]) state.dmConversations[partnerId] = [];
  renderDmList();
  renderDmThread();
  var toMark = (state.dmConversations[partnerId] || []).filter(function (m) { return m.recipient_id === state.myProfile.id && !m.read_at; });
  if (toMark.length) {
    await sb.from("dm_messages").update({read_at: new Date().toISOString()})
      .eq("recipient_id", state.myProfile.id).eq("sender_id", partnerId).is("read_at", null);
  }
}

function dmMsgHtml(m) {
  var who = (state.profilesById[m.sender_id] || {}).display_name || "…";
  var mine = m.sender_id === state.myProfile.id;
  return '<div class="chat-msg' + (mine ? " mine" : "") + '"><div class="who"><button type="button" class="btn linklike small" data-open-user="' + m.sender_id + '" style="padding:0;">' + escapeHtml(who) + '</button><span class="when">' + fmtTime(m.created_at) + '</span></div>' +
    (m.text ? '<div>' + escapeHtml(m.text) + '</div>' : '') +
    (m.image_url ? '<a href="' + escapeHtml(m.image_url) + '" target="_blank" rel="noopener"><img class="chat-img" src="' + escapeHtml(m.image_url) + '" alt="" loading="lazy"></a>' : '') +
    reactionBarHtml(m.id, state.dmReactions[m.id], state.myProfile.id) +
    '</div>';
}

export function renderDmThread() {
  var thread = document.getElementById("dmThread");
  thread.classList.add("open");
  var head = document.getElementById("dmThreadHead");
  var partnerName = (state.profilesById[state.activeDmUser] || {}).display_name || "…";
  head.hidden = false;
  head.innerHTML = '<button type="button" class="btn linklike" data-open-user="' + state.activeDmUser + '">' + escapeHtml(partnerName) + '</button>';
  head.querySelector("[data-open-user]").addEventListener("click", function () { openUserCard(state.activeDmUser); });
  var log = document.getElementById("dmLog");
  var msgs = state.dmConversations[state.activeDmUser] || [];
  log.innerHTML = msgs.length ? msgs.map(dmMsgHtml).join("") : '<p class="empty-note">Начните переписку.</p>';
  log.scrollTop = log.scrollHeight;
  // Клик по имени автора конкретного сообщения тоже открывает карточку профиля.
  Array.prototype.forEach.call(log.querySelectorAll("[data-open-user]"), function (btn) {
    btn.addEventListener("click", function () { openUserCard(btn.getAttribute("data-open-user")); });
  });
  bindReactionHandlers(log, { sb: sb, state: state, kind: "dm", reactionsMap: state.dmReactions, rerender: renderDmThread });
}

document.getElementById("dmForm").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  if (!state.activeDmUser) { showStatus("Сначала выберите собеседника", true); return; }
  var input = document.getElementById("dmInput");
  var text = input.value.trim();
  if (!text) return;
  const { error } = await sb.from("dm_messages").insert({sender_id: state.myProfile.id, recipient_id: state.activeDmUser, text: text});
  if (error) { showStatus("Не удалось отправить: " + error.message, true); return; }
  input.value = "";
});

document.getElementById("dmEmojiBtn").addEventListener("click", function (ev) {
  ev.stopPropagation();
  var btn = this;
  toggleEmojiPanel(btn, function (emoji) {
    var input = document.getElementById("dmInput");
    input.value += emoji;
    input.focus();
  });
});

document.getElementById("dmImageInput").addEventListener("change", async function (ev) {
  var file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  if (!state.activeDmUser) { showStatus("Сначала выберите собеседника", true); return; }
  var input = document.getElementById("dmInput");
  var text = input.value.trim();
  showStatus("Загружаем картинку…");
  try {
    var imageUrl = await uploadChatImage(sb, state.myProfile.id, file);
    const { error } = await sb.from("dm_messages").insert({
      sender_id: state.myProfile.id, recipient_id: state.activeDmUser, text: text || null, image_url: imageUrl
    });
    if (error) throw error;
    input.value = "";
  } catch (e) {
    showStatus("Не удалось прикрепить картинку: " + e.message, true);
  }
});

registerSectionLoader("messages", loadDmConversations);
