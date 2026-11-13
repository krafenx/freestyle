import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  FAST, GOOD_PASSWORD, LATEST_MIGRATION, PLATFORM_STAGE, PROJECT_DIR, SCHEMA_VERSION,
  addModerator, addSource, createVisitor, newStage, openSocket, patchSource, png, startServer, waitFor,
} from './helpers.js';

/* Этап 7: правки на лету. Проверяется настоящий сервер с настоящей базой и настоящим
   живым каналом.

   Что здесь главное. С этапа 6 сигнал «сцена изменилась» сообщал только номер версии:
   страница, получив его, перечитывала сцену целиком. Теперь к сигналу приложено само
   изменение (delta), и страница применяет его к своей копии — без запроса. Значит,
   проверять нужно три вещи:

   1. Изменение действительно описывает то, что произошло: что добавилось, что
      изменилось, что исчезло, какой стал порядок слоёв. И не больше: без названий
      источников, имён людей, меток страниц и служебных полей базы.
   2. Присутствие («кто что двигает») живёт только в живом канале и только в памяти:
      в базу положение во время перетаскивания не попадает, версия сцены не растёт.
   3. Прежняя страховка на месте: изменение не по порядку, непонятное или про
      незнакомый источник не применяется — вместо этого страница перечитывает сцену.

   Применение изменения на самой странице (store.js, overlay.js) проверяется
   в браузере отдельно; здесь — то, что видно снаружи: сервер и его сообщения. */

/* ---------- Проверки страниц по исходникам ---------- */

const readPublic = (name) => fs.readFileSync(path.join(PROJECT_DIR, 'public', name), 'utf8');
const readServer = (name) => fs.readFileSync(path.join(PROJECT_DIR, 'src/server', name), 'utf8');

// Код без пояснений: ищем в нём то, что должно (и не должно) быть
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/* ---------- Живой канал площадки ---------- */

async function joinTeam(ctx, visitor, workspaceId) {
  const pass = await visitor.post(`/api/workspaces/${workspaceId}/live`);
  assert.equal(pass.status, 200, `пропуск не выдан: ${pass.text}`);
  const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${workspaceId}&ticket=${pass.data.ticket}`);
  assert.equal((await socket.next()).type, 'hello');
  return socket;
}

const TAB = 'liv3tab7k2m9x'; // метка страницы (X-Client-Id): по ней сервер узнаёт, чья правка
const from = (tab = TAB) => ({ headers: { 'X-Client-Id': tab } });

describe('Этап 7 — правки на лету: что приходит к сигналу', () => {
  let ctx;
  let stage;
  let moderator;
  let live;

  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx, { displayName: 'Хозяйка эфира' });
    moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Помощник' });
    live = await joinTeam(ctx, moderator.visitor, stage.id);
  });
  after(async () => {
    await live?.close();
    await ctx.stop();
  });

  // Следующее сообщение о сцене; присутствие по дороге пропускается
  const nextScene = async () => {
    for (;;) {
      const message = await live.next();
      if (message.type === 'workspace:changed' && message.what === 'scene') return message;
      assert.equal(message.type, 'workspace:presence', `неожиданное сообщение: ${JSON.stringify(message)}`);
    }
  };

  it('новый источник: к сигналу приложен он сам и новый порядок слоёв', async () => {
    const created = await stage.visitor.post(`${stage.api}/sources`, { type: 'text', props: { name: 'Заголовок' } }, from());
    assert.equal(created.status, 201);
    const message = await nextScene();
    assert.equal(message.version, created.data.version);
    assert.deepEqual(message.delta, { add: [created.data.source], order: [created.data.source.id] });
    // Источник в изменении — тот же, что отдала бы странице сама сцена
    const scene = await stage.visitor.get(stage.api);
    assert.deepEqual(message.delta.add[0], scene.data.sources[0]);

    // Добавили ещё один: в изменении только новый источник и весь порядок
    const second = await stage.visitor.post(`${stage.api}/sources`, { type: 'shape' }, from());
    assert.deepEqual((await nextScene()).delta, {
      add: [second.data.source],
      order: [created.data.source.id, second.data.source.id],
    });
  });

  it('правка: в изменении только то, что поменялось, — без целого источника', async () => {
    const scene = await stage.visitor.get(stage.api);
    const source = scene.data.sources[0];

    // Только положение — в изменении только оно
    const moved = await patchSource(stage.visitor, stage.id, source.id, { x: 123 });
    assert.equal(moved.status, 200);
    assert.deepEqual((await nextScene()).delta, { put: [{ id: source.id, x: 123 }] });

    // Несколько полей сразу — все в одной записи
    const more = await patchSource(stage.visitor, stage.id, source.id, { y: 45, opacity: 60, visible: false });
    assert.equal(more.status, 200);
    assert.deepEqual((await nextScene()).delta, { put: [{ id: source.id, y: 45, opacity: 60, visible: false }] });

    // Настройки: приходят целиком (страница их и хранит целиком), а не по одному полю
    const text = await patchSource(stage.visitor, stage.id, source.id, { settings: { text: 'Совсем другой текст', size: 96 } });
    assert.equal(text.data.source.settings.text, 'Совсем другой текст');
    assert.deepEqual((await nextScene()).delta, { put: [{ id: source.id, settings: text.data.source.settings }] });

    // Правка, ничего не меняющая, версию не двигает и сообщения не порождает
    const same = await patchSource(stage.visitor, stage.id, source.id, { x: 123 });
    assert.equal(same.status, 200);
    assert.equal(live.inbox.filter((msg) => msg.type === 'workspace:changed').length, 0);
  });

  it('порядок слоёв, копия и удаление: в изменении только то, что случилось', async () => {
    const scene = await stage.visitor.get(stage.api);
    const [bottom, top] = scene.data.sources.map((source) => source.id);

    const moved = await stage.visitor.post(`${stage.api}/sources/${bottom}/move`, { index: 1 }, from());
    assert.equal(moved.status, 200);
    assert.deepEqual((await nextScene()).delta, { order: [top, bottom] });

    const copy = await stage.visitor.post(`${stage.api}/sources/${top}/duplicate`, {}, from());
    assert.equal(copy.status, 201);
    const copyDelta = (await nextScene()).delta;
    assert.deepEqual(copyDelta.add, [copy.data.source]);
    assert.deepEqual(copyDelta.order, copy.data.order);

    const removed = await stage.visitor.post(`${stage.api}/sources/${copy.data.source.id}/delete`, {}, from());
    assert.equal(removed.status, 200);
    assert.deepEqual((await nextScene()).delta, { remove: [copy.data.source.id], order: removed.data.order });
  });

  it('команда таймеру: меняется только ход, и в изменении только он', async () => {
    const timer = await addSource(stage.visitor, stage.id, 'timer');
    await nextScene(); // сам источник
    const started = await stage.visitor.post(`${stage.api}/sources/${timer.id}/command`, { action: 'start' }, from());
    assert.equal(started.status, 200);
    const delta = (await nextScene()).delta;
    assert.deepEqual(delta.put, [{ id: timer.id, state: started.data.source.state }]);
    // Неизменившиеся поля в изменение не попадают вовсе
    for (const key of ['x', 'y', 'width', 'height', 'opacity', 'visible', 'type', 'file']) {
      assert.equal(delta.put[0][key], undefined, `${key} попало в изменение без надобности`);
    }
  });

  it('загрузка и удаление файла сцену не меняют — изменения нет', async () => {
    const uploaded = await stage.visitor.upload(`${stage.api}/media`, png(), { name: 'рамка.png' });
    assert.equal(uploaded.status, 201);
    const message = await live.next();
    assert.equal(message.what, 'scene');
    assert.equal(message.delta, undefined, 'файл — не сцена: изменять на странице нечего');

    await stage.visitor.post(`${stage.api}/media/${uploaded.data.file.id}/delete`, {}, from());
    assert.equal((await live.next()).delta, undefined);
  });

  it('служебных полей базы в изменении нет; название для страницы есть, для оверлея — нет', async () => {
    const created = await stage.visitor.post(`${stage.api}/sources`, { type: 'image', props: { name: 'Тайный кадр' } }, from());
    const message = await nextScene();
    const text = JSON.stringify(message);
    // Всё, что уходит странице, подписано случайными номерами (12 знаков), а не номерами строк
    assert.doesNotMatch(text, /"(id|sourceId|mediaId|workspaceId)":\s*\d+/);
    assert.equal(typeof created.data.source.id, 'string');
    for (const key of ['created_at', 'createdAt', 'workspace_id', 'media_id', 'public_id']) {
      assert.equal(text.includes(key), false, `в изменении оказалось служебное поле ${key}`);
    }
    /* Название источнику нужно самой странице площадки: по нему он виден в списке
       слоёв и в панели свойств. А по ссылке оверлея названия нет ни в сцене, ни
       в изменении — это проверяется ниже, в сообщении оверлея. */
    assert.equal(text.includes('Тайный кадр'), true);
  });

  it('оверлею изменение приходит — но без имён, меток страниц и названий', async () => {
    const link = (await stage.visitor.get(`/api/workspaces/${stage.id}`)).data.overlay;
    const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=overlay&key=${link.token}`);
    assert.equal((await socket.next()).type, 'hello');
    try {
      // Правка с меткой страницы: именно её оверлею знать нельзя
      const created = await stage.visitor.post(`${stage.api}/sources`, { type: 'text', props: { name: 'Баннер' } }, from());
      assert.equal(created.status, 201);
      const message = await socket.next();
      assert.equal(message.type, 'overlay:changed');
      assert.ok(message.delta, 'оверлей получает изменение');
      const text = JSON.stringify(message);
      assert.equal(text.includes(TAB), false, 'метка страницы ушла оверлею');
      assert.equal(text.includes('Помощник'), false, 'имя участника ушло оверлею');
      assert.equal(text.includes('Баннер'), false, 'название источника ушло оверлею');
      assert.equal(message.origin, undefined);
      assert.equal(message.actor, undefined);
      assert.equal(message.delta.add[0].name, undefined);
      assert.equal(message.delta.add[0].id, created.data.source.id);
    } finally {
      await socket.close();
    }
  });

  it('к сигналу приложено и кто изменил — но только страницам площадки', async () => {
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    try {
      // Правку делает модератор. actor — подпись и роль того, кто изменил;
      // mine — «это сделали вы» (у модератора своя вкладка — вторая)
      await addSource(moderator.visitor, stage.id, 'shape');
      const mine = await helper.next();
      assert.equal(mine.type, 'workspace:changed');
      assert.deepEqual(mine.actor, { name: 'Помощник', role: 'moderator' });
      assert.equal(mine.mine, true);
      const seen = await owner.next();
      assert.equal(seen.mine, false);
      // actor — только тем, у кого есть права в площадке; подпись берётся с сервера
      assert.deepEqual(seen.actor, { name: 'Помощник', role: 'moderator' });
    } finally {
      await Promise.all([owner.close(), helper.close()]);
    }
  });

  it('изменение — не право: чужая площадка его не получает', async () => {
    const neighbour = await newStage(ctx, { displayName: 'Сосед' });
    const theirs = await joinTeam(ctx, neighbour.visitor, neighbour.id);
    const ours = await joinTeam(ctx, moderator.visitor, stage.id);
    try {
      await addSource(stage.visitor, stage.id, 'shape');
      assert.equal((await ours.next()).type, 'workspace:changed');
      // Соседу — только про его собственную площадку
      assert.equal(theirs.inbox.length, 0);
    } finally {
      await Promise.all([theirs.close(), ours.close()]);
    }
  });
});

/* ========================================================================== */

describe('Этап 7 — присутствие: кто сейчас что двигает', () => {
  let ctx;
  let stage;
  let moderator;

  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx, { displayName: 'Хозяйка эфира' });
    moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Помощник' });
  });
  after(async () => { await ctx.stop(); });

  const send = (socket, payload) => socket.ws.send(JSON.stringify(payload));
  const nextPresence = async (socket) => {
    for (;;) {
      const message = await socket.next();
      if (message.type === 'workspace:presence') return message;
      assert.equal(message.type, 'workspace:changed', `неожиданное сообщение: ${JSON.stringify(message)}`);
    }
  };
  const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('пока источник тянут, другие видят: кто, что и где; отпустили — пропало', async () => {
    const source = await addSource(stage.visitor, stage.id, 'text', { name: 'Титры' });
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    try {
      // Человек двигает: страница присылает промежуточное положение
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 100, y: 200, width: 300, height: 60 } });
      const seen = await nextPresence(owner);
      assert.deepEqual(seen.people, [{
        name: 'Помощник', role: 'moderator', sourceId: source.id, x: 100, y: 200, width: 300, height: 60, mine: false,
      }]);
      // Двигающий видит то же самое, но отмеченное как своё
      assert.equal((await nextPresence(helper)).people[0].mine, true);

      // Источник отпустили — присутствие снимается сразу, без ожидания срока
      send(helper, { type: 'presence', at: { end: true } });
      assert.deepEqual((await nextPresence(owner)).people, []);

      // В базу положение не попало: сцена не изменилась и версия не сдвинулась
      const scene = await stage.visitor.get(stage.api);
      const saved = scene.data.sources.find((item) => item.id === source.id);
      assert.deepEqual([saved.x, saved.y], [source.x, source.y]);
      assert.equal(owner.inbox.filter((msg) => msg.type === 'workspace:changed').length, 0);
    } finally {
      await Promise.all([owner.close(), helper.close()]);
    }
  });

  it('присутствие живёт не дольше нескольких секунд: закрыли вкладку — запись исчезает сама', async () => {
    const source = await addSource(stage.visitor, stage.id, 'shape');
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    try {
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 1, y: 1, width: 100, height: 100 } });
      await nextPresence(owner);
      assert.equal(ctx.server.realtime.presenceOf(stage.id).length, 1);
      // Источник не двигали, а страницу закрыли без «отпустил»: запись исчезает по сроку
      await waitFor(() => ctx.server.realtime.presenceOf(stage.id).length === 0, 'присутствие истекло', 9000);
      assert.deepEqual((await nextPresence(owner)).people, []);
    } finally {
      await Promise.all([owner.close(), helper.close()]);
    }
  });

  it('двигать «от имени другого» нельзя: подпись и права берутся с сервера, а не из сообщения', async () => {
    const source = await addSource(stage.visitor, stage.id, 'shape');
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    try {
      // Чужой текст в подписи ничего не меняет: сервер подписывает сам
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 5, y: 5, width: 10, height: 10, name: '<img src=x>', role: 'owner' } });
      const seen = await nextPresence(owner);
      assert.equal(seen.people[0].name, 'Помощник');
      assert.equal(seen.people[0].role, 'moderator');

      // Негодное сообщение просто не учитывается — связь при этом не рвётся
      const before = ctx.server.realtime.presenceOf(stage.id);
      for (const junk of [
        { sourceId: 'short', x: 0, y: 0, width: 1, height: 1 },
        { sourceId: source.id, x: 'далеко', y: 0, width: 1, height: 1 },
        { sourceId: source.id, x: 1e9, y: 0, width: 1, height: 1 },
        { sourceId: source.id },
        {},
      ]) {
        send(helper, { type: 'presence', at: junk });
      }
      await hold(200);
      assert.deepEqual(ctx.server.realtime.presenceOf(stage.id), before);
      // Канал жив: следующее правильное сообщение доходит
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 9, y: 9, width: 10, height: 10 } });
      await hold(250);
      assert.equal(ctx.server.realtime.presenceOf(stage.id)[0].x, 9);
    } finally {
      await Promise.all([owner.close(), helper.close()]);
    }
  });

  it('присутствие видят только участники площадки; оверлею его не бывает', async () => {
    const source = await addSource(stage.visitor, stage.id, 'shape');
    // Гость: пропуска в канал не получит вовсе
    const guest = createVisitor(ctx.baseUrl);
    assert.equal((await guest.post(`/api/workspaces/${stage.id}/live`)).status, 401);

    // Оверлей в своём канале: присутствие туда не идёт вовсе
    const link = (await stage.visitor.get(`/api/workspaces/${stage.id}`)).data.overlay;
    const overlay = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=overlay&key=${link.token}`);
    assert.equal((await overlay.next()).type, 'hello');
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    try {
      send(owner, { type: 'presence', at: { sourceId: source.id, x: 7, y: 7, width: 10, height: 10 } });
      await nextPresence(owner);
      // Оверлею не пришло ни присутствия, ни изменений: присутствие — не правка сцены
      assert.equal(overlay.inbox.filter((msg) => msg.type === 'workspace:presence').length, 0);
      assert.equal(overlay.inbox.filter((msg) => msg.type === 'overlay:changed').length, 0);

      // Оверлей не может присылать присутствие: его сообщение никого не касается
      overlay.ws.send(JSON.stringify({ type: 'presence', at: { sourceId: source.id, x: 1, y: 1, width: 10, height: 10 } }));
      await hold(250);
      assert.equal(ctx.server.realtime.presenceOf(stage.id).some((person) => person.name === ''), false);
    } finally {
      await Promise.all([owner.close(), overlay.close()]);
    }
  });

  it('две вкладки одного человека: вторая видит его руку как чужую', async () => {
    const source = await addSource(stage.visitor, stage.id, 'shape');
    // Один и тот же вход (одна сессия) в двух вкладках — так бывает в жизни постоянно
    const first = await joinTeam(ctx, stage.visitor, stage.id);
    const second = await joinTeam(ctx, stage.visitor, stage.id);
    try {
      // В первой вкладке тянут источник
      send(first, { type: 'presence', at: { sourceId: source.id, x: 42, y: 24, width: 300, height: 60 } });

      // Ей самой — «это я», второй вкладке того же человека — «это не ты»:
      // иначе вторая вкладка промолчит, и человек не увидит, что где-то идёт движение
      const own = await nextPresence(first);
      assert.equal(own.people[0].mine, true, 'своя вкладка узнаёт своё движение');
      const other = await nextPresence(second);
      assert.equal(other.people[0].sourceId, source.id);
      assert.equal(other.people[0].mine, false, 'вторая вкладка того же человека — чужая рука');
      assert.equal(other.people[0].name, stage.visitor.displayName || other.people[0].name);

      // Запись всё равно одна на человека: присутствие не удваивается
      assert.equal(ctx.server.realtime.presenceOf(stage.id).length, 1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('во время перетаскивания уходит весь прямоугольник, а не только сдвиг', async () => {
    /* Ошибка, которую ловит эта проверка, была настоящей: страница присылала только
       x и y (что изменилось), а сервер справедливо ждал все четыре числа. В итоге
       присутствие не работало вовсе — молча, ведь негодное сообщение не считается. */
    const source = await addSource(stage.visitor, stage.id, 'shape');
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    const owner = await joinTeam(ctx, stage.visitor, stage.id);
    try {
      // Так же, как страница: источник целиком, с положением и размером
      const shown = { sourceId: source.id, x: 320, y: 180, width: source.width, height: source.height, end: false };
      send(helper, { type: 'presence', at: shown });
      const seen = await nextPresence(owner);
      assert.equal(seen.people.length, 1, 'присутствие принято, а не отброшено');
      assert.deepEqual(
        { sourceId: seen.people[0].sourceId, x: seen.people[0].x, y: seen.people[0].y, width: seen.people[0].width, height: seen.people[0].height },
        { sourceId: source.id, x: 320, y: 180, width: Math.round(source.width), height: Math.round(source.height) },
      );

      // А сообщение без размера — негодное: сервер не выдумывает размер за страницу
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 1, y: 1, end: false } });
      await hold(250);
      assert.equal(ctx.server.realtime.presenceOf(stage.id)[0].x, 320, 'негодное сообщение не сдвинуло источник');
    } finally {
      await Promise.all([helper.close(), owner.close()]);
    }
  });

  it('ушёл из команды — пропадает и присутствие: права проверяются перед каждой отправкой', async () => {
    const source = await addSource(stage.visitor, stage.id, 'shape');
    const helper = await joinTeam(ctx, moderator.visitor, stage.id);
    try {
      send(helper, { type: 'presence', at: { sourceId: source.id, x: 3, y: 3, width: 10, height: 10 } });
      await waitFor(() => ctx.server.realtime.presenceOf(stage.id).length === 1, 'присутствие появилось');
      await stage.visitor.post(`/api/workspaces/${stage.id}/members/remove`, { username: moderator.username });
      // Канал закрыт, а «двигает» больше никого не держит
      await waitFor(() => ctx.server.realtime.presenceOf(stage.id).length === 0, 'присутствие убрано вместе с правами');
      assert.equal((await helper.closed).code, 4403);
    } finally {
      await helper.close();
    }
  });
});

/* ========================================================================== */

describe('Этап 7 — на странице: изменение применяется, а не подошло — перечитываем', () => {
  const readStore = () => codeOf(readPublic('js/editor/store.js'));

  it('изменение не по порядку, непонятное или про незнакомый источник — не применяется', () => {
    const code = readStore();
    // Порядок строгий: изменение годится, только если оно ровно на шаг новее
    assert.match(code, /if \(typeof nextVersion === 'number' && nextVersion !== version \+ 1\) return false;/);
    // Незнакомый источник — значит, страница отстала: перечитываем
    assert.match(code, /if \(put\.some\(\(item\) => !item \|\| !known\.has\(item\.id\)\)\) return false;/);
    assert.match(code, /if \(add\.some\(\(item\) => !item \|\| known\.has\(item\.id\)\)\) return false;/);
    assert.match(code, /if \(remove\.some\(\(id\) => !known\.has\(id\)\)\) return false;/);
    // Не подошло — перечитываем сцену обычным запросом
    assert.match(code, /if \(applyDelta\(message\.delta, message\.version\)\) return;/);
    assert.match(code, /queueRefetch\(\);/);
  });

  it('неотправленная правка человека остаётся поверх пришедшего изменения', () => {
    const code = readStore();
    // Источник из изменения склеивается с тем, что человек ещё не отправил
    assert.match(code, /function mergeServer\(server\) \{/);
    assert.match(code, /applyPatch\(server, patch\)/);
  });

  it('оверлей тоже применяет изменение, а не подошло — перечитывает сцену', () => {
    const code = codeOf(readPublic('js/pages/overlay.js'));
    assert.match(code, /function applyDelta\(delta, nextVersion\)/);
    assert.match(code, /if \(applyDelta\(msg\.delta, msg\.version\)\) \{/);
    assert.match(code, /sync\(typeof msg\.version === 'number' \? msg\.version : Infinity\)/);
    // Настройки и состояние, которые не изменились, остаются теми же объектами:
    // иначе ролик начинался бы заново от каждой чужой правки
    assert.match(code, /if \(old\.settings === settings\) source\.settings = old\.source\.settings;/);
  });

  it('перетаскивание: показать сразу, сохранить при отпускании, сообщить о присутствии', () => {
    const stage = codeOf(readPublic('js/editor/stage.js'));
    // Пока тянут — на сервер ничего не сохраняется (save: false), но присутствие уходит
    assert.match(stage, /store\.change\(drag\.id, patch, \{ save: false \}\);\s*store\.moving\(drag\.id\);/);
    // Отпустили — «двигаю» снимается сразу и правка отправляется
    assert.match(stage, /store\.stoppedMoving\(\);\s*store\.flush\(\);/);
    // Чужая рука на сцене видна: кто и что двигает
    assert.match(stage, /двигает: \$\{source\.name\}/);
    // Своё присутствие не рисуется поверх собственной руки
    assert.match(stage, /if \(person\.mine\) continue;/);
  });

  it('присутствие шлётся не чаще, чем полезно глазам, и в базу не попадает', () => {
    const store = readStore();
    assert.match(store, /const PRESENCE_EVERY_MS = 120;/);
    assert.match(store, /if \(time - presenceLast < PRESENCE_EVERY_MS\) return;/);
    // Присутствие не идёт через очередь команд и не поднимает версию сцены
    const lines = store.split('\n');
    const start = lines.findIndex((line) => line.includes('moving(id, patch)'));
    const body = lines.slice(start, start + 12).join('\n');
    assert.doesNotMatch(body, /enqueue|pending\.set|scheduleFlush/);
    // На сервере присутствие тоже не пишется в базу: в hub.js нет ни одной записи
    assert.doesNotMatch(codeOf(readServer('ws/hub.js')), /INSERT INTO|UPDATE |DELETE FROM/);
  });

  it('каждая правка несёт изменение, иначе страницы не смогут обойтись без перечитывания', () => {
    const code = codeOf(readServer('scene/scene.js'));
    assert.match(code, /function deltaOf\(\{ add = \[\], put = \[\], order, remove = \[\] \} = \{\}\)/);
    assert.match(code, /function putOf\(before, after\)/);
    // И передаётся вместе с сигналом, а не отдельным сообщением
    assert.match(code, /onChange\(\{[\s\S]*?delta/);
  });
});

/* ========================================================================== */

describe('Этап 7 — обновление с прошлого этапа', () => {
  it('сервер сообщает текущий этап и версию структуры базы', async () => {
    const ctx = await startServer();
    try {
      const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
      assert.equal(health.stage, PLATFORM_STAGE);
      // Этап не откатывается назад: прошлый этап уже позади
      assert.ok(health.stage >= 7);
      assert.equal(health.db.schemaVersion, SCHEMA_VERSION);
      assert.equal(health.db.schemaVersion, 6);
      assert.equal(health.db.latestMigration, LATEST_MIGRATION);
      assert.equal(health.db.latestMigration, '006_live_edits');
    } finally {
      await ctx.stop();
    }
  });

  it('база этапа 6 открывается и работает: прежние входы, сцена и ссылка оверлея на месте', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-live-upgrade-'));
    // Настоящая ссылка оверлея: её алфавит уже, чем «любые 32 знака»
    const { newOverlayToken, newLinkToken } = await import('../src/server/auth/tokens.js');
    const LINK = newOverlayToken();
    const SOURCE = newLinkToken(12);
    try {
      // Всё, что было в базе к концу этапа 6
      const old = (await import('../src/server/db/database.js')).openDatabase(path.join(tmpDir, 'auth-test.db'), { upToVersion: 5 });
      assert.equal(old.getHealth().schemaVersion, 5);
      const { createAccounts } = await import('../src/server/auth/accounts.js');
      const accounts = createAccounts({ db: old.raw, passwordCost: FAST });
      // Вход того же вида, что у настоящего сервера: тот же способ проверки пароля
      const registered = await accounts.register({ username: 'live_old', displayName: 'Старожил', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      assert.ok(registered);
      const userId = old.raw.prepare("SELECT id FROM users WHERE username_key = 'live_old'").get().id;
      const workspaceId = 'st4gew4tchhh';
      old.raw.prepare('INSERT INTO workspaces (public_id, owner_id, name, created_at, updated_at, overlay_token, overlay_token_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(workspaceId, userId, 'Площадка со сценой', Date.now(), Date.now(), LINK, Date.now());
      const room = old.raw.prepare('SELECT id FROM workspaces WHERE public_id = ?').get(workspaceId).id;
      old.raw.prepare(`INSERT INTO sources (public_id, workspace_id, type, name, x, y, width, height, layer, visible, settings)
        VALUES (?, ?, 'text', 'Надпись', 10, 20, 300, 100, 0, 1, '{"text":"Старая сцена"}')`)
        .run(SOURCE, room);
      old.raw.prepare('UPDATE workspaces SET scene_version = 1 WHERE id = ?').run(room);
      old.close();

      // Сервер этапа 7 открывает её сам и достраивает
      const ctx = await startServer({ tmpDir });
      try {
        const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
        assert.equal(health.db.schemaVersion, 6);
        assert.equal(health.db.latestMigration, '006_live_edits');

        // Прежний вход действует, прежняя сцена и ссылка оверлея — на месте
        const visitor = createVisitor(ctx.baseUrl);
        const login = await visitor.post('/api/auth/login', { username: 'live_old', password: GOOD_PASSWORD });
        assert.equal(login.status, 200);
        const scene = (await visitor.get(`/api/workspaces/${workspaceId}/scene`)).data;
        assert.equal(scene.scene.version, 1);
        assert.equal(scene.sources[0].settings.text, 'Старая сцена');
        const byLink = (await createVisitor(ctx.baseUrl).get(`/api/overlay/${LINK}`)).data;
        assert.equal(byLink.sources.length, 1, 'по прежней ссылке сцена открывается');

        // И изменение по живому каналу теперь приходит к новой правке
        const pass = await visitor.post(`/api/workspaces/${workspaceId}/live`);
        const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${workspaceId}&ticket=${pass.data.ticket}`);
        assert.equal((await socket.next()).type, 'hello');
        try {
          const moved = await visitor.patch(`/api/workspaces/${workspaceId}/scene/sources/${SOURCE}`, { x: 400 });
          assert.equal(moved.status, 200);
          const message = await socket.next();
          assert.equal(message.version, 2);
          assert.deepEqual(message.delta, { put: [{ id: SOURCE, x: 400 }] });
        } finally {
          await socket.close();
        }
      } finally {
        await ctx.stop();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */

describe('Этап 7 — страницы и документы рассказывают про правки на лету', () => {
  const readPublicPage = (name) => fs.readFileSync(path.join(PROJECT_DIR, 'public', name), 'utf8');

  it('страницы называют текущим этап 9, а прошлый — прошлым', () => {
    assert.match(readPublicPage('index.html'), /этап 9 из 9/);
    assert.match(readPublicPage('app.html'), /<span class="mono">9 \/ 9<\/span>/);
    assert.match(readPublicPage('app.html'), /этап 9 из 9 завершён/);
    assert.match(readPublicPage('app.html'), /Правки на лету в OBS и между модераторами/);
    // Ни одна страница и ни один скрипт больше не называют текущим этап 6
    const files = [];
    const stack = [path.join(PROJECT_DIR, 'public')];
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
      /* Ищем только подпись о текущем этапе: «этап 7 из 9», «7 / 9» кнопкой кабинета.
         Упоминание «(этап 7)» в пояснении к коду — это история, и она полезна. */
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /этап 8 из 9|>8 \/ 9</i, path.relative(PROJECT_DIR, file));
    }
  });

  it('редактор показывает, кто изменил сцену, — иначе подпись с сервера никто не увидит', () => {
    const html = readPublicPage('editor.html');
    assert.match(html, /id="actor-status"/, 'в шапке нет места для подписи автора');

    const page = fs.readFileSync(path.join(PROJECT_DIR, 'public/js/pages/editor.js'), 'utf8');
    assert.match(page, /function showActor\(actor\)/, 'подпись автора нигде не показывается');
    // Показывать её нужно по сигналу о сцене, и только когда правка не своя
    assert.match(page, /if \(msg\.what === 'scene'\) \{\s*\/\/.+\n\s*if \(!msg\.mine\) showActor\(msg\.actor\);/, 'подпись автора не показывается на приход правки');
    // Своё не подписываем: это видно по рамке выделения
    assert.match(page, /изменил \$\{actor\.name\}/);
  });

  it('оба README обещают «этап 9 из 9» и рассказывают про правки на лету', () => {
    for (const name of ['README.md', '../README.md']) {
      const text = fs.readFileSync(path.join(PROJECT_DIR, name), 'utf8');
      assert.match(text, /этап 9 из 9/, name);
      assert.match(text, /[Пп]равки на лету/, name);
    }
  });

  it('архитектура описывает изменение, присутствие и где страховка', () => {
    const plan = fs.readFileSync(path.join(PROJECT_DIR, '../docs/overlay-platform/ARCHITECTURE.md'), 'utf8');
    assert.match(plan, /этап 7/i);
    assert.match(plan, /\| ?7 ?\|/);
    for (const needle of ['Сделано на этапе 7', 'Присутствие', '006_live_edits', '`add`', '`put`', '`order`', '`remove`']) {
      assert.ok(plan.includes(needle), `в архитектуре нет «${needle}»`);
    }
  });

  it('версия платформы в описании — та же, что в package.json', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version, '0.7.0');
  });
});
