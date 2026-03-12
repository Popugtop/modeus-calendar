# Modeus Calendar

Сервис подписки на расписание ТюмГУ в формате iCalendar.

Пользователь вводит ФИО на веб-странице → получает личную ссылку → добавляет в Apple Calendar или Google Calendar → расписание обновляется автоматически каждые 3 часа.

---

## Содержание

1. [Структура проекта](#структура-проекта)
2. [Локальный запуск](#локальный-запуск)
3. [Деплой на сервер (Caddy)](#деплой-на-сервер)
4. [API](#api)
5. [Как работает авторизация](#как-работает-авторизация)
6. [Возможные проблемы](#возможные-проблемы)

---

## Структура проекта

```
client/                          # React-фронтенд (Vite + Tailwind + Framer Motion)
  src/
    components/
      CalendarForm.tsx            # Форма ввода ФИО с валидацией
      SuccessCard.tsx             # Экран успеха со ссылкой и инструкцией
    lib/
      api.ts                      # Запрос к /api/calendar/register
      validate.ts                 # Валидация ФИО (кириллица, 3 слова)
    App.tsx                       # Роутинг между form / success

src/
  auth/
    ModeusAuthService.ts          # SSO-авторизация (OAuth2 + SAML)
    tokenCache.ts                 # Кэш токенов в .tokens.json
  api/
    ModeusService.ts              # Методы API Modeus
  calendar/
    CalendarRepository.ts         # SQLite: подписки + кэш расписания
    IcsBuilder.ts                 # Генерация ICS через ical-generator
    ScheduleSyncService.ts        # Cron: фоновая синхронизация
    types.ts
  types/
    index.ts                      # TypeScript-интерфейсы
  server.ts                       # Express: API + раздача фронтенда
```

---

## Локальный запуск

### Требования

- Node.js >= 18

### Установка

```bash
git clone <repo-url>
cd modeus-bot
npm install
cp .env.example .env
# заполнить .env
```

### Переменные окружения

```env
# Логин от аккаунта utmn.modeus.org
MODEUS_USERNAME=ivanov.ii@s.utmn.ru
MODEUS_PASSWORD=ВашПароль

# Порт сервера (по умолчанию 3000)
PORT=3000

# Путь к SQLite-базе
DB_PATH=./calendar.db

# Расписание синхронизации (cron, по умолчанию каждые 3 часа)
CRON_SCHEDULE=0 */3 * * *

# Сколько недель вперёд загружать
SYNC_WEEKS_AHEAD=4
```

### Запуск

```bash
# Backend (сервер + API)
npm run dev

# Frontend (Vite dev-сервер с hot reload, в отдельном терминале)
npm run dev:client
```

Фронтенд открывается на `http://localhost:5173`, запросы к `/api` проксируются на `localhost:3000`.

### Сборка для продакшна

```bash
npm run build
# Собирает TypeScript → dist/ и React → client/dist/
# После этого npm start раздаёт и API, и фронтенд на одном порту
```

---

## Деплой на сервер

### Что нужно

- VPS с Ubuntu 22.04 (минимум 512 MB RAM)
- Домен `calendar.popugtop.dev` с доступом к DNS

---

### 1. DNS

В панели DNS-регистратора добавь A-запись:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| `A` | `calendar` | `IP вашего VPS` | 300 |

Если Cloudflare — на этапе получения сертификата выключи Proxy (серое облако), после можно включить.

Проверь что DNS распространился:
```bash
nslookup calendar.popugtop.dev
```

---

### 2. Установка зависимостей на сервере

```bash
ssh root@<IP>

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# pm2 — менеджер процессов
npm install -g pm2

# Caddy — reverse proxy с автоматическим SSL
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

---

### 3. Загрузка кода

**Через git:**
```bash
git clone https://github.com/ВАШ_ЛОГИН/modeus-bot.git /root/app
```

**Через rsync (с локальной машины):**
```bash
rsync -av \
  --exclude='node_modules' --exclude='client/node_modules' \
  --exclude='dist' --exclude='client/dist' \
  --exclude='.tokens.json' --exclude='calendar.db' --exclude='.env' \
  /Users/popugtop/Code/modeus-bot/ root@<IP>:/root/app/
```

---

### 4. Сборка и настройка

```bash
cd /root/app

# Установить зависимости (бэкенд + фронтенд)
npm install
cd client && npm install && cd ..

# Собрать всё (TypeScript + React)
npm run build
```

Создай `.env`:
```bash
nano /root/app/.env
```

```env
MODEUS_USERNAME=ivanov.ii@s.utmn.ru
MODEUS_PASSWORD=ВашПароль
PORT=3000
DB_PATH=/root/app/calendar.db
CRON_SCHEDULE=0 */3 * * *
SYNC_WEEKS_AHEAD=4
```

Проверь что запускается:
```bash
node dist/server.js
# [Server] Слушает http://localhost:3000  ← должно появиться
# Ctrl+C
```

---

### 5. Запуск через pm2

```bash
cd /root/app
pm2 start dist/server.js --name modeus-calendar
pm2 save

# Автозапуск при перезагрузке сервера
pm2 startup
# ↑ выведет команду вида "sudo env PATH=..." — скопируй и выполни её
```

---

### 6. Настройка Caddy

Caddy автоматически получает и обновляет SSL-сертификаты. Никаких certbot, никаких ручных продлений.

```bash
nano /etc/caddy/Caddyfile
```

Замени всё содержимое на:

```
calendar.popugtop.dev {
    reverse_proxy localhost:3000
}
```

Перезапусти:

```bash
systemctl reload caddy
```

Через 10–20 секунд сертификат выпустится автоматически. Проверь:

```bash
curl -I https://calendar.popugtop.dev
# HTTP/2 200  ← фронтенд отвечает
```

---

### 7. Обновление кода

```bash
cd /root/app
git pull
npm install
cd client && npm install && cd ..
npm run build
pm2 restart modeus-calendar
```

---

### Диагностика

```bash
pm2 logs modeus-calendar --lines 50   # логи приложения
journalctl -u caddy -n 50             # логи Caddy
ss -tlnp | grep 3000                  # Node.js слушает порт

# Проверить ICS вручную (подставь реальный токен из БД)
curl https://calendar.popugtop.dev/<token> | head -5
# Должно начинаться с: BEGIN:VCALENDAR
```

---

### Архитектура

```
Браузер / Apple Calendar / Google Calendar
        │
        ▼
    Caddy :443  (автоSSL, reverse proxy)
        │
    Node.js :3000  (pm2, автозапуск)
        │
        ├── GET /           → client/dist/index.html  (React SPA)
        ├── POST /api/...   → Express API
        ├── GET /<token>    → ICS из SQLite (без API-вызовов)
        │
    SQLite calendar.db
        │
    ScheduleSyncService (cron 0 */3 * * *)
        └──→ Modeus API (utmn.modeus.org)
```

---

## API

### `POST /api/calendar/register`

Создать подписку по ФИО.

```bash
curl -X POST https://calendar.popugtop.dev/api/calendar/register \
  -H "Content-Type: application/json" \
  -d '{"fio": "Иванов Иван Иванович"}'
```

```json
{
  "message": "Подписка создана для \"Иванов Иван Иванович\".",
  "token": "a3f8c2d1e4b59f7a...",
  "url": "https://calendar.popugtop.dev/a3f8c2d1e4b59f7a..."
}
```

### `GET /<token>`

Отдаёт ICS-файл. Этот URL добавляется в календарное приложение.
Данные берутся из локального кэша — Modeus API не вызывается.

---

## Как работает авторизация

Modeus использует **WSO2 Identity Server** + **ADFS** (fs.utmn.ru). Флоу — OAuth2 Implicit + SAML 2.0:

```
GET  auth.modeus.org/oauth2/authorize
      → ADFS форма логина
POST fs.utmn.ru/adfs/ls  { login, password }
      → SAMLResponse
POST auth.modeus.org/commonauth  { SAMLResponse }
      → redirect → ...#id_token=JWT&access_token=UUID
```

Токены и куки кэшируются в `.tokens.json`. Время жизни ~24 часа. При истечении — удали `.tokens.json` и перезапусти сервер.

---

## Возможные проблемы

**`401 Unauthorized` в логах**
Токен истёк. Удали `.tokens.json` и перезапусти: `pm2 restart modeus-calendar`

**`503` при открытии ICS-ссылки**
Первая синхронизация ещё не завершилась. Подожди 30 секунд и попробуй снова.

**`Человек не найден в Modeus`**
Попробуй только фамилию или сокращённый вариант ФИО.

**Caddy не получает сертификат**
Убедись что порты 80 и 443 открыты в firewall:
```bash
ufw allow 80 && ufw allow 443
```
И что DNS уже указывает на сервер (`nslookup calendar.popugtop.dev`).

**Фронтенд не открывается после `npm start`**
Убедись что перед запуском была выполнена полная сборка (`npm run build`), включая `client/dist/`.
