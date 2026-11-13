import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/* Этап 7: страница применяет изменение сама.
   Здесь проверяется настоящий код страницы — public/js/editor/store.js, тот же,
   что открывает браузер. Сети нет: вместо ответов сервера — подставные данные,
   а вместо живого канала — прямой вызов store.signal().

   Что важно: применённое изменение не должно расходиться с тем, что показало бы
   перечитывание сцены. Поэтому каждая проверка сравнивает одно с другим. */

const shown = (id, extra = {}) => ({
  id, type: 'text', name: id, x: 0, y: 0, width: 10, height: 10, opacity: 100,
  visible: true, locked: false, settings: { text: id }, ...extra,
});

const sceneData = (sources, version = 1) => ({
  workspace: { id: 'w', name: 'Площадка', role: 'owner' },
  scene: { width: 1920, height: 1080, version },
  sources,
  media: [],
  limits: { sources: 100 },
  usage: { files: 0, storageBytes: 0 },
  serverTime: Date.now(),
});

// Заглушки того, что нужно store.js: он написан для браузера, а проверяется в Node.js
const saved = {};
const stubs = {
  performance: () => ({ now: () => Date.now() }),
  window: () => ({ location: { href: '' }, addEventListener: () => {} }),
};

let createStore = null;
before(async () => {
  for (const [name, make] of Object.entries(stubs)) {
    saved[name] = globalThis[name];
    if (!globalThis[name]) globalThis[name] = make();
  }
  ({ createStore } = await import('../public/js/editor/store.js'));
});
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

/* Новая страница с заданной сценой. serverScene — то, что сервер отдаст на запрос
   перечитывания; fetches считает такие запросы (если изменение применилось само,
   лишнего запроса быть не должно). */
async function page(sources, version = 1) {
  const state = { scene: sceneData(sources, version) };
  const counts = { fetches: 0 };
  globalThis.fetch = async () => {
    counts.fetches += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, ...state.scene }) };
  };
  const store = createStore({ workspaceId: 'w', clientId: 'page1', notify: () => {} });
  await store.load();
  return {
    store,
    counts,
    serverNow: (nextSources, nextVersion) => { state.scene = sceneData(nextSources, nextVersion); },
  };
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Этап 7 — изменение применяется к копии сцены', () => {
  it('новый источник встаёт на своё место в порядке слоёв', async () => {
    const { store } = await page([shown('aaaa')]);
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { add: [shown('cccc')], order: ['cccc', 'aaaa'] } });
    assert.deepEqual(store.state.sources.map((source) => source.id), ['cccc', 'aaaa']);
  });

  it('правка меняет только присланное; нетронутый источник остаётся тем же объектом', async () => {
    const { store } = await page([shown('aaaa'), shown('bbbb')]);
    const untouched = store.state.sources[1];
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { put: [{ id: 'aaaa', x: 500 }] } });
    assert.equal(store.find('aaaa').x, 500);
    assert.equal(store.find('aaaa').y, 0, 'остальное у источника не пострадало');
    // Сцена не перерисовывает то, что не менялось
    assert.equal(store.state.sources[1], untouched);
  });

  it('удаление убирает источник, и порядок сходится', async () => {
    const { store } = await page([shown('aaaa'), shown('bbbb')]);
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { remove: ['aaaa'], order: ['bbbb'] } });
    assert.deepEqual(store.state.sources.map((source) => source.id), ['bbbb']);
  });

  it('применённое изменение совпадает с перечитыванием сцены', async () => {
    const { store, counts, serverNow } = await page([shown('aaaa'), shown('bbbb')]);
    const add = shown('cccc', { x: 300, settings: { text: 'Новый' } });
    const next = [store.find('aaaa'), { ...store.find('bbbb'), x: 44 }, add];
    // Сервер уже знает новое состояние — если бы страница перечитала сцену, она получила бы это
    serverNow(next, 2);
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { add: [add], put: [{ id: 'bbbb', x: 44 }], order: ['aaaa', 'bbbb', 'cccc'] } });
    const applied = store.state.sources;
    // Изменение применилось само: без нашего refresh() страница к серверу не ходила
    assert.equal(counts.fetches, 1, 'изменение применилось без запроса сцены');
    await store.refresh(); // а теперь перечитываем нарочно
    await settle();
    assert.deepEqual(store.state.sources, applied, 'на лету и после перечитывания — одно и то же');
  });

  it('неотправленная правка человека остаётся поверх пришедшего изменения', async () => {
    const { store } = await page([shown('aaaa')]);
    store.change('aaaa', { x: 42 }, { save: false }); // ещё не отправлено
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { put: [{ id: 'aaaa', x: 999, y: 7 }] } });
    assert.equal(store.find('aaaa').x, 42, 'своё не потерялось');
    assert.equal(store.find('aaaa').y, 7, 'чужое применилось');
  });
});

describe('Этап 7 — когда изменение не подходит, сцену перечитывают', () => {
  it('изменение через версию (пропуск) не применяется — вместо него запрос сцены', async () => {
    const { store, counts } = await page([shown('aaaa')]);
    store.signal({ what: 'scene', version: 5, origin: 'other', delta: { put: [{ id: 'aaaa', x: 1 }] } });
    await settle();
    assert.equal(counts.fetches, 2, 'сцена перечитана');
    assert.equal(store.find('aaaa').x, 0, 'изменение с пропуском не применилось');
  });

  it('источник, которого страница не знает, — тоже повод перечитать', async () => {
    const { store, counts } = await page([shown('aaaa')]);
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { put: [{ id: 'zzzz', x: 1 }] } });
    await settle();
    assert.equal(counts.fetches, 2);
  });

  it('своя же правка и уже известная версия не трогают страницу', async () => {
    const { store, counts } = await page([shown('aaaa')]);
    store.signal({ what: 'scene', version: 2, origin: 'page1', delta: { put: [{ id: 'aaaa', x: 5 }] } });
    store.signal({ what: 'scene', version: 1, origin: 'other', delta: { put: [{ id: 'aaaa', x: 5 }] } });
    await settle();
    assert.equal(counts.fetches, 1);
    assert.equal(store.find('aaaa').x, 0);
  });

  it('испорченное изменение не ломает страницу: просто перечитываем сцену', async () => {
    const { store, counts } = await page([shown('aaaa')]);
    for (const bad of [null, {}, { put: 'нет' }, { order: 'нет' }, { remove: 5 }, { add: [{}] }]) {
      store.signal({ what: 'scene', version: 2, origin: 'other', delta: bad });
    }
    await settle();
    assert.ok(counts.fetches > 1, 'сцена перечитана');
    assert.equal(store.state.sources.length, 1, 'сцена на странице цела');
  });
});

describe('Этап 7 — присутствие на странице', () => {
  it('о положении сообщается не чаще, чем полезно глазам, и форма сообщения одна', async () => {
    const { store } = await page([shown('aaaa', { x: 40, y: 30, width: 300, height: 60 })]);
    const sent = [];
    store.setPresenceChannel((message) => sent.push(message));
    store.moving('aaaa');
    store.moving('aaaa'); // не успело — пропущено
    assert.equal(sent.length, 1);
    /* Прямоугольник — весь, из сцены, а не из присланной правки: правка во время
       перетаскивания несёт только то, что изменилось (чаще всего x и y), а вторая
       страница по двум числам не нарисует ни рамку, ни источник. Сервер к тому же
       без всех четырёх чисел сообщение отбрасывает — молча, поэтому ошибка была тихой. */
    assert.deepEqual(sent[0], { sourceId: 'aaaa', x: 40, y: 30, width: 300, height: 60, end: false });
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(typeof sent[0][key], 'number', `в сообщении о присутствии нет ${key}`);
    }
    store.stoppedMoving();
    assert.deepEqual(sent[sent.length - 1], { end: true });
  });

  it('движение, которого нет на сцене, никуда не сообщается', async () => {
    const { store } = await page([shown('aaaa')]);
    const sent = [];
    store.setPresenceChannel((message) => sent.push(message));
    store.moving('zzzz');
    assert.deepEqual(sent, []);
  });

  it('присутствие не трогает сцену: ни положения, ни версии', async () => {
    const { store } = await page([shown('aaaa')]);
    store.setPresenceChannel(() => {});
    store.moving('aaaa');
    store.setPresence([{ name: 'Помощник', role: 'moderator', sourceId: 'aaaa', x: 1, y: 1, width: 9, height: 9, mine: false }]);
    assert.equal(store.find('aaaa').x, 0);
    assert.equal(store.presenceOf('aaaa').name, 'Помощник');
  });

  it('без живого канала двигать можно: сообщение просто не уходит', async () => {
    const { store } = await page([shown('aaaa')]);
    store.setPresenceChannel(null);
    assert.doesNotThrow(() => {
      store.moving('aaaa');
      store.stoppedMoving();
    });
  });

  it('снятая подпись не остаётся: присутствие приходит целиком и заменяет прежнее', async () => {
    const { store } = await page([shown('aaaa')]);
    store.setPresence([
      { name: 'Помощник', sourceId: 'aaaa', x: 1, y: 1, width: 9, height: 9, mine: false },
      { name: 'Гость', sourceId: 'aaaa', x: 2, y: 2, width: 9, height: 9, mine: false },
    ]);
    assert.equal(store.presence().length, 1, 'на один источник — одна запись');
    store.setPresence([]);
    assert.equal(store.presence().length, 0);
  });
});
