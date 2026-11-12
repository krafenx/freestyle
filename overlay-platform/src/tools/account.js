import { createAccounts } from '../server/auth/accounts.js';
import { loadConfig, loadEnvFile } from '../server/config.js';
import { openDatabase } from '../server/db/database.js';

/* Помощник владельца сервера. Запускается на самом сервере, из папки платформы:

     npm run account -- list                 список аккаунтов
     npm run account -- new-code <имя>       новый код восстановления

   Вторая команда нужна, когда человек потерял и пароль, и код восстановления.
   Почты у платформы нет, поэтому вернуть доступ может только владелец сервера:
   он выдаёт новый код, а человек с этим кодом сам задаёт пароль на странице
   «Восстановление доступа». Пароль при этом никому не становится известен. */

const HELP = `Команды:
  list                 список аккаунтов
  new-code <имя>       выдать новый код восстановления`;

loadEnvFile();

const [command, argument] = process.argv.slice(2);
const database = openDatabase(loadConfig().dbPath);
const accounts = createAccounts({ db: database.raw });
let exitCode = 0;

try {
  if (command === 'list') {
    const users = accounts.listUsers();
    if (users.length === 0) {
      console.log('Аккаунтов пока нет.');
    }
    for (const user of users) {
      const shown = user.displayName === user.username ? '' : ` (${user.displayName})`;
      console.log(`${user.username}${shown} — с ${user.createdAt.slice(0, 10)}, активных входов: ${user.activeSessions}`);
    }
  } else if (command === 'new-code') {
    const issued = argument ? accounts.issueRecoveryCode(argument) : null;
    if (!issued) {
      console.error(argument ? `Аккаунт «${argument}» не найден.` : 'Укажите имя аккаунта: new-code <имя>');
      exitCode = 1;
    } else {
      console.log(`Новый код восстановления для ${issued.username}:`);
      console.log(issued.recoveryCode);
      console.log('Передайте его владельцу аккаунта. Прежний код больше не действует; пароль не изменён.');
    }
  } else {
    console.error(HELP);
    exitCode = command ? 1 : 0;
  }
} finally {
  database.close();
}

process.exitCode = exitCode;
