// endpoints/tick.js — единственный способ разбудить бота БЕЗ сообщения.
//
// На платформе нет таймера, зато есть management API: `npx tgcloud run`
// исполняет модуль в облаке. Поэтому внешний крон (GitHub Actions, crontab
// на любой машине) делает ровно это:
//
//   TGCLOUD_TOKEN=app12345:... npx tgcloud run endpoints/tick
//
// Важно: `/run` исполняет код из ЛОКАЛЬНОЙ папки, а не задеплоенный, поэтому
// крон должен запускаться на том же коммите, что и задеплоен.
//
// Ошибки НЕ проглатываются: если напоминание не ушло (бота выкинули из чата,
// нет chat_id, Bot API ругается), процесс падает с ненулевым кодом — иначе
// сломанный крон выглядит как «тишина, всё хорошо», что хуже всего.

import { runTick, tickSummary } from 'lib/tick';

export default async function (input, ctx) {
  const res = await runTick({ trigger: 'external' });
  const summary = tickSummary(res);

  if (res.skipped) {
    // Нет чата для напоминаний — это не «пусто», это конфигурационная ошибка.
    throw new Error(`тик не выполнена: ${res.skipped}`);
  }
  if (res.errors.length) {
    throw new Error(`тик с ошибками (${res.errors.length}): ${res.errors.join('; ')}`);
  }

  console.log(summary);
  return { ...res, summary, at: new Date().toISOString() };
}
