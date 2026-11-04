// lib/ui.js — клавиатуры и тексты сообщений.
//
// callback_data жёстко ограничен 64 байтами, поэтому внутри только короткие
// коды: `v:<action>:<grantId>`. Никаких «сырых» длинных id.

export function reminderKeyboard(grantId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Снял VIP', callback_data: `v:rem:${grantId}` }],
      [
        { text: '➕ +30 дн.', callback_data: `v:ext:${grantId}` },
        { text: '📅 +7 дн.', callback_data: `v:ext7:${grantId}` },
      ],
      [
        { text: '🙈 Оставить', callback_data: `v:keep:${grantId}` },
        { text: '⏰ Завтра', callback_data: `v:snz:${grantId}` },
      ],
    ],
  };
}

export function confirmRemoveKeyboard(grantId) {
  return {
    inline_keyboard: [[
      { text: '✅ Да, снял', callback_data: `v:rem:${grantId}` },
      { text: '↩️ Отмена', callback_data: `v:noop:${grantId}` },
    ]],
  };
}

export function listKeyboard(grantIds = []) {
  return {
    inline_keyboard: grantIds.slice(0, 6).map((id) => [{
      text: `➕ продлить ${id}`,
      callback_data: `v:ext:${id}`,
    }]),
  };
}

/** Готовая команда, которую удобно скопировать тапом (моноширинный блок). */
export function copyableCommand(login) {
  return `<code>/vip ${login}</code>`;
}

export const HELP = [
  '<b>Учёт Twitch VIP на месяц</b>',
  '',
  '/vip add @nick [30d] [--to 2026-12-01] [--note …] — записать выдачу',
  '/vip list [--expired|--all] — что сейчас активно',
  '/vip info @nick — история по человеку',
  '/vip extend @nick [+30d] — продлить',
  '/vip remove @nick [причина] — снять / закрыть',
  '/vip keep @nick — оставить как есть (напомню через неделю)',
  '/vip cancel @nick — отменить ошибочную запись',
  '/vip export — CSV (текстом, файлы платформа не отдаёт)',
  '/vip stats — сводка',
  '/vip dashboard — закрепить/обновить дашборд',
  '/vip admins [add|del @user_id] — кто имеет доступ',
  '',
  'Напоминания: за 3 дня, за 1 день, в день истечения и раз в неделю после —',
  'в каждом уже лежит готовая команда <code>/unvip ник</code>.',
  '',
  'Бот не трогает Twitch API: только запись, срок и напоминание. Ник — просто текст,',
  'поэтому выдавать и снимать роль ты продолжаешь сам.',
].join('\n');

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
