// Наш Кинозал — вкладка «Сообщения» (личные сообщения между двумя пользователями).

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";

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
  renderDmNewSelect();
  renderDmList();
  if (state.activeDmUser) renderDmThread();
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
    return '<div class="dm-list-item' + (state.activeDmUser === pid ? " active" : "") + '" data-partner="' + pid + '">' +
      '<div><div>' + escapeHtml(name) + '</div><div class="preview">' + (last ? escapeHtml(last.text) : "Новая переписка") + '</div></div>' +
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
  return '<div class="chat-msg' + (mine ? " mine" : "") + '"><div class="who">' + escapeHtml(who) + '<span class="when">' + fmtTime(m.created_at) + '</span></div><div>' + escapeHtml(m.text) + '</div></div>';
}

function renderDmThread() {
  var thread = document.getElementById("dmThread");
  thread.classList.add("open");
  var log = document.getElementById("dmLog");
  var msgs = state.dmConversations[state.activeDmUser] || [];
  log.innerHTML = msgs.length ? msgs.map(dmMsgHtml).join("") : '<p class="empty-note">Начните переписку.</p>';
  log.scrollTop = log.scrollHeight;
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

registerSectionLoader("messages", loadDmConversations);
