import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checkBackup, createBackup } from '../src/server/backup.js';

/* Этап 9: резервные копии. Проверяется не «создался ли файл», а то, ради чего
   копию делают: что из неё действительно можно поднять работающую платформу. */

let root;
const at = new Date('2026-03-14T01:02:03Z');

/* База делается настоящая — теми же миграциями, что и на сервере, и через сервер же,
   чтобы в копию попало то, что там на самом деле лежит. */
async function makeInstall() {
  const { openDatabase } = await import('../src/server/db/database.js');
  const { createAccounts } = await import('../src/server/auth/accounts.js');
  const { createWorkspaces } = await import('../src/server/workspaces/workspaces.js');
  const base = fs.mkdtempSync(path.join(root, 'data-'));
  const dbPath = path.join(base, 'overlay.db');
  const uploadsDir = path.join(base, 'uploads');
  const db = openDatabase(dbPath);

  /* Данные собираются теми же модулями, что и на сервере, а не вставками в таблицы:
     так проверка не сломается, если у таблиц появится новый обязательный столбец. */
  const accounts = createAccounts({ db: db.raw, passwordCost: { N: 4096, r: 8, p: 1 } });
  const workspaces = createWorkspaces({ db: db.raw });
  await accounts.register({ username: 'anna', displayName: 'Аня', password: 'длинный надёжный пароль 42' });
  // Наружу отдаётся только имя, внутренний номер берём из базы
  const userId = db.raw.prepare('SELECT id FROM users WHERE username_key = ?').get('anna').id;
  const created = workspaces.create({ userId, name: 'Пятничный стрим' });
  const workspaceId = created.workspace.id;
  const workspaceRow = db.raw.prepare('SELECT id, public_id FROM workspaces WHERE public_id = ?').get(workspaceId);

  // Два файла: целый и «недописанный» (размер в базе больше, чем на диске)
  const media = [
    { public_id: 'file-good-0001', size: 11, name: 'картинка.png' },
    { public_id: 'file-short-001', size: 99, name: 'ролик.mp4' },
  ];
  for (const item of media) {
    db.raw.prepare(`INSERT INTO media_files (public_id, workspace_id, uploaded_by, kind, mime, size_bytes, width, height, name, created_at)
                    VALUES (?, ?, ?, 'image', 'image/png', ?, 10, 10, ?, ?)`)
      .run(item.public_id, workspaceRow.id, userId, item.size, item.name, Date.now());
  }
  fs.mkdirSync(path.join(uploadsDir, workspaceId), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, workspaceId, 'file-good-0001'), 'hello world'); // ровно 11
  fs.writeFileSync(path.join(uploadsDir, workspaceId, 'file-short-001'), 'обрезано'); // не 99

  // Не оставляем базу открытой: сервер закрывает её при остановке, копия снимается с файла
  db.close();
  return { base, dbPath, uploadsDir, workspaceId, workspaceRow: workspaceRow.public_id, userId, accounts, db };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-backup-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Этап 9 — резервные копии', () => {
  it('копия базы снимается с работающей базы вместе с последними записями', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    /* Пишем «прямо сейчас», не закрывая базу: так делает живой сервер. Обычное
       копирование файла .db потеряло бы эту запись — она ещё в .db-wal. */
    const { openDatabase } = await import('../src/server/db/database.js');
    const { createAccounts } = await import('../src/server/auth/accounts.js');
    const live = openDatabase(dbPath);
    const accounts = createAccounts({ db: live.raw, passwordCost: { N: 4096, r: 8, p: 1 } });
    await accounts.register({ username: 'boris', displayName: 'Борис', password: 'ещё один длинный пароль 42' });
    assert.ok(fs.existsSync(`${dbPath}-wal`), 'запись должна лежать в WAL — иначе проверка ничего не значит');

    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies'), now: () => at });
    live.close();

    assert.equal(made.name, 'backup-20260314-010203');
    assert.equal(made.manifest.schemaVersion > 0, true);
    // Именно эта запись и проверяется: она была в WAL
    const copy = new DatabaseSync(path.join(made.dir, 'overlay.db'), { readOnly: true });
    const boris = copy.prepare('SELECT display_name FROM users WHERE username = ?').get('boris');
    copy.close();
    assert.equal(boris?.display_name, 'Борис', 'последняя запись должна попасть в копию');
  });

  it('в копию попадают только целые файлы, и об этом сказано в описи', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies2'), now: () => at });
    assert.equal(made.manifest.media.known, 2);
    assert.equal(made.manifest.media.copied, 1);
    assert.equal(made.manifest.media.bytes, 11);
    // Про пропущенный файл сказано поимённо и с причиной — иначе копия молча неполная
    assert.equal(made.manifest.media.missing, 1);
    assert.equal(made.manifest.media.skipped.length, 1);
    assert.equal(made.manifest.media.skipped[0].file, 'file-short-001');
    assert.match(made.manifest.media.skipped[0].why, /размер/);
    assert.equal(fs.readFileSync(path.join(made.dir, 'uploads', workspaceRow, 'file-good-0001'), 'utf8'), 'hello world');
    assert.equal(fs.existsSync(path.join(made.dir, 'uploads', workspaceRow, 'file-short-001')), false);
  });

  it('проверка копии подтверждает цельную копию', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies3'), now: () => at });
    const checked = checkBackup(made.dir);
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.equal(checked.database, 'ok');
    assert.equal(checked.media.present, 1);
    assert.equal(checked.media.absent, 0);
    assert.equal(checked.madeAt, at.toISOString());
  });

  it('проверка замечает испорченную копию: файл пропал', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies4'), now: () => at });
    fs.rmSync(path.join(made.dir, 'uploads', workspaceRow, 'file-good-0001'));
    const checked = checkBackup(made.dir);
    assert.equal(checked.ok, false);
    assert.equal(checked.media.absent, 1);
    assert.match(checked.problems.join('; '), new RegExp(`Нет файла ${workspaceRow}/file-good-0001`));
  });

  it('проверка замечает испорченную копию: файл другого размера', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies5'), now: () => at });
    fs.writeFileSync(path.join(made.dir, 'uploads', workspaceRow, 'file-good-0001'), 'короче');
    const checked = checkBackup(made.dir);
    assert.equal(checked.ok, false);
    assert.match(checked.problems.join('; '), /не того размера/);
  });

  it('проверка не считает копией случайную папку', () => {
    const empty = fs.mkdtempSync(path.join(root, 'пусто-'));
    const checked = checkBackup(empty);
    assert.equal(checked.ok, false);
    assert.match(checked.problems[0], /это не копия платформы/);
  });

  it('испорченная база в копии ловится, а не выдаётся за целую', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const made = createBackup({ dbPath, uploadsDir, targetDir: path.join(root, 'copies6'), now: () => at });
    const file = path.join(made.dir, 'overlay.db');
    const buffer = fs.readFileSync(file);
    buffer.fill(0, 100, 400); // портим середину файла
    fs.writeFileSync(file, buffer);
    const checked = checkBackup(made.dir);
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.length > 0);
  });

  it('копий в одной папке может быть много — каждая в своей', async () => {
    const { dbPath, uploadsDir, workspaceRow } = await makeInstall();
    const targetDir = path.join(root, 'many');
    const first = createBackup({ dbPath, uploadsDir, targetDir, now: () => new Date('2026-01-01T00:00:00Z') });
    const second = createBackup({ dbPath, uploadsDir, targetDir, now: () => new Date('2026-01-02T00:00:00Z') });
    assert.notEqual(first.dir, second.dir);
    assert.equal(checkBackup(first.dir).ok, true);
    assert.equal(checkBackup(second.dir).ok, true);
    assert.equal(fs.readdirSync(targetDir).length, 2);
  });

  it('базы ещё нет — копия не падает, а честно об этом говорит', () => {
    const uploadsDir = fs.mkdtempSync(path.join(root, 'пустые-файлы-'));
    const made = createBackup({
      dbPath: path.join(root, 'нет-такой', 'overlay.db'),
      uploadsDir,
      targetDir: path.join(root, 'copies7'),
      now: () => at,
      log: () => {},
    });
    assert.equal(made.manifest.database, null);
    assert.equal(made.manifest.media.known, 0);
    const checked = checkBackup(made.dir);
    assert.equal(checked.ok, true, checked.problems.join('; '));
  });
});

describe('Этап 9 — руководство по запуску', () => {
  const root9 = new URL('../', import.meta.url);
  const read = (name) => fs.readFileSync(new URL(name, root9), 'utf8');

  it('руководство есть и покрывает все шаги запуска', () => {
    const text = read('docs/PUBLISH.md');
    for (const needle of [
      'systemd', 'Caddy', 'npm ci', 'HOST=127.0.0.1', 'TRUST_PROXY=loopback',
      'UPLOADS_TOTAL_LIMIT_MB', 'npm run backup', '--check', 'Восстановление из копии',
      'curl -s https://', '/api/health', 'OBS',
    ]) {
      assert.ok(text.includes(needle), `в руководстве нет «${needle}»`);
    }
  });

  it('руководство не советует открывать сервер напрямую', () => {
    const text = read('docs/PUBLISH.md');
    // Наружу смотрит Caddy по https; сам сервер слушает только свою машину
    assert.match(text, /HOST=127\.0\.0\.1/);
    assert.match(text, /Наружу смотрит Caddy/);
    // И прямо предупреждает, чем плох 0.0.0.0
    assert.match(text, /открытым текстом/);
  });

  it('руководство велит проверять копию и уносить её с сервера', () => {
    const text = read('docs/PUBLISH.md');
    assert.match(text, /Копию нужно уносить с сервера/);
    assert.match(text, /rsync/);
    assert.match(text, /не спасает от потери диска/);
    // Проверено восстановление, а не только создание
    assert.match(text, /Проверено на настоящей копии/);
  });

  it('версия структуры базы и этап в руководстве совпадают с кодом', () => {
    const text = read('docs/PUBLISH.md');
    assert.match(text, /"stage": 9/);
    assert.match(text, /"schemaVersion": 6/);
    assert.match(text, /stage: 9/);
  });

  it('помощник копий умеет три вещи: снять, проверить, подсказать', () => {
    const tool = read('src/tools/backup.js');
    assert.match(tool, /createBackup\(/);
    assert.match(tool, /checkBackup\(/);
    assert.match(tool, /--check/);
    // Сразу проверяет снятую копию: «сделали» и «годится» — разные вещи
    assert.match(tool, /const checked = checkBackup\(made\.dir\)/);
    // И говорит про унос с машины
    assert.match(tool, /уберите её с этой машины/i);
  });

  it('в package.json есть команда backup и она указывает на существующий файл', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.backup, /src\/tools\/backup\.js/);
    assert.equal(fs.existsSync(new URL('src/tools/backup.js', root9)), true);
  });

  it('в .gitignore копии не попадают в репозиторий', () => {
    const ignore = fs.readFileSync(new URL('../.gitignore', root9), 'utf8');
    assert.match(ignore, /overlay-platform\/data\/\*/);
  });
});
