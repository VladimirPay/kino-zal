// Наш Кинозал — прокси-функция Supabase Edge Function для ApiGet.ru
// (данные Кинопоиска; заменила Kinopoisk.dev/poiskkino.dev — тот был
// ограничен бесплатным лимитом ~200 запросов в сутки на весь сайт, а
// ApiGet.ru работает по предоплаченному балансу без дневного лимита:
// 0.01₽ за каждый УСПЕШНЫЙ запрос, ошибки бесплатны).
//
// Зачем нужна эта функция: браузер не может напрямую обратиться к
// apiget.ru (запрос блокируется политикой CORS). Эта функция работает на
// сервере Supabase (сервер-сервер, без CORS-ограничений), сама ходит в
// ApiGet.ru с секретным ключом и отдаёт ответ сайту — ключ ApiGet.ru при
// этом не лежит открытым текстом в index.html.
//
// ВАЖНО про формат ответа ApiGet.ru: HTTP-код ответа от apiget.ru ВСЕГДА
// 200, даже при ошибке — успех или неудача определяется полем "error"
// внутри тела ответа (0 = успех, любое другое значение = ошибка, текст
// ошибки — в "message"). Поэтому ниже "ok" вычисляется из этого поля, а не
// из статуса HTTP-ответа.
//
// ===================== КАК УСТАНОВИТЬ (без командной строки) =====================
// 1) В Supabase: "Edge Functions" -> откройте уже существующую функцию
//    "kinopoisk-proxy" (создавали её ещё для Kinopoisk.dev) -> откройте
//    редактор кода -> сотрите всё и вставьте вместо этого содержимое
//    данного файла целиком -> "Deploy function". Имя функции менять не
//    нужно — оно уже "зашито" в index.html/catalog.js.
// 2) В том же разделе Supabase откройте "Edge Function Secrets" и добавьте
//    секрет с именем APIGET_KEY, значение — ваш ключ из личного кабинета
//    apiget.ru. Старый секрет KP_API_KEY (для Kinopoisk.dev) больше не
//    используется — можно оставить как есть или удалить, не важно. Новый
//    секрет применяется сразу, без повторного деплоя.
// 3) Готово — «Каталог» на сайте продолжит работать, теперь через ApiGet.ru.
// ===================================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APIGET_BASE = "https://apiget.ru/API/";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    let method = "";
    let params: Record<string, unknown> = {};
    try {
      const body = await req.json();
      // Сайт называет это поле "method" (метод ApiGet.ru: search, get-info,
      // get-random и т.д.) — раньше здесь был "path" (путь Kinopoisk.dev),
      // имя поля сохранено под новый смысл, чтобы не путать с HTTP-методом.
      method = typeof body.method === "string" ? body.method : "";
      params = body.params && typeof body.params === "object" ? body.params : {};
    } catch (_e) {
      return jsonResponse({ ok: false, status: 400, message: "Некорректный запрос к прокси." }, 200);
    }

    if (!method) {
      return jsonResponse({ ok: false, status: 400, message: "Не указан метод запроса к ApiGet.ru." }, 200);
    }

    const APIGET_KEY = Deno.env.get("APIGET_KEY") || "";
    if (!APIGET_KEY) {
      return jsonResponse({
        ok: false,
        status: 500,
        message: "На сервере не задан секрет APIGET_KEY — добавьте его в настройках Edge Functions в Supabase (личный кабинет apiget.ru → ваш ключ).",
      }, 200);
    }

    try {
      const url = new URL(APIGET_BASE);
      url.searchParams.set("method", method);
      url.searchParams.set("key", APIGET_KEY);
      Object.keys(params).forEach((key) => {
        const value = params[key];
        if (value === null || value === undefined || value === "") return;
        // ApiGet.ru принимает списки (например, id через запятую) обычной
        // строкой — в отличие от Kinopoisk.dev, где массив разбивался на
        // несколько одноимённых параметров, здесь достаточно join(",").
        url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
      });

      const kpRes = await fetch(url.toString(), { headers: { accept: "application/json" } });
      const text = await kpRes.text();
      // deno-lint-ignore no-explicit-any
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = null; }

      const ok = !!parsed && parsed.error === 0;
      // "status" здесь — это код ошибки ApiGet.ru (или HTTP-статус, если сам
      // ответ вообще не разобрался как JSON), а НЕ HTTP-код ответа — он у
      // ApiGet.ru всегда 200 и ни о чём не говорит.
      const status = ok ? 200 : (parsed && parsed.error != null ? parsed.error : (kpRes.status || 500));
      return jsonResponse({ ok, status, body: parsed, message: parsed ? parsed.message : undefined });
    } catch (e) {
      return jsonResponse({
        ok: false,
        status: 0,
        message: "Ошибка сети при обращении к ApiGet.ru с сервера: " + String(e),
      }, 200);
    }
  },
};
