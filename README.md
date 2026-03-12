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
2. Проходит SSO-авторизацию на `fs.utmn.ru` и получает Bearer-токен
3. Запрашивает вашу **успеваемость** и выводит оценки в консоль
4. Если указан `MODEUS_PERSON_ID` — запрашивает **расписание** на текущую неделю
5. Запрашивает **активные кампании выбора** элективов и показывает доступные модули с количеством свободных мест

## Использование классов в своём коде

```typescript
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';

const auth = new ModeusAuthService('login@s.utmn.ru', 'password');
await auth.login();

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

**`Не удалось извлечь Bearer-токен`**
Проверьте логин и пароль. Если данные верны — SSO-флоу мог измениться; запустите скрипт с `NODE_DEBUG=axios` и посмотрите на цепочку редиректов.

**`401 Unauthorized`**
Токен истёк. Создайте новый экземпляр `ModeusAuthService` и вызовите `login()` повторно.

**`Нет свободных мест`**
`applyForModule` проверяет `enrolledCount < capacity` перед записью и бросает ошибку, если мест нет. Это защита от лишнего запроса к API.
