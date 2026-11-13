import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultsOf, isShown, readSettings } from '../public/js/scene/schema.js';
import { SOURCE_LIST, sourceType } from '../public/js/scene/sources/index.js';
import { createAccounts } from '../src/server/auth/accounts.js';
import { newLinkToken, newOverlayToken, OVERLAY_TOKEN_LENGTH } from '../src/server/auth/tokens.js';
import { openDatabase } from '../src/server/db/database.js';
import { DEFAULT_WORKSPACE_LIMITS } from '../src/server/workspaces/workspaces.js';
import {
  FAST, GOOD_PASSWORD, LATEST_MIGRATION, MINUTE, PLATFORM_STAGE, PROJECT_DIR, SCHEMA_VERSION,
  addModerator, addSource, createVisitor, createWorkspace, newStage, openSocket, patchSource, png,
  refusal, registerUser, startServer, uploadFile,
} from './helpers.js';

/* Этап 6: оверлей для OBS. Проверяется настоящий сервер с настоящей базой и настоящей
   папкой файлов.

   Главное здесь — ссылка. По ней площадку открывает тот, кто в аккаунт не входит вовсе
   (OBS), поэтому ссылка заменяет и вход, и права: увидеть по ней можно только то, что
   сейчас в эфире, и никогда — саму ссылку, имена людей и названия источников. Ссылку
   видят и меняют только владельцы; новая ссылка убивает старую сразу — и в сцене,
   и в файлах, и в живом канале. */

const HOUR = 60 * MINUTE;
const OVERLAY_LINK = /^[0-9a-hjkmnp-tv-z]{32}$/;
const PUBLIC_ID = /^[0-9a-hjkmnp-tv-z]{12}$/;

/* ---------- Что нужно для проверок ---------- */

const publicDir = path.join(PROJECT_DIR, 'public');
const readPublic = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');
const readServer = (name) => fs.readFileSync(path.join(PROJECT_DIR, 'src/server', name), 'utf8');
const readPage = (name) => fs.readFileSync(path.join(PROJECT_DIR, name), 'utf8'); // README и прочее
const pageText = (name) => readPublic(name).replace(/<!--[\s\S]*?-->/g, ''); // разметка без пояснений

// Страница оверлея одна на всех: в ней нет ни сцены, ни ссылки — сцену присылает сервер
const OVERLAY_PAGE = readPublic('overlay.html');

// Ссылка площадки глазами владельца: { token, createdAt }
async function overlayOf(visitor, workspaceId) {
  const res = await visitor.get(`/api/workspaces/${workspaceId}`);
  assert.equal(res.status, 200, `площадка не открылась: ${res.text}`);
  return res.data.overlay;
}

// Прочитать сцену так, как это делает OBS: без cookie, без входа — только по ссылке
const viaLink = (ctx, token) => createVisitor(ctx.baseUrl).get(`/api/overlay/${token}`);

// Прямой запрос мимо «посетителя»: нужны заголовки, которых «посетитель» не ставит
function rawRequest(ctx, method, url, { headers = {}, body } = {}) {
  const target = new URL(url, ctx.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Поля, которые сейчас ни на что не влияют: вместо них в эфир уходит значение по умолчанию
const switchedOff = (fields, settings) => Object.entries(fields).filter(([, field]) => !isShown(field, settings));

// Заметный текст и цвета, которых в эфире быть не должно
const MARKS = /ТАЙН|СКРЫТ|ИМЯ-|#00ff00|#00ffff|#ff00ff|<b>|<style>/;

function findDeep(value, pattern, trail = '') {
  if (typeof value === 'string') return pattern.test(value) ? [trail || '(строка)'] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findDeep(item, pattern, `${trail}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findDeep(item, pattern, trail ? `${trail}.${key}` : key));
  }
  return [];
}

// Все адреса, начинающиеся с /overlay, отвечают страницей оверлея — такой же, как на ссылку
const opensPage = (res) => res.headers['content-type']?.startsWith('text/html') && res.bytes.toString('utf8') === OVERLAY_PAGE;

/* ---------- Живой канал оверлея ---------- */

const overlayChannel = (ctx, key) =>
  `${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=overlay${key === undefined ? '' : `&key=${encodeURIComponent(key)}`}`;

// Подключиться к каналу оверлея: приветствие сервера уже прочитано
async function joinOverlay(ctx, key) {
  const socket = await openSocket(overlayChannel(ctx, key));
  const hello = await socket.next();
  assert.equal(hello.type, 'hello', 'оверлею не пришло приветствие');
  return { ...socket, hello };
}

// Отказ: сообщение denied и закрытие 4403 — одинаковые для отменённой, выдуманной и пустой ссылки
async function denied(ctx, key) {
  const socket = await openSocket(overlayChannel(ctx, key));
  assert.deepEqual(await socket.next(), { type: 'denied' });
  assert.equal((await socket.closed).code, 4403);
}

// Что с каналом: открыт или закрыт сервером (и с каким кодом)
const channelState = (socket) =>
  Promise.race([
    socket.closed.then(({ code }) => ({ closed: code })),
    new Promise((resolve) => setTimeout(() => resolve({ open: true }), 250)),
  ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ========================================================================== */

describe('Этап 6 — ссылка оверлея: у площадки есть ссылка, и выпускает её только владелец', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { await ctx.stop(); });

  it('ссылка появляется вместе с площадкой: 32 знака, из своего алфавита, у каждой своя', async () => {
    const owner = await registerUser(ctx.baseUrl, { displayName: 'Владелец' });
    const workspace = await createWorkspace(owner.visitor, 'Ночной эфир');
    const overlay = await overlayOf(owner.visitor, workspace.id);

    assert.deepEqual(Object.keys(overlay).sort(), ['createdAt', 'token']);
    assert.match(overlay.token, OVERLAY_LINK, 'ссылка — 32 знака своего алфавита');
    // Длина другая, чем у приглашения (26 знаков): одну ссылку нельзя принять за другую
    assert.equal(OVERLAY_TOKEN_LENGTH, 32);
    assert.match(newOverlayToken(), OVERLAY_LINK);
    // Выдана вместе с площадкой, а не позже
    assert.equal(overlay.createdAt, workspace.createdAt);

    // У каждой площадки своя ссылка; повторно та же не выдаётся
    const second = await createWorkspace(owner.visitor, 'Утренний эфир');
    const other = await overlayOf(owner.visitor, second.id);
    assert.notEqual(other.token, overlay.token);
    assert.deepEqual(await overlayOf(owner.visitor, workspace.id), overlay);

    // Список площадок ссылок не показывает: это секрет страницы площадки
    const list = await owner.visitor.get('/api/workspaces');
    assert.equal(list.text.includes(overlay.token), false);
    assert.equal(list.text.includes('"overlay"'), false);
  });

  it('ссылку видит только владелец: модератор, посторонний и гость её не получают', async () => {
    const stage = await newStage(ctx, { name: 'Площадка со ссылкой' });
    const moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Модератор' });
    const stranger = await registerUser(ctx.baseUrl, { displayName: 'Посторонний' });
    const guest = createVisitor(ctx.baseUrl);
    const overlay = await overlayOf(stage.visitor, stage.id);

    // Модератор видит площадку и команду — но не ссылку: ни поля, ни самого секрета
    const seen = await moderator.visitor.get(`/api/workspaces/${stage.id}`);
    assert.equal(seen.status, 200);
    assert.equal('overlay' in seen.data, false);
    assert.equal(seen.text.includes(overlay.token), false);

    // Посторонний и гость о площадке не узнают ничего — как и о несуществующей
    refusal(await stranger.visitor.get(`/api/workspaces/${stage.id}`), 404, 'workspace_not_found');
    refusal(await guest.get(`/api/workspaces/${stage.id}`), 401, 'unauthorized');

    // И новой ссылки не выпустят
    for (const [visitor, status, error] of [[moderator.visitor, 403, 'owner_only'], [stranger.visitor, 404, 'workspace_not_found'], [guest, 401, 'unauthorized']]) {
      refusal(await visitor.post(`/api/workspaces/${stage.id}/overlay/renew`), status, error);
    }
    // От их попыток ссылка не изменилась
    assert.deepEqual(await overlayOf(stage.visitor, stage.id), overlay);
  });

  it('новую ссылку нельзя выпустить чужой страницей, формой или без JSON', async () => {
    const stage = await newStage(ctx, { name: 'Чужая страница' });
    const before = await overlayOf(stage.visitor, stage.id);
    const url = `/api/workspaces/${stage.id}/overlay/renew`;

    /* Запрос с чужого сайта не проходит: иначе посторонний сайт тихо отключил бы
       стримеру оверлей, пока тот смотрит на этот сайт. */
    for (const headers of [
      { Origin: 'https://evil.example' },
      { Origin: 'http://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ]) {
      refusal(await stage.visitor.post(url, {}, { headers }), 403, 'cross_site_request');
    }

    // Тело — только JSON: обычная форма так не умеет
    const cookie = [...stage.visitor.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const form = await rawRequest(ctx, 'POST', url, {
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    assert.equal(form.status, 415);
    assert.deepEqual(JSON.parse(form.bytes.toString('utf8')), { ok: false, error: 'json_required' });
    // Чтением ссылку не выпустить: адрес принимает только POST
    refusal(await stage.visitor.get(url), 404, 'not_found');
    refusal(await stage.visitor.get(`/api/workspaces/${stage.id}/overlay`), 404, 'not_found');
    assert.equal((await overlayOf(stage.visitor, stage.id)).token, before.token, 'ничего не выпущено');
  });

  it('новая ссылка сразу отменяет старую; владелец узнаёт об этом сигналом, модератор — нет', async () => {
    const stage = await newStage(ctx, { name: 'Новая ссылка' });
    const moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Модератор' });
    const old = await overlayOf(stage.visitor, stage.id);

    const joinTeam = async (visitor) => {
      const pass = await visitor.post(`/api/workspaces/${stage.id}/live`);
      assert.equal(pass.status, 200, `пропуск не выдан: ${pass.text}`);
      const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${stage.id}&ticket=${pass.data.ticket}`);
      assert.equal((await socket.next()).type, 'hello');
      return socket;
    };
    const ownerSocket = await joinTeam(stage.visitor);
    const moderatorSocket = await joinTeam(moderator.visitor);
    try {
      const renewed = await stage.visitor.post(`/api/workspaces/${stage.id}/overlay/renew`);
      assert.equal(renewed.status, 200, `ссылка не выпущена: ${renewed.text}`);
      const fresh = renewed.data.overlay;
      assert.equal(renewed.data.ok, true);
      assert.match(fresh.token, OVERLAY_LINK);
      assert.notEqual(fresh.token, old.token);
      // Время выпуска — «сейчас», а не время создания площадки
      assert.ok(Date.parse(fresh.createdAt) > Date.parse(old.createdAt));
      assert.deepEqual(await overlayOf(stage.visitor, stage.id), fresh);

      // Сигнал о ссылке получает владелец; модератору он не нужен и не уходит
      assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'overlay', mine: true });
      await sleep(150);
      assert.deepEqual(moderatorSocket.inbox, []);

      // Старая ссылка перестала работать, новая работает
      refusal(await viaLink(ctx, old.token), 404, 'overlay_not_found');
      assert.equal((await viaLink(ctx, fresh.token)).status, 200);
      // У модератора новой ссылки тоже нет
      assert.equal('overlay' in (await moderator.visitor.get(`/api/workspaces/${stage.id}`)).data, false);
    } finally {
      await ownerSocket.close();
      await moderatorSocket.close();
    }
  });

  it('выпускать ссылки без конца нельзя: тридцать в час, дальше — отказ с указанием срока', async () => {
    // Отдельный сервер со своим маленьким пределом: проверка не ждёт часа
    const small = await startServer({ workspaceLimits: { overlayRenewalsPerUser: { limit: 3, windowMs: HOUR } } });
    try {
      const stage = await newStage(small, { name: 'Три выпуска' });
      const links = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await stage.visitor.post(`/api/workspaces/${stage.id}/overlay/renew`);
        assert.equal(res.status, 200, `выпуск ${i + 1}: ${res.text}`);
        links.push(res.data.overlay.token);
      }
      assert.equal(new Set(links).size, 3, 'каждая новая ссылка отличается от прежних');

      const blocked = await stage.visitor.post(`/api/workspaces/${stage.id}/overlay/renew`);
      refusal(blocked, 429, 'too_many_requests', { retryAfterSeconds: 3600 });
      assert.equal(blocked.headers.get('retry-after'), '3600');
      // Последняя выпущенная ссылка работает: предел — только на выпуск новых
      assert.equal((await viaLink(small, links[2])).status, 200);
      assert.equal((await overlayOf(stage.visitor, stage.id)).token, links[2]);

      // Счёт у каждого свой: другой владелец выпускает спокойно
      const other = await newStage(small, { name: 'Свой счёт' });
      assert.equal((await other.visitor.post(`/api/workspaces/${other.id}/overlay/renew`)).status, 200);
      // Предел по умолчанию — тридцать в час
      assert.deepEqual(DEFAULT_WORKSPACE_LIMITS.overlayRenewalsPerUser, { limit: 30, windowMs: HOUR });
    } finally {
      await small.stop();
    }
  });

  it('ссылка удалённой площадки перестаёт работать; соседние площадки не задеты', async () => {
    const doomed = await newStage(ctx, { name: 'Площадка под снос' });
    const neighbour = await newStage(ctx, { displayName: 'Сосед', name: 'Соседняя площадка' });
    const doomedLink = await overlayOf(doomed.visitor, doomed.id);
    const neighbourLink = await overlayOf(neighbour.visitor, neighbour.id);
    await addSource(doomed.visitor, doomed.id, 'text', { settings: { text: 'Уйдёт вместе с площадкой' } });
    await addSource(neighbour.visitor, neighbour.id, 'text', { settings: { text: 'Останется' } });

    const removed = await doomed.visitor.post(`/api/workspaces/${doomed.id}/delete`, { confirmName: 'Площадка под снос' });
    assert.equal(removed.status, 200);

    refusal(await viaLink(ctx, doomedLink.token), 404, 'overlay_not_found');
    refusal(await doomed.visitor.post(`/api/workspaces/${doomed.id}/overlay/renew`), 404, 'workspace_not_found');

    const alive = await viaLink(ctx, neighbourLink.token);
    assert.equal(alive.status, 200);
    assert.deepEqual(alive.data.sources.map((source) => source.settings.text), ['Останется']);
  });
});

/* ========================================================================== */

describe('Этап 6 — что видно по ссылке: только сцена и только то, что в эфире', () => {
  let ctx;
  let stage;
  let moderator;
  let overlay;
  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx, { displayName: 'Владелец Тестов', name: 'Закулисье' });
    moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Модератор' });
    overlay = await overlayOf(stage.visitor, stage.id);
  });
  after(async () => { await ctx.stop(); });

  it('в ответе — размеры сцены, источники и часы сервера; ни площадки, ни людей, ни ссылки', async () => {
    const scene = await viaLink(ctx, overlay.token);
    assert.equal(scene.status, 200);
    assert.deepEqual(Object.keys(scene.data).sort(), ['ok', 'scene', 'serverTime', 'sources']);
    assert.equal(scene.data.ok, true);
    assert.deepEqual(Object.keys(scene.data.scene).sort(), ['height', 'version', 'width']);
    assert.deepEqual([scene.data.scene.width, scene.data.scene.height], [1920, 1080]);
    assert.ok(Math.abs(Date.now() - scene.data.serverTime) < MINUTE, 'часы сервера — настоящие');

    // Ни названия площадки, ни её номера, ни людей, ни файлов, ни пределов
    for (const forbidden of ['workspace', 'media', 'usage', 'limits', 'members']) {
      assert.equal(forbidden in scene.data, false, `в ответе не должно быть «${forbidden}»`);
    }
    for (const secret of ['Закулисье', stage.id, 'Владелец Тестов', 'Модератор', overlay.token]) {
      assert.equal(scene.text.includes(secret), false, `по ссылке ушло лишнее: ${secret}`);
    }
  });

  it('скрытые источники в эфир не уходят, а видимые идут снизу вверх без служебных полей редактора', async () => {
    const below = await addSource(stage.visitor, stage.id, 'shape', { visible: false, settings: { color: '#123456' } });
    const middle = await addSource(stage.visitor, stage.id, 'text', { name: 'ИМЯ-ИСТОЧНИКА', settings: { text: 'Первая надпись' } });
    const above = await addSource(stage.visitor, stage.id, 'timer', { settings: { mode: 'clock' } });
    const hidden = await addSource(stage.visitor, stage.id, 'text', { visible: false, settings: { text: 'СКРЫТАЯ НАДПИСЬ' } });

    const scene = await viaLink(ctx, overlay.token);
    assert.deepEqual(scene.data.sources.map((source) => source.id), [middle.id, above.id]);
    for (const gone of [below.id, hidden.id, 'СКРЫТАЯ НАДПИСЬ', 'ИМЯ-ИСТОЧНИКА']) {
      assert.equal(scene.text.includes(gone), false, `в эфир ушло скрытое: ${gone}`);
    }

    // Порядок — как на сцене (снизу вверх); название и защита от сдвига остаются в редакторе
    for (const source of scene.data.sources) {
      assert.equal('name' in source, false, 'название источника остаётся в редакторе');
      assert.equal('locked' in source, false, 'защита от сдвига — тоже');
      assert.equal('layer' in source, false);
      assert.equal(source.visible, true, 'скрытые сюда не попадают вовсе');
      assert.match(source.id, PUBLIC_ID);
    }
    assert.deepEqual(scene.data.sources[0].settings, readSettings(sourceType('text').fields, { text: 'Первая надпись' }));
    assert.equal(scene.data.sources[1].settings.mode, 'clock');
    assert.deepEqual(scene.data.sources[1].state, sourceType('timer').readState(scene.data.sources[1].settings, {}));

    // Скрыть источник — он тут же пропадает из эфира; показать — возвращается
    assert.equal((await patchSource(stage.visitor, stage.id, middle.id, { visible: false })).status, 200);
    assert.deepEqual((await viaLink(ctx, overlay.token)).data.sources.map((source) => source.id), [above.id]);
    assert.equal((await patchSource(moderator.visitor, stage.id, middle.id, { visible: true })).status, 200);
    assert.deepEqual((await viaLink(ctx, overlay.token)).data.sources.map((source) => source.id), [middle.id, above.id]);

    // Удалить — тоже
    await stage.visitor.post(`${stage.api}/sources/${above.id}/delete`);
    assert.deepEqual((await viaLink(ctx, overlay.token)).data.sources.map((source) => source.id), [middle.id]);
  });

  it('настройки, которые сейчас ни на что не влияют, в эфир не уходят — вместо них значения по умолчанию', async () => {
    /* У каждого типа источника есть поля с условием «показывать, когда…». Всё, что скрыто
       в панели свойств, в эфире заменяется значением по умолчанию: иначе по ссылке можно
       было бы прочитать заготовки, которых на сцене не видно (текст будущей бегущей строки
       у виджета-шкалы, код своего блока, цвет обводки без обводки). */
    const cases = [
      ['text', {
        text: 'Надпись', strokeWidth: 0, strokeColor: '#00ff00',
        shadow: false, shadowColor: '#00ffff', shadowBlur: 60, shadowOffset: 30,
        plate: false, plateColor: '#ff00ff', plateOpacity: 100, plateRadius: 77, platePadding: 90,
      }],
      ['shape', { fill: 'none', color: '#00ff00', fillOpacity: 100, color2: '#00ff00', angle: 10, borderWidth: 0, borderColor: '#00ff00', borderOpacity: 100 }],
      ['timer', { mode: 'clock', duration: 77, endText: 'ТАЙНЫЙ-КОНЕЦ', showSeconds: true, utcOffset: 0 }],
      ['timer', { mode: 'countdown', duration: 90, endText: 'Готово', showSeconds: false, utcOffset: 120 }],
      ['widget', {
        kind: 'goal', goalTitle: 'Цель', goalCurrent: 5, goalTarget: 10, goalUnit: 'шт',
        tickerText: 'ТАЙНАЯ-СТРОКА', cardBadge: 'ТАЙНАЯ-МЕТКА', cardTitle: 'ТАЙНАЯ-КАРТОЧКА',
        cardText: 'ТАЙНАЯ-ПОДПИСЬ', accent: '#a31313', fontSize: 30,
        // код своего блока — заготовка на потом: на сцене он не виден, по ссылке его не прочитать
        html: '<b>ТАЙНЫЙ-БЛОК</b>',
      }],
      ['widget', { kind: 'ticker', tickerText: 'В эфире строка', goalTitle: 'ТАЙНАЯ-ЦЕЛЬ', html: '<b>ТАЙНЫЙ-БЛОК</b>' }],
      ['widget', { kind: 'html', html: '<p>Свой блок</p>', goalTitle: 'ТАЙНАЯ-ЦЕЛЬ', tickerText: 'ТАЙНАЯ-СТРОКА' }],
      ['image', { borderWidth: 0, borderColor: '#00ff00' }],
      ['video', { muted: true, volume: 5 }],
    ];

    const made = [];
    for (const [type, settings] of cases) {
      const source = await addSource(stage.visitor, stage.id, type, { settings });
      made.push(source.id);
      const sent = (await viaLink(ctx, overlay.token)).data.sources.find((item) => item.id === source.id);
      const fields = sourceType(type).fields;
      const kept = readSettings(fields, settings);

      // Всё, что на сцене видно, приходит без изменений
      for (const [key, field] of Object.entries(fields)) {
        if (isShown(field, kept)) assert.deepEqual(sent.settings[key], kept[key], `${type}.${key} потерялось по дороге`);
      }
      // А скрытое — значения по умолчанию; в наборе есть случай на каждый тип с условиями
      const off = switchedOff(fields, kept);
      if (Object.values(fields).some((field) => typeof field.when === 'function')) {
        assert.ok(off.length > 0, `${type}: в наборе нет ни одного скрытого поля — проверять нечего`);
      }
      for (const [key] of off) assert.deepEqual(sent.settings[key], fields[key].default, `${type}.${key} ушло в эфир`);
      // Набор полей тот же, что у типа, и ничего заметного из заготовок
      assert.deepEqual(Object.keys(sent.settings).sort(), Object.keys(fields).sort());
      // Заметный текст и цвета уходят только с полями, которые сейчас на сцене:
      // значение по умолчанию — не заготовка и «заметным» быть не перестаёт
      for (const where of findDeep(sent.settings, MARKS)) {
        const key = where.split('.')[0];
        assert.ok(isShown(fields[key], kept) || sent.settings[key] === fields[key].default, `${type}: по ссылке ушла заготовка из скрытого поля ${where}`);
      }
      await stage.visitor.post(`${stage.api}/sources/${source.id}/delete`);
    }
    // Проверочных источников в эфире не осталось
    const left = (await viaLink(ctx, overlay.token)).data.sources.map((source) => source.id);
    for (const id of made) assert.equal(left.includes(id), false, id);

    // И у всех типов сразу: значения по умолчанию — то, что обещает описание типа
    for (const module of SOURCE_LIST) {
      assert.deepEqual(defaultsOf(module.fields), readSettings(module.fields, {}));
    }
  });

  it('файл отдаётся, только пока его показывает видимый источник', async () => {
    const bytes = png(12, 9);
    const file = await uploadFile(stage.visitor, stage.id, bytes, 'кадр.png');
    const image = await addSource(stage.visitor, stage.id, 'image', { file: file.id });
    const guest = createVisitor(ctx.baseUrl);
    const media = (fileId = file.id) => guest.get(`/overlay/${overlay.token}/media/${fileId}`);

    // Источник виден — файл можно скачать, и он приходит файлом, а не страницей
    assert.equal((await viaLink(ctx, overlay.token)).data.sources.find((source) => source.id === image.id).file, file.id);
    const got = await media();
    assert.equal(got.status, 200);
    assert.deepEqual(got.bytes, bytes);
    assert.equal(got.headers.get('content-type'), 'image/png');
    // Браузер ничего в нём не выполняет и не отдаёт с чужого сайта
    assert.equal(got.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(got.headers.get('cross-origin-resource-policy'), 'same-origin');
    // Файл запоминается, но перед каждым показом браузер сверяется с сервером
    assert.equal(got.headers.get('cache-control'), 'private, no-cache');

    /* Файл из библиотеки, которого нет на сцене, по ссылке не получить, даже зная его номер.
       И «нет на сцене» — это именно что: правило смотрит на источники, а не на то,
       что файл вообще загружен площадке. */
    const unused = await uploadFile(stage.visitor, stage.id, png(5, 5), 'лишний.png');
    refusal(await media(unused.id), 404, 'media_not_found');
    // По внутреннему адресу файл тоже не отдаётся: папка загрузок наружу не открыта
    for (const url of [`/media/${stage.id}/${unused.id}`, `/data/uploads/${stage.id}/${unused.id}`, `/uploads/${stage.id}/${unused.id}`]) {
      assert.equal((await guest.get(url)).status, 404, url);
    }
    // Источник скрыли — файл тоже пропал; вернули — снова на месте
    await patchSource(stage.visitor, stage.id, image.id, { visible: false });
    refusal(await media(), 404, 'media_not_found');
    await patchSource(stage.visitor, stage.id, image.id, { visible: true });
    assert.equal((await media()).status, 200);

    // Чужая ссылка чужой файл не открывает — даже если этот файл у себя в эфире
    const other = await newStage(ctx, { name: 'Площадка-сосед' });
    const otherFile = await uploadFile(other.visitor, other.id, png(14, 3), 'соседний.png');
    await addSource(other.visitor, other.id, 'image', { file: otherFile.id });
    refusal(await media(otherFile.id), 404, 'media_not_found');
    // Негодный номер файла — тот же ответ, что и на несуществующий
    for (const wrong of ['abc', '0123456789ab', 'ABCDEFGHJKMNP', '0123456789abc']) {
      refusal(await media(wrong), 404, 'media_not_found');
    }
    // Пустой номер — не файл: это обычная страница «такого адреса нет», и она прозрачна
    const empty = await guest.get(`/overlay/${overlay.token}/media/`);
    assert.equal(empty.status, 404);
    assert.equal(empty.text, OVERLAY_PAGE);
    // Отменённая ссылка файлы не отдаёт
    const old = overlay.token;
    await stage.visitor.post(`/api/workspaces/${stage.id}/overlay/renew`);
    refusal(await guest.get(`/overlay/${old}/media/${file.id}`), 404, 'overlay_not_found');
    // Дальше площадка живёт по новой ссылке
    overlay = await overlayOf(stage.visitor, stage.id);
    assert.notEqual(overlay.token, old);
    assert.equal((await guest.get(`/overlay/${overlay.token}/media/${file.id}`)).status, 200);
    await stage.visitor.post(`${stage.api}/sources/${image.id}/delete`);
  });

  it('таймерами по ссылке не управляют, а их ход по ней виден', async () => {
    const timer = await addSource(stage.visitor, stage.id, 'timer', { settings: { mode: 'countdown', duration: 120 } });
    const stateOf = async () => (await viaLink(ctx, overlay.token)).data.sources.find((source) => source.id === timer.id)?.state;
    const guest = createVisitor(ctx.baseUrl);

    // Обычные адреса сцены без входа не работают
    refusal(await guest.post(`${stage.api}/sources/${timer.id}/command`, { action: 'start' }), 401, 'unauthorized');
    refusal(await guest.post(`${stage.api}/sources`, { type: 'text' }), 401, 'unauthorized');
    refusal(await guest.patch(`${stage.api}/sources/${timer.id}`, { x: 1 }), 401, 'unauthorized');
    // У адресов оверлея действий нет вовсе
    for (const [method, url] of [
      ['POST', `/api/overlay/${overlay.token}`],
      ['POST', `/api/overlay/${overlay.token}/sources`],
      ['GET', `/api/overlay/${overlay.token}/command`],
      ['POST', `/overlay/${overlay.token}/media/0123456789ab`],
    ]) {
      const res = method === 'GET' ? await guest.get(url) : await guest.post(url, {});
      assert.equal(res.status, 404, `${method} ${url}`);
    }

    assert.deepEqual(await stateOf(), { running: false, base: 120_000, since: 0 });
    // Команда из редактора — и в эфире видно, что отсчёт пошёл
    assert.equal((await stage.visitor.post(`${stage.api}/sources/${timer.id}/command`, { action: 'start' })).status, 200);
    const running = await stateOf();
    assert.equal(running.running, true);
    assert.ok(running.since > 0);
    await stage.visitor.post(`${stage.api}/sources/${timer.id}/command`, { action: 'pause' });
    assert.equal((await stateOf()).running, false);
    await stage.visitor.post(`${stage.api}/sources/${timer.id}/command`, { action: 'reset' });
    assert.deepEqual(await stateOf(), { running: false, base: 120_000, since: 0 });
    await stage.visitor.post(`${stage.api}/sources/${timer.id}/delete`);
  });

  it('пока настройки и ход источника не менялись, в ответе те же значения: оверлею нечего перезапускать', async () => {
    /* Оверлей сверяет новую сцену с показанной: источник, у которого не поменялись
       настройки и состояние, не пересобирается — иначе каждый сигнал о правке
       перезапускал бы ролик с начала. Здесь проверяется то, на что оверлей опирается. */
    const source = await addSource(stage.visitor, stage.id, 'text', { x: 100, y: 200, settings: { text: 'Постоянная надпись' } });
    const first = (await viaLink(ctx, overlay.token)).data.sources.find((item) => item.id === source.id);
    // Подвинули — настройки и состояние те же, изменилось только место
    await patchSource(stage.visitor, stage.id, source.id, { x: 300 });
    const moved = (await viaLink(ctx, overlay.token)).data.sources.find((item) => item.id === source.id);
    assert.deepEqual(moved.settings, first.settings);
    assert.deepEqual(moved.state, first.state);
    assert.deepEqual([moved.x, moved.y], [300, 200]);
    // Сменили настройку — видно и её
    await patchSource(stage.visitor, stage.id, source.id, { settings: { text: 'Новая надпись' } });
    const edited = (await viaLink(ctx, overlay.token)).data.sources.find((item) => item.id === source.id);
    assert.equal(edited.settings.text, 'Новая надпись');
    await stage.visitor.post(`${stage.api}/sources/${source.id}/delete`);
  });
});

/* ========================================================================== */

describe('Этап 6 — страница оверлея и её адреса', () => {
  let ctx;
  let stage;
  let overlay;
  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx, { displayName: 'Владелец Тестов', name: 'Закулисье' });
    overlay = await overlayOf(stage.visitor, stage.id);
  });
  after(async () => { await ctx.stop(); });

  it('по ссылке открывается прозрачная страница: без входа, без cookie и без «не найдено»', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const page = await guest.get(`/overlay/${overlay.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.text, OVERLAY_PAGE);
    // Ссылка — секрет: браузер не сообщает адрес страницы другим сайтам и не запоминает её
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.setCookies.length, 0, 'страница оверлея cookie не выставляет');
    // Вместе со страницей приходят её оформление и код — и ничего лишнего
    for (const asset of ['/styles/overlay.css', '/styles/scene.css', '/styles/fonts.css', '/js/pages/overlay.js']) {
      assert.equal((await guest.get(asset)).status, 200, asset);
    }

    /* Любой адрес под /overlay даёт ту же страницу: в OBS «не найдено» оказалось бы
       в эфире, а пустой оверлей просто ничего не рисует. */
    for (const [route, status] of [
      ['/overlay/check', 200],
      ['/overlay', 404],
      ['/overlay/', 404],
      ['/overlay/a/b', 404],
      ['/overlay/%E0%A4%A', 404],
      [`/overlay/${overlay.token}/media`, 404],
      [`/overlay/${newLinkToken(12)}`, 200],
    ]) {
      const res = await guest.get(route);
      assert.equal(res.status, status, route);
      assert.equal(res.text, OVERLAY_PAGE, `${route} — не страница оверлея`);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', route);
      assert.equal(res.headers.get('cache-control'), 'no-store', route);
      assert.equal(res.setCookies.length, 0, route);
    }
    // …и каждая страница оверлея, а не только главная ссылка: адрес не должен утекать
    for (const route of ['/overlay/a/b', '/overlay', '/overlay/check']) {
      assert.equal((await rawRequest(ctx, 'GET', route)).headers['referrer-policy'], 'no-referrer', route);
    }
    // Напрямую файлом страница не отдаётся
    assert.equal((await guest.get('/overlay.html')).status, 404);
    // Не-GET страницей не подменяется: это не запрос страницы
    const posted = await rawRequest(ctx, 'POST', `/overlay/${overlay.token}`, {});
    assert.equal(posted.status, 404);
    assert.notEqual(posted.bytes.toString('utf8'), OVERLAY_PAGE);
    // Голова — та же страница без тела
    const head = await rawRequest(ctx, 'HEAD', '/overlay');
    assert.equal(head.status, 404);
    assert.equal(head.bytes.length, 0);
    assert.equal(head.headers['content-type'], 'text/html; charset=UTF-8');
    // Сцену отдаёт отдельный адрес
    assert.equal((await guest.get(`/api/overlay/${overlay.token}`)).status, 200);
  });

  it('запрос сцены по ссылке: без cookie, без запоминания, без утечки через заголовки', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const res = await guest.get(`/api/overlay/${overlay.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.setCookies.length, 0);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, 'правила безопасности — те же, что у остальных страниц');

    // Cookie оверлей не читает: чужой вход ничего не меняет и не продлевает
    const sessions = () => ctx.db.prepare('SELECT id, last_seen_at FROM sessions ORDER BY id').all();
    const before = sessions();
    const withCookie = await stage.visitor.get(`/api/overlay/${overlay.token}`);
    assert.equal(withCookie.status, 200);
    assert.equal(withCookie.data.ok, true);
    assert.deepEqual(sessions(), before, 'оверлей не трогает сеансы');
    // Ответ не зависит от того, чей браузер спросил
    assert.deepEqual({ ...withCookie.data, serverTime: 0 }, { ...(await guest.get(`/api/overlay/${overlay.token}`)).data, serverTime: 0 });
  });

  it('негодная, выдуманная и отменённая ссылки неотличимы', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const wrong = [
      '0'.repeat(32), // такого не бывает, но и не «почти ссылка»
      '0123456789ABCDEFGHJKMNPQRSTVWXYZ', // заглавные буквы
      newLinkToken(26), // длина приглашения
      `${overlay.token}x`.slice(0, 33), // длиннее
      overlay.token.slice(1), // короче
      stage.id, // номер площадки вместо ссылки
      '0123456789ab', // номер источника
      `${overlay.token} `.trimEnd() + '0',
      'i'.repeat(32), // буквы нет в алфавите
    ];
    for (const wrongToken of wrong) {
      refusal(await guest.get(`/api/overlay/${wrongToken}`), 404, 'overlay_not_found');
    }
    // Пустой адрес и лишние части пути
    for (const url of ['/api/overlay', '/api/overlay/', `/api/overlay/${overlay.token}/sources`]) {
      refusal(await guest.get(url), 404, 'not_found');
    }
    // А действующая ссылка отвечает — она для того и нужна
    assert.equal((await guest.get(`/api/overlay/${overlay.token}`)).status, 200);
  });

  it('адреса оверлея — только чтение: попытки что-то изменить ничего не меняют', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const snapshot = () => JSON.stringify({
      sources: ctx.db.prepare('SELECT * FROM sources ORDER BY id').all(),
      workspaces: ctx.db.prepare('SELECT id, overlay_token, scene_version FROM workspaces ORDER BY id').all(),
    });
    const before = snapshot();
    for (const [method, url] of [
      ['POST', `/api/overlay/${overlay.token}`],
      ['PATCH', `/api/overlay/${overlay.token}`],
      ['PUT', `/api/overlay/${overlay.token}`],
      ['DELETE', `/api/overlay/${overlay.token}`],
      ['POST', `/api/overlay/${overlay.token}/sources`],
      ['POST', `/api/overlay/${overlay.token}/media`],
      ['POST', `/overlay/${overlay.token}/media/0123456789ab`],
      ['POST', `/api/overlay/${overlay.token}/renew`],
    ]) {
      const res = await rawRequest(ctx, method, url, {
        headers: ['POST', 'PATCH', 'PUT'].includes(method) ? { 'Content-Type': 'application/json' } : {},
        body: ['POST', 'PATCH', 'PUT'].includes(method) ? '{}' : undefined,
      });
      assert.equal(res.status, 404, `${method} ${url}`);
    }
    assert.equal(snapshot(), before, 'попытки что-то изменить ничего не изменили');
    assert.equal(guest.jar.size, 0, 'оверлей не обзавёлся ни одним cookie');
  });

  it('страница оверлея: только сцена — ни оформления кабинета, ни чужих адресов', async () => {
    const html = pageText('overlay.html');
    // Ни зерна, ни дождя, ни свечения, ни фирменного знака, ни кнопок: всё нарисованное уйдёт в эфир
    for (const extra of ['grain', 'id="glow"', 'rain', 'vignette', 'kra<em>fen</em>', '<button', '<a ', '<form', '<nav', '<header', '<footer']) {
      assert.equal(html.includes(extra), false, `на странице оверлея лишнее: ${extra}`);
    }
    // Подключаются только шрифты, вид сцены и её собственное оформление
    assert.deepEqual([...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((href) => href.endsWith('.css')), [
      '/styles/fonts.css', '/styles/scene.css', '/styles/overlay.css',
    ]);
    assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/js/pages/overlay.js']);
    assert.equal(/<script(?![^>]*src=)/.test(html), false, 'на странице нет ни одного своего скрипта');
    // В разметке нет ни сцены, ни ссылки: страница одна на все площадки
    assert.doesNotMatch(html, /\/api\/|\/overlay\/[0-9a-z]{20,}|data-(workspace|overlay|token)/);
    // Прозрачность: ни обоев, ни подложки — только место под сцену. Проверяются
    // оба правила по отдельности: «background: transparent» где-то в файле не годится
    const own = readPublic('styles/overlay.css');
    for (const selector of ['html', 'body']) {
      const block = own.match(new RegExp(`(?:^|\\n)${selector} \\{([\\s\\S]*?)\\n\\}`));
      assert.ok(block, `в overlay.css нет правила ${selector}`);
      assert.match(block[1], /background: transparent;/, `${selector} страницы оверлея должен быть прозрачным`);
      // Значение любое, но прозрачное: ни цвета, ни картинки
      const value = block[1].match(/background:\s*([^;]+);/)[1].trim();
      assert.equal(value, 'transparent', `${selector}: подложка в эфире`);
    }
    // Страница не вставляется в рамку на чужом сайте
    const frame = await rawRequest(ctx, 'GET', `/overlay/${overlay.token}`);
    assert.equal(frame.headers['x-content-type-options'], 'nosniff');
    assert.match(frame.headers['content-security-policy'], /default-src 'self'/);
  });

  it('оформление оверлея не зависит от кабинета: свои цвета, шрифты и размеры', async () => {
    /* scene.css подключают и редактор, и оверлей. Если бы он брал цвета и шрифты
       у страницы (переменные кабинета), в OBS сцена выглядела бы иначе: там этих
       переменных нет. Поэтому в нём только собственные значения и переменные --kf-*. */
    const scene = readPublic('styles/scene.css');
    const used = [...scene.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(used.length > 0, 'в scene.css должны быть свои переменные сцены');
    for (const name of used) assert.match(name, /^--kf-/, `scene.css взял переменную кабинета: ${name}`);

    /* Цвет текста, шрифт и межстрочный интервал заданы явно, а не унаследованы от страницы.
       Каждое свойство проверяется своей строкой: «где-то в правиле есть color:» ничего
       не значит — так подошло бы и -webkit-text-fill-color. */
    const root = scene.match(/\.kf-scene \{([\s\S]*?)\n\}/)[1];
    for (const [property, value] of [
      ['color', /#[0-9a-f]{3,6}/i],
      ['font-family', /"Manrope"/],
      ['font-size', /\d+px/],
      ['line-height', /[\d.]+/],
      ['font-weight', /\d{3}/],
      ['letter-spacing', /normal|\d/],
      ['text-align', /start|left/],
      ['white-space', /normal|pre/],
      ['direction', /ltr/],
      ['box-sizing', /border-box/],
    ]) {
      const line = root.match(new RegExp(`^\\s+${property}:\\s*(.+);$`, 'm'));
      assert.ok(line, `.kf-scene должен сам задавать ${property}`);
      assert.match(line[1], value, `.kf-scene: ${property} задан странно`);
    }
    // И у сцены нет ничего, что берётся у страницы «по наследству» из переменных кабинета
    assert.doesNotMatch(root, /var\(--(void|abyss|silver|crimson|glass|line|label)/);
    // Свои значения есть и у кабинетных шрифтов: сцена называет их сама
    for (const family of ['Alice', 'JetBrains Mono', 'Manrope']) assert.ok(scene.includes(family), family);

    // Никаких чужих сайтов: шрифты и оформление лежат на нашем сервере
    for (const file of ['styles/scene.css', 'styles/overlay.css', 'styles/fonts.css', 'overlay.html']) {
      assert.doesNotMatch(readPublic(file), /https?:\/\//, `${file}: чужая ссылка`);
    }
    // Из общих переменных кабинета оверлей не берёт ничего
    for (const name of [...readPublic('styles/overlay.css').matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])) {
      assert.match(name, /^--kf-/, `overlay.css взял переменную кабинета: ${name}`);
    }
    // И кабинетными классами не пользуется
    assert.doesNotMatch(readPublic('styles/overlay.css'), /\.(glass|pad-card|btn-|sidebar|toast)\w*/);
    // На сцене ничего не нажимается: в эфире нажимать некому
    assert.match(scene, /\.kf-src \{\n  position: absolute;\n  pointer-events: none;/);
    assert.match(scene, /\.kf-scene \[hidden\] \{\n  display: none !important;/);
  });

  it('страница оверлея в OBS: без связи сцена остаётся, отменённая ссылка гасит её целиком', async () => {
    /* В OBS не бывает ни «не найдено», ни «ошибка»: страница либо показывает сцену,
       либо пуста. Без связи показанная сцена остаётся; отменённая ссылка убирает всё. */
    const code = readPublic('js/pages/overlay.js');

    // Сроки сверки и повторов — названные числами, а не «как получится»
    assert.match(code, /const RETRY_STEPS_MS = \[1000, 2000, 4000, 8000, 15_000\];/);
    assert.match(code, /const POLL_LIVE_MS = 30_000;/);
    assert.match(code, /const POLL_OFFLINE_MS = 5000;/);
    assert.match(code, /const BUSY_RETRY_MS = 60_000;/);

    // Отменённая ссылка: сцена убирается, канал закрывается, вопросов к серверу больше нет
    const leave = code.match(/function leave\(\) \{([\s\S]*?)\n\}/)[1];
    assert.match(leave, /state = 'gone';/);
    assert.match(leave, /view\.setSources\(\[\]\);/);
    assert.match(leave, /live\.close\(\)/);
    for (const stop of ['clearTimeout(timer);', 'clearTimeout(liveTimer);', 'queued = null;']) assert.ok(leave.includes(stop), stop);
    assert.match(code, /if \(state === 'gone'\) return;\n  live = connectRealtime\(\{/, 'после отмены ссылки канал не переоткрывается');
    assert.match(code, /if \(res\.status === 404 && res\.data && res\.data\.error === 'overlay_not_found'\) \{\n    leave\(\);/, 'отмена ссылки узнаётся по коду отказа');

    // Сервер не ответил — сцена остаётся, и запрос повторяется сам, с растущей паузой
    assert.match(code, /fails \+= 1;\n\s+reachable = false;/);
    assert.match(code, /else plan\(RETRY_STEPS_MS\[Math\.min\(fails, RETRY_STEPS_MS\.length\) - 1\]\);/);
    // Слишком много каналов по ссылке — страница показывает сцену и стучится редко
    assert.match(code, /crowded = true;/);
    assert.match(code, /liveTimer = setTimeout\(startLive, BUSY_RETRY_MS\);/);

    // Вкладка проверки: в самом OBS её нет — знак об этом даёт window.obsstudio
    assert.match(code, /const insideObs = typeof window\.obsstudio !== 'undefined';/);
    assert.match(code, /checking = !insideObs;/);
    // Ссылка из вкладки проверки не уходит на сервер и убирается из адресной строки
    assert.match(code, /const given = window\.location\.hash\.slice\(1\);/);
    assert.match(code, /window\.history\.replaceState\(token \? \{ overlayLink: token \} : null, '', '\/overlay\/check'\);/);

    // Cookie не нужны вовсе; чужого кода на странице нет
    assert.doesNotMatch(code, /document\.cookie/);
    assert.match(code, /credentials: 'omit'/);
    assert.doesNotMatch(code, /\/api\/(auth|workspaces|invites)/);
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function\(/);
    // Сцену собирает тот же модуль, что и в редакторе, — не своя копия
    assert.match(code, /import \{ createSceneView } from '\.\.\/scene\/view\.js';/);
  });

  it('у адресов оверлея нет своих проверок прав: это дело площадок и сцены', async () => {
    const rules = readServer('overlay/http.js');
    // Пояснения в файле не в счёт: смотрим только код
    const code = rules.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const word of ['workspace_members', 'owner_id', "'owner'", "'moderator'", 'requireAuth', 'identify', 'session', 'cookie']) {
      assert.equal(code.includes(word), false, `overlay/http.js сам проверяет права: ${word}`);
    }
    // Адреса только передают ссылку и номер файла, и решают это общие правила
    assert.match(rules, /const from = \(req\) => \(\{ token: req\.params\.token \}\);/);
    assert.match(rules, /scene\.overlayScene\(from\(req\)\)/);
    assert.match(rules, /scene\.openOverlayMedia\(\{ \.\.\.from\(req\), fileId: req\.params\.fileId \}\)/);
    // Ни сцена, ни отказ не запоминаются браузером: ссылку могут отменить в любой момент
    assert.match(rules, /res\.setHeader\('Cache-Control', 'no-store'\);/);
    // Страница оверлея отдаётся не из общих страниц кабинета, а отдельно
    const app = readServer('app.js');
    assert.match(app, /app\.get\('\/overlay\/:token', overlayPage\(200\)\);/);
    assert.match(app, /res\.setHeader\('Referrer-Policy', 'no-referrer'\);/);
  });

  it('страница площадки: ссылка на виду у владельца, прикрыта по умолчанию и не попадает в разметку', async () => {
    const html = pageText('workspace.html');
    const code = readPublic('js/pages/workspace.js');

    // Карточка ссылки: сама ссылка приходит от сервера и кладётся скриптом — в разметке её нет
    assert.match(html, /<section class="glass pad-card" id="overlay-card" aria-labelledby="overlay-title">/);
    assert.match(html, /<h2 class="settings-title" id="overlay-title">Ссылка для OBS<\/h2>/);
    assert.match(html, /<div class="code-value link-value" id="overlay-link-value"><\/div>/);
    for (const id of ['overlay-owner', 'overlay-moderator', 'overlay-issued', 'overlay-reveal', 'overlay-copy', 'overlay-check', 'overlay-renew']) {
      assert.match(html, new RegExp(`id="${id}"`), `на странице площадки нет элемента ${id}`);
    }
    assert.doesNotMatch(html, /\/overlay\/[0-9a-z]{20,}/, 'в разметке не должно быть ссылки оверлея');
    // Объяснение: что это, как вставить в OBS, почему ссылка прикрыта
    assert.match(html, /В OBS добавьте источник «Браузер»/);
    assert.match(html, /1920&nbsp;×&nbsp;1080/);
    assert.match(html, /Ссылка прикрыта, чтобы не попасть в эфир вместе с этой страницей/);
    // Модератору — не пустое место, а объяснение, где взять ссылку
    assert.match(html, /Сцена попадает в эфир по ссылке, которую владелец площадки вставляет в OBS/);

    // Скрипт: прикрытие, показ, копирование без показа, вкладка проверки, новая ссылка
    assert.match(code, /const OVERLAY_COVER = '•'\.repeat\(12\);/);
    assert.match(code, /const overlayAddress = \(link\) => `\$\{window\.location\.origin\}\/overlay\/\$\{link\}`;/);
    assert.match(code, /overlayValue\.textContent = overlayOpen \? overlayAddress\(overlayLink\) : overlayAddress\(OVERLAY_COVER\);/);
    assert.match(code, /window\.open\(`\/overlay\/check#\$\{overlayLink\}`, '_blank'\)/);
    assert.match(code, /if \(tab\) tab\.opener = null;/, 'вкладка проверки не связана с кабинетом');
    assert.match(code, /Прежняя ссылка сразу перестанет работать/);
    // Без ссылки на странице окно новой ссылки не открывается (так у модератора)
    assert.match(code, /if \(!current \|\| !overlayLink\) return;/);
    // Ушли со вкладки — ссылка снова прикрыта
    assert.match(code, /document\.addEventListener\('visibilitychange', \(\) => \{\n  if \(document\.hidden && overlayOpen\) \{/);
    // Ссылку видит только владелец; модератору карточка объясняет, а не показывает пустоту
    assert.match(code, /\$\('overlay-owner'\)\.hidden = !hasLink;/);
    assert.match(code, /\$\('overlay-moderator'\)\.hidden = isOwner;/);
    // Новая пришедшая ссылка снова прикрыта: её не показывают сами
    assert.match(code, /if \(overlay\.token !== overlayLink\) overlayOpen = false;/);
  });
});

/* ========================================================================== */

describe('Этап 6 — живой канал оверлея: только сигнал и только по действующей ссылке', () => {
  let ctx;
  let stage;
  let overlay;
  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx, { name: 'Живой оверлей' });
    overlay = await overlayOf(stage.visitor, stage.id);
  });
  after(async () => { await ctx.stop(); });

  it('по ссылке оверлей попадает в свой канал: приветствие без номера площадки, замер без чужих сведений', async () => {
    const first = await joinOverlay(ctx, overlay.token);
    try {
      // В приветствии — только имя канала, номер соединения и часы сервера
      assert.deepEqual(Object.keys(first.hello).sort(), ['channel', 'clientId', 'serverTime', 'type']);
      assert.equal(first.hello.channel, 'overlay');
      assert.equal(first.hello.type, 'hello');
      assert.ok(Math.abs(Date.now() - first.hello.serverTime) < MINUTE, 'часы сервера — настоящие');
      const helloText = JSON.stringify(first.hello);
      assert.equal(helloText.includes(stage.id), false, 'номер площадки оверлею не сообщается');
      assert.equal(helloText.includes(overlay.token), false, 'ссылка обратно не приходит');

      // Замер задержки работает, но сколько страниц на связи — не дело оверлея
      first.ws.send(JSON.stringify({ type: 'ping', clientTs: 5 }));
      const pong = await first.next();
      assert.deepEqual(pong, { type: 'pong', clientTs: 5, serverTime: pong.serverTime });
      assert.ok(Math.abs(Date.now() - pong.serverTime) < MINUTE);
      first.ws.send(JSON.stringify({ type: 'ping' }));
      const noTs = await first.next();
      assert.equal(noTs.clientTs, null, 'без метки страницы — и в ответе её нет');
      // Испорченное сообщение не роняет канал
      first.ws.send('не json');
      assert.deepEqual(await first.next(), { type: 'error', code: 'invalid_json' });
      assert.deepEqual(first.inbox, []);
    } finally {
      await first.close();
    }
  });

  it('отменённая, выдуманная и чужая ссылка в канал не пускают — одинаково и без объяснений', async () => {
    const other = await newStage(ctx, { name: 'Чужая ссылка' });
    const otherLink = await overlayOf(other.visitor, other.id);

    for (const key of ['', '0'.repeat(32), overlay.token.toUpperCase(), overlay.token.slice(0, 31), newLinkToken(26), stage.id, 'нет-это-не-ссылка']) {
      await denied(ctx, key);
    }
    await denied(ctx, undefined); // без ссылки вовсе

    // Ссылка соседней площадки действует — но она открывает только свою площадку.
    // Канал оверлея у площадок общий по имени, поэтому проверяется: соседние каналы не путаются
    const neighbour = await joinOverlay(ctx, otherLink.token);
    try {
      const created = await other.visitor.post(`${other.api}/sources`, { type: 'text' });
      assert.deepEqual(await neighbour.next(), { type: 'overlay:changed', version: created.data.version });
      // Правки проверяемой площадки в этот канал не попадают
      await addSource(stage.visitor, stage.id, 'shape');
      await sleep(150);
      assert.deepEqual(neighbour.inbox, []);
    } finally {
      await neighbour.close();
    }

    // Канал с выдуманным именем оверлеем не считается — но и он ничего не рассказывает
    const plain = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=overlay-не-наш`);
    const hello = await plain.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.channel, 'overlay-не-наш');
    await plain.close();

    // Под канал площадки по ссылке не пройти: там свой пропуск, который выдаётся после входа
    const asTeam = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${stage.id}&ticket=${overlay.token}`);
    assert.deepEqual(await asTeam.next(), { type: 'denied' });
    assert.equal((await asTeam.closed).code, 4403);

    // Пропуск команды тоже не пускает в канал оверлея: ключ и пропуск — разные вещи
    const pass = await stage.visitor.post(`/api/workspaces/${stage.id}/live`);
    await denied(ctx, pass.data.ticket);
  });

  it('оверлей узнаёт только о правках сцены: о команде, названии и ссылках ему не сообщают', async () => {
    const socket = await joinOverlay(ctx, overlay.token);
    let alive = true;
    try {
      // Правка сцены — сигнал с номером версии, и ничего больше
      const created = await stage.visitor.post(`${stage.api}/sources`, { type: 'text' }, { headers: { 'X-Client-Id': 'tab7k2m9x4pq' } });
      assert.equal(created.status, 201);
      assert.deepEqual(await socket.next(), { type: 'overlay:changed', version: created.data.version });

      // Разговор о площадке: название, команда, приглашения — оверлею не слышен
      await stage.visitor.patch(`/api/workspaces/${stage.id}`, { name: 'Живой оверлей 2' });
      await sleep(150);
      assert.deepEqual(socket.inbox, [], 'разговор о площадке оверлею не слышен');

      // А правка сцены — слышна, и с новым номером версии
      await patchSource(stage.visitor, stage.id, created.data.source.id, { x: 11 });
      assert.deepEqual(await socket.next(), { type: 'overlay:changed', version: created.data.version + 1 });
      // Номер версии — только числом; ни кто менял, ни с какой страницы
      assert.deepEqual(Object.keys(await (async () => {
        await patchSource(stage.visitor, stage.id, created.data.source.id, { x: 12 });
        return socket.next();
      })()).sort(), ['type', 'version']);

      // Новая ссылка закрывает канал по старой; сигнал об этом — отказ, а не рассказ
      const old = overlay.token;
      await stage.visitor.post(`/api/workspaces/${stage.id}/overlay/renew`);
      assert.deepEqual(await socket.next(), { type: 'denied' });
      assert.equal((await socket.closed).code, 4403);
      alive = false;
      refusal(await createVisitor(ctx.baseUrl).get(`/api/overlay/${old}`), 404, 'overlay_not_found');
      overlay = await overlayOf(stage.visitor, stage.id);

      // По новой ссылке — снова канал, и снова только сцена
      const again = await joinOverlay(ctx, overlay.token);
      try {
        await stage.visitor.patch(`/api/workspaces/${stage.id}`, { name: 'Живой оверлей 3' });
        await sleep(150);
        assert.deepEqual(again.inbox, []);
        await patchSource(stage.visitor, stage.id, created.data.source.id, { x: 13 });
        assert.equal((await again.next()).type, 'overlay:changed');
      } finally {
        await again.close();
      }
    } finally {
      if (alive) await socket.close();
    }
  });

  it('ссылка, выпущенная заново, закрывает все каналы сразу; удаление площадки — тоже', async () => {
    const own = await newStage(ctx, { name: 'Смена ссылки' });
    const link = await overlayOf(own.visitor, own.id);
    const first = await joinOverlay(ctx, link.token);
    const second = await joinOverlay(ctx, link.token);
    try {
      await own.visitor.post(`/api/workspaces/${own.id}/overlay/renew`);
      for (const socket of [first, second]) {
        assert.deepEqual(await socket.next(), { type: 'denied' });
        assert.equal((await socket.closed).code, 4403);
      }
      await denied(ctx, link.token);
    } finally {
      await first.close().catch(() => {});
      await second.close().catch(() => {});
    }

    const doomed = await newStage(ctx, { name: 'Площадка под снос' });
    const doomedLink = await overlayOf(doomed.visitor, doomed.id);
    const socket = await joinOverlay(ctx, doomedLink.token);
    await doomed.visitor.post(`/api/workspaces/${doomed.id}/delete`, { confirmName: 'Площадка под снос' });
    assert.deepEqual(await socket.next(), { type: 'denied' });
    assert.equal((await socket.closed).code, 4403);
    await socket.close().catch(() => {});
  });

  it('каналов по одной ссылке не может быть сколько угодно: лишним — «занято», а не отказ в доступе', async () => {
    const small = await startServer({ realtimeLimits: { overlaysPerWorkspace: 3 } });
    try {
      const own = await newStage(small, { name: 'Тесный канал' });
      const link = await overlayOf(own.visitor, own.id);
      const opened = [];
      for (let i = 0; i < 3; i += 1) opened.push(await joinOverlay(small, link.token));
      try {
        const extra = await openSocket(overlayChannel(small, link.token));
        assert.deepEqual(await extra.next(), { type: 'busy' });
        assert.equal((await extra.closed).code, 4429);
        // Сцена при этом доступна: предел — только на живой канал
        assert.equal((await viaLink(small, link.token)).status, 200);
        // Через минуту страница попробует снова, а пока сверяется запросами
        assert.match(readPublic('js/pages/overlay.js'), /liveTimer = setTimeout\(startLive, BUSY_RETRY_MS\);/);

        // Канал освободился — входят снова
        await opened[0].close();
        await sleep(150);
        const next = await joinOverlay(small, link.token);
        await next.close();
      } finally {
        for (const socket of opened) await socket.close().catch(() => {});
      }
    } finally {
      await small.stop();
    }
  });

  it('живой канал не читает cookie: оверлей входит по ссылке, а не по входу', async () => {
    // Никаких обращений к cookie: ни в канале команды (там одноразовый пропуск), ни в канале оверлея
    const code = readServer('ws/hub.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /cookie/i);
    // Оверлею не сообщается, сколько людей сейчас на связи
    assert.match(code, /\? \{\} : \{ activeClients: clients\.size \}/);
    // Ссылка проверяется перед каждой отправкой; отменённая — сразу отключается
    assert.match(code, /if \(meta\.kind === 'overlay'\) return overlayTargetOf\(meta\.overlayToken\) === meta\.workspaceId;/);
    assert.match(code, /const room = overlayChannel\(workspaceId\);[\s\S]*?safeSend\(ws, \{ type: 'busy' \}\);/);
  });
});

/* ========================================================================== */

describe('Этап 6 — обновление с прошлого этапа', () => {
  it('база этапа 5 достраивается при запуске: у каждой площадки появляется своя ссылка', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-upgrade-'));
    const dbPath = path.join(tmpDir, 'auth-test.db');
    try {
      // База в том виде, в каком её оставил этап 5: два владельца, две площадки, сцена
      const old = openDatabase(dbPath, { upToVersion: 4 });
      assert.equal(old.getHealth().schemaVersion, 4);
      const columns = old.raw.prepare('PRAGMA table_info(workspaces)').all().map((column) => column.name);
      assert.equal(columns.includes('overlay_token'), false, 'в базе этапа 5 ссылки ещё нет');

      const accounts = createAccounts({ db: old.raw, passwordCost: FAST });
      const oldStreamer = await accounts.register({ username: 'old_streamer', displayName: 'Старожил', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      const oldHelper = await accounts.register({ username: 'old_helper', displayName: 'Помощник', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      const userRow = (name) => old.raw.prepare('SELECT id FROM users WHERE username_key = ?').get(name).id;
      const rooms = [[newLinkToken(12), 'Площадка старожила', 'old_streamer'], [newLinkToken(12), 'Площадка помощника', 'old_helper']];
      for (const [id, name, login] of rooms) {
        old.raw.prepare('INSERT INTO workspaces (public_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, userRow(login), name, Date.now(), Date.now());
      }
      const room = old.raw.prepare('SELECT id FROM workspaces WHERE public_id = ?').get(rooms[0][0]).id;
      old.raw.prepare('INSERT INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(room, userRow('old_helper'), Date.now());
      old.raw.prepare(`INSERT INTO sources (public_id, workspace_id, type, name, x, y, width, height, layer, visible, settings)
        VALUES (?, ?, 'text', 'Надпись', 10, 20, 300, 100, 0, 1, '{"text":"Старая сцена"}')`)
        .run(newLinkToken(12), room);
      old.raw.prepare('UPDATE workspaces SET scene_version = 1 WHERE id = ?').run(room);
      old.close();

      const ctx = await startServer({ tmpDir });
      try {
        const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
        assert.equal(health.db.schemaVersion, SCHEMA_VERSION);
        assert.equal(health.db.latestMigration, LATEST_MIGRATION);
        assert.equal(health.stage, PLATFORM_STAGE);

        // Прежние входы действуют: люди не заметили обновления
        const owner = createVisitor(ctx.baseUrl);
        owner.jar.set('ks_session', oldStreamer.token);
        const helper = createVisitor(ctx.baseUrl);
        helper.jar.set('ks_session', oldHelper.token);
        assert.equal(await owner.isSignedIn(), true);

        // У каждой площадки — своя новая ссылка, и все они разные
        const first = await overlayOf(owner, rooms[0][0]);
        const second = await overlayOf(helper, rooms[1][0]);
        assert.match(first.token, OVERLAY_LINK);
        assert.match(second.token, OVERLAY_LINK);
        assert.notEqual(first.token, second.token);
        const rows = ctx.db.prepare('SELECT public_id, overlay_token FROM workspaces ORDER BY id').all();
        assert.deepEqual(rows.map((row) => row.public_id), rooms.map(([id]) => id));
        assert.equal(new Set(rows.map((row) => row.overlay_token)).size, 2, 'ссылки у площадок разные');

        /* Ссылка выдана обновлением базы, а не при первом чтении площадки: колонка
           заполнена у всех площадок сразу после запуска, ещё до чьих-либо запросов. */
        const filled = ctx.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE overlay_token IS NULL').get().n;
        assert.equal(filled, 0, 'у каждой площадки ссылка есть сразу после обновления');
        const issuedAt = ctx.db.prepare('SELECT overlay_token_at FROM workspaces ORDER BY id').all().map((row) => row.overlay_token_at);
        assert.deepEqual(issuedAt, [issuedAt[0], issuedAt[0]], 'ссылки выданы одним обновлением базы');
        assert.ok(Date.now() - issuedAt[0] < HOUR);

        // Сцена старожила видна по новой ссылке — со всеми прежними правками
        const scene = await viaLink(ctx, first.token);
        assert.equal(scene.status, 200);
        assert.equal(scene.data.scene.version, 1);
        assert.deepEqual(scene.data.sources.map((source) => source.settings.text), ['Старая сцена']);
        // А вторая площадка пуста и по своей ссылке
        assert.deepEqual((await viaLink(ctx, second.token)).data.sources, []);
        // Ссылка не отменяет входа: площадка по-прежнему закрыта без него
        assert.equal((await createVisitor(ctx.baseUrl).get(`/api/workspaces/${rooms[0][0]}`)).status, 401);
      } finally {
        await ctx.stop({ keepFiles: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('страницы и сервер называют текущим этап 6, а прошлый — прошлым', async () => {
    // Главная и кабинет знают, какой этап сейчас
    assert.match(readPublic('index.html'), /этап 6 из 9/);
    assert.match(readPublic('app.html'), /<span class="mono">6 \/ 9<\/span>/);
    assert.match(readPublic('app.html'), /этап 6 из 9 завершён/);
    assert.match(readPublic('app.html'), /<div class="stage-card-title">Оверлей для OBS<\/div>/);
    // Ни одна страница и ни один скрипт больше не называют текущим этап 5
    const files = [];
    const stack = [publicDir];
    while (stack.length) {
      const folder = stack.pop();
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(html|js|css)$/.test(entry.name)) files.push(full);
      }
    }
    assert.ok(files.length > 20);
    for (const file of files) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /этап(?:е|а)? 5\b|5 \/ 9|5 из 9/i, path.relative(publicDir, file));
    }

    // Сервер сообщает этап 6 и пятую версию структуры базы
    const ctx = await startServer();
    try {
      const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
      assert.equal(health.stage, PLATFORM_STAGE);
      assert.equal(PLATFORM_STAGE, 6);
      assert.equal(health.db.schemaVersion, 5);
      assert.equal(health.db.latestMigration, '005_overlay_link');
      // Общий счётчик на связи существует, но оверлею он не показывается
      assert.equal(typeof health.realtime.connectedClients, 'number');
    } finally {
      await ctx.stop();
    }
  });

  it('документы называют этап 6 сделанным и объясняют, как смотреть оверлей', () => {
    const plan = readPage('../docs/overlay-platform/ARCHITECTURE.md');
    const projectReadme = readPage('README.md');
    const repoReadme = readPage('../README.md');
    for (const text of [plan, projectReadme, repoReadme]) {
      assert.match(text, /этап 6/i, 'документы должны называть текущий этап');
    }
    // Архитектура: оверлей описан в общем плане и в своём разделе
    assert.match(plan, /Оверлей для OBS/);
    assert.match(plan, /\| ?6 ?\|/);
    // Оба README обещают «готов этап 6 из 9» и рассказывают про ссылку для OBS
    for (const text of [projectReadme, repoReadme]) {
      assert.match(text, /этап 6 из 9/);
      assert.match(text, /[Сс]сылка для OBS/);
    }
    // Версия платформы в описании — та же, что в package.json
    assert.equal(JSON.parse(readPage('package.json')).version, '0.6.0');
  });
});
