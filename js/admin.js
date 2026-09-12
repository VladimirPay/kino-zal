// Наш Кинозал — диалог «Пользователи» (только для администраторов):
// выдать/снять права администратора. Личные списки пользователей сюда не попадают.

import { sb } from "./supabaseClient.js";
import { state } from "./state.js";
import { escapeHtml, showStatus } from "./utils.js";

export async function openAdminDialog() {
  const { data, error } = await sb.from("profiles").select("*").order("display_name");
  var tbody = document.querySelector("#usersTable tbody");
  if (error) { tbody.innerHTML = '<tr><td>Ошибка загрузки: ' + escapeHtml(error.message) + '</td></tr>'; document.getElementById("adminDialog").showModal(); return; }
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
      openAdminDialog();
    });
  });
  document.getElementById("adminDialog").showModal();
}
