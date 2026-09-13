// Наш Кинозал — общее состояние приложения. Один объект, который все остальные
// модули читают и меняют напрямую (state.xxx = ...) — это проще, чем тащить
// сеттеры через каждый модуль, и достаточно для одной страницы такого размера.

import { SECTIONS, TABS } from "./config.js";
import { readSessionValue } from "./utils.js";

function initialSection() {
  var v = readSessionValue("kz_section", "mylist");
  return SECTIONS.some(function (s) { return s.key === v; }) ? v : "mylist";
}
function initialTab() {
  var v = readSessionValue("kz_tab", "all");
  return TABS.some(function (t) { return t.key === v; }) ? v : "all";
}
function initialCatalogTypeFilter() {
  var v = readSessionValue("kz_catalog_type", "all");
  return ["all", "movie", "series"].indexOf(v) !== -1 ? v : "all";
}

export const state = {
  myTitles: [],
  activeSection: initialSection(),
  activeTab: initialTab(),
  searchQuery: "",
  openTitleId: null,
  session: null,
  myProfile: null,
  realtimeChannel: null,
  profilesById: {},
  allProfilesList: [],
  catalogResults: [],
  catalogMode: null, // null (ещё не открывали) | "browse" (подборка по умолчанию) | "search"
  catalogTypeFilter: initialCatalogTypeFilter(), // "all" | "movie" | "series" — только отображение, не влияет на запросы к ApiGet.ru
  chatMessages: [],
  chatReactions: {}, // messageId -> [{user_id, emoji}]
  dmConversations: {}, // partnerId -> [messages]
  dmReactions: {}, // messageId -> [{user_id, emoji}]
  activeDmUser: null,
  friendRequestsIn: [],
  friendRequestsOut: [],
  friends: []
};
