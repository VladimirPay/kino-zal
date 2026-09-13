// Наш Кинозал — вкладка «Управление» (видна только администраторам — см.
// SECTIONS в config.js и гейтинг в router.js). Разделы:
//  · Пользователи — выдать/снять права администратора, а также кнопка
//    «Просмотреть» — полный административный просмотр чужого профиля (см.
//    openUserInspect ниже);
//  · Фильмы — весь каталог тайтлов, с возможностью удалить (вместе со всеми
//    личными статусами/оценками/комментариями к нему у всех пользователей —
//    это разрешено RLS-политикой "titles: delete admin only");
//  · Жалобы — жалобы пользователей друг на друга (user_reports, см.
//    social-upgrade-8.sql) с возможностью отметить как рассмотренную/
//    отклонённой и открыть административный просмотр того, на кого жалуются;
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
//
// ВАЖНО про приватность: до миграции social-upgrade-8.sql личный список
// (user_titles), друзья (friend_requests) и личные сообщения (dm_messages)
// были видны ТОЛЬКО их владельцу — даже администратору эти данные не
// показывались. social-upgrade-8.sql добавляет к ним дополнительные
// RLS-политики "…: admin read all" (это ДОБАВКА к существующим политикам, а
// не замена — обычные пользователи всё так же видят только своё), которые
// открывают эти данные для is_admin(). Это осознанное изменение модели
// приватности сайта по прямому запросу владельца — раньше в комментариях
// кода и в интерфейсе явно утверждалось обратное.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { ADMIN_TABS, TYPE_LABEL, STATUS_LABEL } from "./config.js";
import { bindClose, escapeHtml, fmtTime, showStatus } from "./utils.js";
import { registerSectionLoader } from "./router.js";
import { seedPopularCatalog } from "./catalog.js";

var activeAdminTab = "users";
var allAdminTitles = [];

var PANEL_IDS = {
  users: "adminPanelUsers",
  titles: "adminPanelTitles",
  reports: "adminPanelReports",
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
  if (key === "reports") return loadReportsPanel();
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
      '<td>' + (isMe ? '' : '<button class="btn small" data-uid="' + u.id + '" data-role="' + (isAdm ? "user" : "admin") + '">' + (isAdm ? "Снять права" : "Сделать админом") + '</button>') +
        ' <button class="btn small" data-inspect="' + u.id + '" type="button">Просмотреть</button>' +
      '</td></tr>';
  }).join("");
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-uid]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("profiles").update({role: btn.getAttribute("data-role")}).eq("id", btn.getAttribute("data-uid"));
      if (error) { showStatus("Не удалось изменить роль: " + error.message, true); return; }
      loadUsersPanel();
    });
  });
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-inspect]"), function (btn) {
    btn.addEventListener("click", function () { openUserInspect(btn.getAttribute("data-inspect")); });
  });
}

// Вызывается из realtime.js при live-обновлении user_reports — обновляет
// таблицу жалоб, только если администратор прямо сейчас смотрит на неё
// (activeAdminTab — приватная переменная этого модуля, поэтому это отдельная
// функция, а не прямой вызов loadReportsPanel извне).
export function refreshReportsIfVisible() {
  if (state.activeSection === "admin" && activeAdminTab === "reports") loadReportsPanel();
}

// ---------- Жалобы ----------
async function loadReportsPanel() {
  var tbody = document.querySelector("#reportsTable tbody");
  tbody.innerHTML = '<tr><td>Загрузка…</td></tr>';
  const { data, error } = await sb.from("user_reports").select("*").order("created_at", { ascending: false });
  if (error) {
    tbody.innerHTML = '<tr><td>Не удалось загрузить жалобы' + (error ? ": " + escapeHtml(error.message) : "") + ' — возможно, ещё не выполнена миграция social-upgrade-8.sql.</td></tr>';
    return;
  }
  if (!data || !data.length) { tbody.innerHTML = '<tr><td>Жалоб пока нет.</td></tr>'; return; }
  var reportStatusLabel = { new: "новая", reviewed: "рассмотрена", dismissed: "отклонена" };
  tbody.innerHTML = '<tr><th>Когда</th><th>Кто жалуется</th><th>На кого</th><th>Причина</th><th>Статус</th><th></th></tr>' + data.map(function (r) {
    var reporter = (state.profilesById[r.reporter_id] || {}).display_name || "…";
    var reported = (state.profilesById[r.reported_id] || {}).display_name || "…";
    return '<tr>' +
      '<td class="mono">' + fmtTime(r.created_at) + '</td>' +
      '<td>' + escapeHtml(reporter) + '</td>' +
      '<td><button class="btn linklike small" data-inspect="' + r.reported_id + '" type="button">' + escapeHtml(reported) + '</button></td>' +
      '<td>' + escapeHtml(r.reason) + '</td>' +
      '<td>' + (reportStatusLabel[r.status] || r.status) + '</td>' +
      '<td>' +
        (r.status !== "reviewed" ? '<button class="btn small" data-report-status="reviewed" data-report-id="' + r.id + '" type="button">Рассмотрено</button> ' : '') +
        (r.status !== "dismissed" ? '<button class="btn small" data-report-status="dismissed" data-report-id="' + r.id + '" type="button">Отклонить</button>' : '') +
      '</td>' +
    '</tr>';
  }).join("");
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-inspect]"), function (btn) {
    btn.addEventListener("click", function () { openUserInspect(btn.getAttribute("data-inspect")); });
  });
  Array.prototype.forEach.call(tbody.querySelectorAll("[data-report-status]"), function (btn) {
    btn.addEventListener("click", async function () {
      const { error } = await sb.from("user_reports").update({ status: btn.getAttribute("data-report-status") }).eq("id", btn.getAttribute("data-report-id"));
      if (error) { showStatus("Не удалось обновить статус жалобы: " + error.message, true); return; }
      loadReportsPanel();
    });
  });
}

// ---------- Административный просмотр чужого профиля ----------
// Показывает то, что обычно видит только сам пользователь: личный список
// (user_titles), друзей (friend_requests со статусом accepted) и личные
// сообщения (dm_messages), сгруппированные по собеседнику. Работает только
// после social-upgrade-8.sql (новые RLS-политики "…: admin read all") — до
// неё запросы ниже просто вернут пустой список (RLS отфильтрует чужие
// строки), и это покажется как "пусто", а не как явная ошибка.
async function openUserInspect(userId) {
  var dlg = document.getElementById("adminUserInspectDialog");
  var inner = dlg.querySelector(".dialog-inner");
  inner.innerHTML = '<button class="close-x" data-close="adminUserInspectDialog">✕</button><p class="empty-note">Загрузка…</p>';
  bindClose(inner);
  if (!dlg.open) dlg.showModal();

  const [profRes, friendsRes, listRes, dmRes] = await Promise.all([
    sb.from("profiles").select("*").eq("id", userId).limit(1),
    sb.from("friend_requests").select("*").eq("status", "accepted").or("from_user.eq." + userId + ",to_user.eq." + userId),
    sb.from("user_titles").select("*, titles(title,year,media_type)").eq("user_id", userId).order("updated_at", { ascending: false }),
    sb.from("dm_messages").select("*").or("sender_id.eq." + userId + ",recipient_id.eq." + userId).order("created_at", { ascending: false }).limit(500)
  ]);
  if (profRes.error || !profRes.data || !profRes.data.length) {
    inner.innerHTML = '<button class="close-x" data-close="adminUserInspectDialog">✕</button><p class="empty-note">Не удалось загрузить профиль' + (profRes.error ? ": " + escapeHtml(profRes.error.message) : "") + '.</p>';
    bindClose(inner);
    return;
  }
  var p = profRes.data[0];

  var friendsHtml = friendsRes.error
    ? '<p class="empty-note">Не удалось загрузить друзей: ' + escapeHtml(friendsRes.error.message) + '</p>'
    : (!friendsRes.data || !friendsRes.data.length)
      ? '<p class="empty-note">Друзей нет.</p>'
      : '<ul style="margin:4px 0;padding-left:20px;">' + friendsRes.data.map(function (f) {
          var otherId = f.from_user === userId ? f.to_user : f.from_user;
          var name = (state.profilesById[otherId] || {}).display_name || "…";
          return '<li>' + escapeHtml(name) + '</li>';
        }).join("") + '</ul>';

  var listHtml = listRes.error
    ? '<p class="empty-note">Не удалось загрузить личный список: ' + escapeHtml(listRes.error.message) + '</p>'
    : (!listRes.data || !listRes.data.length)
      ? '<p class="empty-note">Список пуст.</p>'
      : '<table class="users-table"><tr><th>Тайтл</th><th>Статус</th><th>Заметка</th></tr>' + listRes.data.map(function (ut) {
          var t = ut.titles || {};
          return '<tr><td>' + escapeHtml(t.title || "…") + (t.year ? ' <span class="mono" style="color:var(--muted);">(' + t.year + ')</span>' : '') + '</td>' +
            '<td>' + (STATUS_LABEL[ut.status] || ut.status) + '</td>' +
            '<td>' + (ut.note ? escapeHtml(ut.note) : '—') + '</td></tr>';
        }).join("") + '</table>';

  var dmByPartner = {};
  (dmRes.data || []).forEach(function (m) {
    var partnerId = m.sender_id === userId ? m.recipient_id : m.sender_id;
    (dmByPartner[partnerId] = dmByPartner[partnerId] || []).push(m);
  });
  var partnerIds = Object.keys(dmByPartner);
  var dmHtml = dmRes.error
    ? '<p class="empty-note">Не удалось загрузить сообщения: ' + escapeHtml(dmRes.error.message) + '</p>'
    : !partnerIds.length
      ? '<p class="empty-note">Личных сообщений нет.</p>'
      : partnerIds.map(function (partnerId) {
          var msgs = dmByPartner[partnerId].slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
          var name = (state.profilesById[partnerId] || {}).display_name || "…";
          return '<details style="margin-bottom:8px;">' +
            '<summary style="cursor:pointer;">' + escapeHtml(name) + ' <span class="mono" style="color:var(--muted);font-size:0.8rem;">(' + msgs.length + ')</span></summary>' +
            '<div style="margin-top:6px;padding-left:10px;border-left:2px solid var(--border);">' +
              msgs.map(function (m) {
                var who = (state.profilesById[m.sender_id] || {}).display_name || "…";
                var body = m.text ? escapeHtml(m.text) : (m.image_url ? "[картинка]" : (m.shared_title_id ? "[карточка тайтла]" : ""));
                return '<div class="comment"><div class="who">' + escapeHtml(who) + ' <span class="mono" style="font-size:0.72rem;">' + fmtTime(m.created_at) + '</span></div><div>' + body + '</div></div>';
              }).join("") +
            '</div></details>';
        }).join("");

  inner.innerHTML =
    '<button class="close-x" data-close="adminUserInspectDialog">✕</button>' +
    '<h2>' + escapeHtml(p.display_name) + '</h2>' +
    (p.role === "admin" ? '<span class="role-badge">администратор</span>' : '') +
    (p.bio ? '<p class="detail-note">' + escapeHtml(p.bio) + '</p>' : '<p class="catalog-hint" style="margin:8px 0 0;">Ничего не написал о себе.</p>') +
    '<p class="catalog-hint" style="margin:10px 0 0;">⚠️ Административный просмотр: обычно личный список, друзья и переписка видны только самому пользователю.</p>' +
    '<div class="section-h">Друзья</div>' + friendsHtml +
    '<div class="section-h">Личный список</div>' + listHtml +
    '<div class="section-h">Личные сообщения</div>' + dmHtml;
  bindClose(inner);
}

// ---------- Фильмы ----------
async function loadTitlesPanel() {
  var tbody = document.querySelector("#titlesTable tbody");
  tbody.innerHTML = '<tr><td>Загрузка…</td></tr>';
  const { data, error } = await sb.from("titles").select("*").order("created_at", {ascending: false});
  if (error) { tbody.innerHTML = '<tr><td>Ошибка загрузки: ' + escapeHtml(error.message) + '</td></tr>'; return; }
  allAdminTitles = data || [];
  populateAdminTitlesGenreFilter();
  renderTitlesTable();
}

// Список жанров в фильтре собирается из уже загруженного каталога (без
// отдельного запроса к базе или к ApiGet.ru) — поэтому в нём появляются
// только реально встречающиеся в titles жанры, а не весь справочник.
// Текущий выбор сохраняется между обновлениями списка, если такой жанр
// всё ещё встречается.
function populateAdminTitlesGenreFilter() {
  var sel = document.getElementById("adminTitlesGenre");
  var prev = sel.value || "all";
  var genres = {};
  allAdminTitles.forEach(function (t) { (t.genre_names || []).forEach(function (g) { if (g) genres[g] = true; }); });
  var sorted = Object.keys(genres).sort(function (a, b) { return a.localeCompare(b, "ru"); });
  sel.innerHTML = '<option value="all">Все жанры</option>' + sorted.map(function (g) {
    return '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + '</option>';
  }).join("");
  sel.value = (prev === "all" || sorted.indexOf(prev) !== -1) ? prev : "all";
}

function renderTitlesTable() {
  var q = (document.getElementById("adminTitlesSearch").value || "").trim().toLowerCase();
  var typeFilter = document.getElementById("adminTitlesType").value;
  var genreFilter = document.getElementById("adminTitlesGenre").value;
  var list = allAdminTitles.filter(function (t) {
    if (q && t.title.toLowerCase().indexOf(q) === -1) return false;
    if (typeFilter !== "all" && t.media_type !== typeFilter) return false;
    if (genreFilter !== "all" && (t.genre_names || []).indexOf(genreFilter) === -1) return false;
    return true;
  });
  document.getElementById("adminTitlesCount").textContent = list.length + " из " + allAdminTitles.length;
  var tbody = document.querySelector("#titlesTable tbody");
  if (!list.length) { tbody.innerHTML = '<tr><td>' + (allAdminTitles.length ? "Ничего не найдено — попробуйте другие фильтры." : "Каталог пока пуст.") + '</td></tr>'; return; }
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
document.getElementById("adminTitlesType").addEventListener("change", renderTitlesTable);
document.getElementById("adminTitlesGenre").addEventListener("change", renderTitlesTable);

// ---------- Наполнение библиотеки каталога ----------
// Разово (и повторно, когда захочется добрать новое) собирает ~1000
// популярных тайтлов и сохраняет их в titles — см. seedPopularCatalog в
// catalog.js. Работает прямо в этой вкладке админа, в фоне это может занять
// несколько минут (платные запросы к ApiGet.ru, поэтому есть троттлинг) —
// прогресс виден ниже кнопки.
document.getElementById("seedCatalogBtn").addEventListener("click", async function () {
  var btn = this;
  var status = document.getElementById("seedCatalogStatus");
  btn.disabled = true;
  status.hidden = false;
  status.textContent = "Ищем недавние премьеры…";
  try {
    var result = await seedPopularCatalog(function (p) {
      if (p.stage === "recent-done") {
        status.textContent = "Недавние премьеры собраны (" + p.movies + " фильмов, " + p.series + " сериалов) — добираем топ-500 Кинопоиска…";
      } else if (p.stage === "top500-done") {
        status.textContent = "Топ-500 получен (" + p.movies + " фильмов, " + p.series + " сериалов) — добираем по жанрам…";
      } else if (p.stage === "genres-progress") {
        status.textContent = "Жанр «" + p.genre + "»… собрано " + p.movies + " фильмов, " + p.series + " сериалов";
      } else if (p.stage === "pool-ready") {
        status.textContent = "Список готов (" + p.total + " тайтлов) — сохраняем в каталог…";
      } else if (p.stage === "progress") {
        status.textContent = "Сохраняем " + p.done + " из " + p.total + " (новых: " + p.added + ", уже было: " + p.skipped +
          (p.excluded ? ", аниме пропущено: " + p.excluded : "") + (p.failed ? ", ошибок: " + p.failed : "") + ")…";
      } else if (p.stage === "error") {
        status.textContent = p.message;
      }
    });
    status.textContent = "Готово: новых тайтлов — " + result.added + ", уже были в каталоге — " + result.skipped +
      (result.excluded ? ", аниме пропущено — " + result.excluded : "") +
      (result.failed ? ", не удалось загрузить — " + result.failed : "") + ".";
    showStatus("Топ-подборка каталога обновлена");
    loadTitlesPanel();
  } catch (e) {
    status.textContent = "Не удалось обновить подборку: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

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
