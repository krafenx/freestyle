import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    name: '001_foundation_meta',
    sql: `
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      INSERT OR IGNORE INTO system_settings (key, value)
      VALUES ('platform_stage', '2');
    `,
  },
  {
    // Аккаунты и сеансы входа. Время хранится числом миллисекунд (UTC).
    version: 2,
    name: '002_accounts',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        recovery_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        password_changed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT NOT NULL DEFAULT ''
      ) STRICT;

      CREATE INDEX sessions_user_idx ON sessions (user_id);
      CREATE INDEX sessions_expires_idx ON sessions (expires_at);

      UPDATE system_settings
      SET value = '3', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'platform_stage';
    `,
  },
  {
    /* Площадки, модераторы и приглашения.

       Владелец записан в самой площадке (owner_id): он ровно один, и база не даст
       сохранить площадку без владельца. Модераторы — отдельной таблицей.
       Приглашение хранится отпечатком ссылки (как ключ сеанса): прочитав базу,
       воспользоваться чужим приглашением нельзя. Принятое приглашение остаётся
       записью «по какой ссылке человек вошёл» — ровно одной на модератора.
       Удаление площадки убирает её модераторов и приглашения, удаление аккаунта —
       его площадки и участие в чужих.

       В адресах и ответах сервера используются случайные номера (public_id):
       порядковые номера строк наружу не выходят. Сцена и ссылка оверлея
       добавятся на своих этапах — здесь только то, что уже используется. */
    version: 3,
    name: '003_workspaces',
    sql: `
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX workspaces_owner_idx ON workspaces (owner_id);

      CREATE TABLE workspace_members (
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

      CREATE TABLE workspace_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_by INTEGER REFERENCES users (id) ON DELETE CASCADE,
        accepted_at INTEGER
      ) STRICT;

      CREATE INDEX workspace_invites_workspace_idx ON workspace_invites (workspace_id);
      CREATE INDEX workspace_invites_accepted_idx ON workspace_invites (accepted_by);
      CREATE UNIQUE INDEX workspace_invites_member_idx
        ON workspace_invites (workspace_id, accepted_by) WHERE accepted_by IS NOT NULL;

      UPDATE system_settings
      SET value = '4', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'platform_stage';
    `,
  },
];

/* Несколько изменений как одно целое: либо применяются все, либо ни одного.
   BEGIN IMMEDIATE сразу занимает право записи — второй пишущий подождёт своей
   очереди, а не получит отказ посреди работы. */
export function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* upToVersion нужен только проверкам: так создаётся база «как на прошлом этапе»,
   чтобы убедиться, что обновление её достраивает и ничего не теряет. */
export function openDatabase(dbPath, { upToVersion = Infinity } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const hasMigrationStmt = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigrationStmt = db.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)'
  );

  for (const migration of MIGRATIONS) {
    if (migration.version > upToVersion) break;
    const exists = hasMigrationStmt.get(migration.version);
    if (!exists) {
      inTransaction(db, () => {
        db.exec(migration.sql);
        recordMigrationStmt.run(migration.version, migration.name);
      });
    }
  }

  function getHealth() {
    const journalRow = db.prepare('PRAGMA journal_mode;').get();
    const fkRow = db.prepare('PRAGMA foreign_keys;').get();
    const latestMigration = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get();

    return {
      ok: true,
      engine: 'sqlite',
      journalMode: String(journalRow?.journal_mode || 'unknown').toLowerCase(),
      foreignKeys: Boolean(fkRow?.foreign_keys),
      schemaVersion: latestMigration?.version ?? 0,
      latestMigration: latestMigration?.name ?? null,
    };
  }

  return {
    raw: db,
    getHealth,
    close() {
      db.close();
    },
  };
}
