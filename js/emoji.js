// Наш Кинозал — общая всплывающая панель эмодзи. Используется в двух местах:
// вставить эмодзи в текст сообщения (кнопка рядом с полем ввода) и выбрать
// эмодзи-реакцию под конкретным сообщением (кнопка «+» в reaction-баре).
// Один и тот же код на оба случая, чтобы не тащить два набора эмодзи и два
// почти одинаковых поповера.

export const EMOJI_SET = [
  "😀","😂","🥲","😍","😮","😢","😡","🤔",
  "👍","👎","🔥","🎉","❤️","💀","🍿","👀",
  "😴","🙌","😱","🥳","😭","😎","🤯","👏",
  "🙏","💯","🤝","🎬","👻","🤡"
];

// Открывает панель у якорной кнопки anchorBtn; клик по эмодзи вызывает
// onPick(emoji) и закрывает панель. Повторный клик по той же самой кнопке,
// клик снаружи или выбор эмодзи — всё закрывает панель. В любой момент
// открыта только одна панель на всю страницу.
export function toggleEmojiPanel(anchorBtn, onPick) {
  var existing = document.querySelector(".emoji-panel");
  if (existing) {
    var wasSameAnchor = existing.__anchor === anchorBtn;
    closePanel(existing);
    if (wasSameAnchor) return;
  }

  var panel = document.createElement("div");
  panel.className = "emoji-panel";
  panel.setAttribute("role", "menu");
  panel.innerHTML = EMOJI_SET.map(function (e) {
    return '<button type="button" data-emoji="' + e + '">' + e + "</button>";
  }).join("");
  document.body.appendChild(panel);
  panel.__anchor = anchorBtn;

  var rect = anchorBtn.getBoundingClientRect();
  var panelWidth = 236, panelMaxHeight = 220; // держим в синхроне с styles.css
  panel.style.position = "fixed";
  // Если снизу не хватает места (кнопка ближе к низу экрана — как поле ввода
  // чата) — открываем панель НАД кнопкой, а не под ней, чтобы она не
  // уезжала за пределы экрана.
  var fitsBelow = rect.bottom + 6 + panelMaxHeight <= window.innerHeight;
  panel.style.top = fitsBelow
    ? (rect.bottom + 6) + "px"
    : Math.max(6, rect.top - panelMaxHeight - 6) + "px";
  panel.style.left = Math.max(6, Math.min(rect.left, window.innerWidth - panelWidth - 6)) + "px";

  Array.prototype.forEach.call(panel.querySelectorAll("[data-emoji]"), function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      onPick(btn.getAttribute("data-emoji"));
      closePanel(panel);
    });
  });

  function outsideHandler(ev) {
    if (!panel.contains(ev.target) && ev.target !== anchorBtn) closePanel(panel);
  }
  panel.__outsideHandler = outsideHandler;
  // Открывающий клик ещё «летит» по document — если повесить обработчик
  // сразу же, он тут же и сработает как «клик снаружи» и закроет панель.
  setTimeout(function () { document.addEventListener("click", outsideHandler, true); }, 0);
}

function closePanel(panel) {
  if (panel.__outsideHandler) document.removeEventListener("click", panel.__outsideHandler, true);
  panel.remove();
}

// ---------- Реакции-эмодзи под сообщением ----------
// Общий код для чата и личных сообщений (message_reactions хранит и то, и
// другое, отличая их полем kind — см. social-upgrade-5.sql). reactionsMap —
// это state.chatReactions или state.dmReactions: {messageId -> [{user_id,emoji}]}.

export function reactionBarHtml(messageId, reactionsForMsg, myUserId) {
  var byEmoji = {};
  (reactionsForMsg || []).forEach(function (r) {
    (byEmoji[r.emoji] = byEmoji[r.emoji] || []).push(r.user_id);
  });
  var pills = Object.keys(byEmoji).map(function (e) {
    var mine = byEmoji[e].indexOf(myUserId) !== -1;
    return '<button type="button" class="reaction-pill' + (mine ? " mine" : "") + '" data-reaction-emoji="' + e + '" data-reaction-msg="' + messageId + '">' + e + " " + byEmoji[e].length + "</button>";
  }).join("");
  return '<div class="reaction-bar">' + pills + '<button type="button" class="reaction-add" data-reaction-add="' + messageId + '" title="Добавить реакцию">+</button></div>';
}

// Клик по уже стоящему эмодзи снимает свою реакцию, если она там есть, и
// ставит, если её ещё не было — обычный toggle, без отдельного UI для
// "убрать реакцию".
async function toggleReaction(sb, state, kind, messageId, emoji, reactionsMap, rerender) {
  var list = reactionsMap[messageId] || (reactionsMap[messageId] = []);
  var mine = list.find(function (r) { return r.user_id === state.myProfile.id && r.emoji === emoji; });
  if (mine) {
    await sb.from("message_reactions").delete()
      .eq("kind", kind).eq("message_id", messageId).eq("user_id", state.myProfile.id).eq("emoji", emoji);
    reactionsMap[messageId] = list.filter(function (r) { return r !== mine; });
  } else {
    const { error } = await sb.from("message_reactions").insert({ kind: kind, message_id: messageId, user_id: state.myProfile.id, emoji: emoji });
    if (!error) list.push({ user_id: state.myProfile.id, emoji: emoji });
  }
  rerender();
}

// Вешает обработчики на уже отрисованные .reaction-pill/.reaction-add внутри
// root (лог чата целиком — проще перевешивать заново при каждом рендере, чем
// точечно отслеживать, что изменилось).
export function bindReactionHandlers(root, opts) {
  Array.prototype.forEach.call(root.querySelectorAll("[data-reaction-emoji]"), function (btn) {
    btn.addEventListener("click", function () {
      toggleReaction(opts.sb, opts.state, opts.kind, btn.getAttribute("data-reaction-msg"), btn.getAttribute("data-reaction-emoji"), opts.reactionsMap, opts.rerender);
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll("[data-reaction-add]"), function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var msgId = btn.getAttribute("data-reaction-add");
      toggleEmojiPanel(btn, function (emoji) {
        toggleReaction(opts.sb, opts.state, opts.kind, msgId, emoji, opts.reactionsMap, opts.rerender);
      });
    });
  });
}
