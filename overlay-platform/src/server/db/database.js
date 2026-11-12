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
