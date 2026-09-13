// Наш Кинозал — загрузка картинок, прикреплённых к сообщениям (общий чат и
// личные сообщения). Общий код для chat.js и messages.js — оба поддерживают
// одну и ту же кнопку 📎 и один и тот же bucket в Supabase Storage
// (см. social-upgrade-5.sql).

var MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 МБ — с запасом хватает на фото с телефона

export async function uploadChatImage(sb, userId, file) {
  if (!file.type || file.type.indexOf("image/") !== 0) throw new Error("можно прикрепить только картинку");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("картинка слишком большая (максимум 5 МБ)");
  var ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  var path = userId + "/" + Date.now() + "-" + Math.random().toString(36).slice(2) + "." + ext;
  const { error } = await sb.storage.from("chat-images").upload(path, file, { contentType: file.type });
  if (error) throw error;
  var pub = sb.storage.from("chat-images").getPublicUrl(path);
  return pub.data.publicUrl;
}
