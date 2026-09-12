// Наш Кинозал — экран входа/регистрации и переключение между
// «показать форму входа» / «показать личный кабинет» по статусу сессии Supabase.
// Этот модуль замыкает граф импортов: именно он в конце «включает» сайт.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { showAuthMsg, showStatus } from "./utils.js";
import { renderMainNav, showSection } from "./router.js";
import { renderYouRow } from "./profile.js";
import { subscribeRealtime } from "./realtime.js";

// ---------- AUTH SCREEN ----------
Array.prototype.forEach.call(document.querySelectorAll("[data-atab]"), function (btn) {
  btn.addEventListener("click", function () {
    var which = btn.getAttribute("data-atab");
    Array.prototype.forEach.call(document.querySelectorAll("[data-atab]"), function (b) { b.classList.toggle("active", b === btn); });
    document.getElementById("loginForm").hidden = which !== "login";
    document.getElementById("signupForm").hidden = which !== "signup";
    document.getElementById("authMsg").hidden = true;
  });
});

document.getElementById("loginForm").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var email = document.getElementById("li-email").value.trim();
  var password = document.getElementById("li-password").value;
  showAuthMsg("Входим…");
  const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
  if (error) { showAuthMsg("Не удалось войти: " + error.message, "error"); return; }
  document.getElementById("authMsg").hidden = true;
});

document.getElementById("signupForm").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var name = document.getElementById("su-name").value.trim();
  var email = document.getElementById("su-email").value.trim();
  var password = document.getElementById("su-password").value;
  if (!name) { showAuthMsg("Введите имя", "error"); return; }
  showAuthMsg("Создаём аккаунт…");
  const { data, error } = await sb.auth.signUp({
    email: email, password: password,
    options: { data: { display_name: name } }
  });
  if (error) { showAuthMsg("Не удалось зарегистрироваться: " + error.message, "error"); return; }
  if (data && data.session) {
    showAuthMsg("Готово! Входим…", "ok");
  } else {
    showAuthMsg("Аккаунт создан. Если включено подтверждение почты — проверьте письмо, затем войдите.", "ok");
  }
});

document.getElementById("forgotBtn").addEventListener("click", async function () {
  var email = document.getElementById("li-email").value.trim();
  if (!email) { showAuthMsg("Сначала введите email в поле выше", "error"); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) { showAuthMsg("Не удалось отправить письмо: " + error.message, "error"); return; }
  showAuthMsg("Письмо для сброса пароля отправлено на " + email, "ok");
});

// ---------- SESSION / PROFILE ----------
async function onSignedIn() {
  document.getElementById("authScreen").hidden = true;
  const { data: profRows, error: profErr } = await sb.from("profiles").select("*").eq("id", state.session.user.id).limit(1);
  if (profErr || !profRows || !profRows.length) {
    showStatus("Не удалось загрузить профиль: " + (profErr ? profErr.message : "нет записи"), true);
    return;
  }
  state.myProfile = profRows[0];
  document.getElementById("mainApp").hidden = false;
  renderYouRow();
  subscribeRealtime();
  await loadAllProfiles();
  renderMainNav();
  showSection(state.activeSection);
}

function onSignedOut() {
  state.myProfile = null;
  state.myTitles = [];
  if (state.realtimeChannel) { sb.removeChannel(state.realtimeChannel); state.realtimeChannel = null; }
  document.getElementById("mainApp").hidden = true;
  document.getElementById("authScreen").hidden = false;
}

sb.auth.onAuthStateChange(function (event, sess) {
  state.session = sess;
  if (event === "PASSWORD_RECOVERY") {
    document.getElementById("mainApp").hidden = true;
    document.getElementById("authScreen").hidden = true;
    var pw = prompt("Введите новый пароль (минимум 6 символов):");
    if (pw && pw.length >= 6) {
      sb.auth.updateUser({ password: pw }).then(function (res) {
        if (res.error) alert("Не удалось изменить пароль: " + res.error.message);
        else alert("Пароль изменён, теперь можно пользоваться сайтом.");
      });
    }
    return;
  }
  if (state.session) { onSignedIn(); } else { onSignedOut(); }
});

async function loadAllProfiles() {
  const { data, error } = await sb.from("profiles").select("id,display_name,role");
  if (error) return;
  state.allProfilesList = data || [];
  state.profilesById = {};
  state.allProfilesList.forEach(function (p) { state.profilesById[p.id] = p; });
}

// Kick things off: reveal either auth screen or app once we know the session state
sb.auth.getSession().then(function (res) {
  state.session = res.data.session;
  if (state.session) { onSignedIn(); } else { document.getElementById("authScreen").hidden = false; }
});
