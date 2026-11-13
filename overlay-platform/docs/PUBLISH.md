# Как поставить платформу на сервер

Руководство для владельца сервера. Всё, что здесь описано, делается один раз; дальше
платформа работает сама, а обновление занимает пару минут.

Здесь нет ни одного шага, который уже сделан за вас: **платформа пока нигде не опубликована.**
Схема та же, что у `krafen.me`: один небольшой сервер, одна программа под присмотром
`systemd`, один файл базы и папка с загруженными файлами.

## Что нужно

| | Требование | Зачем |
| --- | --- | --- |
| **Сервер** | 1 ядро, 1 ГБ памяти, 10 ГБ диска, Linux (Debian или Ubuntu) | платформа почти не нагружает процессор; память нужна в основном базе |
| **Node.js** | версия 22.13 или новее | на ней написана платформа; более старая не запустит базу |
| **Домен** | например `studio.example.ru`, A-запись на адрес сервера | без него не будет https, а без https нельзя входить |
| **Доступ** | `ssh` под пользователем с `sudo` | для установки и обновлений |

Загруженные файлы (картинки, GIF, видео) занимают место на диске: по умолчанию общий предел
5 ГБ, у одной площадки — 200 МБ. Если стримеров будет много, диск нужен больше.

**Платформа не подходит для Vercel и подобных.** Ей нужны свой диск (файл базы и загрузки)
и постоянное соединение для правок на лету. Это обычный сервер, а не набор отдельных функций.

## Шаг 1. Подготовить сервер

```bash
sudo apt update
sudo apt install -y curl git ufw
```

Ставим Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # должно быть v22.13 или новее
```

Закрываем всё, кроме `ssh`, `http` и `https`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## Шаг 2. Завести отдельного пользователя

Платформа не должна работать от `root`: если в ней найдётся ошибка, пострадает только
её собственный каталог.

```bash
sudo adduser --system --group --home /srv/krafen krafen
```

## Шаг 3. Положить код

```bash
sudo mkdir -p /srv/krafen
sudo chown krafen:krafen /srv/krafen
sudo -u krafen git clone https://github.com/krafenx/freestyle.git /srv/krafen/app
cd /srv/krafen/app/overlay-platform
sudo -u krafen npm ci --omit=dev
```

`npm ci` ставит ровно те версии, что записаны в `package-lock.json`, — так на сервер
попадает то же, что проверено.

## Шаг 4. Настроить

Создайте файл `/srv/krafen/app/overlay-platform/.env`:

```bash
sudo -u krafen tee /srv/krafen/app/overlay-platform/.env >/dev/null <<'EOF'
# Снаружи принимает только Caddy: сам сервер слушает только эту машину
HOST=127.0.0.1
PORT=3000

# Где живут данные. Отдельно от кода: обновление кода их не задевает
DB_PATH=/srv/krafen/data/overlay.db
UPLOADS_DIR=/srv/krafen/data/uploads

# Перед приложением стоит Caddy на этой же машине
TRUST_PROXY=loopback

# Открытая регистрация. После того как свои люди зарегистрировались,
# поставьте closed — новые аккаунты создавать будет нельзя
REGISTRATION=open

# Обычная работа сайта. embedded — только для предпросмотра, не для сервера
SESSION_COOKIE_MODE=standard

# Сколько всего места могут занять загруженные файлы
UPLOADS_TOTAL_LIMIT_MB=5120
EOF

sudo -u krafen mkdir -p /srv/krafen/data/uploads
sudo chmod 600 /srv/krafen/app/overlay-platform/.env
```

**`HOST=127.0.0.1` — важно.** Наружу смотрит Caddy, а сама платформа доступна только
с этой машины. Если поставить `0.0.0.0`, сервер будет открыт напрямую, без https:
пароли и вход поедут по сети открытым текстом.

## Шаг 5. Запустить под systemd

Создайте `/etc/systemd/system/krafen-studio.service`:

```ini
[Unit]
Description=krafen studio — платформа стрим-оверлеев
After=network.target

[Service]
Type=simple
User=krafen
Group=krafen
WorkingDirectory=/srv/krafen/app/overlay-platform
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

# Платформе нужен только свой каталог
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/krafen/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now krafen-studio
sudo systemctl status krafen-studio     # должно быть active (running)
curl -s http://127.0.0.1:3000/api/health
```

`Restart=always` — если программа всё же упадёт, `systemd` поднимет её через три секунды.
`ProtectSystem=strict` не даёт ей писать никуда, кроме своего каталога данных.

## Шаг 6. Caddy: https и домен

Caddy сам получает и продлевает сертификат — настраивать нечего. Файл
`/etc/caddy/Caddyfile`:

```
studio.example.ru {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Замените `studio.example.ru` на свой домен. Проверка: откройте `https://studio.example.ru` —
должна открыться главная страница, а в адресе — замок.

**Почему Caddy, а не Nginx.** Caddy сам берёт сертификат и сам его продлевает;
у Nginx это отдельный шаг, который забывают, и через три месяца сайт гаснет. Если у вас
уже стоит Nginx, он тоже подойдёт — тогда нужны `proxy_set_header` и отдельная настройка
`certbot`. Ничего в самой платформе менять не нужно.

## Шаг 7. Проверить, что всё работает

Зайдите на сайт браузером и пройдите путь целиком:

1. **Зарегистрируйтесь** и сохраните код восстановления — почты нет, без кода пароль
   не восстановить.
2. **Создайте площадку**, соберите пару источников на сцене.
3. **Скопируйте ссылку для OBS** и вставьте её в OBS источником «Браузер» 1920 × 1080.
4. **Поменяйте что-нибудь** в редакторе — в OBS изменение должно появиться за долю секунды.

Из командной строки:

```bash
# Сервер отвечает, база на месте, живой канал работает
curl -s https://studio.example.ru/api/health

# Вход закрыт для чужих: без cookie личные страницы ведут на вход
curl -sI https://studio.example.ru/app | head -3

# Оверлей отдаётся без cookie и не запоминается
curl -sI https://studio.example.ru/overlay/ваша-ссылка | head -5
```

В `/api/health` должно быть `"stage": 9`, `"db": {"ok": true, ... "schemaVersion": 6}`
и `"realtime": {"ok": true, ...}`.

**Проверьте, что видит чужой человек.** Откройте сайт в браузере без входа: кабинет должен
вести на страницу входа, а не показывать чужие площадки.

## Обновление

```bash
cd /srv/krafen/app
sudo -u krafen git pull
cd overlay-platform
sudo -u krafen npm ci --omit=dev
sudo systemctl restart krafen-studio
curl -s http://127.0.0.1:3000/api/health
```

База обновляется сама при запуске: недостающие изменения структуры применяются по порядку,
в одной транзакции. **Но перед обновлением всё равно снимите копию** — см. ниже.

Откат: `git checkout <прежний коммит>`, `npm ci`, перезапуск. Структура базы назад
не откатывается — если новый выпуск что-то в ней изменил, восстановление идёт из копии.

## Резервные копии

Копия снимается с **работающего** сервера, останавливать ничего не нужно:

```bash
cd /srv/krafen/app/overlay-platform
sudo -u krafen npm run backup -- /srv/krafen/data/backups
```

Что происходит: база собирается в один цельный файл (`VACUUM INTO` — он учитывает
режим WAL, поэтому в копию попадают и последние записи), копируются все загруженные файлы,
о которых знает база. В копию кладётся опись `backup.json`: когда снята, версия структуры,
сколько файлов и какие не удалось взять.

Проверить копию, не разворачивая её:

```bash
sudo -u krafen npm run backup -- --check /srv/krafen/data/backups/backup-20261113-222642
```

Проверка открывает базу из копии, считает контрольную сумму целостности, сверяет наличие
и размер каждого файла. «Копия есть» и «копия годится» — разные вещи, поэтому команда
`backup` проверяет только что снятую копию сама и сообщает, если та непригодна.

**Копию нужно уносить с сервера.** Копия на том же диске не спасает от потери диска.
Простой вариант — раз в сутки забирать её к себе:

```bash
# на своей машине, не на сервере
rsync -av --delete krafen@studio.example.ru:/srv/krafen/data/backups/ ~/krafen-backups/
```

Автоматически, каждый день в 4 утра — `crontab -u krafen -e`:

```
0 4 * * * /usr/bin/npm --prefix /srv/krafen/app/overlay-platform run backup -- /srv/krafen/data/backups >> /srv/krafen/data/backup.log 2>&1
20 4 * * * find /srv/krafen/data/backups -maxdepth 1 -name 'backup-*' -mtime +14 -exec rm -rf {} +
```

Вторая строка удаляет копии старше двух недель. Храните их столько, сколько нужно,
но не только на сервере.

## Восстановление из копии

```bash
# 1. Остановить платформу
sudo systemctl stop krafen-studio

# 2. Убрать текущие данные в сторону (не удаляя: если что-то пойдёт не так, вернётесь)
sudo -u krafen mv /srv/krafen/data/overlay.db /srv/krafen/data/overlay.db.broken
sudo -u krafen mv /srv/krafen/data/uploads /srv/krafen/data/uploads.broken

# 3. Развернуть копию
sudo -u krafen cp /srv/krafen/data/backups/backup-20261113-222642/overlay.db /srv/krafen/data/
sudo -u krafen cp -r /srv/krafen/data/backups/backup-20261113-222642/uploads /srv/krafen/data/

# 4. Поднять и проверить
sudo systemctl start krafen-studio
curl -s http://127.0.0.1:3000/api/health
```

Проверено на настоящей копии: после такого восстановления работает вход, площадки
и сцены на месте, загруженные файлы отдаются, новые правки сохраняются.

Учтите: **входы, которые были открыты в момент снятия копии, останутся действительными** —
они записаны в базе. Если копия старая, люди увидят старую сцену и потеряют правки,
сделанные после неё. Поэтому важна не только копия, но и её свежесть.

## Что делать, если что-то не так

| Что видно | Что проверить |
| --- | --- |
| Сайт не открывается | `sudo systemctl status krafen-studio`, `sudo journalctl -u krafen-studio -n 50` |
| Ошибка сертификата | `sudo journalctl -u caddy -n 50`; домен должен указывать на этот сервер |
| «Нет связи с сервером» на странице | `curl -s http://127.0.0.1:3000/api/health`; если отвечает, дело в Caddy |
| Не загружаются файлы | место на диске: `df -h`; предел `UPLOADS_TOTAL_LIMIT_MB` в `.env` |
| Не приходят правки в OBS | ссылка оверлея в OBS и интернет на машине со стримом; `realtime` в `/api/health` |
| Забыт пароль | человек восстанавливает кодом; если кода нет — `npm run account -- new-code <имя>` |
| Никто не может войти | счётчики попыток живут в памяти: перезапуск сбрасывает их |

Журнал: `sudo journalctl -u krafen-studio -f` — показывает ошибки сервера в реальном времени.
Подробности ошибок наружу не отдаются: человек видит короткий код, а текст с путями и стеком
остаётся в журнале.

## Что стоит сделать до открытия для людей

- [ ] **Регистрация решена:** либо `closed` после первых людей, либо открыта осознанно
- [ ] **Копии снимаются и уносятся с сервера** — проверено восстановление, а не только создание
- [ ] **https работает**, сертификат получен, `http` перенаправляется на `https`
- [ ] **`/api/health` отвечает** и показывает `stage: 9`, `schemaVersion: 6`
- [ ] **Путь от регистрации до эфира пройден** своими руками, включая OBS
- [ ] **Проверено с телефона**, что страницы не разъезжаются
- [ ] **Пароль от сервера** не тот же, что где-либо ещё; вход по паролю, а не только по ключу
- [ ] **Домен и адрес** записаны там, где их найдут, если что-то случится
