# Modeus Bot

Клиент для образовательного портала ТюмГУ (utmn.modeus.org) на TypeScript.
Авторизация через SSO `fs.utmn.ru` — только чистые HTTP-запросы, без браузеров.

## Требования

- Node.js >= 18
- npm >= 9

## Установка

```bash
git clone <repo-url>
cd modeus-bot
npm install
```

## Настройка .env

Скопируйте шаблон и заполните его:

```bash
cp .env.example .env
```

Откройте `.env` и укажите данные:

```env
# Логин от личного кабинета ТюмГУ (тот же, что на fs.utmn.ru)
MODEUS_USERNAME=ivanov.ii@s.utmn.ru

# Пароль
MODEUS_PASSWORD=ваш_пароль

# (Опционально) UUID вашего студенческого профиля в Modeus.
# Нужен только для запроса расписания.
# Как получить — см. раздел ниже.
MODEUS_PERSON_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> **Важно:** файл `.env` добавлен в `.gitignore`. Никогда не коммитьте его в репозиторий.

### Как узнать свой MODEUS_PERSON_ID

Это UUID вашего профиля в системе Modeus. Способы получить его:

1. **Через DevTools браузера.** Войдите в Modeus вручную, откройте вкладку Network, найдите любой запрос к `schedule-app` или `people-app` — в теле запроса или ответа будет поле `id` или `personId`.

2. **Через URL профиля.** Перейдите в свой профиль на `utmn.modeus.org` — UUID часто присутствует прямо в адресной строке.

3. **Оставить пустым.** Без `MODEUS_PERSON_ID` скрипт просто пропустит запрос расписания, остальное (оценки, элективы) работает без него.

## Как работает авторизация

Modeus использует связку **WSO2 Identity Server** (`auth.modeus.org`) + **ADFS** (`fs.utmn.ru`). Флоу — OAuth2 Implicit + SAML 2.0:

```
1. GET  auth.modeus.org/oauth2/authorize?response_type=id_token+token&client_id=...
        → 302-цепочка → fs.utmn.ru/adfs/ls?SAMLRequest=...

2. GET  fs.utmn.ru/adfs/ls?SAMLRequest=...
        → 200  HTML-форма логина (2 hidden-поля: AuthState + CSRF)

3. POST fs.utmn.ru/adfs/ls  { UserName, Password, ...hidden }
        → 302 → GET → 200  HTML с <form> и SAMLResponse внутри

4. POST auth.modeus.org/commonauth  { SAMLResponse, RelayState }
        → 302 → auth.modeus.org/oauth2/authorize?sessionDataKey=...
        → 302 → utmn.modeus.org/schedule-calendar/my#access_token=UUID&id_token=JWT&...

5. Токен извлекается из URL-фрагмента (#).
   Для API используется id_token (JWT), а не access_token (UUID).
```

### Где хранится токен

Токен хранится **только в памяти** — в свойствах экземпляра `ModeusAuthService`:

```typescript
auth.idToken      // JWT — используется в Authorization: Bearer для API-запросов
auth.bearerToken  // UUID access_token — хранится для справки, API его не принимает
```

При перезапуске скрипта токен теряется — нужно вызывать `login()` заново.
Время жизни токена — ~24 часа (указано в поле `exp` внутри JWT).

Если нужно сохранять токен между запусками — запишите `auth.idToken` в файл или БД и передавайте напрямую в `ModeusService`:

```typescript
// Сохранить
fs.writeFileSync('.token', auth.idToken);

// Восстановить (без повторного логина)
const token = fs.readFileSync('.token', 'utf-8');
const modeus = new ModeusService(token); // принимает raw строку
```

## Запуск

### Режим разработки (без сборки, через ts-node)

```bash
npm run dev
```

### Продакшн (сборка + запуск)

```bash
npm run build
npm start
```

### Только проверка типов (без запуска)

```bash
npm run typecheck
```

## Что делает скрипт при запуске

1. Читает логин и пароль из `.env`
2. Проходит SSO-авторизацию и получает JWT токен
3. Запрашивает вашу **успеваемость** и выводит оценки в консоль
4. Если указан `MODEUS_PERSON_ID` — запрашивает **расписание** на текущую неделю
5. Запрашивает **активные кампании выбора** элективов и показывает доступные модули с количеством свободных мест

## Использование классов в своём коде

```typescript
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';

const auth = new ModeusAuthService('login@s.utmn.ru', 'password');
await auth.login();

// auth.idToken  — JWT для API
// auth.bearerToken — UUID access_token

const modeus = new ModeusService(auth);

// Оценки
const performance = await modeus.getMyPerformance();

// Расписание
const schedule = await modeus.getSchedule({
  size: 50,
  timeMin: '2024-09-01T00:00:00+05:00',
  timeMax: '2024-09-07T23:59:59+05:00',
  attendeePersonId: ['ваш-uuid'],
});

// Активные кампании выбора
const selections = await modeus.getActiveSelections();

// Модули первой кампании
const modules = await modeus.getSelectionModules(selections.data[0].id);

// Записаться на модуль (проверяет свободные места автоматически)
await modeus.applyForModule(selectionId, moduleId, 1);

// Отменить запись
await modeus.cancelModule(selectionId, moduleId);
```

## Структура проекта

```
src/
├── auth/
│   └── ModeusAuthService.ts   # SSO-авторизация: куки, редиректы, SAML, токен
├── api/
│   └── ModeusService.ts       # Методы API: расписание, оценки, элективы
├── types/
│   └── index.ts               # TypeScript-интерфейсы всех запросов и ответов
└── index.ts                   # Пример запуска
```

## Возможные проблемы

**`Неверный логин или пароль`**
Проверьте `MODEUS_USERNAME` и `MODEUS_PASSWORD` в `.env`. Логин обычно в формате `ivanov.ii@s.utmn.ru`.

**`SAMLResponse не найден`**
ADFS изменил структуру страницы. Включите отладочный вывод — в ошибке будут первые 300 символов HTML, по ним можно понять что пошло не так.

**`401 Unauthorized`**
Токен истёк (~24 часа). Создайте новый экземпляр `ModeusAuthService` и вызовите `login()` повторно.

**`Нет свободных мест`**
`applyForModule` проверяет `enrolledCount < capacity` перед записью и бросает ошибку, если мест нет. Это защита от лишнего запроса к API.
