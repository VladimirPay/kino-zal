// Наш Кинозал — вкладка «Чат» (общий чат всех пользователей).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, fmtTime, sharedTitleCardHtml, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";
import { openUserCard } from "./userCard.js";
import { openTitleDetail } from "./titleDetail.js";
import { toggleEmojiPanel, reactionBarHtml, bindReactionHandlers } from "./emoji.js";
import { uploadChatImage } from "./chatMedia.js";

export async function loadChat() {
  // titles!shared_title_id — карточка фильма/сериала, которым поделились
  // (см. «Поделиться» в titleDetail.js и social-upgrade-7.sql); для обычных
  // сообщений без вложения будет null.
  const { data, error } = await sb.from("chat_messages")
    .select("*, profiles!user_id(display_name), titles!shared_title_id(id,title,year,poster_url,media_type,kp_rating)")
    .order("created_at", {ascending: false}).limit(150);
  if (error) { showStatus("Не удалось загрузить чат: " + error.message, true); return; }
  state.chatMessages = (data || []).slice().reverse();
  await loadChatReactions();
  renderChat();
}

// Реакции подгружаем отдельным запросом (одним на все загруженные сообщения
// сразу) — таблица message_reactions общая на чат и личные сообщения, и
// готового "embed" через связь тут нет (kind — не внешний ключ), поэтому
// группируем сами, как и в других местах сайта с ручными джойнами.
async function loadChatReactions() {
  var ids = state.chatMessages.map(function (m) { return m.id; });
  state.chatReactions = {};
  if (!ids.length) return;
  try {
    var res = await sb.from("message_reactions").select("message_id,user_id,emoji").eq("kind", "chat").in("message_id", ids);
    (res.data || []).forEach(function (r) {
      (state.chatReactions[r.message_id] = state.chatReactions[r.message_id] || []).push({ user_id: r.user_id, emoji: r.emoji });
    });
  } catch (e) { /* миграция social-upgrade-5.sql ещё не выполнена — просто без реакций */ }
}

function chatMsgHtml(m) {
  var who = (m.profiles && m.profiles.display_name) || (state.profilesById[m.user_id] || {}).display_name || "…";
  var mine = m.user_id === state.myProfile.id;
  return '<div class="chat-msg' + (mine ? " mine" : "") + '"><div class="who"><button type="button" class="btn linklike small" data-open-user="' + m.user_id + '" style="padding:0;">' + escapeHtml(who) + '</button><span class="when">' + fmtTime(m.created_at) + '</span></div>' +
    (m.text ? '<div>' + escapeHtml(m.text) + '</div>' : '') +
    (m.image_url ? '<a href="' + escapeHtml(m.image_url) + '" target="_blank" rel="noopener"><img class="chat-img" src="' + escapeHtml(m.image_url) + '" alt="" loading="lazy"></a>' : '') +
    (m.shared_title_id ? sharedTitleCardHtml(m.titles) : '') +
    reactionBarHtml(m.id, state.chatReactions[m.id], state.myProfile.id) +
    '</div>';
}

export function renderChat() {
  var log = document.getElementById("chatLog");
  log.innerHTML = state.chatMessages.length ? state.chatMessages.map(chatMsgHtml).join("") : '<p class="empty-note">Пока никто не написал — начните разговор!</p>';
  log.scrollTop = log.scrollHeight;
  // Клик по имени автора сообщения открывает его карточку профиля — оттуда
  // можно сразу добавить в друзья или написать в ЛС, без ручного поиска.
  Array.prototype.forEach.call(log.querySelectorAll("[data-open-user]"), function (btn) {
    btn.addEventListener("click", function () { openUserCard(btn.getAttribute("data-open-user")); });
  });
  // Клик по прикреплённой карточке фильма/сериала открывает её общую
  // карточку (ту же, что в «Каталоге»/«Моём списке») — stopPropagation не
  // нужен, у самого сообщения нет своего обработчика клика.
  Array.prototype.forEach.call(log.querySelectorAll("[data-open-title]"), function (el) {
    el.addEventListener("click", function () { openTitleDetail(parseInt(el.getAttribute("data-open-title"), 10)); });
  });
  bindReactionHandlers(log, { sb: sb, state: state, kind: "chat", reactionsMap: state.chatReactions, rerender: renderChat });
}

document.getElementById("chatForm").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var input = document.getElementById("chatInput");
  var text = input.value.trim();
  if (!text) return;
  const { error } = await sb.from("chat_messages").insert({user_id: state.myProfile.id, text: text});
  if (error) { showStatus("Не удалось отправить: " + error.message, true); return; }
  input.value = "";
});

document.getElementById("chatEmojiBtn").addEventListener("click", function (ev) {
  ev.stopPropagation();
  var btn = this;
  toggleEmojiPanel(btn, function (emoji) {
    var input = document.getElementById("chatInput");
    input.value += emoji;
    input.focus();
  });
});

// Прикрепление картинки отправляет сообщение сразу (вместе с уже набранным
// текстом, если он есть) — без отдельного шага "предпросмотр, затем
// отправить": для маленького междусобойного чата это лишний клик.
document.getElementById("chatImageInput").addEventListener("change", async function (ev) {
  var file = ev.target.files && ev.target.files[0];
  ev.target.value = ""; // чтобы повторный выбор того же файла тоже сработал
  if (!file) return;
  var input = document.getElementById("chatInput");
  var text = input.value.trim();
  showStatus("Загружаем картинку…");
  try {
    var imageUrl = await uploadChatImage(sb, state.myProfile.id, file);
    const { error } = await sb.from("chat_messages").insert({
      user_id: state.myProfile.id, text: text || null, image_url: imageUrl
    });
    if (error) throw error;
    input.value = "";
  } catch (e) {
    showStatus("Не удалось прикрепить картинку: " + e.message, true);
  }
});

registerSectionLoader("chat", loadChat);
