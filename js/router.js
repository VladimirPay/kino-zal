// Наш Кинозал — переключение вкладок ("секций"). Модули-фичи (mylist.js,
// chat.js, messages.js, friends.js, admin.js) сами регистрируют, что нужно
// делать при открытии их вкладки, через registerSectionLoader — так router.js
// не должен ничего знать про них напрямую (и не возникает циклических импортов).

import { state } from "./state.js";
import { SECTIONS } from "./config.js";
import { writeSessionValue } from "./utils.js";

var sectionLoaders = {};

export function registerSectionLoader(key, fn) {
  sectionLoaders[key] = fn;
}

function visibleSections() {
  var isAdmin = !!(state.myProfile && state.myProfile.role === "admin");
  return SECTIONS.filter(function (s) { return !s.adminOnly || isAdmin; });
}

export function renderMainNav() {
  var el = document.getElementById("mainNav");
  var sections = visibleSections();
  // Если сохранённая с прошлого раза вкладка (например, "Управление") больше
  // не видна этому пользователю — вернём его на "Мой список", а не оставим
  // экран в подвешенном состоянии.
  if (!sections.some(function (s) { return s.key === state.activeSection; })) {
    state.activeSection = "mylist";
  }
  el.innerHTML = sections.map(function (s) {
    return '<button data-section="' + s.key + '" class="' + (state.activeSection === s.key ? "active" : "") + '">' + s.label + '</button>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () { showSection(btn.getAttribute("data-section")); });
  });
}

export function showSection(key) {
  var allowed = visibleSections().some(function (s) { return s.key === key; });
  if (!allowed) key = "mylist";
  state.activeSection = key;
  writeSessionValue("kz_section", key);
  renderMainNav();
  SECTIONS.forEach(function (s) {
    document.getElementById("section-" + s.key).hidden = (s.key !== key);
  });
  if (sectionLoaders[key]) sectionLoaders[key]();
}
