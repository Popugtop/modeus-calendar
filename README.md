# Modeus Bot

Клиент для образовательного портала ТюмГУ (utmn.modeus.org) на TypeScript.
Авторизация через SSO `fs.utmn.ru` — только чистые HTTP-запросы, без браузеров.

Включает **сервис подписки на расписание в формате iCalendar** — пользователь получает личную ссылку, которую добавляет в Apple Calendar / Google Calendar, и расписание обновляется автоматически.

---

## Содержание

1. [Структура проекта](#структура-проекта)
2. [Локальный запуск (CLI)](#локальный-запуск-cli)
3. [Сервер подписки на расписание](#сервер-подписки-на-расписание)
4. [Деплой на удалённый сервер](#деплой-на-удалённый-сервер)
5. [Как работает авторизация](#как-работает-авторизация)
6. [Использование классов в своём коде](#использование-классов-в-своём-коде)
7. [Возможные проблемы](#возможные-проблемы)

---

## Структура проекта

```
src/
├── auth/
│   ├── ModeusAuthService.ts     # SSO-авторизация: куки, редиректы, SAML, токен
│   └── tokenCache.ts            # Кэш токенов в .tokens.json
├── api/
│   └── ModeusService.ts         # Методы API: расписание, оценки, элективы
├── calendar/
│   ├── types.ts                 # Типы для БД и обогащённых событий
│   ├── CalendarRepository.ts    # SQLite-репозиторий (подписки + кэш расписания)
│   ├── IcsBuilder.ts            # Генерация ICS-файла через ical-generator
│   └── ScheduleSyncService.ts   # Cron-задача: фоновое обновление расписания
├── types/
│   └── index.ts                 # TypeScript-интерфейсы всех запросов и ответов
├── index.ts                     # CLI: поиск человека + вывод расписания в консоль
└── server.ts                    # Express-сервер: REST API + ICS-фид
```

---

## Локальный запуск (CLI)

### Требования

- Node.js >= 18
- npm >= 9

### Установка

```bash
git clone <repo-url>
cd modeus-bot
npm install
```

### Настройка .env

```bash
cp .env.example .env
```

Заполните `.env`:

```env
# Логин от личного кабинета ТюмГУ (тот же, что на fs.utmn.ru)
MODEUS_USERNAME=ivanov.ii@s.utmn.ru

# Пароль
MODEUS_PASSWORD=ваш_пароль
```

### Запуск

```bash
# Режим разработки (без сборки)
npm run dev

# Или: сборка + запуск
npm run build && npm start
```

Скрипт спросит ФИО и выведет расписание на текущую неделю.

---

## Сервер подписки на расписание

Сервер предоставляет два эндпоинта:

| Метод | URL | Описание |
|-------|-----|----------|
| `POST` | `/api/calendar/register` | Создать подписку по ФИО |
| `GET` | `/<token>` | Отдать ICS-фид по токену |

### Запуск сервера локально

```bash
npm run dev:server
```

### Создать подписку

```bash
curl -X POST http://localhost:3000/api/calendar/register \
  -H "Content-Type: application/json" \
  -d '{"fio": "Иванов Иван Иванович"}'
```

Ответ:

```json
{
  "message": "Подписка создана для \"Иванов Иван Иванович\".",
  "token": "a3f8c2d1e4b59f...",
  "url": "http://localhost:3000/a3f8c2d1e4b59f..."
}
```

Подождите 10–30 секунд, пока фоновый sync загрузит расписание, затем откройте ссылку — скачается `.ics` файл.

### Переменные окружения сервера

Добавьте в `.env`:

```env
# Порт Express-сервера (по умолчанию 3000)
PORT=3000

# Путь к SQLite-базе данных (по умолчанию ./calendar.db)
DB_PATH=./calendar.db

# Расписание cron-синхронизации (по умолчанию каждые 3 часа)
# Формат: минута час день месяц день_недели
CRON_SCHEDULE=0 */3 * * *

# Сколько недель вперёд загружать расписание (по умолчанию 4)
SYNC_WEEKS_AHEAD=4
```

---

## Деплой на удалённый сервер

Ниже — полная инструкция для установки на VPS с Ubuntu 22.04 с доменом `calendar.popugtop.dev`.

### Что понадобится

- VPS с Ubuntu 22.04 LTS (минимум 512 MB RAM, 1 CPU)
- SSH-доступ под root или sudo-пользователем
- Домен `calendar.popugtop.dev` (или любой другой), которым управляете

---

### Шаг 1 — Настройка DNS

Зайдите в панель управления DNS вашего регистратора (Cloudflare, Reg.ru, Namecheap и т.д.) и добавьте A-запись:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| `A` | `calendar` | `<IP-адрес VPS>` | 300 |

Если используете Cloudflare — **отключите оранжевое облако** (режим "Proxied" → "DNS only") до момента, пока не выпустите SSL-сертификат. После можно включить обратно.

Проверьте, что DNS обновился (обычно 5–10 минут):

```bash
nslookup calendar.popugtop.dev
# Должен вернуть IP вашего сервера
```

---

### Шаг 2 — Подготовка сервера

Подключитесь по SSH:

```bash
ssh root@<IP_СЕРВЕРА>
```

#### 2.1 Установка Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version  # v22.x.x
```

#### 2.2 Установка pm2

pm2 — менеджер процессов для Node.js. Следит за приложением и поднимает его при перезагрузке сервера.

```bash
npm install -g pm2
```

#### 2.3 Установка nginx и certbot

```bash
apt-get install -y nginx certbot python3-certbot-nginx
```

---

### Шаг 3 — Загрузка кода на сервер

**Вариант А — через Git (рекомендуется)**

```bash
# На сервере
git clone https://github.com/ВАШ_ЛОГИН/modeus-bot.git /root/app
cd /root/app
```

**Вариант Б — через rsync с локальной машины**

Выполните на своём Mac (не на сервере):

```bash
rsync -av \
  --exclude='node_modules' \
  --exclude='.tokens.json' \
  --exclude='calendar.db' \
  --exclude='.env' \
  /Users/popugtop/Code/modeus-bot/ root@<IP_СЕРВЕРА>:/root/app/
```

---

### Шаг 4 — Настройка приложения на сервере

```bash
cd /root/app

# Установить зависимости
npm install

# Скомпилировать TypeScript
npm run build
```

#### 4.1 Создайте файл `.env`

```bash
nano /root/app/.env
```

Вставьте и заполните (каждое поле объяснено):

```env
# ─── Авторизация Modeus ────────────────────────────────────────────────────────
# Логин от аккаунта utmn.modeus.org (формат: ivanov.ii@s.utmn.ru)
MODEUS_USERNAME=ivanov.ii@s.utmn.ru

# Пароль
MODEUS_PASSWORD=ВашПароль

# ─── Сервер ────────────────────────────────────────────────────────────────────
# Порт Node.js (nginx будет проксировать с 443 → 3000, наружу не открывать)
PORT=3000

# Путь к SQLite-базе (хранит подписки и кэш расписания)
DB_PATH=/root/app/calendar.db

# ─── Синхронизация расписания ──────────────────────────────────────────────────
# Cron-выражение: как часто обновлять кэш
# "0 */3 * * *" = каждые 3 часа в 00 минут
CRON_SCHEDULE=0 */3 * * *

# Сколько недель вперёд загружать расписание
SYNC_WEEKS_AHEAD=4
```

Сохраните: `Ctrl+O` → `Enter` → `Ctrl+X`

#### 4.2 Проверьте запуск вручную

```bash
cd /root/app
node dist/server.js
```

Должно появиться:

```
[TokenCache] Токен действителен ещё XXX мин.
[Server] Слушает http://localhost:3000
[Sync] Cron запущен: "0 */3 * * *"
[Sync] Синхронизируем 0 подписок...
```

Остановите: `Ctrl+C`

---

### Шаг 5 — Запуск через pm2

```bash
cd /root/app

# Запустить приложение
pm2 start dist/server.js --name modeus-calendar

# Сохранить список процессов для автозапуска
pm2 save

# Настроить автозапуск при перезагрузке сервера
pm2 startup
# ↑ команда выведет строку вида "sudo env PATH=...". Скопируйте и выполните её!
```

Полезные команды:

```bash
pm2 status                     # состояние всех процессов
pm2 logs modeus-calendar       # логи в реальном времени
pm2 logs modeus-calendar --lines 100  # последние 100 строк
pm2 restart modeus-calendar    # перезапустить (после обновления кода)
pm2 stop modeus-calendar       # остановить
pm2 delete modeus-calendar     # удалить из pm2
```

---

### Шаг 6 — Настройка nginx

#### 6.1 Создайте конфиг сайта

```bash
nano /etc/nginx/sites-available/calendar.popugtop.dev
```

Вставьте:

```nginx
server {
    listen 80;
    server_name calendar.popugtop.dev;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Сохраните: `Ctrl+O` → `Enter` → `Ctrl+X`

#### 6.2 Активируйте конфиг и перезапустите nginx

```bash
# Создать символическую ссылку
ln -s /etc/nginx/sites-available/calendar.popugtop.dev \
      /etc/nginx/sites-enabled/

# Проверить синтаксис конфига
nginx -t
# Должно быть: syntax is ok / test is successful

# Применить
systemctl reload nginx
```

---

### Шаг 7 — SSL-сертификат (Let's Encrypt)

```bash
certbot --nginx -d calendar.popugtop.dev
```

Certbot задаст вопросы:

1. **Enter email address** — введите свой email (нужен для уведомлений об истечении сертификата)
2. **Terms of Service** — введите `Y`
3. **Share your email** — введите `N` (по желанию)
4. **Redirect HTTP to HTTPS** — введите `2` (Redirect)

Certbot сам обновит конфиг nginx и добавит HTTPS. Сертификат **автоматически обновляется** каждые 90 дней через системный cron.

Проверьте:

```bash
curl -I https://calendar.popugtop.dev/api/calendar/register
# HTTP/2 405  ← нормально, это GET-запрос на POST-эндпоинт
```

---

### Шаг 8 — Создать первую подписку

С любого компьютера:

```bash
curl -X POST https://calendar.popugtop.dev/api/calendar/register \
  -H "Content-Type: application/json" \
  -d '{"fio": "Иванов Иван Иванович"}'
```

Ответ:

```json
{
  "message": "Подписка создана для \"Иванов Иван Иванович\".",
  "token": "a3f8c2d1e4b59f7a...",
  "url": "https://calendar.popugtop.dev/a3f8c2d1e4b59f7a..."
}
```

Подождите 10–30 секунд (фоновый sync), затем откройте ссылку в браузере — должен скачаться `.ics` файл.

---

### Шаг 9 — Добавить в Apple Calendar

**На Mac:**

1. Откройте **Календарь**
2. В меню: **Файл → Новая подписка на календарь...**
3. Вставьте ссылку: `https://calendar.popugtop.dev/<ваш_токен>`
4. Нажмите **Подписаться**
5. Задайте имя календаря и установите **Интервал обновления: Каждый час**

**На iPhone:**

1. Настройки → Календарь → Аккаунты
2. Добавить аккаунт → Другое
3. Добавить подписной календарь
4. Вставьте ссылку и нажмите Далее

---

### Шаг 10 — Обновление кода

После изменений в коде на сервере:

```bash
cd /root/app

# Если через git:
git pull

# Если через rsync — выполните на локальной машине:
# rsync -av --exclude='node_modules' --exclude='.tokens.json' \
#   --exclude='calendar.db' --exclude='.env' \
#   /Users/popugtop/Code/modeus-bot/ root@<IP>:/root/app/

# На сервере — пересобрать и перезапустить:
npm install
npm run build
pm2 restart modeus-calendar
```

---

### Диагностика

```bash
# Логи приложения (последние 50 строк)
pm2 logs modeus-calendar --lines 50

# Ошибки nginx
tail -30 /var/log/nginx/error.log

# Убедиться, что Node.js слушает порт 3000
ss -tlnp | grep 3000

# Проверить ICS вручную
curl https://calendar.popugtop.dev/<токен>
# Первые строки должны быть: BEGIN:VCALENDAR

# Проверить, что pm2 поднимается при перезагрузке
reboot
# После перезагрузки:
ssh root@<IP>
pm2 status  # modeus-calendar должен быть online
```

---

### Итоговая архитектура

```
Apple Calendar / Google Calendar
         │  GET https://calendar.popugtop.dev/<token>
         │  (автоопрос каждый час)
         ▼
    nginx :443 (SSL)
         │
         │  proxy_pass
         ▼
    Node.js :3000  (pm2, автозапуск)
         │
    ┌────┴────────────────────────────┐
    │  POST /api/calendar/register    │  ← создать подписку
    │  GET  /:token                   │  ← отдать ICS из кэша
    └────┬────────────────────────────┘
         │
    CalendarRepository (SQLite, calendar.db)
         │
    ScheduleSyncService (cron: 0 */3 * * *)
         │  каждые 3 часа
         └──→ ModeusService → API Modeus (utmn.modeus.org)
```

---

## Как работает авторизация

Modeus использует связку **WSO2 Identity Server** (`auth.modeus.org`) + **ADFS** (`fs.utmn.ru`). Флоу — OAuth2 Implicit + SAML 2.0:

```
1. GET  auth.modeus.org/oauth2/authorize?response_type=id_token+token&client_id=...
        → 302-цепочка → fs.utmn.ru/adfs/ls?SAMLRequest=...

2. GET  fs.utmn.ru/adfs/ls?SAMLRequest=...
        → 200  HTML-форма логина (hidden-поля: AuthState + CSRF)

3. POST fs.utmn.ru/adfs/ls  { UserName, Password, ...hidden }
        → 302 → GET → 200  HTML с <form> и SAMLResponse внутри

4. POST auth.modeus.org/commonauth  { SAMLResponse, RelayState }
        → 302 → auth.modeus.org/oauth2/authorize?sessionDataKey=...
        → 302 → utmn.modeus.org/...#access_token=UUID&id_token=JWT&...

5. Токен извлекается из URL-фрагмента (#).
   Для API используется id_token (JWT), а не access_token (UUID).
```

Токены и куки кэшируются в `.tokens.json`. Время жизни — ~24 часа.

---

## Использование классов в своём коде

```typescript
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';

const auth = new ModeusAuthService('login@s.utmn.ru', 'password');
await auth.login();

const modeus = new ModeusService(auth);

// Расписание
const schedule = await modeus.getSchedule({
  size: 50,
  timeMin: '2024-09-01T00:00:00+05:00',
  timeMax: '2024-09-07T23:59:59+05:00',
  attendeePersonId: ['ваш-uuid'],
});

// Поиск человека
const { persons } = await modeus.searchPersons('Иванов Иван');

// Активные кампании выбора
const selections = await modeus.getActiveSelections();

// Модули первой кампании
const modules = await modeus.getSelectionModules(selections.data[0].id);

// Записаться на модуль (проверяет свободные места автоматически)
await modeus.applyForModule(selectionId, moduleId, 1);

// Отменить запись
await modeus.cancelModule(selectionId, moduleId);
```

---

## Возможные проблемы

**`Неверный логин или пароль`**
Проверьте `MODEUS_USERNAME` и `MODEUS_PASSWORD` в `.env`. Логин обычно в формате `ivanov.ii@s.utmn.ru`.

**`SAMLResponse не найден`**
ADFS изменил структуру страницы. В тексте ошибки будут первые 300 символов HTML — по ним видно, что вернул сервер.

**`401 Unauthorized`**
Токен истёк (~24 часа). Удалите файл `.tokens.json` — при следующем запуске произойдёт повторный логин.

**`Расписание не загружается / 503 в ICS-фиде`**
Фоновый sync ещё не завершился. Проверьте логи: `pm2 logs modeus-calendar`. Если там ошибки API — скорее всего истёк токен (удалите `.tokens.json` и перезапустите).

**`Нет свободных мест`**
`applyForModule` проверяет `enrolledCount < capacity` перед записью и бросает ошибку, если мест нет.
