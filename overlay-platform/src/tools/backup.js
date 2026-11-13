import path from 'node:path';
import { checkBackup, createBackup } from '../server/backup.js';
import { loadConfig, loadEnvFile } from '../server/config.js';

/* Резервные копии. Запускается на самом сервере, из папки платформы:

     npm run backup                    снять копию в ./data/backups
     npm run backup -- /путь/к/копиям  снять копию в указанную папку
     npm run backup -- --check /путь   проверить копию, ничего не меняя

   Сервер останавливать не нужно: база копируется целиком согласованно, вместе
   с последними записями. Копию лучше уносить с машины — копия на том же диске
   не спасает от потери диска. */

const HELP = `Команды:
  (без аргументов)     копия в ./data/backups
  <папка>              копия в указанную папку
  --check <папка>      проверить копию`;

loadEnvFile();
const args = process.argv.slice(2);

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

let exitCode = 0;

if (args[0] === '--check') {
  const dir = args[1];
  if (!dir) {
    console.error('Укажите папку копии: --check <папка>');
    process.exitCode = 1;
  } else {
    const result = checkBackup(dir);
    console.log(`Копия: ${result.dir}`);
    if (result.madeAt) console.log(`Снята: ${result.madeAt}`);
    if (result.schemaVersion) console.log(`Структура базы: версия ${result.schemaVersion}`);
    if (result.database) console.log(`Целость базы: ${result.database === 'ok' ? 'в порядке' : result.database}`);
    console.log(`Файлы: в базе ${result.media.known}, на месте ${result.media.present}, потеряно ${result.media.absent}`);
    if (result.media.missingAtCopy) {
      console.log(`Не были скопированы ещё тогда (${result.media.missingAtCopy}):`);
      for (const item of result.media.skipped.slice(0, 10)) {
        console.log(`  ${item.workspace}/${item.file} — ${item.why}`);
      }
    }
    if (result.ok) {
      console.log('Копия цела: из неё можно поднять платформу.');
    } else {
      console.log('КОПИЯ НЕПРИГОДНА:');
      for (const problem of result.problems) console.log(`  ${problem}`);
      exitCode = 1;
    }
  }
} else if (args[0] === '--help' || args[0] === '-h') {
  console.log(HELP);
} else {
  const config = loadConfig();
  // Пустая папка в аргументе значит «рядом с базой», как и без аргумента вовсе
  const targetDir = args[0] ? path.resolve(args[0]) : path.join(path.dirname(config.dbPath), 'backups');
  const startedAt = Date.now();
  try {
    const made = createBackup({
      dbPath: config.dbPath,
      uploadsDir: config.uploadsDir,
      targetDir,
      log: (message) => console.log(message),
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Копия готова за ${seconds} с: ${made.dir}`);
    console.log(`  база: ${made.manifest.database ? 'есть' : 'не было'}, структура версии ${made.manifest.schemaVersion}`);
    console.log(`  файлы: ${made.manifest.media.copied} из ${made.manifest.media.known}, ${human(made.manifest.media.bytes)}`);
    if (made.manifest.media.missing) {
      console.log(`  не скопированы (${made.manifest.media.missing}) — их не было на диске целиком:`);
      for (const item of made.manifest.media.skipped.slice(0, 10)) {
        console.log(`    ${item.workspace}/${item.file} — ${item.why}`);
      }
    }
    console.log('Проверьте копию: npm run backup -- --check ' + made.dir);
    console.log('И уберите её с этой машины: копия на том же диске от потери диска не спасает.');
    // Сразу проверяем, что получилось: «сделали копию» и «копия годится» — разные вещи
    const checked = checkBackup(made.dir);
    if (!checked.ok) {
      console.log('КОПИЯ НЕПРИГОДНА:');
      for (const problem of checked.problems) console.log(`  ${problem}`);
      exitCode = 1;
    }
  } catch (err) {
    console.error('Копию снять не удалось:', err.message);
    exitCode = 1;
  }
}

process.exitCode = exitCode;
