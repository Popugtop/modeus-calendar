# Modeus Calendar

Сервис подписки на расписание ТюмГУ в формате iCalendar.

Пользователь вводит ФИО → получает ссылку → добавляет в Apple Calendar / Google Calendar → расписание обновляется автоматически.

---

## Быстрый старт (локально)

```bash
git clone <repo-url>
cd modeus-bot
npm install
cp .env.example .env
# заполни .env (см. ниже)
npm run dev
```

Сервер запустится на `http://localhost:3000`.

---

## Переменные окружения

Скопируй шаблон и заполни:

```bash
cp .env.example .env
```

```env
# Логин от аккаунта utmn.modeus.org
MODEUS_USERNAME=ivanov.ii@s.utmn.ru
MODEUS_PASSWORD=ВашПароль

# Порт сервера (по умолчанию 3000)
PORT=3000

# Путь к SQLite-базе
DB_PATH=./calendar.db

# Как часто синхронизировать расписание (cron, по умолчанию каждые 3 часа)
CRON_SCHEDULE=0 */3 * * *

# Сколько недель вперёд загружать
SYNC_WEEKS_AHEAD=4
```

---

## API

### Создать подписку

```
POST /api/calendar/register
Content-Type: application/json

{ "fio": "Иванов Иван Иванович" }
```

Ответ:

```json
{
  "message": "Подписка создана для \"Иванов Иван Иванович\".",
  "token": "a3f8c2d1e4b59f7a...",
  "url": "https://calendar.popugtop.dev/a3f8c2d1e4b59f7a..."
}
```

### Получить ICS-фид

```
GET /<token>
```

Возвращает `text/calendar` — этот URL добавляется в календарное приложение.
Подождите 10–30 секунд после регистрации пока пройдёт первая синхронизация.

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
  --exclude='node_modules' --exclude='.tokens.json' \
  --exclude='calendar.db' --exclude='.env' \
  /Users/popugtop/Code/modeus-bot/ root@<IP>:/root/app/
```

---

### 4. Сборка и настройка

```bash
cd /root/app
npm install
npm run build
```

Создай `.env`:
```bash
nano /root/app/.env
```

Вставь и заполни (аналогично локальному, порт оставь 3000):
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

# Настроить автозапуск при перезагрузке сервера:
pm2 startup
# ↑ выведет команду вида "sudo env PATH=..." — скопируй и выполни её
```

---

### 6. Настройка Caddy

Caddy сам получает и обновляет SSL-сертификаты через Let's Encrypt — никаких certbot и ручных продлений.

```bash
nano /etc/caddy/Caddyfile
```

Замени всё содержимое на:

```
calendar.popugtop.dev {
    reverse_proxy localhost:3000
}
```

Перезапусти Caddy:

```bash
systemctl reload caddy
```

Через 10–20 секунд сертификат выпустится автоматически. Проверь:

```bash
curl -I https://calendar.popugtop.dev/api/calendar/register
# HTTP/2 405  ← нормально (GET на POST-эндпоинт)
```

---

### 7. Создать первую подписку

```bash
curl -X POST https://calendar.popugtop.dev/api/calendar/register \
  -H "Content-Type: application/json" \
  -d '{"fio": "Иванов Иван Иванович"}'
```

Подожди 10–30 секунд и открой полученный `url` в браузере — скачается `.ics` файл.

---

### 8. Добавить в Apple Calendar

**Mac:** Календарь → Файл → Новая подписка на календарь → вставь ссылку → Интервал обновления: Каждый час

**iPhone:** Настройки → Календарь → Аккаунты → Добавить аккаунт → Другое → Добавить подписной календарь → вставь ссылку

---

### Обновление кода

```bash
cd /root/app
git pull                    # или rsync с локальной машины
npm install
npm run build
pm2 restart modeus-calendar
```

---

### Диагностика

```bash
pm2 logs modeus-calendar --lines 50   # логи приложения
journalctl -u caddy -n 50             # логи caddy
ss -tlnp | grep 3000                  # убедиться что Node.js слушает порт
curl https://calendar.popugtop.dev/<token> | head -3  # должно быть BEGIN:VCALENDAR
```

---

### Архитектура

```
Apple Calendar (опрос каждый час)
        │ GET https://calendar.popugtop.dev/<token>
        ▼
    Caddy :443  (автоSSL, reverse proxy)
        │
    Node.js :3000  (pm2)
        │
    SQLite (calendar.db)
        │
    ScheduleSyncService (cron 0 */3 * * *)
        └──→ Modeus API (utmn.modeus.org)
```

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

Токены и куки кэшируются в `.tokens.json`. Время жизни ~24 часа. При истечении — удали `.tokens.json` и перезапусти.

---

## Возможные проблемы

**`401 Unauthorized` в логах**
Токен истёк. Удали `.tokens.json` и перезапусти: `pm2 restart modeus-calendar`

**`503` при открытии ICS-ссылки**
Первая синхронизация ещё не завершилась. Подожди 30 секунд и обнови страницу.

**`Человек не найден в Modeus`**
Попробуй с фамилией и инициалами (`Иванов И.И.`) или только с фамилией.

**Caddy не получает сертификат**
Убедись что порт 80 и 443 открыты в firewall (`ufw allow 80 && ufw allow 443`) и DNS уже указывает на сервер.
