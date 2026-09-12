// Наш Кинозал — подписка на «живые» обновления Supabase Realtime. Держит
// открытым один канал на все таблицы и обновляет только ту вкладку, которая
// сейчас открыта (activeSection) — не тратит время на невидимые вкладки.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { loadMyList } from "./mylist.js";
import { renderChat } from "./chat.js";
import { loadDmConversations } from "./messages.js";
import { loadFriends, loadFriendsFeed } from "./friends.js";

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
    .on("postgres_changes", {event: "*", schema: "public", table: "friend_requests"}, function () { if (state.activeSection === "friends") loadFriends(); })
    .on("postgres_changes", {event: "*", schema: "public", table: "activity_feed"}, function () { if (state.activeSection === "friends") loadFriendsFeed(); })
    .subscribe();
}
