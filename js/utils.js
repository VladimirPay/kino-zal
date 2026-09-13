// Наш Кинозал — мелкие утилиты общего назначения, без зависимостей от
// состояния приложения и от Supabase. Используются почти всеми остальными модулями.

import { TYPE_LABEL } from "./config.js";

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c];
  });
}

export function pluralRu(n, forms) {
  var abs = Math.abs(n) % 100, last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function ratingAvg(t) {
  var vals = (t.ratings || []).map(function (r) { return r.value; });
  if (!vals.length) return null;
  return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
}

export function starsHtml(avg, max) {
  max = max || 5;
  var full = avg ? Math.round(avg) : 0, out = "";
  for (var i = 1; i <= max; i++) { out += (i <= full) ? "★" : "<span class=\"empty\">★</span>"; }
  return out;
}

export function posterHtml(url) {
  return url ? '<img class="poster" src="' + escapeHtml(url) + '" alt="" loading="lazy">'
              : '<div class="poster-placeholder">без постера</div>';
}

// Карточка тайтла, «прикреплённая» к сообщению в чате/ЛС (см. «Поделиться»
// в titleDetail.js и social-upgrade-7.sql) — компактная, кликабельная,
// открывает ту же общую карточку тайтла (openTitleDetail). Используется и в
// chat.js, и в messages.js — общий вид для обоих мест. titleRow может быть
// null (тайтл впоследствии удалили из каталога через Управление → Фильмы —
// shared_title_id тогда обнуляется по внешнему ключу "on delete set null",
// само сообщение при этом не пропадает).
export function sharedTitleCardHtml(titleRow) {
  if (!titleRow) return '<div class="shared-title-card removed">Эта карточка фильма больше не в каталоге.</div>';
  return '<div class="shared-title-card" data-open-title="' + titleRow.id + '">' +
    posterHtml(titleRow.poster_url) +
    '<div class="shared-title-info">' +
      '<div class="shared-title-badge">' + (TYPE_LABEL[titleRow.media_type] || titleRow.media_type) +
        (titleRow.kp_rating ? ' · ★ ' + titleRow.kp_rating : '') + '</div>' +
      '<div class="shared-title-name">' + escapeHtml(titleRow.title) + '</div>' +
      '<div class="mono" style="color:var(--muted);font-size:0.78rem;">' + (titleRow.year || '—') + '</div>' +
    '</div>' +
  '</div>';
}

export function fmtTime(iso) {
  var d = new Date(iso);
  return d.toLocaleString("ru-RU", {day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
}

export function showStatus(msg, isError) {
  var el = document.getElementById("statusBanner");
  el.textContent = msg;
  el.style.background = isError ? "var(--accent-2)" : "var(--watched)";
  el.hidden = false;
  setTimeout(function () { el.hidden = true; }, 4000);
}

export function showAuthMsg(text, kind) {
  var el = document.getElementById("authMsg");
  el.textContent = text;
  el.className = "auth-msg" + (kind ? " " + kind : "");
  el.hidden = false;
}

export function bindClose(root) {
  Array.prototype.forEach.call(root.querySelectorAll("[data-close]"), function (btn) {
    btn.addEventListener("click", function () { document.getElementById(btn.getAttribute("data-close")).close(); });
  });
}

// Запоминаем, на какой вкладке пользователь был, в sessionStorage — это
// переживает сворачивание/разворачивание браузера (когда мобильный браузер
// перезагружает страницу в фоне) и возвращает на ту же вкладку, но не
// "запоминает навсегда" (очищается при полном закрытии вкладки).
export function readSessionValue(key, fallback) {
  try { return sessionStorage.getItem(key) || fallback; } catch (e) { return fallback; }
}
export function writeSessionValue(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) {}
}
