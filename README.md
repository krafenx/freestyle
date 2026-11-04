# freestyle

## Twitch VIP на месяц: учёт, сроки, напоминания

Telegram-бот для модератора: помнит, кому выдан VIP, считает дату окончания, напоминает
за 3 дня / за день / в день истечения и ведёт историю. Работает на **Telegram Serverless**
(без сервера, встроенная SQLite).

- **[`vip-bot/`](vip-bot/)** — рабочий проект: `tgcloud/schema.js`, обработчики, тик
  напоминаний, 28 тестов чистой логики, smoke-проверка модулей, README с деплоем и
  workflow для внешнего крона.
- [`docs/vip-tracker/telegram-serverless.md`](docs/vip-tracker/telegram-serverless.md) —
  план под платформу: что она даёт, чем платим (нет таймера, нет входящего HTTP), архитектура, риски.
- [`docs/vip-tracker/PROMPT.md`](docs/vip-tracker/PROMPT.md) — готовый промпт/ТЗ для агента
  или разработчика (в т.ч. мини-версия для MVP за вечер).
- [`docs/vip-tracker/README.md`](docs/vip-tracker/README.md) — разбор задачи, варианты
  реализации, крайние случаи.
- [`docs/vip-tracker/schema.sql`](docs/vip-tracker/schema.sql) — та же модель данных в
  обычном SQL (для D1/Postgres/VPS-варианта).

### Быстрый старт

```bash
cd vip-bot
npm install
npm test                 # 28 тестов: даты, DST, разбор команд, напоминания
npx tgcloud login        # CLI-токен из BotFather → бот → Serverless → CLI Access
npx tgcloud push         # код в облако
npx tgcloud migrate      # таблицы (push базу не меняет)
```

Затем `/start` боту — первый написавший становится владельцем и чатом для напоминаний.
