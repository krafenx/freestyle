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
];

export function openDatabase(dbPath) {
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
    const exists = hasMigrationStmt.get(migration.version);
    if (!exists) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(migration.sql);
        recordMigrationStmt.run(migration.version, migration.name);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
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
