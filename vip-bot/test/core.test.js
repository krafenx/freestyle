// Тесты только на чистую логику (lib/core.js) — она не импортирует `sdk`,
// поэтому гоняется в обычном Node: npm test.
//
// Всё, что требует платформы (БД, Bot API), проверяется руками по чек-листу
// в README — на Serverless нет эмулятора sdk.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tzParts, dayNumber, weekday, daysLeft, formatDateRu, humanDays,
  parseVipCommand, parseDateOnly, nextExpiry, dueReminders, digestDue,
  chunkText, csvText, shortId, DAY_MS,
  isTwitchLogin, reminderText,
} from '../tgcloud/lib/core.js';

const MSK = 'Europe/Moscow';
const utc = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

// ---------------------------------------------------------------------------
// часовые пояса
// ---------------------------------------------------------------------------

test('tzParts: Москва = UTC+3', () => {
  const p = tzParts(utc(2026, 11, 10, 8, 0), MSK);
  assert.equal(p.hour, 11);
  assert.equal(p.day, 10);
});

test('tzParts: полночь не превращается в 24 часа', () => {
  // 21:00 UTC = 00:00 следующего дня в Москве
  const p = tzParts(utc(2026, 11, 10, 21, 0), MSK);
  assert.equal(p.day, 11);
  assert.equal(p.hour, 0);
});

test('dayNumber переживает переход на летнее время (Лондон)', () => {
  const beforeSwitch = utc(2026, 3, 28, 23, 30); // GMT
  const afterSwitch = utc(2026, 3, 29, 22, 30); // BST, следующая местная ночь
  assert.equal(dayNumber(afterSwitch, 'Europe/London') - dayNumber(beforeSwitch, 'Europe/London'), 1);
});

test('daysLeft считается по календарным дням, а не по часам', () => {
  const expires = utc(2026, 11, 10, 20, 0); // 23:00 МСК 10-го
  const now = utc(2026, 11, 9, 23, 0);      // 02:00 МСК 10-го
  assert.equal(daysLeft(expires, now, MSK), 0);
});

test('weekday: 2026-11-09 — понедельник', () => {
  assert.equal(weekday(utc(2026, 11, 9, 8), MSK), 1);
});

test('formatDateRu и humanDays', () => {
  assert.equal(formatDateRu(utc(2026, 11, 10, 8), MSK), '10.11.2026');
  assert.equal(humanDays(0), 'сегодня');
  assert.equal(humanDays(-2), 'просрочено на 2 дн.');
});

// ---------------------------------------------------------------------------
// разбор команд
// ---------------------------------------------------------------------------

test('parseVipCommand: add со сроком', () => {
  const c = parseVipCommand('/vip add @Nick 14d');
  assert.equal(c.sub, 'add');
  assert.equal(c.login, 'nick');
  assert.equal(c.days, 14);
});

test('parseVipCommand: --to и --note', () => {
  const c = parseVipCommand('/vip add nick --to 2026-12-01 --note за 5000 битсов');
  assert.equal(c.to, '2026-12-01');
  assert.equal(c.note, 'за 5000 битсов');
  assert.equal(c.error, undefined);
});

test('parseVipCommand: битая дата → ошибка', () => {
  assert.equal(parseVipCommand('/vip add nick --to 01.12.2026').error !== undefined, true);
});

test('parseVipCommand: /vip@Bot и короткая форма', () => {
  assert.equal(parseVipCommand('/vip@MyVipBot info @nick').sub, 'info');
  const c = parseVipCommand('/vip @nick');
  assert.equal(c.sub, 'add');
  assert.equal(c.login, 'nick');
});

test('parseVipCommand: чужой текст игнорируется', () => {
  assert.equal(parseVipCommand('привет, бот').ignored, true);
});

test('parseDateOnly', () => {
  assert.equal(parseDateOnly('2026-12-01'), utc(2026, 12, 1, 12));
  assert.equal(parseDateOnly('01.12.2026'), null);
});

// ---------------------------------------------------------------------------
// сроки и продление
// ---------------------------------------------------------------------------

test('nextExpiry: stack считает от конца, now — от сегодня', () => {
  const now = utc(2026, 11, 10);
  const current = utc(2026, 11, 20);
  assert.equal(nextExpiry({ currentExpiresAt: current, now, periodDays: 30 }), current + 30 * DAY_MS);
  assert.equal(nextExpiry({ currentExpiresAt: current, now, periodDays: 30, policy: 'now' }), now + 30 * DAY_MS);
});

test('nextExpiry: истёкшую випку продлеваем от сегодня', () => {
  const now = utc(2026, 11, 10);
  const expired = utc(2026, 10, 1);
  assert.equal(nextExpiry({ currentExpiresAt: expired, now, periodDays: 30 }), now + 30 * DAY_MS);
});

// ---------------------------------------------------------------------------
// напоминания
// ---------------------------------------------------------------------------

const expires = utc(2026, 11, 10, 20, 0); // 23:00 МСК 10 ноября
const grant = (over = {}) => ({ id: 'g1', login: 'nick', status: 'active', expiresAt: new Date(expires), ...over });
const kindsAt = (now, over = {}, opts = {}) =>
  dueReminders(grant(over), now, { tz: MSK, hour: 10, ...opts }).map((r) => r.kind);

test('T-3', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 7, 8)), ['t-3']);
});

test('T-1', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 9, 8)), ['t-1']);
});

test('T-0 только после 10:00 локального', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 10, 5)), []);   // 08:00 МСК
  assert.deepEqual(kindsAt(utc(2026, 11, 10, 8)), ['t-0']); // 11:00 МСК
});

test('в промежуточные дни молчим', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 8, 8)), []);
});

test('просрочка приходит догоном, а не строго в один день', () => {
  // пропустили день -1 (бот не просыпался) — на следующем тике всё равно скажем
  assert.deepEqual(kindsAt(utc(2026, 11, 12, 8)), ['overdue']);   // -2
  assert.deepEqual(kindsAt(utc(2026, 11, 20, 8)), ['overdue']);   // -10
  assert.deepEqual(kindsAt(utc(2026, 12, 30, 8)), ['overdue']);   // -50
  // уже отправляли — тишина до недельной эскалации
  assert.deepEqual(kindsAt(utc(2026, 11, 12, 8), {}, { sent: ['overdue'] }), []);
});

test('недельная эскалация после просрочки', () => {
  const sentOverdue = { sent: ['overdue'] };
  assert.deepEqual(kindsAt(utc(2026, 11, 18, 8), {}, sentOverdue), ['escalation-1']);  // -8
  assert.deepEqual(kindsAt(utc(2026, 11, 25, 8), {}, sentOverdue), ['escalation-2']);  // -15
  // шаг уже отправлен — в промежутке до следующей недели молчим
  assert.deepEqual(
    kindsAt(utc(2026, 11, 20, 8), {}, { sent: ['overdue', 'escalation-1'] }),
    [],
  );
});

test('эскалация упирается в 4 и затихает', () => {
  assert.deepEqual(kindsAt(utc(2026, 12, 16, 8), {}, { sent: ['overdue'] }), ['escalation-4']);
  assert.deepEqual(
    kindsAt(utc(2026, 12, 23, 8), {}, { sent: ['overdue', 'escalation-4'] }),
    [],
  );
});

test('повторный тик не дублирует: sent блокирует', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 7, 8), {}, { sent: ['t-3'] }), []);
});

test('snooze («напомнить завтра») глушит напоминания', () => {
  const now = utc(2026, 11, 7, 8);
  assert.deepEqual(kindsAt(now, { snoozeUntil: new Date(now + 3600_000) }), []);
});

test('keep: тихое напоминание раз в неделю', () => {
  assert.deepEqual(kindsAt(utc(2026, 11, 18, 8), { status: 'keep' }), ['keep-1']);
  assert.deepEqual(kindsAt(utc(2026, 11, 18, 8), { status: 'keep' }, { sent: ['keep-1'] }), []);
  assert.deepEqual(kindsAt(utc(2026, 11, 25, 8), { status: 'keep' }, { sent: ['keep-1'] }), ['keep-2']);
});

test('закрытые записи не напоминают', () => {
  for (const status of ['removed', 'cancelled', 'waitlist']) {
    assert.deepEqual(kindsAt(utc(2026, 11, 7, 8), { status }), []);
  }
});

test('digestDue: понедельник после 10:00, раз в день', () => {
  const mon = utc(2026, 11, 9, 8);
  assert.equal(digestDue(mon, { tz: MSK, hour: 10 }), true);
  assert.equal(digestDue(mon, { tz: MSK, hour: 10, lastDay: dayNumber(mon, MSK) }), false);
  assert.equal(digestDue(utc(2026, 11, 9, 5), { tz: MSK, hour: 10 }), false); // 08:00 МСК
  assert.equal(digestDue(utc(2026, 11, 10, 8), { tz: MSK, hour: 10 }), false); // вторник
});

// ---------------------------------------------------------------------------
// вывод
// ---------------------------------------------------------------------------

test('chunkText режет по границам строк и не теряет данные', () => {
  const text = Array.from({ length: 40 }, (_, i) => `строка ${i} ${'x'.repeat(50)}`).join('\n');
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 300));
  assert.equal(chunks.join('\n'), text);
});

test('csvText экранирует кавычки', () => {
  const csv = csvText([{
    login: 'nick', status: 'active', grantedAt: utc(2026, 11, 1), expiresAt: utc(2026, 12, 1),
    periodDays: 30, source: 'manual', grantedBy: '1', notes: 'за "битсы"',
  }], { tz: MSK });
  assert.equal(csv.split('\n').length, 2);
  assert.ok(csv.includes('""битсы""'));
});

test('isTwitchLogin: отсекаем мусор и кириллицу', () => {
  assert.equal(isTwitchLogin('nick'), true);
  assert.equal(isTwitchLogin('Nick_95'), true);
  assert.equal(isTwitchLogin('abc'), false);          // короче 4
  assert.equal(isTwitchLogin('ник'), false);          // кириллица
  assert.equal(isTwitchLogin('my nick'), false);      // пробел
  assert.equal(isTwitchLogin(''), false);
});

test('reminderText: в напоминании есть готовая команда снятия', () => {
  const text = reminderText(grant(), 't-1', { tz: MSK, now: utc(2026, 11, 9, 8) });
  assert.ok(text.includes('/unvip nick'), text);
  assert.ok(text.includes('@nick'));
});

test('reminderText: «оставить» не подсовывает команду снятия', () => {
  const text = reminderText(grant({ status: 'keep' }), 'keep-1', { tz: MSK, now: utc(2026, 11, 18, 8) });
  assert.equal(text.includes('/unvip'), false);
});

test('shortId: 8 символов', () => {
  assert.equal(shortId(() => 0.42).length, 8);
  assert.equal(shortId(() => 0).length, 8);
});
