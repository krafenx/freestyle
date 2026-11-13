import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/* Этап 8: отмена своих действий (Ctrl+Z).
   Проверяется настоящий код страницы — public/js/editor/store.js, тот же, что открывает
   браузер. Сеть заменена подставным сервером: он запоминает запросы и отвечает так же,
   как настоящий, чтобы было видно, что именно уехало. */

const shown = (id, extra = {}) => ({
  id, type: 'text', name: id, x: 0, y: 0, width: 100, height: 50, opacity: 100,
  visible: true, locked: false, settings: { text: id }, ...extra,
});

let createStore = null;
const saved = {};
before(async () => {
  for (const [name, make] of Object.entries({
    performance: () => ({ now: () => Date.now() }),
    window: () => ({ location: { href: '' }, addEventListener: () => {} }),
  })) {
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

/* Подставной сервер: сцена, версия и список того, что у него просили.
   Отвечает теми же полями, что настоящий, — иначе проверка была бы про заглушку. */
async function open(sources, { version = 1 } = {}) {
  const calls = [];
  let current = sources.map((source) => ({ ...source }));
  const state = { version };
  const nextVersion = () => (state.version += 1);

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/scene/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, path, body });
    const answer = (payload) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...payload }) });

    if (method === 'GET') {
      return answer({
        workspace: { id: 'w', name: 'Площадка', role: 'owner' },
        scene: { width: 1920, height: 1080, version: state.version },
        sources: current.map((source) => ({ ...source })), media: [],
        limits: { sources: 100 }, usage: { files: 0, storageBytes: 0 }, serverTime: Date.now(),
      });
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(path.match(/\/sources\/([^/]+)/)[1]);
      current = current.map((source) => (source.id === id
        ? { ...source, ...body, settings: { ...source.settings, ...(body.settings || {}) } }
        : source));
      return answer({ version: nextVersion(), source: current.find((source) => source.id === id) });
    }
    if (path === '/sources' && method === 'POST') {
      const created = { ...shown(`new${current.length + 1}`, body.props || {}), ...body.props, id: `new${current.length + 1}` };
      current = [...current, created];
      return answer({ version: nextVersion(), source: created, order: current.map((source) => source.id) });
    }
    const del = path.match(/\/sources\/([^/]+)\/delete/);
    if (del) {
      const id = decodeURIComponent(del[1]);
      current = current.filter((source) => source.id !== id);
      return answer({ version: nextVersion(), order: current.map((source) => source.id) });
    }
    const move = path.match(/\/sources\/([^/]+)\/move/);
    if (move) {
      const id = decodeURIComponent(move[1]);
      const source = current.find((item) => item.id === id);
      const rest = current.filter((item) => item.id !== id);
      rest.splice(Math.max(0, Math.min(rest.length, body.index)), 0, source);
      current = rest;
      return answer({ version: nextVersion(), order: current.map((item) => item.id) });
    }
    return { ok: false, status: 400, json: async () => ({ ok: false, error: 'unexpected' }) };
  };

  const store = createStore({ workspaceId: 'w', clientId: 'tab1', notify: () => {} });
  await store.load();
  return { store, calls, server: () => current, version: () => state.version };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Этап 8 — отмена своих действий', () => {
  it('правка отменяется до отправки: ни запроса, ни новой версии', async () => {
    const { store, calls, server } = await open([shown('aaaa')]);
    store.change('aaaa', { x: 500 });
    assert.equal(store.find('aaaa').x, 500, 'на странице правка видна сразу');
    assert.equal(store.history().canUndo, true);

    store.undo();
    assert.equal(store.find('aaaa').x, 0, 'отмена вернула прежнее');
    await settle(); // дольше паузы перед отправкой
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0, 'на сервер ничего не ушло');
    assert.equal(server()[0].x, 0);
  });

  it('повтор возвращает отменённое, и только потом оно уходит на сервер', async () => {
    const { store, calls } = await open([shown('aaaa')]);
    store.change('aaaa', { x: 500 });
    store.undo();
    assert.equal(store.history().canRedo, true);
    store.redo();
    assert.equal(store.find('aaaa').x, 500, 'повтор вернул значение');
    await settle();
    const patches = calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1, 'после повтора правка ушла на сервер');
    assert.equal(patches[0].body.x, 500);
  });

  it('несколько правок подряд отменяются по одной, в обратном порядке', async () => {
    const { store } = await open([shown('aaaa')]);
    store.change('aaaa', { x: 10 });
    store.change('aaaa', { x: 20 });
    store.change('aaaa', { y: 30 });
    store.undo();
    assert.equal(store.find('aaaa').y, 0, 'последняя правка отменена');
    assert.equal(store.find('aaaa').x, 20, 'предыдущая осталась');
    store.undo();
    assert.equal(store.find('aaaa').x, 10, 'и ещё одна — до значения перед ней');
    store.undo();
    assert.equal(store.find('aaaa').x, 0, 'и самая первая');
  });

  it('отмена одной настройки не стирает соседнюю, сделанную после', async () => {
    const { store } = await open([shown('aaaa')]);
    store.change('aaaa', { settings: { text: 'первый' } });
    store.change('aaaa', { settings: { color: '#ff0000' } });
    store.undo();
    assert.equal(store.find('aaaa').settings.text, 'первый', 'соседняя настройка цела');
    assert.notEqual(store.find('aaaa').settings.color, '#ff0000', 'а отменённая — вернулась');
  });

  it('своё действие не отменяется после того, как чужая правка уже сохранена? — отменяется только своя очередь', async () => {
    const { store, calls } = await open([shown('aaaa'), shown('bbbb')]);
    store.change('aaaa', { x: 111 });
    await settle(); // эта правка ушла на сервер
    store.change('bbbb', { x: 222 }); // а эта ещё нет
    const sentBefore = calls.filter((call) => call.method === 'PATCH').length;
    store.undo();
    assert.equal(store.find('bbbb').x, 0, 'неотправленная правка отменена');
    assert.equal(store.find('aaaa').x, 111, 'уже сохранённую отмена не трогает');
    await settle();
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, sentBefore, 'лишнего запроса нет');
  });

  it('пока источник тянут, история не растёт', async () => {
    const { store } = await open([shown('aaaa')]);
    store.change('aaaa', { x: 5 }, { save: false });
    store.change('aaaa', { x: 9 }, { save: false });
    assert.equal(store.history().canUndo, false, 'перетаскивание — не действие для отмены');
  });

  it('отмена добавления убирает источник и на странице, и на сервере', async () => {
    const { store, calls, server } = await open([shown('aaaa')]);
    const created = await store.create('text');
    assert.equal(store.state.sources.length, 2);
    store.undo();
    await settle();
    assert.equal(store.state.sources.length, 1, 'на странице источника нет');
    assert.equal(calls.some((call) => /\/delete$/.test(call.path)), true, 'удаление ушло на сервер');
    assert.equal(server().length, 1, 'и на сервере его нет');
    assert.equal(created.id, 'new2');
  });

  it('отмена удаления возвращает источник и его место в слоях', async () => {
    const { store, calls, server } = await open([shown('aaaa'), shown('bbbb'), shown('cccc')]);
    await store.remove('bbbb');
    assert.deepEqual(store.state.sources.map((source) => source.id), ['aaaa', 'cccc']);
    store.undo();
    await settle();
    assert.equal(store.state.sources.some((source) => source.name === 'bbbb'), true, 'источник вернулся');
    assert.equal(calls.filter((call) => call.path === '/sources').length, 1, 'на сервере он создан заново');
    assert.equal(server().length, 3, 'и снова их трое');
    assert.deepEqual(server().map((source) => source.name), ['aaaa', 'bbbb', 'cccc'], 'и стоит на своём месте');
  });

  it('отмена порядка возвращает прежний порядок слоёв и на сервере', async () => {
    const { store, calls } = await open([shown('aaaa'), shown('bbbb'), shown('cccc')]);
    await store.move('aaaa', 2);
    assert.deepEqual(store.state.sources.map((source) => source.id), ['bbbb', 'cccc', 'aaaa']);
    store.undo();
    await settle();
    assert.deepEqual(store.state.sources.map((source) => source.id), ['aaaa', 'bbbb', 'cccc'], 'порядок прежний');
    assert.ok(calls.filter((call) => /\/move$/.test(call.path)).length >= 2, 'перестановки ушли на сервер');
  });

  it('историю не подделать с клавиатуры дважды: отменять больше нечего — ничего и не происходит', async () => {
    const { store } = await open([shown('aaaa')]);
    assert.equal(store.undo(), null);
    assert.equal(store.redo(), null);
    assert.equal(store.find('aaaa').x, 0);
  });

  it('чужая правка поверх отменённой не воскресает и не спорит с ней', async () => {
    const { store } = await open([shown('aaaa')]);
    store.change('aaaa', { x: 500 });
    store.signal({ what: 'scene', version: 2, origin: 'other', delta: { put: [{ id: 'aaaa', y: 9 }] } });
    store.undo();
    assert.equal(store.find('aaaa').x, 0, 'своё отменено');
    assert.equal(store.find('aaaa').y, 9, 'чужое осталось');
  });
});
