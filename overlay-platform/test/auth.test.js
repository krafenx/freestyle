import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createOverlayServer } from '../src/server/app.js';
import { parseCookies } from '../src/server/auth/cookies.js';
import { safeNextPath } from '../src/server/auth/http.js';
import { checkNewPassword, createPasswordHasher } from '../src/server/auth/passwords.js';
import { clientKey, createRateLimiter } from '../src/server/auth/rate-limit.js';
import { newRecoveryCode, normalizeRecoveryCode } from '../src/server/auth/tokens.js';
import {
  CODE_PATTERN, DAY, FAST, GOOD_PASSWORD, MINUTE, NODE_FLAGS, NO_LIMITS, PROJECT_DIR,
  childEnv, createVisitor, registerUser, runNode, startServer, uniqueName,
} from './helpers.js';

/* Этап 3: аккаунты и вход. Проверяется настоящий сервер с настоящей базой:
   регистрация, вход, выход, восстановление доступа, защита личных страниц,
   защита от перебора и от запросов с чужих сайтов. */

/* ========================================================================== */

describe('Этап 3 — регистрация, вход и выход', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { await ctx.stop(); });

  it('регистрация создаёт аккаунт, сразу впускает и выдаёт код восстановления', async () => {
    const visitor = createVisitor(ctx.baseUrl);
    const res = await visitor.post('/api/auth/register', {
      username: 'Streamer_One',
      displayName: 'Стример Один',
      password: GOOD_PASSWORD,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.ok, true);
    assert.deepEqual(Object.keys(res.data.user).sort(), ['createdAt', 'displayName', 'username']);
    assert.equal(res.data.user.username, 'Streamer_One');
    assert.equal(res.data.user.displayName, 'Стример Один');
    assert.match(res.data.recoveryCode, CODE_PATTERN);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    // Cookie сеанса: недоступна скриптам страницы и не отправляется с чужих сайтов
    assert.equal(res.setCookies.length, 1);
    const cookie = res.setCookies[0];
    assert.match(cookie, /^ks_session=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Max-Age=2592000/, 'вход хранится 30 дней');
    assert.doesNotMatch(cookie, /Secure/, 'по обычному http пометка Secure не ставится — иначе cookie не сохранится');

    const session = await visitor.get('/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.user.username, 'Streamer_One');
    assert.equal(session.data.activeSessions, 1);
    assert.equal(session.data.registrationOpen, true);

    // Без отображаемого имени показывается имя для входа
    const plain = await registerUser(ctx.baseUrl, { username: 'No_Display' });
    assert.equal(plain.res.data.user.displayName, 'No_Display');
  });

  it('пароль, код восстановления и ключ сеанса в базе не лежат — только их необратимые отпечатки', async () => {
    const password = 'секретный-пароль-которого-нет-в-базе';
    const { visitor, username, recoveryCode } = await registerUser(ctx.baseUrl, { password });
    const token = visitor.jar.get('ks_session');

    const user = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    assert.match(user.password_hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
    assert.match(user.recovery_hash, /^[0-9a-f]{64}$/);

    const session = ctx.db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(user.id);
    assert.match(session.token_hash, /^[0-9a-f]{64}$/);

    const everything = JSON.stringify([
      ctx.db.prepare('SELECT * FROM users').all(),
      ctx.db.prepare('SELECT * FROM sessions').all(),
    ]);
    assert.ok(!everything.includes(password), 'пароль найден в базе открытым текстом');
    assert.ok(!everything.includes(token), 'ключ сеанса найден в базе открытым текстом');
    assert.ok(!everything.includes(recoveryCode), 'код восстановления найден в базе открытым текстом');
    assert.ok(!everything.includes(recoveryCode.replaceAll('-', '')), 'код восстановления найден в базе');
  });

  it('имя пользователя: латиница, цифры и подчёркивание; служебные и занятые имена отклоняются', async () => {
    const visitor = createVisitor(ctx.baseUrl);
    const attempt = (username) => visitor.post('/api/auth/register', { username, password: GOOD_PASSWORD });

    for (const bad of ['ab', 'a'.repeat(25), 'имя_кириллицей', 'with space', 'semi;colon', '<script>', '', 42, null, ['x'], { a: 1 }]) {
      const res = await attempt(bad);
      assert.equal(res.status, 400, `имя ${JSON.stringify(bad)} должно быть отклонено`);
      assert.deepEqual(res.data, { ok: false, error: 'username_invalid', field: 'username' });
      assert.equal(res.setCookies.length, 0);
    }

    for (const reserved of ['admin', 'Support', 'ROOT', 'overlay']) {
      const res = await attempt(reserved);
      assert.equal(res.status, 400);
      assert.equal(res.data.error, 'username_reserved');
    }

    assert.equal((await attempt('Taken_Name')).status, 201);
    const again = await createVisitor(ctx.baseUrl).post('/api/auth/register', { username: 'taken_NAME', password: GOOD_PASSWORD });
    assert.equal(again.status, 409, 'имена сравниваются без учёта регистра');
    assert.deepEqual(again.data, { ok: false, error: 'username_taken', field: 'username' });

    assert.equal((await attempt('abc')).status, 201, 'три символа — допустимая длина');
    assert.equal((await attempt('a'.repeat(24))).status, 201, '24 символа — допустимая длина');
  });

  it('слабые пароли отклоняются: короткие, самые ходовые и повторяющие имя', async () => {
    const visitor = createVisitor(ctx.baseUrl);
    const cases = [
      ['Weak_A', 'short1', 'password_too_short'],
      ['Weak_B', 'password123', 'password_too_common'],
      ['Weak_C', '12345678', 'password_too_common'],
      ['Weak_D', 'aaaaaaaaaa', 'password_too_common'],
      ['Weak_E', 'QWERTYUIOP', 'password_too_common'],
      ['Weak_F', 'weak_f2024', 'password_like_username'],
      ['Weak_G', 'x'.repeat(201), 'password_too_long'],
      ['Weak_H', undefined, 'password_required'],
      ['Weak_I', '', 'password_required'],
      ['Weak_J', 12345678, 'password_required'],
    ];
    for (const [username, password, reason] of cases) {
      const res = await visitor.post('/api/auth/register', { username, password });
      assert.equal(res.status, 400, `пароль ${JSON.stringify(password)} должен быть отклонён`);
      assert.deepEqual(res.data, { ok: false, error: reason, field: 'password' });
    }
    const created = ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'Weak%'").get();
    assert.equal(created.n, 0, 'при отказе аккаунт создаваться не должен');
  });

  it('вход: верный пароль впускает, а неверный пароль и несуществующее имя дают одинаковый ответ', async () => {
    const { username, password } = await registerUser(ctx.baseUrl, { username: 'Login_Case' });

    const wrong = await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password: 'не тот пароль' });
    const unknown = await createVisitor(ctx.baseUrl).post('/api/auth/login', { username: 'nobody_here', password });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.text, unknown.text, 'по ответу нельзя понять, существует ли аккаунт');
    assert.deepEqual(wrong.data, { ok: false, error: 'invalid_credentials' });
    assert.equal(wrong.setCookies.length, 0);

    for (const body of [{}, { username }, { password }, { username: '   ', password }, { username: 1, password: 2 }]) {
      const res = await createVisitor(ctx.baseUrl).post('/api/auth/login', body);
      assert.equal(res.status, 400);
      assert.equal(res.data.error, 'credentials_required');
    }

    const visitor = createVisitor(ctx.baseUrl);
    const ok = await visitor.post('/api/auth/login', { username: '  LOGIN_case ', password });
    assert.equal(ok.status, 200, 'регистр букв и пробелы по краям имени не мешают входу');
    assert.equal(ok.data.user.username, 'Login_Case');
    assert.equal(await visitor.isSignedIn(), true);
  });

  it('выход закрывает сеанс на сервере: прежний ключ больше не действует', async () => {
    const { visitor } = await registerUser(ctx.baseUrl);
    const stolen = createVisitor(ctx.baseUrl);
    stolen.jar.set('ks_session', visitor.jar.get('ks_session')); // копия ключа, как если бы его украли
    assert.equal(await stolen.isSignedIn(), true);

    const out = await visitor.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookies[0], /^ks_session=; .*Max-Age=0/, 'cookie стирается в браузере');
    assert.equal(visitor.jar.size, 0);
    assert.equal(await visitor.isSignedIn(), false);
    assert.equal(await stolen.isSignedIn(), false, 'после выхода украденная копия ключа бесполезна');

    assert.equal((await visitor.post('/api/auth/logout')).status, 200, 'повторный выход не даёт ошибку');
  });

  it('новый вход в том же браузере заменяет прежний, а не копит «активные входы»', async () => {
    const { visitor, username, password, recoveryCode } = await registerUser(ctx.baseUrl);
    const sessions = async () => (await visitor.get('/api/auth/session')).data.activeSessions;
    const copyOfKey = () => {
      const copy = createVisitor(ctx.baseUrl);
      copy.jar.set('ks_session', visitor.jar.get('ks_session'));
      return copy;
    };
    assert.equal(await sessions(), 1);

    // Неудачная попытка входа действующий вход не трогает
    const before = copyOfKey();
    assert.equal((await visitor.post('/api/auth/login', { username, password: 'не тот пароль' })).status, 401);
    assert.equal(await visitor.isSignedIn(), true);

    // Удачный повторный вход: ключ новый, прежний закрыт, счётчик не вырос
    assert.equal((await visitor.post('/api/auth/login', { username, password })).status, 200);
    assert.equal(await visitor.isSignedIn(), true);
    assert.equal(await before.isSignedIn(), false, 'прежний ключ этого браузера больше не действует');
    assert.equal(await sessions(), 1);

    // Восстановление доступа из-под действующего входа: человек остаётся в кабинете.
    // Перед этим в базе появляется чужой вход, а наш становится самым свежим: именно в таком
    // раскладе новый сеанс мог бы получить номер только что закрытого и пропасть вместе с ним.
    await registerUser(ctx.baseUrl);
    assert.equal((await visitor.post('/api/auth/login', { username, password })).status, 200);
    const recovered = await visitor.post('/api/auth/recover', { username, recoveryCode, newPassword: 'пароль после восстановления 5' });
    assert.equal(recovered.status, 200);
    assert.equal(await visitor.isSignedIn(), true, 'новый сеанс не должен пропасть вместе с прежним');
    assert.equal(await sessions(), 1);

    // Регистрация второго аккаунта в этом же браузере закрывает вход первого
    const first = copyOfKey();
    const second = await visitor.post('/api/auth/register', { username: uniqueName(), password: GOOD_PASSWORD });
    assert.equal(second.status, 201);
    assert.equal((await visitor.get('/api/auth/session')).data.user.username, second.data.user.username);
    assert.equal(await first.isSignedIn(), false);
    const left = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?').get(username).n;
    assert.equal(left, 0, 'у первого аккаунта не осталось висящих входов');
  });

  it('«выйти на всех устройствах» закрывает все входы аккаунта', async () => {
    const { visitor, username, password } = await registerUser(ctx.baseUrl);
    const phone = createVisitor(ctx.baseUrl);
    const laptop = createVisitor(ctx.baseUrl);
    await phone.post('/api/auth/login', { username, password });
    await laptop.post('/api/auth/login', { username, password });
    assert.equal((await visitor.get('/api/auth/session')).data.activeSessions, 3);

    const res = await laptop.post('/api/auth/logout-all');
    assert.equal(res.status, 200);
    assert.equal(res.data.endedSessions, 3);
    for (const device of [visitor, phone, laptop]) {
      assert.equal(await device.isSignedIn(), false);
    }
  });

  it('кабинет закрыт для гостей: страница ведёт на вход, адреса аккаунта отвечают отказом', async () => {
    const guest = createVisitor(ctx.baseUrl);

    const page = await guest.get('/app');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Fapp');
    assert.doesNotMatch(page.text, /pane-account/, 'содержимое кабинета гостю не отдаётся');

    const deep = await guest.get('/app?tab=plan');
    assert.equal(deep.headers.get('location'), '/login?next=%2Fapp%3Ftab%3Dplan');

    // Как файл страницу тоже не получить — проверка входа не обходится
    for (const direct of ['/app.html', '/app%2Ehtml', '/APP.HTML', '/login.html', '/index.html', '/404.html']) {
      assert.equal((await guest.get(direct)).status, 404, `${direct} не должен открываться`);
    }

    for (const [method, url] of [
      ['patch', '/api/account/profile'],
      ['post', '/api/account/password'],
      ['post', '/api/account/recovery-code'],
      ['post', '/api/auth/logout-all'],
    ]) {
      const res = await guest[method](url, {});
      assert.equal(res.status, 401, `${url} без входа`);
      assert.deepEqual(res.data, { ok: false, error: 'unauthorized' });
    }

    const { visitor } = await registerUser(ctx.baseUrl);
    const cabinet = await visitor.get('/app');
    assert.equal(cabinet.status, 200);
    assert.match(cabinet.text, /id="pane-account"/);
    assert.equal(cabinet.headers.get('cache-control'), 'no-store', 'кабинет не остаётся в памяти браузера после выхода');

    // Страницы входа и регистрации вошедшему не показываются
    for (const url of ['/login', '/register', '/recover']) {
      assert.equal((await guest.get(url)).status, 200);
      const res = await visitor.get(url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/app');
    }
  });

  it('после входа человек возвращается туда, куда шёл, но не на чужой сайт', async () => {
    const { visitor } = await registerUser(ctx.baseUrl);
    const target = async (next) =>
      (await visitor.get(`/login?next=${encodeURIComponent(next)}`)).headers.get('location');

    assert.equal(await target('/app?tab=plan#top'), '/app?tab=plan#top');
    for (const hostile of [
      'https://evil.example/', '//evil.example/', '/\\evil.example', '\\\\evil.example',
      'javascript:alert(1)', 'evil.example', '/login', '/register?x=1', '/recover/', '/app\nSet-Cookie: x=1', '',
    ]) {
      assert.equal(await target(hostile), '/app', `next=${JSON.stringify(hostile)} не должен никуда уводить`);
    }
    assert.equal((await visitor.get('/login?next=/a&next=//evil.example')).headers.get('location'), '/app');

    assert.equal(safeNextPath('/app'), '/app');
    assert.equal(safeNextPath('/app/../x?y=1'), '/x?y=1');
    assert.equal(safeNextPath(`/${'a'.repeat(600)}`), null);
    assert.equal(safeNextPath(undefined), null);
    assert.equal(safeNextPath(['/app']), null);
  });

  it('команды с чужих сайтов отклоняются даже при действующем входе', async () => {
    const { visitor } = await registerUser(ctx.baseUrl, { displayName: 'Исходное имя' });
    const host = new URL(ctx.baseUrl).host;
    const rename = (headers, body = { displayName: 'Подмена' }) =>
      visitor.patch('/api/account/profile', body, { headers });

    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'none' },
      { 'Sec-Fetch-Site': 'cross-site', Origin: `http://${host}` },
      { Origin: 'https://evil.example' },
      { Origin: `http://${host}.evil.example` },
      { Origin: 'null' },
    ]) {
      const res = await rename(headers);
      assert.equal(res.status, 403, `запрос с ${JSON.stringify(headers)} должен быть отклонён`);
      assert.deepEqual(res.data, { ok: false, error: 'cross_site_request' });
    }

    // Обычная форма на чужом сайте может отправить только такие виды данных — они не принимаются
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const res = await visitor.patch('/api/account/profile', 'displayName=%D0%9F', { headers: { 'Content-Type': type } });
      assert.equal(res.status, 415);
      assert.equal(res.data.error, 'json_required');
    }

    assert.equal((await visitor.get('/api/auth/session')).data.user.displayName, 'Исходное имя');

    // Запросы со своей же страницы проходят
    assert.equal((await rename({ 'Sec-Fetch-Site': 'same-origin' }, { displayName: 'Своё имя' })).status, 200);
    assert.equal((await rename({ Origin: `http://${host}` }, { displayName: 'Своё имя 2' })).status, 200);
    assert.equal((await visitor.get('/api/auth/session')).data.user.displayName, 'Своё имя 2');

    // Защита общая для всех команд /api, включая те, что появятся позже
    const future = await visitor.post('/api/something-new', {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(future.status, 403);
    // Чтение чужому сайту ничего не даёт: ответ ему не виден, а cookie с ним не отправляется
    assert.equal((await visitor.get('/api/auth/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  });

  it('отображаемое имя сохраняется как текст, невидимые символы и лишние пробелы убираются', async () => {
    const { visitor, username } = await registerUser(ctx.baseUrl);

    const res = await visitor.patch('/api/account/profile', {
      displayName: '  <b>Имя</b>\u200b  с   пробелами\n ',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.displayName, '<b>Имя</b> с пробелами', 'разметка не вырезается, а хранится как обычный текст');
    assert.equal(res.data.user.username, username, 'имя для входа не меняется');

    for (const [value, reason] of [
      ['', 'display_name_required'],
      ['   \u200b ', 'display_name_required'],
      [undefined, 'display_name_required'],
      [{ toString: 'x' }, 'display_name_required'],
      ['я'.repeat(41), 'display_name_too_long'],
    ]) {
      const bad = await visitor.patch('/api/account/profile', { displayName: value });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.data, { ok: false, error: reason, field: 'displayName' });
    }
    assert.equal((await visitor.patch('/api/account/profile', { displayName: 'я'.repeat(40) })).status, 200);

    const long = await createVisitor(ctx.baseUrl).post('/api/auth/register', {
      username: uniqueName(), password: GOOD_PASSWORD, displayName: 'x'.repeat(41),
    });
    assert.equal(long.status, 400);
    assert.equal(long.data.error, 'display_name_too_long');
  });

  it('смена пароля требует текущий пароль и закрывает входы на других устройствах', async () => {
    const { visitor, username, password } = await registerUser(ctx.baseUrl);
    const other = createVisitor(ctx.baseUrl);
    await other.post('/api/auth/login', { username, password });
    const newPassword = 'совсем другой пароль 77';
    const change = (body) => visitor.post('/api/account/password', body);

    const wrong = await change({ currentPassword: 'не тот', newPassword });
    assert.equal(wrong.status, 403);
    assert.deepEqual(wrong.data, { ok: false, error: 'wrong_password', field: 'currentPassword' });

    assert.deepEqual((await change({ newPassword })).data, { ok: false, error: 'current_password_required', field: 'currentPassword' });
    assert.deepEqual((await change({ currentPassword: password, newPassword: 'short' })).data, { ok: false, error: 'password_too_short', field: 'newPassword' });
    assert.deepEqual((await change({ currentPassword: password, newPassword: password })).data, { ok: false, error: 'password_same', field: 'newPassword' });
    assert.equal(await other.isSignedIn(), true, 'неудачные попытки ничего не меняют');

    const ok = await change({ currentPassword: password, newPassword });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.endedSessions, 1);
    assert.equal(await visitor.isSignedIn(), true, 'на этом устройстве человек остаётся в кабинете');
    assert.equal(await other.isSignedIn(), false, 'вход на другом устройстве закрыт');

    assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password })).status, 401);
    assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password: newPassword })).status, 200);
  });

  it('новый код восстановления выдаётся только по паролю, прежний перестаёт действовать', async () => {
    const { visitor, username, password, recoveryCode } = await registerUser(ctx.baseUrl);

    const denied = await visitor.post('/api/account/recovery-code', { currentPassword: 'не тот' });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, 'wrong_password');

    const issued = await visitor.post('/api/account/recovery-code', { currentPassword: password });
    assert.equal(issued.status, 200);
    assert.match(issued.data.recoveryCode, CODE_PATTERN);
    assert.notEqual(issued.data.recoveryCode, recoveryCode);

    const guest = createVisitor(ctx.baseUrl);
    const withOld = await guest.post('/api/auth/recover', { username, recoveryCode, newPassword: 'новый пароль номер 1' });
    assert.equal(withOld.status, 401);
    const withNew = await guest.post('/api/auth/recover', {
      username, recoveryCode: issued.data.recoveryCode, newPassword: 'новый пароль номер 1',
    });
    assert.equal(withNew.status, 200);
  });

  it('восстановление по коду: новый пароль, новый код, все прежние входы закрыты', async () => {
    const { visitor, username, password, recoveryCode } = await registerUser(ctx.baseUrl, { username: 'Lost_Password' });
    const newPassword = 'пароль после восстановления 5';
    const guest = createVisitor(ctx.baseUrl);
    const recover = (body) => guest.post('/api/auth/recover', body);

    const wrongCode = await recover({ username, recoveryCode: newRecoveryCode(), newPassword });
    const noSuchUser = await recover({ username: 'nobody_at_all', recoveryCode, newPassword });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.text, noSuchUser.text, 'по ответу нельзя понять, существует ли аккаунт');
    assert.deepEqual(wrongCode.data, { ok: false, error: 'invalid_recovery' });

    assert.equal((await recover({ username, newPassword })).data.error, 'recovery_required');
    assert.equal((await recover({ username, recoveryCode: 'ерунда', newPassword })).status, 401);

    // Слабый пароль отклоняется, но верный код при этом не «сгорает»
    const weak = await recover({ username, recoveryCode, newPassword: '1234' });
    assert.deepEqual(weak.data, { ok: false, error: 'password_too_short', field: 'newPassword' });
    assert.equal(await visitor.isSignedIn(), true);

    // Код вводят руками: регистр, пробелы и дефисы роли не играют
    const typed = ` ${recoveryCode.toLowerCase().replaceAll('-', ' ')} `;
    const ok = await recover({ username: 'LOST_password', recoveryCode: typed, newPassword });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.username, 'Lost_Password');
    assert.match(ok.data.recoveryCode, CODE_PATTERN);
    assert.notEqual(ok.data.recoveryCode, recoveryCode);
    assert.equal(await guest.isSignedIn(), true, 'после восстановления человек сразу в кабинете');
    assert.equal(await visitor.isSignedIn(), false, 'прежние входы закрыты');

    assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password })).status, 401);
    assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password: newPassword })).status, 200);
    const reuse = await createVisitor(ctx.baseUrl).post('/api/auth/recover', { username, recoveryCode, newPassword: 'ещё один пароль 9' });
    assert.equal(reuse.status, 401, 'использованный код второй раз не срабатывает');
  });

  it('мусор вместо данных не роняет сервер', async () => {
    const visitor = createVisitor(ctx.baseUrl);

    const broken = await visitor.post('/api/auth/login', '{ это не json');
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.data, { ok: false, error: 'invalid_json' });

    const huge = await visitor.post('/api/auth/login', { username: 'x', password: 'y'.repeat(40000) });
    assert.equal(huge.status, 413);
    assert.equal(huge.data.error, 'payload_too_large');

    for (const body of ['[]', '"строка"', '[{"username":"a"}]']) {
      const res = await visitor.post('/api/auth/login', body);
      assert.equal(res.status, 400);
    }

    const longPassword = await visitor.post('/api/auth/login', { username: 'Streamer_One', password: 'z'.repeat(5000) });
    assert.equal(longPassword.status, 401);

    for (const cookie of ['ks_session=', 'ks_session=короткий', `ks_session=${'A'.repeat(4000)}`, 'ks_session="; DROP TABLE users;--', '=;;;===']) {
      const res = await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: encodeURI(cookie) } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).authenticated, false);
    }
    assert.ok(ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0, 'таблица аккаунтов на месте');

    assert.deepEqual([...parseCookies('a=1; b="два"; a=3; =пусто; без-знака')], [['a', '1'], ['b', 'два']]);
  });
});

/* ========================================================================== */

describe('Этап 3 — защита от перебора', () => {
  let ctx;
  let clock = Date.parse('2026-01-10T12:00:00Z');
  const limits = {
    ...NO_LIMITS,
    attemptsPerClientAndName: { limit: 3, windowMs: 15 * MINUTE },
    registrationsPerClient: { limit: 2, windowMs: 60 * MINUTE },
    passwordChecksPerUser: { limit: 2, windowMs: 15 * MINUTE },
  };

  before(async () => { ctx = await startServer({ now: () => clock, authLimits: limits }); });
  after(async () => { await ctx.stop(); });

  const from = (ip) => createVisitor(ctx.baseUrl, { ip });
  let lastOctet = 10;
  const freshIp = () => `198.51.100.${(lastOctet += 1)}`;

  it('после нескольких неудач вход с этого адреса временно закрыт — даже с верным паролем', async () => {
    const { username, password } = await registerUser(ctx.baseUrl, {}, { ip: freshIp() });
    const attackerIp = freshIp();

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await from(attackerIp).post('/api/auth/login', { username, password: `догадка ${i}` })).status, 401);
    }
    const blocked = await from(attackerIp).post('/api/auth/login', { username, password });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, 'too_many_attempts');
    assert.ok(blocked.data.retryAfterSeconds > 0 && blocked.data.retryAfterSeconds <= 15 * 60);
    assert.equal(blocked.headers.get('retry-after'), String(blocked.data.retryAfterSeconds));
    assert.equal(blocked.setCookies.length, 0);

    // Владелец аккаунта со своего адреса при этом входит как обычно
    assert.equal((await from(freshIp()).post('/api/auth/login', { username, password })).status, 200);

    // Через 15 минут ограничение снимается само
    clock += 15 * MINUTE + 1000;
    assert.equal((await from(attackerIp).post('/api/auth/login', { username, password })).status, 200);
  });

  it('удачный вход обнуляет счётчик неудач', async () => {
    const ip = freshIp();
    const { username, password } = await registerUser(ctx.baseUrl, {}, { ip: freshIp() });
    const tryLogin = (pw) => from(ip).post('/api/auth/login', { username, password: pw });

    assert.equal((await tryLogin('мимо 1')).status, 401);
    assert.equal((await tryLogin('мимо 2')).status, 401);
    assert.equal((await tryLogin(password)).status, 200);
    assert.equal((await tryLogin('мимо 3')).status, 401);
    assert.equal((await tryLogin('мимо 4')).status, 401);
    assert.equal((await tryLogin(password)).status, 200, 'опечатки до и после удачного входа не складываются');
  });

  it('перебор кодов восстановления ограничен так же, как перебор паролей', async () => {
    const { username, recoveryCode } = await registerUser(ctx.baseUrl, {}, { ip: freshIp() });
    const ip = freshIp();
    const newPassword = 'пароль после перебора 3';

    for (let i = 0; i < 3; i += 1) {
      const res = await from(ip).post('/api/auth/recover', { username, recoveryCode: newRecoveryCode(), newPassword });
      assert.equal(res.status, 401);
    }
    const blocked = await from(ip).post('/api/auth/recover', { username, recoveryCode, newPassword });
    assert.equal(blocked.status, 429, 'после трёх промахов даже верный код не принимается');

    assert.equal((await from(freshIp()).post('/api/auth/recover', { username, recoveryCode, newPassword })).status, 200);
  });

  it('неверный текущий пароль в настройках аккаунта тоже считается', async () => {
    const { visitor, password } = await registerUser(ctx.baseUrl, {}, { ip: freshIp() });
    const ask = (currentPassword) => visitor.post('/api/account/recovery-code', { currentPassword });

    assert.equal((await ask('мимо 1')).status, 403);
    assert.equal((await ask('мимо 2')).status, 403);
    const blocked = await ask(password);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, 'too_many_attempts');

    clock += 15 * MINUTE + 1000;
    assert.equal((await ask(password)).status, 200);
  });

  it('массовая регистрация с одного адреса ограничена', async () => {
    const ip = freshIp();
    const register = (address) =>
      from(address).post('/api/auth/register', { username: uniqueName('mass'), password: GOOD_PASSWORD });

    assert.equal((await register(ip)).status, 201);
    assert.equal((await register(ip)).status, 201);
    const third = await register(ip);
    assert.equal(third.status, 429);
    assert.equal(third.data.error, 'too_many_attempts');
    assert.equal((await register(freshIp())).status, 201, 'посетителей с других адресов это не касается');

    clock += 60 * MINUTE + 1000;
    assert.equal((await register(ip)).status, 201);
  });

  it('счётчики попыток: адреса одной IPv6-подсети считаются одним посетителем, память ограничена', () => {
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:DB8:1:2::ffff'));
    assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
    assert.equal(clientKey('::1'), '0000:0000:0000:0000::/64');
    assert.equal(clientKey(undefined), 'unknown');

    let time = 0;
    const limiter = createRateLimiter({ now: () => time, maxKeys: 3 });
    const rule = { limit: 2, windowMs: 1000 };
    limiter.hit('a', rule);
    assert.equal(limiter.retryAfterMs('a', rule), 0);
    limiter.hit('a', rule);
    assert.equal(limiter.retryAfterMs('a', rule), 1000);
    time = 400;
    assert.equal(limiter.retryAfterMs('a', rule), 600);
    time = 1000;
    assert.equal(limiter.retryAfterMs('a', rule), 0, 'окно закрылось — счёт начинается заново');
    for (const key of ['b', 'c', 'd', 'e']) limiter.hit(key, rule);
    assert.equal(limiter.size, 3, 'число записей не растёт без предела');
  });
});

/* ========================================================================== */

describe('Этап 3 — срок жизни входа и cookie', () => {
  it('вход «забывается» через 30 дней без посещений, а при посещениях продлевается', async () => {
    let clock = Date.parse('2026-02-01T09:00:00Z');
    const ctx = await startServer({ now: () => clock });
    try {
      const { visitor, username, password } = await registerUser(ctx.baseUrl);

      const sameMinute = await visitor.get('/api/auth/session');
      assert.equal(sameMinute.setCookies.length, 0, 'cookie не переписывается при каждом запросе');

      clock += 29 * DAY;
      const visit = await visitor.get('/api/auth/session');
      assert.equal(visit.data.authenticated, true);
      assert.match(visit.setCookies[0] || '', /^ks_session=[\w-]{43}; .*Max-Age=2592000/, 'при посещении срок продлевается');

      clock += 29 * DAY;
      assert.equal(await visitor.isSignedIn(), true, 'через 58 дней после входа, но с посещением посередине');

      clock += 30 * DAY + MINUTE;
      const late = await visitor.get('/api/auth/session');
      assert.equal(late.data.authenticated, false);
      assert.match(late.setCookies[0] || '', /Max-Age=0/, 'устаревшая cookie стирается');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

      // Истёкшие сеансы, которыми никто не пользуется, убирает периодическая уборка
      await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password });
      await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password });
      clock += 31 * DAY;
      assert.equal(ctx.server.accounts.cleanup(), 2);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    } finally {
      await ctx.stop();
    }
  });

  it('у одного аккаунта хранится не больше 20 входов: самые давние закрываются', async () => {
    let clock = Date.parse('2026-03-01T09:00:00Z');
    const ctx = await startServer({ now: () => clock });
    try {
      const { visitor, username, password } = await registerUser(ctx.baseUrl);
      const devices = [visitor];
      for (let i = 0; i < 21; i += 1) {
        clock += 1000;
        const device = createVisitor(ctx.baseUrl);
        assert.equal((await device.post('/api/auth/login', { username, password })).status, 200);
        devices.push(device);
      }
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 20);
      assert.equal(await devices[0].isSignedIn(), false, 'самый давний вход закрыт');
      assert.equal(await devices[1].isSignedIn(), false);
      assert.equal(await devices[2].isSignedIn(), true);
      assert.equal(await devices.at(-1).isSignedIn(), true);
    } finally {
      await ctx.stop();
    }
  });

  it('по https cookie получает пометку Secure и имя, которое нельзя подложить с соседнего адреса', async () => {
    const ctx = await startServer();
    try {
      const { visitor, res } = await registerUser(ctx.baseUrl, {}, { https: true });
      const cookie = res.setCookies[0];
      assert.match(cookie, /^__Host-ks_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
      assert.equal(await visitor.isSignedIn(), true);

      // Тот же ключ под обычным именем по https не принимается
      const token = visitor.jar.get('__Host-ks_session');
      const planted = createVisitor(ctx.baseUrl, { https: true });
      planted.jar.set('ks_session', token);
      assert.equal(await planted.isSignedIn(), false);

      const out = await visitor.post('/api/auth/logout');
      assert.match(out.setCookies[0], /^__Host-ks_session=; .*Max-Age=0.*; Secure$/);

      // Заголовку «это https» от постороннего сервер не верит
      const outsider = await startServer({ trustProxy: false });
      try {
        const spoofed = await registerUser(outsider.baseUrl, {}, { https: true });
        assert.match(spoofed.res.setCookies[0], /^ks_session=/);
        assert.doesNotMatch(spoofed.res.setCookies[0], /Secure/);
      } finally {
        await outsider.stop();
      }
    } finally {
      await ctx.stop();
    }
  });

  it('режим предпросмотра: cookie пригодна для показа сайта внутри чужой страницы', async () => {
    const ctx = await startServer({ sessionCookieMode: 'embedded' });
    try {
      const { visitor, res } = await registerUser(ctx.baseUrl);
      assert.match(
        res.setCookies[0],
        /^__Host-ks_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=None; Max-Age=2592000; Secure; Partitioned$/
      );
      assert.equal(await visitor.isSignedIn(), true);
      const out = await visitor.post('/api/auth/logout');
      assert.match(out.setCookies[0], /^__Host-ks_session=; .*SameSite=None; Max-Age=0.*Secure; Partitioned$/);
      assert.equal(await visitor.isSignedIn(), false);
    } finally {
      await ctx.stop();
    }
  });
});

/* ========================================================================== */

describe('Этап 3 — настройки, запуск и помощник владельца', () => {
  it('закрытая регистрация: новых аккаунтов создать нельзя, а вход работает', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-auth-closed-'));
    const open = await startServer({ tmpDir });
    const { username, password } = await registerUser(open.baseUrl);
    await open.stop({ keepFiles: true });

    const closed = await startServer({ tmpDir, registration: 'closed' });
    try {
      const visitor = createVisitor(closed.baseUrl);
      assert.equal((await visitor.get('/api/auth/session')).data.registrationOpen, false);

      const res = await visitor.post('/api/auth/register', { username: 'Late_Comer', password: GOOD_PASSWORD });
      assert.equal(res.status, 403);
      assert.deepEqual(res.data, { ok: false, error: 'registration_closed' });
      assert.equal(closed.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);

      assert.equal((await visitor.post('/api/auth/login', { username, password })).status, 200);
    } finally {
      await closed.stop();
    }
  });

  it('опечатка в настройке останавливает запуск, а не включает значение по умолчанию', () => {
    const base = { host: '127.0.0.1', port: 0, dbPath: ':memory:', uploadsDir: os.tmpdir() };
    assert.throws(() => createOverlayServer({ ...base, registration: 'close' }), /REGISTRATION/);
    assert.throws(() => createOverlayServer({ ...base, sessionCookieMode: 'iframe' }), /SESSION_COOKIE_MODE/);
  });

  it('настоящий запуск: настройки читаются из файла .env, по сигналу сервер останавливается сам', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-auth-env-'));
    const envFile = path.join(tmpDir, 'settings.env');
    fs.writeFileSync(envFile, [
      'HOST=127.0.0.1',
      'PORT=0',
      `DB_PATH=${path.join(tmpDir, 'from-env.db')}`,
      `UPLOADS_DIR=${path.join(tmpDir, 'uploads')}`,
      'REGISTRATION=closed',
      'SESSION_COOKIE_MODE=embedded',
      '',
    ].join('\n'));

    const child = spawn(process.execPath, [...NODE_FLAGS, 'src/server/index.js'], {
      cwd: PROJECT_DIR,
      // Режим cookie задан и при запуске, и в файле (по-разному): побеждает заданное при запуске
      env: childEnv({ ENV_FILE: envFile, SESSION_COOKIE_MODE: 'standard' }),
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    try {
      const deadline = Date.now() + 8000;
      let port = null;
      while (!port && Date.now() < deadline) {
        port = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1] || null;
        if (!port) await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(port, `сервер не сообщил адрес. Вывод:\n${output}`);
      assert.match(output, /Регистрация новых аккаунтов закрыта/);

      const session = await (await fetch(`http://127.0.0.1:${port}/api/auth/session`)).json();
      assert.equal(session.registrationOpen, false, 'настройка из файла должна подействовать');
      assert.ok(fs.existsSync(path.join(tmpDir, 'from-env.db')), 'база создана там, где указано в файле');
      assert.doesNotMatch(output, /Режим предпросмотра/, 'файл не должен перекрывать то, что задано при запуске');

      child.kill('SIGTERM');
      assert.equal(await exited, 0, 'сервер должен остановиться без ошибки');
    } finally {
      child.kill('SIGKILL');
      await exited;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('с неверной настройкой сервер не запускается и объясняет почему', async () => {
    const result = await runNode(['src/server/index.js'], {
      HOST: '127.0.0.1', PORT: '0', DB_PATH: ':memory:', UPLOADS_DIR: os.tmpdir(), REGISTRATION: 'opne',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Сервер не запущен: Некорректное значение REGISTRATION/);
    assert.doesNotMatch(result.stderr, /\s+at .*\.js:\d+/, 'человеку нужна причина, а не внутренности программы');
  });

  it('помощник владельца выдаёт новый код, по которому человек сам возвращает доступ', async () => {
    const ctx = await startServer();
    try {
      const { username, recoveryCode: lostCode } = await registerUser(ctx.baseUrl, {
        username: 'Forgot_All', displayName: 'Забыл Всё',
      });
      const env = { DB_PATH: path.join(ctx.tmpDir, 'auth-test.db') };

      const list = await runNode(['src/tools/account.js', 'list'], env);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /Forgot_All \(Забыл Всё\) — с \d{4}-\d{2}-\d{2}, активных входов: 1/);

      const issued = await runNode(['src/tools/account.js', 'new-code', 'forgot_ALL'], env);
      assert.equal(issued.code, 0, issued.stderr);
      const code = issued.stdout.split('\n').find((line) => CODE_PATTERN.test(line.trim()))?.trim();
      assert.ok(code, `в выводе нет кода:\n${issued.stdout}`);
      assert.notEqual(code, lostCode);

      const visitor = createVisitor(ctx.baseUrl);
      const withLost = await visitor.post('/api/auth/recover', { username, recoveryCode: lostCode, newPassword: 'новый пароль от владельца 1' });
      assert.equal(withLost.status, 401, 'потерянный код больше не действует');
      const withIssued = await visitor.post('/api/auth/recover', { username, recoveryCode: code, newPassword: 'новый пароль от владельца 1' });
      assert.equal(withIssued.status, 200);

      const missing = await runNode(['src/tools/account.js', 'new-code', 'no_such_user'], env);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /не найден/);
      assert.equal((await runNode(['src/tools/account.js', 'удалить-всё'], env)).code, 1);
    } finally {
      await ctx.stop();
    }
  });

  it('рабочие параметры защиты пароля: вход работает, запись в базе — в усиленном формате', async () => {
    const ctx = await startServer({ passwordCost: undefined });
    try {
      const { username, password } = await registerUser(ctx.baseUrl);
      const hash = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;
      assert.match(hash, /^scrypt\$32768\$8\$3\$/);
      assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password })).status, 200);
      assert.equal((await createVisitor(ctx.baseUrl).post('/api/auth/login', { username, password: `${password}!` })).status, 401);
    } finally {
      await ctx.stop();
    }
  });

  it('если параметры защиты усилили, запись пользователя обновляется при следующем входе', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-auth-rehash-'));
    const before = await startServer({ tmpDir });
    const { username, password } = await registerUser(before.baseUrl);
    await before.stop({ keepFiles: true });

    const afterUpgrade = await startServer({ tmpDir, passwordCost: { N: 4096, r: 8, p: 1 } });
    try {
      const read = () => afterUpgrade.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;
      assert.match(read(), /^scrypt\$1024\$/);
      assert.equal((await createVisitor(afterUpgrade.baseUrl).post('/api/auth/login', { username, password: 'мимо' })).status, 401);
      assert.match(read(), /^scrypt\$1024\$/, 'неудачный вход ничего не переписывает');
      assert.equal((await createVisitor(afterUpgrade.baseUrl).post('/api/auth/login', { username, password })).status, 200);
      assert.match(read(), /^scrypt\$4096\$/);
      assert.equal((await createVisitor(afterUpgrade.baseUrl).post('/api/auth/login', { username, password })).status, 200);
    } finally {
      await afterUpgrade.stop();
    }
  });

  it('проверка паролей не может занять весь сервер: лишние запросы получают отказ, а не копятся', async () => {
    const hasher = createPasswordHasher({ cost: FAST, maxConcurrent: 1, maxQueue: 1 });
    const results = await Promise.allSettled([hasher.hash('первый'), hasher.hash('второй'), hasher.hash('третий')]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.equal(results[2].reason.code, 'busy');
    assert.match(await hasher.hash('после очереди'), /^scrypt\$1024\$/, 'после разгрузки всё работает дальше');

    // Перегрузка в момент первой «холостой» проверки (вход с несуществующим именем) не ломает её навсегда
    const strict = createPasswordHasher({ cost: FAST, maxConcurrent: 1, maxQueue: 0 });
    const occupying = strict.hash('занимает единственное место');
    await assert.rejects(strict.verifyDecoy('пароль'), { code: 'busy' });
    await occupying;
    assert.equal(await strict.verifyDecoy('пароль'), false, 'после разгрузки холостая проверка снова работает');

    const stored = await hasher.hash('Пароль с ё и й');
    assert.equal(await hasher.verify('Пароль с ё и й', stored), true);
    assert.equal(await hasher.verify('Пароль с е и и', stored), false);
    // «й» одним знаком и «и» с отдельным значком краткости — для человека один и тот же пароль
    assert.equal(await hasher.verify('Пароль с ё и и\u0306', stored), true);
    for (const broken of ['', 'scrypt$', 'scrypt$1$8$1$AAAA$AAAA', 'scrypt$1024$8$1$$', 'bcrypt$1024$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', null]) {
      assert.equal(await hasher.verify('что угодно', broken), false, 'испорченная запись — это отказ, а не сбой');
    }
  });

  it('правила для паролей и кодов восстановления', () => {
    assert.equal(checkNewPassword('correct horse battery'), null);
    assert.equal(checkNewPassword('пароль8!'), null, 'восемь знаков — уже достаточно');
    assert.equal(checkNewPassword('1234567'), 'password_too_short');
    assert.equal(checkNewPassword('87654321'), 'password_too_common');
    assert.equal(checkNewPassword('abcdefgh'), 'password_too_common');
    assert.equal(checkNewPassword('ИЦУКЕНГШ'.toLowerCase().replace('и', 'й')), 'password_too_common');
    assert.equal(checkNewPassword('Krafen2026', { username: 'krafen' }), 'password_like_username');
    assert.equal(checkNewPassword('krafen-и-ещё-слова', { username: 'krafen' }), null);

    const code = newRecoveryCode();
    assert.match(code, CODE_PATTERN);
    assert.equal(normalizeRecoveryCode(code), code.replaceAll('-', ''));
    assert.equal(normalizeRecoveryCode(` ${code.toLowerCase().replaceAll('-', '  ')} `), code.replaceAll('-', ''));
    for (const bad of ['', 'ABCDE', `${code}X`, code.replace(/.$/, '0'), code.replace(/.$/, 'O'), null, 12345, 'я'.repeat(20)]) {
      assert.equal(normalizeRecoveryCode(bad), '', `${JSON.stringify(bad)} — не код`);
    }
    assert.equal(new Set(Array.from({ length: 200 }, newRecoveryCode)).size, 200, 'коды не повторяются');
  });
});

/* ========================================================================== */

describe('Этап 3 — страницы входа', () => {
  const publicDir = path.join(PROJECT_DIR, 'public');
  const pages = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

  function listScripts(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listScripts(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  it('формы отправляются только методом POST: пароль не может оказаться в адресной строке', () => {
    let forms = 0;
    for (const page of pages) {
      for (const match of read(page).matchAll(/<form\b[^>]*>/g)) {
        forms += 1;
        assert.match(match[0], /\smethod="post"/, `${page}: у формы не указан метод POST`);
        assert.doesNotMatch(match[0], /\saction=/, `${page}: форма не должна уходить на другой адрес`);
      }
    }
    assert.ok(forms >= 6, 'ожидались формы входа, регистрации, восстановления и настроек аккаунта');
  });

  it('поля паролей размечены для менеджеров паролей и не ограничивают длину слишком рано', () => {
    let inputs = 0;
    for (const page of pages) {
      for (const match of read(page).matchAll(/<input\b[^>]*type="password"[^>]*>/gs)) {
        inputs += 1;
        assert.match(match[0], /autocomplete="(current-password|new-password)"/, `${page}: поле пароля без подсказки для менеджера паролей`);
        assert.match(match[0], /maxlength="200"/, `${page}: длина пароля должна совпадать с правилом сервера`);
      }
    }
    assert.ok(inputs >= 6);
    assert.match(read('login.html'), /id="login-username"[^>]*autocomplete="username"/s);
    assert.match(read('register.html'), /id="register-password"[^>]*autocomplete="new-password"/s);
  });

  it('текст от пользователя попадает на страницу только как текст, а не как разметка', () => {
    const scripts = listScripts(path.join(publicDir, 'js'));
    assert.ok(scripts.length >= 10);
    for (const file of scripts) {
      const code = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file);
      assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/, `${name}: сборка разметки из строк`);
      assert.doesNotMatch(code, /\beval\(|new Function\(/, `${name}: выполнение текста как кода`);
    }
  });

  it('ключ входа не хранится там, где его может прочитать скрипт страницы', () => {
    for (const file of listScripts(path.join(publicDir, 'js'))) {
      const code = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file).split(path.sep).join('/');
      assert.doesNotMatch(code, /document\.cookie/, `${name}: скрипт не должен работать с cookie`);
      // В памяти браузера лежит одна настройка — включена ли атмосфера. Больше ничего
      if (name !== 'js/core/atmosphere.js') {
        assert.doesNotMatch(code, /(?:local|session)Storage/, `${name}: скрипт не должен хранить данные в браузере`);
      }
    }
  });

  it('каждый отказ сервера имеет понятный текст на странице', () => {
    const messages = read('js/core/session.js');
    const serverCodes = new Set();
    for (const file of ['accounts.js', 'http.js']) {
      const code = fs.readFileSync(path.join(PROJECT_DIR, 'src/server/auth', file), 'utf8');
      for (const match of code.matchAll(/new AuthError\('([a-z_]+)'/g)) serverCodes.add(match[1]);
      for (const match of code.matchAll(/error: '([a-z_]+)'/g)) serverCodes.add(match[1]);
    }
    const passwords = fs.readFileSync(path.join(PROJECT_DIR, 'src/server/auth/passwords.js'), 'utf8');
    for (const match of passwords.matchAll(/return '(password_[a-z_]+)'/g)) serverCodes.add(match[1]);

    assert.ok(serverCodes.size >= 20, `найдено кодов: ${serverCodes.size}`);
    for (const code of serverCodes) {
      if (code === 'json_required') continue; // страница всегда шлёт JSON; на этот случай есть общий текст
      assert.ok(
        new RegExp(`\\b${code}\\b`).test(messages),
        `для отказа «${code}» на странице нет текста`
      );
    }
  });
});
