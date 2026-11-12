import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createOverlayServer } from '../src/server/app.js';

/* Этап 2: проверяем, что основа платформы действительно работает,
   а не просто «лежит в папке»: сервер, база, живой канал связи,
   страницы, стили, скрипты и шрифты. */

const PAGES = { '/': 'index.html', '/app': 'app.html' };

function makeServer(tmpDir) {
  return createOverlayServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: path.join(tmpDir, 'test-overlay.db'),
    uploadsDir: path.join(tmpDir, 'uploads'),
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket: нет ответа за 4 секунды'));
    }, 4000);

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        next() {
          if (inbox.length) return Promise.resolve(inbox.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('WebSocket: сообщение не пришло')), 4000);
            waiters.push((msg) => {
              clearTimeout(t);
              res(msg);
            });
          });
        },
        close() {
          return new Promise((res) => {
            ws.once('close', res);
            ws.close();
          });
        },
      });
    });
  });
}

function listPublicFiles(publicDir, pattern) {
  const found = [];
  const stack = [publicDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (pattern.test(entry.name)) found.push(full);
    }
  }
  return found.sort();
}

describe('Этап 2 — основа платформы', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let wsBase;
  let publicDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-overlay-test-'));
    server = makeServer(tmpDir);
    const { port } = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}/ws`;
    publicDir = server.config.publicDir;
  });

  after(async () => {
    if (server) await server.stop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /* ---------- Сервер и база ---------- */

  it('сервер отвечает, база данных открыта в надёжном режиме (WAL) и с контролем связей', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'krafen-overlay-platform');
    assert.equal(body.db.ok, true);
    assert.equal(body.db.engine, 'sqlite');
    assert.equal(body.db.journalMode, 'wal');
    assert.equal(body.db.foreignKeys, true);
    assert.equal(body.db.schemaVersion, 1);
    assert.equal(typeof body.realtime.connectedClients, 'number');
  });

  it('неизвестный адрес API возвращает понятную ошибку 404 в формате JSON', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await fetch(`${baseUrl}/api/does-not-exist`, { method });
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      assert.deepEqual(await res.json(), { ok: false, error: 'not_found' });
    }
  });

  it('испорченный запрос получает короткий ответ без внутренних подробностей сервера', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ это не json',
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'invalid_json' });
    assert.doesNotMatch(text, /node_modules|at\s+\S+\s+\(|SyntaxError/, 'в ответе не должно быть следов кода сервера');
  });

  /* ---------- Страницы ---------- */

  it('главная страница и рабочая среда открываются и содержат все слои атмосферы', async () => {
    for (const route of Object.keys(PAGES)) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `страница ${route} должна открываться`);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const html = await res.text();
      assert.match(html, /<div class="grain"/, `на странице ${route} нет слоя зернистости`);
      assert.match(html, /id="glow"/, `на странице ${route} нет фонового свечения`);
      assert.match(html, /<canvas id="rain"/, `на странице ${route} нет слоя дождя`);
      assert.match(html, /class="vignette"/, `на странице ${route} нет виньетки`);
      assert.match(html, /kra<em>fen<\/em>/, `на странице ${route} нет фирменного знака`);
      assert.match(html, /<html lang="ru">/, `страница ${route} должна быть помечена как русскоязычная`);
    }
  });

  it('несуществующая страница показывает «не найдено», а не подменяется главной', async () => {
    const res = await fetch(`${baseUrl}/net-takoy-stranitsy`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Страница не найдена/);
    assert.match(html, /<div class="grain"/, 'страница «не найдено» тоже должна быть в общем стиле');

    // Программе (не человеку) вместо страницы приходит короткий текстовый ответ
    const asset = await fetch(`${baseUrl}/styles/missing.css`, { headers: { Accept: 'text/css,*/*;q=0.1' } });
    assert.equal(asset.status, 404);
    assert.match(asset.headers.get('content-type') || '', /text\/plain/);
  });

  it('страницы можно показывать во встроенном окне (OBS, предпросмотр) и они защищены от чужих скриптов', async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.doesNotMatch(csp, /frame-ancestors/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'скрипты разрешены только свои');
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('на страницах нет встроенных скриптов и обработчиков — иначе защита их заблокирует', () => {
    for (const file of listPublicFiles(publicDir, /\.html$/)) {
      const html = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file);
      for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
        assert.match(m[1], /\bsrc="\/js\/[^"]+"/, `${name}: скрипт должен подключаться отдельным файлом`);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${name}: встроенный обработчик события`);
      assert.doesNotMatch(html, /javascript:/i, `${name}: ссылка-скрипт`);
    }
  });

  it('все стили, скрипты и значок сайта, подключённые на страницах, реально отдаются сервером', async () => {
    const seen = new Set();
    for (const file of listPublicFiles(publicDir, /\.html$/)) {
      const html = fs.readFileSync(file, 'utf8');
      for (const m of html.matchAll(/(?:href|src)="(\/(?:styles|js)\/[^"]+|\/favicon\.svg)"/g)) seen.add(m[1]);
    }
    assert.ok(seen.size >= 8, 'на страницах должны быть подключены стили и скрипты');

    // Скрипты подтягивают друг друга через import — проверяем и эти файлы
    const queue = [...seen];
    while (queue.length) {
      const asset = queue.shift();
      const res = await fetch(`${baseUrl}${asset}`);
      assert.equal(res.status, 200, `файл ${asset} не найден`);
      const type = res.headers.get('content-type') || '';
      if (asset.endsWith('.js')) {
        assert.match(type, /javascript/, `${asset}: неверный тип`);
        const code = await res.text();
        for (const m of code.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
          const next = new URL(m[1], `${baseUrl}${asset}`).pathname;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      } else if (asset.endsWith('.svg')) {
        assert.match(type, /image\/svg\+xml/, `${asset}: неверный тип`);
        await res.arrayBuffer();
      } else {
        assert.match(type, /text\/css/, `${asset}: неверный тип`);
        await res.arrayBuffer();
      }
    }
    assert.ok(seen.has('/js/core/atmosphere.js'), 'модуль зерна и атмосферы должен быть подключён');
  });

  it('каждая кнопка и поле, к которым обращаются скрипты страниц, есть в разметке', () => {
    const pairs = [
      ['js/pages/home.js', 'index.html'],
      ['js/pages/shell.js', 'app.html'],
    ];
    for (const [script, page] of pairs) {
      const code = fs.readFileSync(path.join(publicDir, script), 'utf8');
      const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
      const ids = new Set(
        [...code.matchAll(/(?:\$|getElementById)\('([\w-]+)'\)/g)].map((m) => m[1])
      );
      assert.ok(ids.size > 0, `${script}: не найдено обращений к элементам страницы`);
      for (const id of ids) {
        assert.ok(html.includes(`id="${id}"`), `${page}: нет элемента #${id}, который нужен ${script}`);
      }
    }
    // Вкладки и окна ссылаются друг на друга по id — эти связи тоже должны сходиться
    for (const file of listPublicFiles(publicDir, /\.html$/)) {
      const html = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file);
      const refs = [...html.matchAll(/(?:aria-controls|aria-labelledby|data-open-modal|data-close-modal|for)="([\w-]+)"/g)];
      for (const m of refs) {
        assert.ok(html.includes(`id="${m[1]}"`), `${name}: ссылка на несуществующий элемент #${m[1]}`);
      }
      const allIds = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
      assert.equal(new Set(allIds).size, allIds.length, `${name}: повторяющиеся id`);
    }
  });

  it('каждый класс оформления, использованный на страницах, описан в стилях', () => {
    const css = listPublicFiles(path.join(publicDir, 'styles'), /\.css$/)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

    for (const file of listPublicFiles(publicDir, /\.html$/)) {
      const html = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file);
      for (const m of html.matchAll(/\sclass="([^"]+)"/g)) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          assert.ok(defined.has(cls), `${name}: класс «${cls}» не описан в стилях`);
        }
      }
    }
  });

  /* ---------- Внешний вид: шрифты, палитра, зерно ---------- */

  it('все пять шрифтов раздаются с нашего сервера, включая кириллицу', async () => {
    const fontsCss = await (await fetch(`${baseUrl}/styles/fonts.css`)).text();
    assert.doesNotMatch(fontsCss, /https?:\/\//, 'шрифты не должны грузиться с внешних сайтов');

    const imports = [...fontsCss.matchAll(/@import\s+url\("([^"]+)"\)/g)].map((m) => m[1]);
    const families = new Set(imports.map((u) => u.split('/')[3]));
    assert.deepEqual(
      [...families].sort(),
      ['alice', 'cormorant-infant', 'jetbrains-mono', 'manrope', 'medula-one']
    );

    let fontFiles = 0;
    for (const cssUrl of imports) {
      const res = await fetch(`${baseUrl}${cssUrl}`);
      assert.equal(res.status, 200, `описание шрифта ${cssUrl} не найдено`);
      const css = await res.text();
      const family = cssUrl.split('/')[3];
      if (family !== 'medula-one') {
        // У Medula One кириллицы нет в природе — он используется только для латиницы и цифр
        assert.match(css, /cyrillic/, `в ${cssUrl} нет кириллического набора`);
      }
      const files = [...css.matchAll(/url\((\.\/files\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
      assert.ok(files.length > 0, `в ${cssUrl} нет файлов шрифта`);
      for (const file of files) {
        const fileUrl = new URL(file, `${baseUrl}${cssUrl}`).href;
        const fontRes = await fetch(fileUrl, { method: 'HEAD' });
        assert.equal(fontRes.status, 200, `файл шрифта ${fileUrl} не найден`);
        assert.match(fontRes.headers.get('content-type') || '', /font\/woff2/);
        fontFiles += 1;
      }
    }
    assert.ok(fontFiles >= 20, `ожидалось не меньше 20 файлов шрифтов, найдено ${fontFiles}`);
  });

  it('из папки шрифтов наружу не отдаётся ничего, кроме самих шрифтов', async () => {
    for (const probe of [
      '/vendor/fonts/alice/package.json',
      '/vendor/fonts/alice/README.md',
      '/vendor/fonts/alice/',
      '/vendor/fonts/../express/package.json',
      '/vendor/fonts/alice/files/..%2f..%2fpackage.json',
    ]) {
      const res = await fetch(`${baseUrl}${probe}`);
      assert.equal(res.status, 404, `${probe} не должен быть доступен`);
      await res.arrayBuffer();
    }
  });

  it('страницы ничего не загружают с посторонних сайтов', () => {
    for (const file of listPublicFiles(publicDir, /\.(html|css|js)$/)) {
      const text = fs.readFileSync(file, 'utf8');
      const name = path.relative(publicDir, file);
      assert.doesNotMatch(text, /(?:src|href|action)\s*=\s*["'](?:https?:)?\/\//i, `${name}: внешняя ссылка на ресурс`);
      assert.doesNotMatch(text, /url\(\s*["']?(?:https?:)?\/\//i, `${name}: внешний файл в стилях`);
      assert.doesNotMatch(text, /@import\s+["'](?:https?:)?\/\//i, `${name}: внешний импорт стилей`);
      assert.doesNotMatch(text, /\b(?:fetch|import)\(\s*["'`](?:https?:)?\/\//i, `${name}: обращение к внешнему адресу`);
    }
  });

  it('палитра и шрифты совпадают с krafen.me', () => {
    const tokens = fs.readFileSync(path.join(publicDir, 'styles/tokens.css'), 'utf8');
    const expected = {
      '--void': '#050505',
      '--abyss': '#0a0a0c',
      '--silver': '#a0a0a0',
      '--silver-dim': '#666666',
      '--silver-bright': '#e0e0e0',
      '--crimson': '#7c0a0a',
      '--crimson-bright': '#a31313',
      '--crimson-light': '#ff7a7a',
      '--glass': 'rgba(12, 12, 15, 0.66)',
      '--glass-border': 'rgba(160, 160, 160, 0.13)',
      '--line': 'rgba(160, 160, 160, 0.16)',
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(tokens.includes(`${name}: ${value};`), `цвет ${name} должен быть ${value}`);
    }
    for (const font of ['Medula One', 'Alice', 'Cormorant Infant', 'Manrope', 'JetBrains Mono']) {
      assert.ok(tokens.includes(`"${font}"`), `в дизайн-системе нет шрифта ${font}`);
    }
  });

  it('зерно создаётся тем же алгоритмом, что и на krafen.me (плитка 128×128)', () => {
    const code = fs.readFileSync(path.join(publicDir, 'js/core/atmosphere.js'), 'utf8');
    assert.match(code, /canvas\.width = 128/);
    assert.match(code, /canvas\.height = 128/);
    assert.match(code, /let seed = 0x5f3759df/);
    assert.match(code, /seed = \(seed \* 1664525 \+ 1013904223\) >>> 0/);
    assert.match(code, /const v = \(seed >>> 24\) & 255/);

    const css = fs.readFileSync(path.join(publicDir, 'styles/atmosphere.css'), 'utf8');
    const grainRule = css.match(/\.grain\s*\{([^}]+)\}/);
    assert.ok(grainRule, 'в стилях должно быть правило .grain');
    assert.match(grainRule[1], /background-size:\s*128px 128px/);
    assert.match(grainRule[1], /background-repeat:\s*repeat/);
    assert.match(grainRule[1], /pointer-events:\s*none/);
    const opacity = Number(grainRule[1].match(/opacity:\s*([\d.]+)/)?.[1]);
    assert.ok(opacity >= 0.03 && opacity <= 0.05, `непрозрачность зерна вне допустимого: ${opacity}`);

    // Зерно — не картинка-заготовка: готовых файлов шума в проекте быть не должно
    const images = listPublicFiles(publicDir, /\.(png|jpe?g|webp|gif)$/i);
    assert.deepEqual(images, [], 'зерно должно создаваться скриптом, а не лежать картинкой');
  });

  /* ---------- Живой канал связи ---------- */

  it('живой канал связи: приветствие, замер задержки и счётчик подключений', async () => {
    const a = await openSocket(`${wsBase}?channel=test-a`);
    const helloA = await a.next();
    assert.equal(helloA.type, 'hello');
    assert.equal(helloA.channel, 'test-a');
    assert.match(helloA.clientId, /^[0-9a-f-]{36}$/);

    const b = await openSocket(`${wsBase}?channel=test-b`);
    const helloB = await b.next();
    assert.notEqual(helloB.clientId, helloA.clientId);

    a.ws.send(JSON.stringify({ type: 'ping', clientTs: 777 }));
    const pong = await a.next();
    assert.equal(pong.type, 'pong');
    assert.equal(pong.clientTs, 777);
    assert.equal(pong.activeClients, 2);

    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.realtime.connectedClients, 2);

    await a.close();
    await b.close();

    // После отключения счётчик возвращается к нулю — «мёртвые» подключения не копятся
    const deadline = Date.now() + 2000;
    let left = -1;
    while (Date.now() < deadline) {
      left = (await (await fetch(`${baseUrl}/api/health`)).json()).realtime.connectedClients;
      if (left === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(left, 0);
  });

  it('живой канал связи не падает от мусорных сообщений', async () => {
    const c = await openSocket(wsBase);
    const hello = await c.next();
    assert.equal(hello.channel, 'system');

    c.ws.send('это не json {{{');
    const err = await c.next();
    assert.deepEqual(err, { type: 'error', code: 'invalid_json' });

    c.ws.send(JSON.stringify({ type: 'ping', clientTs: 'не число' }));
    const pong = await c.next();
    assert.equal(pong.type, 'pong');
    assert.equal(pong.clientTs, null);

    await c.close();
  });

  it('посторонний адрес не принимается за канал связи', async () => {
    await assert.rejects(openSocket(`${wsBase.replace('/ws', '/not-ws')}`));
  });

  it('в коде страниц нет привязки к адресу конкретного компьютера', () => {
    const files = listPublicFiles(publicDir, /\.(html|js|css)$/);
    for (const file of files) {
      assert.doesNotMatch(
        fs.readFileSync(file, 'utf8'),
        /localhost|127\.0\.0\.1|0\.0\.0\.0/i,
        `${path.relative(publicDir, file)} обращается к локальному адресу`
      );
    }
    assert.ok(files.length >= 10);
  });
});

describe('Этап 2 — сохранность данных', () => {
  it('после перезапуска сервера база не создаётся заново и обновления не применяются повторно', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-overlay-restart-'));
    try {
      const first = makeServer(tmpDir);
      await first.start();
      first.db.raw
        .prepare("INSERT INTO system_settings (key, value) VALUES ('restart_probe', 'сохранено')")
        .run();
      await first.stop();

      const second = makeServer(tmpDir);
      await second.start();
      const probe = second.db.raw
        .prepare("SELECT value FROM system_settings WHERE key = 'restart_probe'")
        .get();
      const migrations = second.db.raw
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get();
      await second.stop();

      assert.equal(probe?.value, 'сохранено');
      assert.equal(migrations.n, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('запуск сервера не оставляет в папке данных ничего, кроме базы и загрузок', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-overlay-files-'));
    try {
      const srv = makeServer(tmpDir);
      await srv.start();
      await srv.stop();
      const entries = fs.readdirSync(tmpDir).sort();
      for (const entry of entries) {
        assert.match(entry, /^(test-overlay\.db(-wal|-shm)?|uploads)$/, `неожиданный файл: ${entry}`);
      }
      assert.ok(entries.includes('test-overlay.db'));
      assert.ok(entries.includes('uploads'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
