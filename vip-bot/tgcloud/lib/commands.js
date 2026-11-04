// lib/commands.js — вся логика команд и кнопок.
//
// Ключевая идея: бот НЕ выдаёт VIP через API (у модератора нет на это прав:
// Helix требует токен самого стримера). Он ведёт учёт и напоминает, а выдачу
// делает человек командой в чате Twitch — поэтому бот сразу отдаёт готовую
// команду для копирования.

import { api } from 'sdk';
import {
  parseVipCommand, parseDateOnly, nextExpiry, formatDateRu, formatDateTimeRu,
  grantLine, dashboardText, csvText, chunkText, daysLeft, humanDays,
  STATUS_LABELS, escapeHtml, isTwitchLogin, LOGIN_HINT,
} from 'lib/core';
import * as store from 'lib/db';
import { runTick, tickSummary } from 'lib/tick';
import { HELP, reminderKeyboard, listKeyboard, copyableCommand, esc } from 'lib/ui';

const BOT_ONLY = 'команда для личного чата с ботом или для группы модераторов';

async function say(chatId, text, extra = {}) {
  try {
    return await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  } catch (err) {
    // Если HTML сломан — отправляем как есть, чтобы сообщение не потерялось.
    if (err.code === 400) return api.sendMessage({ chat_id: chatId, text: text.replace(/<[^>]+>/g, '') });
    throw err;
  }
}

async function ensureAccess(message) {
  const from = message.from;
  const cfg = await store.getConfig();
  if (!cfg.ownerId) {
    // Первый, кто написал боту, становится владельцем. Бот приватный и
    // незаметный, но если это смущает — владельца можно переписать руками
    // в таблице settings (ключ config.ownerId).
    await store.patchConfig({
      ownerId: String(from.id),
      chatId: String(message.chat.id),
      admins: [{ id: String(from.id), name: from.username || from.first_name || 'owner', role: 'owner' }],
    });
    await store.logAudit('bootstrap-owner', { actor: from.id });
    return { ok: true, bootstrapped: true, cfg: await store.getConfig() };
  }
  // Напоминания шлём в настроенный чат, поэтому первый рабочий чат фиксируем.
  if (!cfg.chatId) await store.patchConfig({ chatId: String(message.chat.id) });
  const allowed = await store.isAdmin(from.id);
  return { ok: allowed, cfg: await store.getConfig() };
}

async function resolvePeriod(cmd, cfg) {
  if (cmd.to) {
    const ts = parseDateOnly(cmd.to);
    if (!ts) return { error: 'дата в формате ГГГГ-ММ-ДД' };
    return { expiresAt: ts, days: Math.max(1, Math.round((ts - Date.now()) / 86_400_000)) };
  }
  const days = cmd.days || cfg.periodDays;
  if (!Number.isFinite(days) || days <= 0 || days > 3650) return { error: 'срок должен быть от 1 до 3650 дней' };
  return { expiresAt: Date.now() + days * 86_400_000, days };
}

/** Twitch API мы не используем, поэтому ник — просто строка. Но мусор отсекаем сразу. */
function checkLogin(login) {
  if (!login) return 'кого? укажи ник: `/vip add @nick`';
  if (!isTwitchLogin(login)) return `«${login}» не похоже на ник Twitch — ${LOGIN_HINT}`;
  return null;
}

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

export async function onMessage(message) {
  const text = message.text || '';
  if (!message.from) return;

  if (/^\/(start|help|вип)$/i.test(text.trim())) {
    const access = await ensureAccess(message);
    if (!access.ok) return say(message.chat.id, 'нет доступа');
    const intro = access.bootstrapped
      ? '👋 Ты первый — записал тебя владельцем и этот чат как чат для напоминаний.\n\n'
      : '';
    return say(message.chat.id, intro + HELP);
  }

  const cmd = parseVipCommand(text);
  if (cmd.ignored) return;                 // не наша команда — молчим
  if (cmd.error) return say(message.chat.id, `⚠️ ${cmd.error}`);

  const access = await ensureAccess(message);
  if (!access.ok) return say(message.chat.id, 'нет доступа');
  const cfg = access.cfg;
  const actor = message.from.id;

  // Ленивый тик: пока бот всё равно проснулся, проверяем сроки.
  let tick = null;
  if (['list', 'check', 'info'].includes(cmd.sub)) {
    tick = await runTick({ trigger: 'lazy' });
  }

  switch (cmd.sub) {
    case 'add': {
      const bad = checkLogin(cmd.login);
      if (bad) return say(message.chat.id, bad);
      const period = await resolvePeriod(cmd, cfg);
      if (period.error) return say(message.chat.id, `⚠️ ${period.error}`);

      const existing = await store.findOpenByLogin(cmd.login);
      if (existing) {
        return say(
          message.chat.id,
          `@${esc(cmd.login)} уже в учёте: до ${formatDateRu(existing.expiresAt, cfg.tz)} (${humanDays(daysLeft(existing.expiresAt, Date.now(), cfg.tz))}).\nПродлить?`,
          { reply_markup: reminderKeyboard(existing.id) },
        );
      }

      const grant = await store.createGrant({
        login: cmd.login,
        periodDays: period.days,
        expiresAt: period.expiresAt,
        grantedBy: actor,
        notes: cmd.note,
      });
      await store.logAudit('add', { actor, grantId: grant.id, payload: { login: cmd.login, days: period.days } });

      const body = [
        `🎁 записал: <b>@${esc(grant.login)}</b> — VIP на ${period.days} дн.`,
        `до ${formatDateRu(grant.expiresAt, cfg.tz)}`,
        '',
        'выдай в чате канала:',
        copyableCommand(grant.login),
        '',
        `id <code>${grant.id}</code>`,
      ].join('\n');
      return say(message.chat.id, body, { reply_markup: reminderKeyboard(grant.id) });
    }

    case 'list': {
      const open = await store.listOpen();
      if (!open.length) return say(message.chat.id, 'активных VIP в учёте нет');
      const sorted = open.sort((a, b) => a.expiresAt - b.expiresAt);
      const lines = sorted.slice(0, 20).map((g) => `• ${grantLine(g, { tz: cfg.tz })}`);
      const overdue = sorted.filter((g) => g.status === 'expired').length;
      const head = `📋 активных: ${sorted.length}${overdue ? ` · просрочено: ${overdue}` : ''}`;
      const tail = sorted.length > 20 ? `\n…и ещё ${sorted.length - 20}` : '';
      const kb = listKeyboard(sorted.filter((g) => daysLeft(g.expiresAt, Date.now(), cfg.tz) <= 3).map((g) => g.id));
      return say(message.chat.id, [head, '', ...lines].join('\n') + tail, { reply_markup: kb });
    }

    case 'info': {
      const badInfo = checkLogin(cmd.login);
      if (badInfo) return say(message.chat.id, badInfo);
      const rows = await store.listByLogin(cmd.login);
      if (!rows.length) return say(message.chat.id, `по @${esc(cmd.login)} записей нет`);
      const lines = rows.map((g) => [
        `• ${formatDateRu(g.grantedAt, cfg.tz)} → ${formatDateRu(g.expiresAt, cfg.tz)}`,
        `  ${STATUS_LABELS[g.status] || g.status} · ${g.periodDays} дн. · ${g.source}`,
        g.notes ? `  «${esc(g.notes)}»` : null,
      ].filter(Boolean).join('\n'));
      return say(message.chat.id, `👤 <b>@${esc(cmd.login)}</b>\n${lines.join('\n')}`);
    }

    case 'extend': {
      const badExt = checkLogin(cmd.login);
      if (badExt) return say(message.chat.id, badExt);
      const grant = await store.findOpenByLogin(cmd.login);
      if (!grant) return say(message.chat.id, `у @${esc(cmd.login)} нет активной записи`);
      const days = cmd.days || cfg.periodDays;
      const expiresAt = nextExpiry({
        currentExpiresAt: grant.expiresAt.getTime(),
        now: Date.now(),
        periodDays: days,
        policy: cfg.policy,
      });
      await store.patchGrant(grant.id, { expiresAt: new Date(expiresAt), status: 'active', snoozeUntil: null });
      await store.logAudit('extend', { actor, grantId: grant.id, payload: { days, policy: cfg.policy } });
      return say(
        message.chat.id,
        `➕ @${esc(grant.login)} продлён на ${days} дн. — теперь до ${formatDateRu(expiresAt, cfg.tz)}` +
        (cfg.policy === 'stack' ? ' (считал от текущего конца срока)' : ''),
      );
    }

    case 'remove': {
      const badRem = checkLogin(cmd.login);
      if (badRem) return say(message.chat.id, badRem);
      const grant = await store.findOpenByLogin(cmd.login);
      if (!grant) return say(message.chat.id, `у @${esc(cmd.login)} нет активной записи`);
      await closeGrant(grant, { actor, reason: cmd.note || cmd.args.join(' ') || null });
      return say(
        message.chat.id,
        `✅ @${esc(grant.login)} закрыт в учёте.\nесли ещё не снял роль: <code>/unvip ${esc(grant.login)}</code>`,
      );
    }

    case 'keep': {
      const badKeep = checkLogin(cmd.login);
      if (badKeep) return say(message.chat.id, badKeep);
      const grant = await store.findOpenByLogin(cmd.login);
      if (!grant) return say(message.chat.id, `у @${esc(cmd.login)} нет активной записи`);
      await store.patchGrant(grant.id, { status: 'keep', snoozeUntil: null });
      await store.logAudit('keep', { actor, grantId: grant.id });
      return say(message.chat.id, `🙈 ок, @${esc(grant.login)} остаётся. Напомню через неделю.`);
    }

    case 'cancel': {
      const badCancel = checkLogin(cmd.login);
      if (badCancel) return say(message.chat.id, badCancel);
      const grant = await store.findOpenByLogin(cmd.login);
      if (!grant) return say(message.chat.id, `у @${esc(cmd.login)} нет активной записи`);
      await store.patchGrant(grant.id, { status: 'cancelled' });
      await store.logAudit('cancel', { actor, grantId: grant.id });
      return say(message.chat.id, `🗑 запись @${esc(grant.login)} отменена (осталась в истории).`);
    }

    case 'export': {
      const rows = await store.listAll(1000);
      if (!rows.length) return say(message.chat.id, 'выгружать нечего');
      const chunks = chunkText(csvText(rows, { tz: cfg.tz }));
      for (const [i, chunk] of chunks.entries()) {
        await say(message.chat.id, `<pre>${escapeHtml(chunk)}</pre>` +
          (chunks.length > 1 ? `\nчасть ${i + 1}/${chunks.length}` : ''));
      }
      return null;
    }

    case 'stats': {
      const counts = await store.countByStatus();
      const open = await store.listOpen();
      const overdue = open.filter((g) => g.status === 'expired').length;
      const avg = open.length
        ? Math.round(open.reduce((s, g) => s + g.periodDays, 0) / open.length)
        : 0;
      const lines = [
        '📊 <b>Сводка</b>',
        `в учёте: ${open.length}`,
        `просрочено: ${overdue}`,
        `средний срок: ${avg} дн.`,
        '',
        ...Object.entries(counts).map(([k, v]) => `${STATUS_LABELS[k] || k}: ${v}`),
      ];
      return say(message.chat.id, lines.join('\n'));
    }

    case 'dashboard': {
      const open = await store.listOpen();
      const text = dashboardText(open, { tz: cfg.tz });
      const msg = await say(message.chat.id, text);
      await store.setSetting('dashboard', {
        chatId: String(message.chat.id), messageId: msg.message_id, text,
      });
      try { await api.pinChatMessage({ chat_id: message.chat.id, message_id: msg.message_id, disable_notification: true }); } catch { /* не в группе — ок */ }
      return null;
    }

    case 'check': {
      return say(message.chat.id, '🔄 ' + tickSummary(tick || await runTick({ trigger: 'manual' })));
    }

    case 'whoami': {
      return say(message.chat.id, `tg id: <code>${actor}</code>\nchat id: <code>${message.chat.id}</code>\nпояс: ${cfg.tz}`);
    }

    case 'admins': {
      const action = (cmd.args[0] || '').toLowerCase();
      const target = cmd.args[1];
      const admins = cfg.admins || [];
      if (!action) {
        return say(message.chat.id, '👥 ' + admins.map((a) => `${a.role === 'owner' ? '★' : '•'} ${esc(a.name)} (<code>${a.id}</code>)`).join('\n'));
      }
      if (String(cfg.ownerId) !== String(actor)) return say(message.chat.id, 'менять список может только владелец');
      if (action === 'add' && target) {
        if (admins.some((a) => String(a.id) === String(target))) return say(message.chat.id, 'уже в списке');
        await store.patchConfig({ admins: [...admins, { id: String(target), name: String(target), role: 'mod' }] });
        return say(message.chat.id, `✅ добавлен <code>${esc(target)}</code>`);
      }
      if ((action === 'del' || action === 'remove') && target) {
        await store.patchConfig({ admins: admins.filter((a) => String(a.id) !== String(target)) });
        return say(message.chat.id, `🗑 удалён <code>${esc(target)}</code>`);
      }
      return say(message.chat.id, 'так: `/vip admins add 123456789` (id узнаётся командой /vip whoami)');
    }

    default:
      return say(message.chat.id, HELP);
  }
}

async function closeGrant(grant, { actor, reason = null }) {
  await store.patchGrant(grant.id, { status: 'removed', notes: reason || grant.notes || null });
  await store.logAudit('remove', { actor, grantId: grant.id, payload: { reason } });
}

// ---------------------------------------------------------------------------
// callback_query (инлайн-кнопки)
// ---------------------------------------------------------------------------

export async function onCallback(query) {
  const data = query.data || '';
  const [, action, grantId] = data.split(':');
  const from = query.from;
  const chatId = query.message?.chat?.id;

  const answer = async (text) => {
    try { await api.answerCallbackQuery({ callback_query_id: query.id, text }); } catch { /* истёк — не важно */ }
  };

  if (!action || !grantId) return answer('не понял кнопку');

  const allowed = await store.isAdmin(from.id);
  if (!allowed) return answer('нет доступа');

  const grant = await store.getGrant(grantId);
  if (!grant) return answer('запись не найдена');

  const cfg = await store.getConfig();
  const login = grant.login;

  if (action === 'noop') return answer('ок');

  if (action === 'rem') {
    await closeGrant(grant, { actor: from.id, reason: 'кнопка «снял»' });
    await answer('записал');
    return say(chatId, `✅ @${esc(login)} закрыт.`);
  }

  if (action === 'ext' || action === 'ext7') {
    const days = action === 'ext7' ? 7 : cfg.periodDays;
    const expiresAt = nextExpiry({
      currentExpiresAt: grant.expiresAt.getTime(),
      now: Date.now(),
      periodDays: days,
      policy: cfg.policy,
    });
    await store.patchGrant(grant.id, { expiresAt: new Date(expiresAt), status: 'active', snoozeUntil: null });
    await store.logAudit('extend', { actor: from.id, grantId, payload: { days, via: 'button' } });
    await answer(`+${days} дн.`);
    return say(chatId, `➕ @${esc(login)} теперь до ${formatDateRu(expiresAt, cfg.tz)}`);
  }

  if (action === 'keep') {
    await store.patchGrant(grant.id, { status: 'keep', snoozeUntil: null });
    await store.logAudit('keep', { actor: from.id, grantId, payload: { via: 'button' } });
    await answer('оставил');
    return say(chatId, `🙈 @${esc(login)} остаётся, напомню через неделю.`);
  }

  if (action === 'snz') {
    await store.snoozeGrant(grant.id, Date.now() + 86_400_000);
    await answer('до завтра');
    return say(chatId, `⏰ напомню про @${esc(login)} завтра.`);
  }

  return answer('неизвестное действие');
}

export { BOT_ONLY, formatDateTimeRu };
