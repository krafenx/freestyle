// endpoints/dev-reset.js — аварийный сброс настроек (владелец, чат, часовой пояс).
//
// Зачем: владелец назначается автоматически на первый `/start`. Если этот первый
// запуск случился с «тестовым» id (например, при проверке через
// `tgcloud run handlers/message '{"from":{"id":1},…}'`), то настоящему модератору
// бот ответит «нет доступа», и починить это из чата невозможно.
//
// Запуск (нужен CLI-токен, снаружи не вызвать):
//   npx tgcloud run endpoints/dev-reset
//
// Удаляется ТОЛЬКО строка настроек `config`. Записи о VIP, журнал отправок и
// аудит остаются на месте. После сброса следующий `/start` снова назначит владельца.

import { db, eq } from 'sdk/db';
import { settings } from 'schema';

export default async function () {
  await db.delete(settings).where(eq(settings.key, 'config')).run();
  console.log('config сброшен: следующий /start назначит владельца заново');
  return { ok: true, reset: ['config'] };
}
