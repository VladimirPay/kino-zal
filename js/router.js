// Наш Кинозал — переключение вкладок ("секций"). Модули-фичи (mylist.js,
// chat.js, messages.js, friends.js) сами регистрируют, что нужно делать при
// открытии их вкладки, через registerSectionLoader — так router.js не должен
// ничего знать про них напрямую (и не возникает циклических импортов).

import { state } from "./state.js";
import { SECTIONS } from "./config.js";
import { writeSessionValue } from "./utils.js";

var sectionLoaders = {};

export function registerSectionLoader(key, fn) {
  sectionLoaders[key] = fn;
}

export function renderMainNav() {
  var el = document.getElementById("mainNav");
  el.innerHTML = SECTIONS.map(function (s) {
    return '<button data-section="' + s.key + '" class="' + (state.activeSection === s.key ? "active" : "") + '">' + s.label + '</button>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () { showSection(btn.getAttribute("data-section")); });
  });
}

export function showSection(key) {
  state.activeSection = key;
  writeSessionValue("kz_section", key);
  renderMainNav();
  SECTIONS.forEach(function (s) {
    document.getElementById("section-" + s.key).hidden = (s.key !== key);
  });
  if (sectionLoaders[key]) sectionLoaders[key]();
}
