# Modeus Calendar

Сервис подписки на расписание ТюмГУ в формате iCalendar.

Пользователь вводит ФИО → получает ссылку → добавляет в Apple Calendar / Google Calendar → расписание обновляется автоматически каждые 3 часа.

---

## Содержание

1. [Архитектура](#архитектура)
2. [Локальный запуск](#локальный-запуск)
3. [Деплой через Docker](#деплой-через-docker)
4. [Подключение к Caddy](#подключение-к-caddy)
5. [API](#api)
6. [Возможные проблемы](#возможные-проблемы)

---

## Архитектура

```
Браузер / Apple Calendar
        │
        ▼
   frontend (nginx)          ← статика React + маршрутизация
        │
        ├── /api/*   ──────→ backend (Node.js :3000)   ← регистрация подписок
        └── /<token> ──────→ backend                   ← ICS-фид из кэша
                                    │
                               SQLite (volume)
                                    │
                         cron → Modeus API (utmn.modeus.org)
```

**Два Docker-контейнера:**
- `frontend` — nginx раздаёт собранный React-билд, проксирует API и ICS на `backend`
- `backend` — Express: регистрация подписок, отдача ICS, cron-синхронизация

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
# заполни .env
```

### Переменные окружения

```env
MODEUS_USERNAME=ivanov.ii@s.utmn.ru
MODEUS_PASSWORD=ВашПароль

PORT=3000
DB_PATH=./calendar.db
CRON_SCHEDULE=0 */3 * * *
SYNC_WEEKS_AHEAD=4
```

### Запуск

```bash
# Backend
npm run dev

# Frontend (Vite dev с hot reload, в отдельном терминале)
npm run dev:client
# → открывается на http://localhost:5173
# → /api/* проксируется на localhost:3000
```

### Сборка для продакшна (без Docker)

```bash
npm run build          # компилирует TS + собирает React
npm start              # один процесс, один порт
```

---

## Деплой через Docker

### Структура контейнеров

| Контейнер | Образ | Назначение |
|-----------|-------|-----------|
| `frontend` | nginx:alpine | React-билд + реверс-прокси |
| `backend` | node:22-slim | API + ICS + cron-синхронизация |

### Шаги

**1. Скопируй проект на сервер**

```bash
# С локальной машины:
rsync -av \
  --exclude='node_modules' --exclude='client/node_modules' \
  --exclude='dist' --exclude='client/dist' \
  --exclude='.tokens.json' --exclude='*.db' --exclude='.env' \
  /Users/popugtop/Code/modeus-bot/ root@<IP>:/root/app/

# Или через git:
git clone <repo-url> /root/app
```

**2. Создай `.env` на сервере**

```bash
nano /root/app/.env
```

```env
MODEUS_USERNAME=ivanov.ii@s.utmn.ru
MODEUS_PASSWORD=ВашПароль
PORT=3000
DB_PATH=/app/data/calendar.db
CRON_SCHEDULE=0 */3 * * *
SYNC_WEEKS_AHEAD=4
```

**3. Собери и запусти**

```bash
cd /root/app
docker compose up -d --build
```

Готово. Frontend слушает на порту `3000` хоста.

**Посмотреть логи:**

```bash
docker compose logs -f            # все контейнеры
docker compose logs -f backend    # только backend
```

**Перезапуск после обновления кода:**

```bash
git pull
docker compose up -d --build
```

**Остановить:**

```bash
docker compose down
```

> Данные SQLite хранятся в Docker volume `calendar-data` и **не удаляются** при `down`.
> Чтобы удалить данные тоже: `docker compose down -v`

---

## Подключение к Caddy

Если Caddy уже работает на сервере, добавь в `Caddyfile` один блок:

```
calendar.popugtop.dev {
    reverse_proxy localhost:3000
}
```

Перезагрузи конфиг:

```bash
caddy reload --config /etc/caddy/Caddyfile
# или если запущен как systemd-сервис:
systemctl reload caddy
```

SSL-сертификат выпустится автоматически. Больше ничего делать не нужно.

---

## API

### `POST /api/calendar/register`

Создать подписку по ФИО.

**Лимит:** 20 запросов за 15 минут с одного IP.

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

**Ошибки:**

| HTTP | Причина |
|------|---------|
| 400 | ФИО не прошло валидацию |
| 404 | Человек не найден в Modeus |
| 429 | Превышен лимит запросов |

### `GET /<token>`

Отдаёт ICS-файл (`text/calendar`). Данные из кэша, Modeus API не вызывается.
Принимает и `/<token>`, и `/<token>.ics` — оба варианта работают.

---

## Возможные проблемы

**`401 Unauthorized` в логах backend**
Токен Modeus истёк (~24 часа). Перезапусти backend — он получит новый токен при старте:
```bash
docker compose restart backend
```

**`503` при открытии ICS-ссылки**
Первая синхронизация ещё не завершилась. Подожди 30–60 секунд.

**`Человек не найден в Modeus`**
Попробуй точное написание с отчеством, либо только фамилию.

**Docker билд падает с ошибкой компиляции native addon**
`better-sqlite3` компилируется из исходников при отсутствии prebuilt-бинаря.
Убедись что на сервере достаточно RAM (минимум 512 MB) — компиляция C++ требует памяти.
