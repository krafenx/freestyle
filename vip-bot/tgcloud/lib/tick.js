// lib/tick.js — «тик»: смена статусов, напоминания, дайджест, дашборд.
//
// На Telegram Serverless НЕТ таймера: код запускается только на входящий
// апдейт или на вызов endpoint'а. Поэтому тик вызывают из трёх мест:
//   1) handlers/message + handlers/callback_query — «ленивый» тик (бесплатно,
//      но сработает только когда кто-то пишет боту);
//   2) endpoints/tick — ручной/внешний запуск: `npx tgcloud run endpoints/tick`
//      из GitHub Actions или крона на любой машине;
//   3) кнопка «Проверить» в дашборде.
// Идемпотентность держит не вызывающий, а UNIQUE(grant_id, kind) в базе:
// три тика подряд отправят одно и то же напоминание ровно один раз.

import { api } from 'sdk';
import {
  dueReminders, digestDue, reminderText, dashboardText, daysLeft, formatDateRu,
} from 'lib/core';
import * as store from 'lib/db';
import { reminderKeyboard } from 'lib/ui';

const DIGEST_KEY = '__digest__';

async function targetChats(cfg) {
  const chats = new Set();
  if (cfg.chatId) chats.add(String(cfg.chatId));
  return [...chats];
}

async function send(chats, text, extra = {}) {
  const res = [];
  for (const chatId of chats) {
    try {
      const msg = await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', ...extra });
      res.push({ chatId, ok: true, messageId: msg?.message_id ?? null });
    } catch (err) {
      // 403 — бота выкинули из чата: это надо увидеть, а не проглотить
      res.push({ chatId, ok: false, error: `${err.code ?? ''} ${err.description ?? err.message}` });
    }
  }
  return res;
}

/**
 * @returns {Promise<{reminders:number, digest:boolean, errors:string[], skipped?:string}>}
 */
export async function runTick({ trigger = 'update', now = Date.now() } = {}) {
  const cfg = await store.getConfig();
  const chats = await targetChats(cfg);
  const out = { trigger, reminders: 0, digest: false, errors: [], skipped: null };
  if (!chats.length) {
    out.skipped = 'нет chatId в настройках: напишите боту /start в чате модераторов';
    return out;
  }

  const open = await store.listOpen();

  for (const grant of open) {
    const dl = daysLeft(grant.expiresAt, now, cfg.tz);

    // 1. статусы
    if (grant.status === 'active' && dl < 0) {
      await store.patchGrant(grant.id, { status: 'expired' });
      grant.status = 'expired';
    } else if (grant.status === 'active' && dl <= 3) {
      await store.patchGrant(grant.id, { status: 'expiring' });
      grant.status = 'expiring';
    }

    // 2. напоминания
    const sent = await store.sentKinds(grant.id);
    const due = dueReminders(grant, now, { tz: cfg.tz, hour: cfg.hour, sent });
    for (const item of due) {
      const claim = await store.claimNotification(grant.id, item.kind, chats[0]);
      if (!claim.ok) continue;
      const text = reminderText(grant, item.kind, { tz: cfg.tz, now });
      const results = await send(chats, text, { reply_markup: reminderKeyboard(grant.id) });
      const bad = results.find((r) => !r.ok);
      await store.markNotification(claim.id, bad
        ? { status: 'failed', error: bad.error }
        : { status: 'sent', messageId: results[0]?.messageId });
      if (bad) out.errors.push(`напоминание ${grant.login}: ${bad.error}`);
      else out.reminders += 1;
    }
  }

  // 3. недельный дайджест
  if (digestDue(now, { tz: cfg.tz, hour: cfg.hour, lastDay: cfg.lastDigestDay })) {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const claim = await store.claimNotification(DIGEST_KEY, `digest-${dayKey}`, chats[0]);
    if (claim.ok) {
      const soon = open
        .filter((g) => ['active', 'expiring'].includes(g.status))
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(0, 10);
      const text = soon.length
        ? ['🗓 <b>На этой неделе</b>', ...soon.map((g) => `• @${g.login} — до ${formatDateRu(g.expiresAt, cfg.tz)}`)].join('\n')
        : '🗓 На этой неделе истечений нет.';
      const results = await send(chats, text);
      const bad = results.find((r) => !r.ok);
      await store.markNotification(claim.id, bad ? { status: 'failed', error: bad.error } : { status: 'sent' });
      out.digest = !bad;
    }
    await store.patchConfig({ lastDigestDay: Math.floor(Date.now() / 86_400_000) });
  }

  // 4. дашборд: одно сообщение, которое бот правит, а не плодит новые
  const dash = await store.getSetting('dashboard', null);
  if (dash?.chatId && dash?.messageId) {
    const text = dashboardText(open, { tz: cfg.tz, now });
    if (text !== dash.text) {
      try {
        await api.editMessageText({
          chat_id: dash.chatId, message_id: dash.messageId, text, parse_mode: 'HTML',
        });
        await store.setSetting('dashboard', { ...dash, text });
      } catch (err) {
        if (err.code === 400) await store.setSetting('dashboard', null); // сообщение удалили
        else out.errors.push(`дашборд: ${err.description ?? err.message}`);
      }
    }
  }

  return out;
}

/** Текст для ответа на кнопку «Проверить» и для `tgcloud run endpoints/tick`. */
export function tickSummary(res) {
  if (res.skipped) return res.skipped;
  const parts = [`проверил: напоминаний ${res.reminders}`];
  if (res.digest) parts.push('дайджест отправлен');
  if (res.errors.length) parts.push(`ошибки: ${res.errors.join('; ')}`);
  return parts.join(' · ');
}
