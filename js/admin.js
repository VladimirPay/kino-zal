// Наш Кинозал — вкладка «Управление» (видна только администраторам — см.
// SECTIONS в config.js и гейтинг в router.js). Четыре раздела:
//  · Пользователи — выдать/снять права администратора;
//  · Фильмы — весь каталог тайтлов, с возможностью удалить (вместе со всеми
//    личными статусами/оценками/комментариями к нему у всех пользователей —
//    это разрешено RLS-политикой "titles: delete admin only");
//  · Лимиты API — сколько запросов к ApiGet.ru было сделано и примерно
//    сколько это стоило (0.01₽ за успешный запрос, без дневного лимита) —
//    из таблицы kp_api_log, которую пишет catalog.js при каждом обращении;
//  · Журнал действий — activity_log: кто/что/когда менял, пишется
//    триггерами на уровне базы данных (см. auth-upgrade.sql), не зависит от
//    кода сайта — при желании данные можно прочитать/перенести и без него.
//
// Таблицы kp_api_log и dismissed_recommendations создаются отдельной,
// неразрушающей миграцией social-upgrade-2.sql. Пока она не выполнена,
// раздел «Лимиты API» просто показывает вежливое пояснение вместо ошибки.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { ADMIN_TABS, TYPE_LABEL } from "./config.js";
import { escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";

var activeAdminTab = "users";
var allAdminTitles = [];

var PANEL_IDS = {
  users: "adminPanelUsers",
  titles: "adminPanelTitles",
  apiLimits: "adminPanelApi",
  activityLog: "adminPanelLog"
};

export async function loadAdminSection() {
  renderAdminTabs();
  await loadAdminPanel(activeAdminTab);
}

function renderAdminTabs() {
  var el = document.getElementById("adminTabs");
  el.innerHTML = ADMIN_TABS.map(function (t) {
    return '<button data-admin-tab="' + t.key + '" class="' + (activeAdminTab === t.key ? "active" : "") + '">' + t.label + '</button>';
  }).join("");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () {
      activeAdminTab = btn.getAttribute("data-admin-tab");
      renderAdminTabs();
      loadAdminPanel(activeAdminTab);
    });
  });
  ADMIN_TABS.forEach(function (t) {
    document.getElementById(PANEL_IDS[t.key]).hidden = (t.key !== activeAdminTab);
  });
}

function loadAdminPanel(key) {
  if (key === "users") return loadUsersPanel();
  if (key === "titles") return loadTitlesPanel();
  if (key === "apiLimits") return loadApiLimitsPanel();
  if (key === "activityLog") return loadActivityLogPanel();
}

// ---------- Пользователи ----------
async function loadUsersPanel() {
  const { data, error } = await sb.from("profiles").select("*").order("display_name");
  var tbody = document.querySelector("#usersTable tbody");
  if (error) { tbody.innerHTML = '<tr><td>Ошибка загрузки: ' + escapeHtml(error.message) + '</td></tr>'; return; }
  tbody.innerHTML = '<tr><th>Имя</th><th>Роль</th><th></th></tr>' + data.map(function (u) {
    var isMe = u.id === state.myProfile.id;
    var isAdm = u.role === "admin";
    return '<tr><td>' + escapeHtml(u.display_name) + (isMe ? ' <span class="mono" style="color:var(--muted);font-size:0.75rem;">(вы)</span>' : '') + '</td>' +
      '<td>' + (isAdm ? 'администратор' : 'участник') + '</td>' +
      '<td>' + (isMe ? '' : '<button class="btn small" data-uid="' + u.id + '" data-role="' + (isAdm ? "user" : "admin") + '">' + (isAdm ? "Снять права" : "Сделать админом") + '</button>') + '</td></tr>';
  }).join("");
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-uid]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("profiles").update({role: btn.getAttribute("data-role")}).eq("id", btn.getAttribute("data-uid"));
      if (error) { showStatus("Не удалось изменить роль: " + error.message, true); return; }
      loadUsersPanel();
    });
  });
}

// ---------- Фильмы ----------
async function loadTitlesPanel() {
  var tbody = document.querySelector("#titlesTable tbody");
  tbody.innerHTML = '<tr><td>Загрузка…</td></tr>';
  const { data, error } = await sb.from("titles").select("*").order("created_at", {ascending: false});
  if (error) { tbody.innerHTML = '<tr><td>Ошибка загрузки: ' + escapeHtml(error.message) + '</td></tr>'; return; }
  allAdminTitles = data || [];
  renderTitlesTable();
}

function renderTitlesTable() {
  var q = (document.getElementById("adminTitlesSearch").value || "").trim().toLowerCase();
  var list = q ? allAdminTitles.filter(function (t) { return t.title.toLowerCase().indexOf(q) !== -1; }) : allAdminTitles;
  document.getElementById("adminTitlesCount").textContent = list.length + " из " + allAdminTitles.length;
  var tbody = document.querySelector("#titlesTable tbody");
  if (!list.length) { tbody.innerHTML = '<tr><td>' + (allAdminTitles.length ? "Ничего не найдено." : "Каталог пока пуст.") + '</td></tr>'; return; }
  tbody.innerHTML = '<tr><th>Название</th><th>Тип</th><th>Год</th><th>Kinopoisk</th><th></th></tr>' + list.map(function (t) {
    return '<tr><td>' + escapeHtml(t.title) + '</td><td>' + (TYPE_LABEL[t.media_type] || t.media_type) + '</td><td>' + (t.year || "—") + '</td>' +
      '<td>' + (t.kp_rating || "—") + '</td>' +
      '<td><button class="btn small danger" data-del-title="' + t.id + '" type="button">Удалить</button></td></tr>';
  }).join("");
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-del-title]"), function (btn) {
    btn.addEventListener("click", async function () {
      var id = btn.getAttribute("data-del-title");
      var t = allAdminTitles.find(function (x) { return String(x.id) === String(id); });
      if (!confirm('Удалить «' + (t ? t.title : "тайтл") + '» из каталога вместе со всеми личными статусами, оценками и комментариями к нему у ВСЕХ пользователей? Это необратимо.')) return;
      const { error } = await sb.from("titles").delete().eq("id", id);
      if (error) { showStatus("Не удалось удалить: " + error.message, true); return; }
      showStatus('«' + (t ? t.title : "Тайтл") + '» удалён');
      loadTitlesPanel();
    });
  });
}

document.getElementById("adminTitlesSearch").addEventListener("input", renderTitlesTable);

// ---------- Лимиты API ----------
async function loadApiLimitsPanel() {
  var summaryEl = document.getElementById("apiLimitsSummary");
  var tbody = document.querySelector("#apiLimitsTable tbody");
  summaryEl.innerHTML = '<p class="empty-note">Загрузка…</p>';
  tbody.innerHTML = "";

  const { data, error } = await sb.from("kp_api_log").select("*").order("created_at", {ascending: false}).limit(500);
  if (error) {
    summaryEl.innerHTML = '<p class="empty-note">Таблица учёта запросов ещё не создана — выполните миграцию social-upgrade-2.sql в Supabase, чтобы увидеть эту статистику.</p>';
    return;
  }
  var rows = data || [];
  var startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  var today = rows.filter(function (r) { return new Date(r.created_at) >= startOfDay; });
  var okToday = today.filter(function (r) { return r.ok; }).length;
  var failToday = today.length - okToday;
  var costToday = (okToday * 0.01).toFixed(2).replace(".", ",");

  summaryEl.innerHTML =
    '<p class="catalog-hint">ApiGet.ru берёт с предоплаченного баланса 0.01₽ за каждый УСПЕШНЫЙ запрос, дневного лимита нет — точный остаток средств смотрите в личном кабинете apiget.ru. Счётчик ниже — приблизительный расход по данным самого сайта (считается с полуночи по времени вашего браузера).</p>' +
    '<p style="font-size:1.05rem;margin:4px 0 14px;"><strong class="mono">' + today.length + '</strong> запросов сегодня' +
    (okToday ? ' <span class="mono" style="color:var(--muted);">(≈' + costToday + '₽)</span>' : '') +
    (failToday ? ' <span class="mono" style="color:var(--accent-2);">(' + failToday + ' с ошибкой, бесплатно)</span>' : '') + '</p>';

  if (!rows.length) { tbody.innerHTML = '<tr><td>Запросов пока не было.</td></tr>'; return; }
  tbody.innerHTML = '<tr><th>Когда</th><th>Кто</th><th>Запрос</th><th>Результат</th></tr>' + rows.slice(0, 150).map(function (r) {
    var who = (state.profilesById[r.user_id] || {}).display_name || "…";
    return '<tr><td class="mono">' + fmtTime(r.created_at) + '</td><td>' + escapeHtml(who) + '</td><td class="mono">' + escapeHtml(r.path) + '</td>' +
      '<td>' + (r.ok ? '<span class="mono" style="color:var(--watched);">ok</span>' : '<span class="mono" style="color:var(--accent-2);">' + escapeHtml(String(r.status || "ошибка")) + '</span>') + '</td></tr>';
  }).join("");
}

// ---------- Журнал действий ----------
async function loadActivityLogPanel() {
  var tbody = document.querySelector("#activityLogTable tbody");
  tbody.innerHTML = '<tr><td>Загрузка…</td></tr>';
  const { data, error } = await sb.from("activity_log").select("*").order("occurred_at", {ascending: false}).limit(200);
  if (error) { tbody.innerHTML = '<tr><td>Не удалось загрузить журнал: ' + escapeHtml(error.message) + '</td></tr>'; return; }
  if (!data || !data.length) { tbody.innerHTML = '<tr><td>Пока пусто.</td></tr>'; return; }

  var actionLabel = {insert: "добавление", update: "изменение", delete: "удаление"};
  tbody.innerHTML = '<tr><th>Когда</th><th>Кто</th><th>Таблица</th><th>Действие</th></tr>' + data.map(function (r, idx) {
    var who = r.actor ? ((state.profilesById[r.actor] || {}).display_name || "…") : "система";
    return (
      '<tr class="log-row" data-log-idx="' + idx + '" style="cursor:pointer;" title="Показать подробности">' +
        '<td class="mono">' + fmtTime(r.occurred_at) + '</td><td>' + escapeHtml(who) + '</td>' +
        '<td class="mono">' + escapeHtml(r.table_name) + '</td><td>' + (actionLabel[r.action] || r.action) + '</td>' +
      '</tr>' +
      '<tr class="log-detail" data-log-detail="' + idx + '" hidden><td colspan="4"><pre class="mono" style="white-space:pre-wrap;font-size:0.75rem;margin:0;">' +
        escapeHtml(JSON.stringify(r.new_data || r.old_data, null, 2)) +
      '</pre></td></tr>'
    );
  }).join("");
  Array.prototype.forEach.call(tbody.querySelectorAll(".log-row"), function (row) {
    row.addEventListener("click", function () {
      var idx = row.getAttribute("data-log-idx");
      var detail = tbody.querySelector('[data-log-detail="' + idx + '"]');
      detail.hidden = !detail.hidden;
    });
  });
}

registerSectionLoader("admin", loadAdminSection);
