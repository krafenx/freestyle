// endpoints/tick.js — единственный способ разбудить бота БЕЗ сообщения.
//
// На платформе нет таймера, зато есть management API: `npx tgcloud run`
// исполняет модуль в облаке. Поэтому внешний крон (GitHub Actions, cron-job.org
// на любой машине, ноутбук с crontab) делает ровно это:
//
//   TGCLOUD_TOKEN=app123:... npx tgcloud run endpoints/tick
//
// Важно: `/run` исполняет код из ЛОКАЛЬНОЙ папки, а не задеплоенный, поэтому
// крон должен запускаться на том же коммите, что и задеплоен.
//
// Сам endpoint опубликован и как POST /api/tick для Mini App (платформа
// проверяет initData), но Mini App у нас нет — этот путь просто не используется.

import { runTick, tickSummary } from 'lib/tick';

export default async function (input, ctx) {
  const res = await runTick({ trigger: 'external' });
  return { ...res, summary: tickSummary(res), at: new Date().toISOString() };
}
