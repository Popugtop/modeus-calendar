# Modeus API — неофициальная документация

Составлена методом реверс-инжиниринга HAR-трафика и живых тестов.
Все эндпоинты — `https://utmn.modeus.org`.

---

## Аутентификация

### Как работает

Платформа использует **WSO2 Identity Server** (`auth.modeus.org`) + **ADFS** (`fs.utmn.ru`).
Флоу: OAuth2 **Implicit** + SAML 2.0.

```
1. GET  auth.modeus.org/oauth2/authorize
        ?response_type=id_token token
        &client_id=sKir7YQnOUu4G0eCfn3tTxnBfzca
        &redirect_uri=https://utmn.modeus.org/schedule-calendar/my
        &scope=openid
        &nonce=<random>
        &state=<random>
   → серия 302 → fs.utmn.ru/adfs/ls?SAMLRequest=...

2. GET  fs.utmn.ru/adfs/ls?SAMLRequest=...
   → 200  HTML-форма с двумя hidden-полями (AuthState + CSRF-токен)

3. POST fs.utmn.ru/adfs/ls
        UserName=...&Password=...&AuthMethod=FormsAuthentication&<hidden fields>
   → 302 → GET → 200  HTML с <form action="https://auth.modeus.org/commonauth">
                       содержащей SAMLResponse + RelayState

4. POST auth.modeus.org/commonauth
        SAMLResponse=...&RelayState=...
   → 302 → auth.modeus.org/oauth2/authorize?sessionDataKey=...
   → 302 → redirect_uri#access_token=UUID&id_token=JWT&token_type=Bearer&expires_in=86400

5. Токен извлекается из URL-фрагмента (#).
```

### Токены

| Поле           | Тип  | Описание                                              |
|----------------|------|-------------------------------------------------------|
| `access_token` | UUID | Для справки. API его **не принимает** в Authorization |
| `id_token`     | JWT  | Используется в `Authorization: Bearer` для API        |
| `expires_in`   | int  | Время жизни в секундах. Обычно **86400 (24 часа)**    |

### Полезные поля JWT payload

```json
{
  "sub": "048c03cb-...",
  "person_id": "d21b4d29-df37-4d49-b22b-8f41bec1d7c7",
  "ExternalPersonId": "e59123e1-...",
  "preferred_username": "Архаров Никита Александрович",
  "exp": 1773391273,
  "iat": 1773304873
}
```

`person_id` — UUID, который нужен для запросов расписания.

### Важно про куки

API-запросы аутентифицируются через **сессионные куки**, установленные в процессе SSO.
Bearer-токен также принимается на большинстве эндпоинтов, но куки обязательны.
При загрузке токенов из кэша нужно восстанавливать и CookieJar.

### Обязательные заголовки для API-запросов

```
Authorization: Bearer <id_token>
Accept: application/json, text/plain, */*
Content-Type: application/json
Origin: https://utmn.modeus.org
Referer: https://utmn.modeus.org/
User-Agent: Mozilla/5.0 ...
```

Без `Accept: application/json` сервер может вернуть HTML SPA вместо JSON.

---

## schedule-calendar-v2 API

Base path: `/schedule-calendar-v2/api`

### Поиск событий расписания

**Статус: ✅ Работает, подтверждён HAR + живыми тестами**

```
POST /schedule-calendar-v2/api/calendar/events/search?tz=Asia%2FTyumen
Content-Type: application/json
```

**Тело запроса:**
```json
{
  "size": 500,
  "timeMin": "2026-03-08T19:00:00Z",
  "timeMax": "2026-03-15T19:00:00Z",
  "attendeePersonId": ["d21b4d29-df37-4d49-b22b-8f41bec1d7c7"]
}
```

Параметры:
- `timeMin` / `timeMax` — UTC. Полночь Тюмени = 19:00 UTC предыдущего дня (UTC+5)
- `attendeePersonId` — массив UUID студентов/преподавателей
- `size` — максимум событий. 500 хватает на неделю с запасом
- `tz` в query — `Asia/Tyumen` (жёстко, не системная timezone клиента)

**Ответ (HAL-формат):**
```json
{
  "_embedded": {
    "events": [
      {
        "id": "20db9919-32be-4db0-935c-fc76542e98ca",
        "name": "Численные методы решения задач ПЗ №16",
        "nameShort": "Практическое занятие 24",
        "typeId": "SEMI",
        "formatId": null,
        "start": "2026-03-10T21:00:00+05:00",
        "end": "2026-03-10T22:30:00+05:00",
        "startsAtLocal": "2026-03-10T21:00:00",
        "endsAtLocal": "2026-03-10T22:30:00",
        "holdingStatus": {
          "id": "HELD",
          "name": "Проведено"
        },
        "lessonTemplateId": "33b84f8b-...",
        "_links": {
          "self": { "href": "/20db9919-..." },
          "course-unit-realization": { "href": "/962e209a-..." },
          "lesson-realization": { "href": "/e930f8d4-..." },
          "location": { "href": "/20db9919-.../location" },
          "organizers": { "href": "/20db9919-.../organizers" },
          "team": { "href": "/20db9919-.../team" }
        }
      }
    ]
  }
}
```

Возможные значения `typeId`:

| typeId     | Название                |
|------------|-------------------------|
| `LECT`     | Лекционное занятие      |
| `SEMI`     | Практическое занятие    |
| `LAB`      | Лабораторное занятие    |
| `CUR_CHECK`| Текущий контроль        |
| `CONS`     | Консультация            |
| `OTHER`    | Прочее                  |

⚠️ **Курс** (`course-unit-realization`) в ответе поиска отсутствует.
Попытки получить его через `/catalog/course-unit-realizations/{id}` дали 404.
Рабочий способ пока не найден.

---

### Аудитория события

**Статус: ✅ Работает, подтверждён живым тестом**

```
GET /schedule-calendar-v2/api/calendar/events/{eventId}/location
```

**Ответ (с аудиторией):**
```json
{
  "_embedded": {
    "event-rooms": [
      {
        "id": "3c782d30-...",
        "_links": { "room": { "href": "/701fa8e7-..." } }
      }
    ],
    "rooms": [
      {
        "id": "701fa8e7-...",
        "name": "309",
        "nameShort": "309",
        "building": {
          "id": "247ae429-...",
          "name": "Корпус-11",
          "nameShort": "Корпус-11",
          "address": "ул. Ленина, 23"
        },
        "totalCapacity": 24,
        "workingCapacity": 24
      }
    ],
    "buildings": [ { "name": "Корпус-11", ... } ]
  }
}
```

**Ответ (онлайн / произвольное место):**
```json
{
  "eventId": "20db9919-...",
  "customLocation": "LXP"
}
```

Логика отображения:
- Если `_embedded.rooms[0]` есть → `"${room.name}, ${room.building.name}"`
- Иначе если `customLocation` есть → использовать его
- Иначе → `"—"`

---

### Участники события (студенты и преподаватели)

**Статус: ✅ Работает, подтверждён живым тестом**

```
GET /schedule-calendar-v2/api/calendar/events/{eventId}/attendees
```

**Ответ — массив:**
```json
[
  {
    "id": "45e7290e-...",
    "roleId": "TEACH",
    "roleName": "Преподаватель",
    "roleDisplayOrder": 1,
    "personId": "b3f29f34-...",
    "lastName": "Самойлов",
    "firstName": "Михаил",
    "middleName": "Юрьевич",
    "fullName": "Самойлов Михаил Юрьевич",
    "studentId": null,
    "specialtyCode": null
  },
  {
    "id": "fc8e2948-...",
    "roleId": "STUDENT",
    "roleName": "Обучающийся",
    "personId": "8d6faccf-...",
    "fullName": "Измайлович Данил Денисович",
    "studentId": "5e9e8b46-...",
    "specialtyCode": "09.03.03",
    "specialtyName": "Прикладная информатика"
  }
]
```

Роли (`roleId`):
- `TEACH` — преподаватель
- `STUDENT` — студент

Чтобы получить преподавателя: фильтровать по `roleId === 'TEACH'`.

---

### Поиск людей по ФИО

**Статус: ✅ Работает, подтверждён HAR**

```
POST /schedule-calendar-v2/api/people/persons/search
Content-Type: application/json
```

**Тело запроса:**
```json
{
  "fullName": "новоженов",
  "sort": "+fullName",
  "size": 10,
  "page": 0
}
```

- `fullName` — часть ФИО, регистронезависимо
- `sort` — `+fullName` (по возрастанию) или `-fullName`
- `size` / `page` — пагинация

**Ответ:**
```json
{
  "_embedded": {
    "persons": [
      {
        "id": "28cac47a-b4f1-4e36-95b7-2d6e549e5876",
        "fullName": "Новоженов Глеб Алексеевич",
        "lastName": "Новоженов",
        "firstName": "Глеб",
        "middleName": "Алексеевич",
        "_links": { "self": { "href": "/28cac47a-..." } }
      }
    ],
    "students": [
      {
        "id": "14b272a1-...",
        "personId": "28cac47a-b4f1-4e36-95b7-2d6e549e5876",
        "flowId": "29e4974b-...",
        "flowCode": "2025, Бакалавриат, Специалитет, Очная",
        "specialtyCode": "09.03.03",
        "specialtyName": "Прикладная информатика",
        "specialtyProfile": "Разработка информационных систем бизнеса"
      }
    ]
  }
}
```

- `persons[].id` → `personId` для запроса расписания
- `students` связаны с `persons` через `students[].personId === persons[].id`
- Преподаватели попадают в `persons`, но отсутствуют в `students`
- Пустой `fullName: ""` возвращает всех людей постранично

---

## learning-path-selection API

Base path: `/learning-path-selection/api`

### Список кампаний выбора

**Статус: ✅ Работает, подтверждён HAR**

```
GET /learning-path-selection/api/v1/selection/menus
```

**Ответ — массив:**
```json
[
  {
    "campaignMenuId": "5df0a8a4-...",
    "campaignId": "fbb8fa1a-...",
    "campaignName": "Выбор лекции №2 по дисциплине «Философия» 2025/2026",
    "studentMenuId": "d32bc168-...",
    "selectionAbilityStart": "2025-11-01T05:00:00Z",
    "selectionAbilityEnd": "2025-11-01T18:59:00Z",
    "selectionStatus": "SELECTED",
    "category": "COMPLETE"
  }
]
```

Статусы (`selectionStatus`): `SELECTED`, `NOT_SELECTED`, `PARTLY_SELECTED`.
Статусы (`category`): `COMPLETE`, `ACTIVE`, `UPCOMING`.

---

### Детали кампании

**Статус: ✅ Работает, подтверждён HAR**

```
GET /learning-path-selection/api/selection/menus/{campaignMenuId}
```

**Ответ:**
```json
{
  "id": "5df0a8a4-...",
  "name": "Выбор лекции №2 ...",
  "student": {
    "id": "1b8ff468-...",
    "personId": "d21b4d29-...",
    "fullName": "Архаров Никита Александрович"
  },
  "electives": {
    "items": [ { "id": "e6a443f0-...", ... } ]
  }
}
```

---

### Детали элемента (предмет/секция внутри кампании)

**Статус: ✅ Работает, подтверждён HAR**

```
GET /learning-path-selection/api/selection/menus/{campaignMenuId}/items/{itemId}
```

**Ответ:**
```json
{
  "id": "6bfbdb64-...",
  "courseUnitRealizationId": "a9cac656-...",
  "name": "Философия: технологии мышления (лекция 2)",
  "required": false,
  "completed": true,
  "weight": 1,
  "quantity": 1
}
```

---

### Группа элемента (участники и преподаватель)

**Статус: ✅ Работает, подтверждён HAR**

```
GET /learning-path-selection/api/menus/{campaignMenuId}/elements/{elementId}/team
```

**Ответ:**
```json
{
  "id": "4d399265-...",
  "name": "Выбор лекции №2 ...",
  "professors": [
    { "id": "75608327-...", "name": "Батурин Даниил Антонович" }
  ],
  "attendees": [
    { "id": "c002e14b-...", "name": "Акатов Никита Алексеевич" }
  ]
}
```

---

### Выбрать элементы

**Статус: ✅ Работает, подтверждён HAR**

```
POST /learning-path-selection/api/menus/{campaignMenuId}/elements/select
Content-Type: application/json
```

**Тело — массив ID элементов:**
```json
["15659ce8-...", "b75b2446-..."]
```

**Ответ:**
```json
{
  "selectedIds": ["7a9bf74a-...", "b75b2446-...", "15659ce8-..."],
  "deselectedIds": [],
  "partlySelectedIds": ["0ecd513e-..."],
  "errors": [],
  "menuSelectionStatus": "PARTLY_SELECTED"
}
```

---

### Отменить выбор элемента

**Статус: ✅ Работает, подтверждён HAR**

```
POST /learning-path-selection/api/menus/{campaignMenuId}/elements/{elementId}/deselect
```

Тело пустое. Ответ аналогичен `/select`.

---

## Эндпоинты из исходной документации (НЕ проверены)

Следующие эндпоинты взяты из первоначальных предположений и **не подтверждены** ни HAR-анализом, ни живыми тестами. Использовать осторожно.

| Метод  | URL                                                              | Описание                    |
|--------|------------------------------------------------------------------|-----------------------------|
| GET    | `/schedule-app/api/events/{eventId}`                             | Детали занятия (старый API) |
| GET    | `/people-app/api/persons?eventId={eventId}`                      | Участники (старый API)      |
| GET    | `/journals-app/api/v1/journals/students/me/performance`          | Оценки студента             |
| GET    | `/choice-app/api/v2/students/me/selections/active`               | Активные кампании           |
| GET    | `/choice-app/api/v2/selections/{selectionId}/modules`            | Модули кампании             |
| POST   | `/choice-app/api/v2/selections/{selectionId}/apply`              | Запись на модуль            |
| DELETE | `/choice-app/api/v2/selections/{selectionId}/cancel`             | Отмена записи               |

При обращении к этим эндпоинтам без куков сервер возвращает HTML SPA.
Возможно, работают только с сессионными куками, но не тестировались.

---

## Не найдено

- **Название курса** для события расписания. Событие содержит `_links.course-unit-realization.href`, но эндпоинт `/schedule-calendar-v2/api/catalog/course-unit-realizations/{id}` возвращает 404. Рабочий путь неизвестен.
