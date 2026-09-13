// Наш Кинозал — подписка на «живые» обновления Supabase Realtime. Держит
// открытым один канал на все таблицы и обновляет только ту вкладку, которая
// сейчас открыта (activeSection) — не тратит время на невидимые вкладки.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { loadMyList } from "./mylist.js";
import { renderChat } from "./chat.js";
import { loadDmConversations, renderDmThread } from "./messages.js";
import { loadFriends, loadFriendsFeed } from "./friends.js";
import { loadMatchesList } from "./matchgame.js";
import { refreshReportsIfVisible } from "./admin.js";
import { showStatus } from "./utils.js";

// Правки titles/ratings/comments/comment_likes часто прилетают пачками за
// пару секунд (например: один пользователь поставил оценку и написал
// комментарий, или фоновая подгрузка трейлера при первом открытии карточки
// тоже пишет в titles). Без задержки каждое такое событие немедленно гоняло
// бы полный loadMyList() — то есть повторную перерисовку всей сетки «Мой
// список» на КАЖДОЕ отдельное изменение. Схлопываем события в одном коротком
// окне в один вызов — самая частая причина того, что ряды «Мой список»
// выглядели самопроизвольно перезагружающимися.
var myListReloadTimer = null;
function scheduleMyListReload() {
  if (state.activeSection !== "mylist") return;
  if (myListReloadTimer) clearTimeout(myListReloadTimer);
  myListReloadTimer = setTimeout(function () { myListReloadTimer = null; loadMyList(); }, 400);
}

export function subscribeRealtime() {
  if (state.realtimeChannel) return;
  state.realtimeChannel = sb.channel("public:kinozal")
    .on("postgres_changes", {event: "*", schema: "public", table: "titles"}, scheduleMyListReload)
    .on("postgres_changes", {event: "*", schema: "public", table: "user_titles"}, scheduleMyListReload)
    .on("postgres_changes", {event: "*", schema: "public", table: "ratings"}, scheduleMyListReload)
    .on("postgres_changes", {event: "*", schema: "public", table: "comments"}, scheduleMyListReload)
    .on("postgres_changes", {event: "*", schema: "public", table: "comment_likes"}, scheduleMyListReload)
    .on("postgres_changes", {event: "INSERT", schema: "public", table: "chat_messages"}, function (payload) {
      var row = payload.new;
      row.profiles = { display_name: (state.profilesById[row.user_id] || {}).display_name || "…" };
      state.chatMessages.push(row);
      if (state.activeSection === "chat") renderChat();
    })
    .on("postgres_changes", {event: "DELETE", schema: "public", table: "chat_messages"}, function (payload) {
      state.chatMessages = state.chatMessages.filter(function (m) { return m.id !== payload.old.id; });
      if (state.activeSection === "chat") renderChat();
    })
    .on("postgres_changes", {event: "*", schema: "public", table: "dm_messages"}, function () { if (state.activeSection === "messages") loadDmConversations(); })
    // Реакции-эмодзи под сообщениями чата/ЛС — общая таблица message_reactions
    // (kind различает, к чему относится message_id). Чтобы не гонять лишний
    // раз запрос за всей историей чата ради одной реакции, просто правим
    // локальный кэш реакций и перерисовываем, если нужная вкладка открыта.
    .on("postgres_changes", {event: "INSERT", schema: "public", table: "message_reactions"}, function (payload) {
      var r = payload.new;
      var map = r.kind === "chat" ? state.chatReactions : state.dmReactions;
      var list = map[r.message_id] = map[r.message_id] || [];
      if (!list.some(function (x) { return x.user_id === r.user_id && x.emoji === r.emoji; })) list.push({ user_id: r.user_id, emoji: r.emoji });
      if (r.kind === "chat" && state.activeSection === "chat") renderChat();
      if (r.kind === "dm" && state.activeSection === "messages" && state.activeDmUser) renderDmThread();
    })
    .on("postgres_changes", {event: "DELETE", schema: "public", table: "message_reactions"}, function (payload) {
      var r = payload.old;
      var map = r.kind === "chat" ? state.chatReactions : state.dmReactions;
      if (map[r.message_id]) map[r.message_id] = map[r.message_id].filter(function (x) { return !(x.user_id === r.user_id && x.emoji === r.emoji); });
      if (r.kind === "chat" && state.activeSection === "chat") renderChat();
      if (r.kind === "dm" && state.activeSection === "messages" && state.activeDmUser) renderDmThread();
    })
    .on("postgres_changes", {event: "*", schema: "public", table: "friend_requests"}, function () { if (state.activeSection === "friends") loadFriends(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "activity_feed"}, function () { if (state.activeSection === "friends") loadFriendsFeed(); })
    // Совпадение в игре «Матч» может случиться и когда вы не открывали эту
    // вкладку (ваш друг только что лайкнул то же, что понравилось вам
    // раньше) — уведомляем сразу через баннер статуса, независимо от того,
    // где вы сейчас находитесь на сайте.
    .on("postgres_changes", {event: "INSERT", schema: "public", table: "matches"}, function (payload) {
      var m = payload.new;
      if (m.user_a !== state.myProfile.id && m.user_b !== state.myProfile.id) return;
      var otherId = m.user_a === state.myProfile.id ? m.user_b : m.user_a;
      var otherName = (state.profilesById[otherId] || {}).display_name || "друг";
      showStatus("🎉 У вас совпадение с " + otherName + " во вкладке «Мэтч»!");
      if (state.activeSection === "match") loadMatchesList();
    })
    // Жалобы (user_reports, social-upgrade-8.sql) видны только администратору
    // (RLS) — эхо этого события прилетит только клиентам-администраторам,
    // остальным Realtime его просто не покажет.
    .on("postgres_changes", {event: "INSERT", schema: "public", table: "user_reports"}, function () {
      if (state.myProfile.role !== "admin") return;
      showStatus("🚩 Новая жалоба на пользователя — «Управление → Жалобы»");
      refreshReportsIfVisible();
    })
    .subscribe();
}
