// Наш Кинозал — точка сборки: подключает все модули-фичи (каждый регистрирует
// свои обработчики и, если нужно, свой раздел через router.js), затем включает
// закрытие диалогов по ✕ и запускает проверку сессии (в конце auth.js).
//
// main.js импортирует этот файл, только когда конфигурация Supabase на месте —
// поэтому здесь можно быть уверенным, что sb уже создан.

import { bindClose } from "./utils.js";

import "./mylist.js";
import "./catalog.js";
import "./matchgame.js";
import "./chat.js";
import "./messages.js";
import "./friends.js";
import "./profile.js";
import "./admin.js";
import "./realtime.js";
import "./auth.js"; // последним: здесь происходит sb.auth.getSession() — старт сайта

bindClose(document);
