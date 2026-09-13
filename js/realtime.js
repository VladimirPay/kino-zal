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
import { showStatus } from "./utils.js";

export function subscribeRealtime() {
  if (state.realtimeChannel) return;
  state.realtimeChannel = sb.channel("public:kinozal")
    .on("postgres_changes", {event: "*", schema: "public", table: "titles"}, function () { if (state.activeSection === "mylist") loadMyList(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "user_titles"}, function () { if (state.activeSection === "mylist") loadMyList(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "ratings"}, function () { if (state.activeSection === "mylist") loadMyList(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "comments"}, function () { if (state.activeSection === "mylist") loadMyList(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "comment_likes"}, function () { if (state.activeSection === "mylist") loadMyList(); })
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
      showStatus("🎉 У вас совпадение с " + otherName + " во вкладке «Матч»!");
      if (state.activeSection === "match") loadMatchesList();
    })
    .subscribe();
}
