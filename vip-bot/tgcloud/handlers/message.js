// handlers/message.js — платформа вызывает этот модуль на каждый `message`.
// Имя файла = тип апдейта Telegram, менять нельзя.

import { api } from 'sdk';
import { onMessage } from 'lib/commands';

export default async function (message, ctx) {
  try {
    await onMessage(message, ctx);
  } catch (err) {
    // Молчаливых падений не бывает: без этого бот «просто не отвечает».
    console.error('message handler failed', err);
    try {
      await api.sendMessage({
        chat_id: message.chat?.id,
        text: `⚠️ ошибка: ${err.description || err.message}\nпопробуй ещё раз или посмотри логи: npx tgcloud run handlers/message`,
      });
    } catch { /* чат недоступен — уже не помочь */ }
  }
}
