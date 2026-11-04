// handlers/callback_query.js — нажатия инлайн-кнопок под напоминаниями.

import { api } from 'sdk';
import { onCallback } from 'lib/commands';

export default async function (query, ctx) {
  try {
    await onCallback(query, ctx);
  } catch (err) {
    console.error('callback handler failed', err);
    try {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: 'ошибка, попробуй ещё раз' });
    } catch { /* нечего делать */ }
  }
}
