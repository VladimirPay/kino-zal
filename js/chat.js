// Наш Кинозал — вкладка «Чат» (общий чат всех пользователей).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";

export async function loadChat() {
  const { data, error } = await sb.from("chat_messages").select("*, profiles!user_id(display_name)").order("created_at", {ascending: false}).limit(150);
  if (error) { showStatus("Не удалось загрузить чат: " + error.message, true); return; }
  state.chatMessages = (data || []).slice().reverse();
  renderChat();
}

function chatMsgHtml(m) {
  var who = (m.profiles && m.profiles.display_name) || (state.profilesById[m.user_id] || {}).display_name || "…";
  var mine = m.user_id === state.myProfile.id;
  return '<div class="chat-msg' + (mine ? " mine" : "") + '"><div class="who">' + escapeHtml(who) + '<span class="when">' + fmtTime(m.created_at) + '</span></div><div>' + escapeHtml(m.text) + '</div></div>';
}

export function renderChat() {
  var log = document.getElementById("chatLog");
  log.innerHTML = state.chatMessages.length ? state.chatMessages.map(chatMsgHtml).join("") : '<p class="empty-note">Пока никто не написал — начните разговор!</p>';
  log.scrollTop = log.scrollHeight;
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

registerSectionLoader("chat", loadChat);
