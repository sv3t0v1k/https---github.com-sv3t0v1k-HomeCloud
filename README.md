# HomeCloud

**Локальная квалификация на 6 октября 2026:** полный 50 ГиБ Browser E2E — **PASS** в IAB/Chromium через HTTP localhost: три SHA-256 совпали, восстановление той же сессии, отмена и очистка подтверждены [отчётом](docs/evidence/browser-50gib-qualification-20261006/report.md). Safari функциональные сценарии — PASS; Safari полный 50 ГиБ — **UNQUALIFIED**. Production — **NOT_READY / NO_GO**.

Версия `v0.9.0-local.1` — первая нумерованная предпроизводственная локальная версия, не production deployment и не доля завершённости roadmap. [Контракт версии и ограничения](docs/local-release-baseline.md), [изменения](CHANGELOG.md), [план — источник истины](docs/ROADMAP.md).

**Self-hosted универсальное хранилище файлов** с загрузкой по частям, публичными ссылками, превью и веб-интерфейсом. Расширение, MIME и содержимое определяют возможность превью. Они не ограничивают допуск к хранению: бинарные артефакты, архивы, файлы с неизвестным расширением и без расширения принимаются без списка разрешённых типов. Размер ограничивают квота и технические пределы инфраструктуры.

![Backend](https://img.shields.io/badge/Backend-NestJS_10-red)
![Frontend](https://img.shields.io/badge/Frontend-React_18%2B_Vite%2B_Tailwind-blue)
![Database](https://img.shields.io/badge/Database-PostgreSQL_16-blue)
![Redis](https://img.shields.io/badge/Redis-7-blue)

## Возможности

### Управление файлами
- Загрузка файлов через chunked upload (разбивка на части) с настраиваемыми лимитами размера чанка и файла
- Пакетный выбор файлов и Drag & Drop файлов в текущую папку; одна очередь, отдельные состояния и ошибки
- Pause сохраняет сессию; Resume сверяет серверные части и продолжает ту же сессию; Cancel подтверждает очистку
- После перезагрузки страницы или перезапуска браузера для докачки требуется повторно выбрать исходный локальный файл; содержимое файлов и секреты в метаданные загрузки не записываются
- Создание, переименование, перемещение и копирование файлов
- Древовидная структура папок
- Корзина с восстановлением и окончательным удалением
- Поиск файлов по имени

### Безопасность
- JWT аутентификация с access/refresh токенами
- Защищённые API endpoints через JWT guard
- Обычный API: 100 запросов за 60 с; передача частей: 25 запросов/с с burst 50 на пользователя, максимум 4 параллельных запроса на пользователя и 32 на процесс; отмена имеет отдельный бюджет
- Helmet, CORS, валидация входных данных
- Хеширование паролей учётной записи (bcrypt, 12 раундов)
- Парольная защита публичных ссылок (bcrypt, 10 раундов)

### Публичные ссылки
- Создание ссылок для sharing файлов
- Парольная защита
- Настраиваемый срок действия (по умолчанию 7 дней)
- Счётчик скачиваний
- Возможность отзыва ссылки

### Превью и миниатюры
- Автоматическая генерация миниатюр для изображений (300×300 px, PNG)
- Превью текстовых файлов (поддержка JSON, JS, XML, HTML, CSS)
- Превью изображений
- Fallback сообщения для неподдерживаемых типов

### Хранение
- Изолированные директории для каждого пользователя
- Безопасные имена файлов с уникальным суффиксом
- Подсчёт используемого пространства
- Persistent volumes через Docker
- Резервное копирование и восстановление

### Мониторинг
- Health check endpoint (`/api/v1/health`)
- Health checks для всех сервисов в docker-compose
- Логирование запросов (interceptor)
- Глобальный exception filter с timestamp и path

## Технологический стек

### Backend
- **Framework**: NestJS 10
- **Language**: TypeScript 5.5
- **ORM**: TypeORM 0.3
- **Database**: PostgreSQL 16
- **Redis**: Redis 7 (объявлен в Docker Compose; backend пока не использует для кэша/сессий)
- **Auth**: JWT (passport-jwt), bcrypt
- **File processing**: Sharp (thumbnails), file-type
- **Security**: Helmet, CORS, express-rate-limit, class-validator
- **Storage**: Нативная файловая система с streaming

### Frontend
- **Framework**: React 18
- **Build**: Vite 6
- **Language**: TypeScript 5.6
- **Styling**: Tailwind CSS 3.4
- **Routing**: React Router 7
- **HTTP Client**: Axios
- **Deploy**: Nginx Alpine (multi-stage Docker build)

## Требования

- Docker Engine с поддержкой используемых Compose features
- Docker Compose >= 2.24.4
- Ресурсы зависят от данных и параллельных передач; 2 ГиБ RAM и 5 ГиБ диска не являются квалифицированным бюджетом для больших файлов
- Для финализации серверу требуется примерно 2 × размер файла плюс concurrent ingress; исходник и скачанная копия требуют отдельного места. Docker VM backing disk также учитывается

## Быстрый старт

### 1. Клонирование репозитория

```bash
git clone https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud.git HomeCloud
cd HomeCloud
```

### 2. Единственное локальное окружение

Обычная разработка использует **только `homecloud-preview`**: production topology плюс
`docker-compose.local.yml`. Требуется Docker Compose >= 2.24.4 (`!override` заменяет
публичные port bindings, а не добавляет loopback bindings к ним).

Runtime secrets и TLS находятся вне репозитория в
`~/Library/Application Support/HomeCloud/{config,tls,challenges}`. Не копируйте
секреты в repo `.env` и не используйте исчезающие `/private/tmp` overrides.
Local override требует существующие external volumes
`homecloud-preview_db_data` и `homecloud-preview_storage_data`: отсутствие volume
останавливает запуск вместо создания пустой базы. Для нового хоста сначала
восстановите проверенный backup по [runbook](docs/operations-runbook.md).

### 3. Запуск и проверка

```sh
# Выполнять из корня HomeCloud. Файл env защищён правами 0600.
hc() {
  docker compose --project-name homecloud-preview \
    --env-file "$HOME/Library/Application Support/HomeCloud/config/runtime.env" \
    -f docker-compose.production.yml -f docker-compose.local.yml "$@"
}
hc config --quiet
hc up -d --build --wait
hc ps
```

[Полные инструкции запуска, обновления, миграций и восстановления](docs/operations-runbook.md).
`docker-compose.yml` — историческая конфигурация; не запускайте её для обычной
разработки: она связывает другие volumes и создаёт конкурирующее окружение.

### 4. Создание пользователя

Регистрация доступна через `POST /api/v1/auth/register` на том же frontend URL;
экран UI поддерживает вход, отдельного экрана регистрации пока нет. Пароли не хранятся в Git.
Модель ролей отсутствует: регистрация создаёт обычного пользователя с нулевой
квотой. Для загрузки оператор назначает квоту отдельно; local dev-аккаунт уже
получил 100 ГиБ. См. runbook; пароли пользователей напрямую в БД не менять.

## Доступ

| Сервис | URL | Описание |
|--------|-----|----------|
| Frontend | http://localhost:8080 | Канонический локальный UI |
| HTTPS ingress | https://homecloud.localhost | Локальный сертификат, без публичной CA-квалификации |
| API | http://localhost:8080/api/v1 | API через frontend; backend port не опубликован |
| HTTP ingress | http://homecloud.localhost | 308 на HTTPS; ACME challenge отдельно |

DB/backend/Redis не публикуются; Redis profile отключён. Health/metrics недоступны
через публичные proxy routes. Используйте `hc ps` и внутренний readiness endpoint.
Локальный сертификат не установлен в системное доверие: браузер может показать
предупреждение. HTTP localhost остаётся доступным для обычной работы.

## Структура проекта

```
HomeCloud/
├── docker-compose.production.yml # Топология
├── docker-compose.local.yml     # Единственный локальный override
├── docker-compose.yml          # Историческая конфигурация
├── .env.example                # Пример переменных окружения
├── README.md                   # Документация
├── backend/
│   ├── Dockerfile              # Многоэтапная сборка Node 20 Alpine
│   ├── package.json            # Зависимости NestJS
│   ├── tsconfig.json           # Конфигурация TypeScript
│   └── src/
│       ├── main.ts             # Точка входа, глобальные middleware
│       ├── app.module.ts       # Корневой модуль
│       ├── auth/               # Модуль аутентификации
│       │   ├── auth.module.ts
│       │   ├── auth.service.ts
│       │   ├── auth.controller.ts
│       │   ├── jwt.strategy.ts
│       │   ├── local.strategy.ts
│       │   ├── guards/
│       │   │   └── jwt.guard.ts
│       │   └── dtos/
│       │       ├── register.dto.ts
│       │       ├── login.dto.ts
│       │       └── change-password.dto.ts
│       ├── users/              # Модуль пользователей
│       │   ├── users.module.ts
│       │   ├── users.service.ts
│       │   ├── users.controller.ts
│       │   └── dtos/
│       │       └── update-profile.dto.ts
│       ├── files/              # Модуль файлов (ядро)
│       │   ├── files.module.ts
│       │   ├── files.service.ts
│       │   └── files.controller.ts
│       ├── uploads/            # Chunked upload
│       │   ├── uploads.module.ts
│       │   ├── uploads.service.ts
│       │   ├── uploads.controller.ts
│       │   └── dtos/
│       │       ├── create-session.dto.ts
│       │       └── chunk.dto.ts
│       ├── sharing/            # Публичные ссылки
│       │   ├── sharing.module.ts
│       │   ├── sharing.service.ts
│       │   ├── sharing.controller.ts
│       │   └── dtos/
│       │       └── create-share.dto.ts
│       ├── previews/           # Превью и миниатюры
│       │   ├── previews.module.ts
│       │   ├── previews.service.ts
│       │   └── previews.controller.ts
│       ├── storage/            # Работа с файловой системой
│       │   ├── storage.module.ts
│       │   └── storage.service.ts
│       ├── common/             # Общие компоненты
│       │   ├── common.module.ts
│       │   ├── health.controller.ts
│       │   ├── errors/
│       │   │   └── http-exception.filter.ts
│       │   ├── interceptors/
│       │   │   ├── transform.interceptor.ts
│       │   │   └── logging.interceptor.ts
│       │   └── security.config.ts # Helmet, CORS, rate limiting
│       └── entities/           # Сущности TypeORM
│           ├── user.entity.ts
│           ├── file.entity.ts
│           ├── folder.entity.ts
│           ├── share-link.entity.ts
│           └── upload-session.entity.ts
└── frontend/
    ├── Dockerfile              # Multi-stage: Node build + Nginx serve
    ├── nginx.conf              # SPA fallback + API proxy
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── api/
        │   └── client.ts
        └── types/
            ├── auth.ts
            └── files.ts
```

## API Reference

### Аутентификация

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/v1/auth/register` | Регистрация пользователя |
| POST | `/api/v1/auth/login` | Вход, получение токенов |
| POST | `/api/v1/auth/refresh` | Обновление access токена |
| POST | `/api/v1/auth/change-password` | Смена пароля |
| POST | `/api/v1/auth/logout` | Выход |

### Пользователи

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/v1/users/me` | Получить текущего пользователя |
| PATCH | `/api/v1/users/me` | Обновить профиль |

### Файлы

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/v1/files` | Список файлов в корне |
| GET | `/api/v1/files?parentId={id}` | Список файлов в папке |
| GET | `/api/v1/files/:id` | Получить файл |
| PATCH | `/api/v1/files/:id` | Переименовать/переместить |
| DELETE | `/api/v1/files/:id` | В корзину |
| POST | `/api/v1/files/:id/restore` | Восстановить из корзины |
| DELETE | `/api/v1/files/:id/permanent` | Удалить навсегда |
| POST | `/api/v1/files/:id/copy` | Копировать |
| POST | `/api/v1/files/:id/move` | Переместить |
| GET | `/api/v1/files/folders` | Список папок |
| POST | `/api/v1/files/folders` | Создать папку |
| GET | `/api/v1/files/trash` | Корзина |
| POST | `/api/v1/files/empty-trash` | Очистить корзину |
| GET | `/api/v1/files/search?q={query}` | Поиск |
| GET | `/api/v1/files/storage-info` | Информация о хранилище |

### Uploads

Архитектура больших файлов: durable unique chunk metadata и компактные counters; streaming finalization с server disk peak≈2S. Лимиты1ТиБ/file и2ТиБ/active user sessions — настраиваемая policy; quota действует отдельно. Текущий полный 50 ГиБ PASS: [браузерная квалификация](docs/evidence/browser-50gib-qualification-20261006/report.md). История изменения архитектуры: [remediation evidence](docs/evidence/large-file-remediation-20261004/report.md). 50 ГиБ — размер квалификации, не максимальный размер файла.


| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/v1/uploads/limits` | Effective upload limits для текущего пользователя |
| POST | `/api/v1/uploads/session` | Создать сессию загрузки |
| POST | `/api/v1/uploads/session/:uploadId/chunk` | Загрузить чанк |
| POST | `/api/v1/uploads/session/:uploadId/complete` | Завершить загрузку |
| DELETE | `/api/v1/uploads/session/:uploadId` | Отменить загрузку |
| GET | `/api/v1/uploads/sessions` | До 200 неистёкших сессий владельца в состояниях pending/uploading |
| GET | `/api/v1/uploads/session/:uploadId` | Метаданные и SHA-256 принятых частей; сверка завершённой сессии после потери ответа |

### Sharing

Создание ссылки принимает `fileId` (положительное безопасное целое), опциональные
`password` (строка), `isFolder` (boolean), `expiresInDays` (целое от 1 до 36500,
по умолчанию 7) и `maxDownloads` (положительное безопасное целое;
`null` или отсутствие поля означает отсутствие лимита).

Лимит атомарно проверяется вместе с token, active и expiry. Каждый допущенный
полный или Range-ответ списывает отдельную попытку после успешного открытия storage
и проверки диапазона. Ответ 416 и отсутствие файла попытку не расходуют; обрыв
после допуска не возвращает слот. Исчерпанная, истёкшая или отозванная ссылка
отклоняется с 404.

Для ссылки на папку `GET /sharing/public/:token/children` возвращает только
  непосредственных потомков внутри её поддерева. `parentId` — идентификатор
  `FolderEntity`; без него используется корень ссылки. поддерживаются `limit` (1–100)
  и `offset`. Пароль передаётся в `X-Share-Password`, а не в URL. Скачивание папки
  архивом: без `fileId` в body `/download` возвращается потоковый ZIP-архив
  (`200 application/zip`, `Content-Disposition: attachment`, `Cache-Control: no-store`,
  без `Content-Length`) со всеми живыми потомками поддерева; один запрос архива
  списывает ровно один слот, независимо от количества файлов. Скачивание отдельного
  потомка: передайте его `fileId` — будет выдан обычный Range-поток по существующему
  правилу. Слот не возвращается, если клиент отключился или поток упал после допуска.

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/v1/sharing` | Создать публичную ссылку |
| GET | `/api/v1/sharing` | Список ссылок пользователя |
| DELETE | `/api/v1/sharing/:id` | Отозвать ссылку |
| GET | `/api/v1/sharing/public/:token` | Информация о ссылке |
| GET | `/api/v1/sharing/public/:token/children` | Потомки общей папки (`parentId`, `limit`, `offset`) |
| POST | `/api/v1/sharing/public/:token/verify` | Проверить пароль |
| POST | `/api/v1/sharing/public/:token/download` | Скачать файл по ссылке (`fileId` для folder share) |

### Previews

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/v1/previews/:id/thumbnail` | Миниатюра изображения (PNG) |
| GET | `/api/v1/previews/:id` | Превью файла |

### Health

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/v1/health` или `/health/live` | Liveness процесса, не зависимостей |
| GET | `/api/v1/health/ready` | Readiness PostgreSQL и storage |

Все пути относительно `/api/v1`; `/health/live` означает `/api/v1/health/live`. Proxy закрывает health/metrics от публичных запросов; проверки выполняются внутри canonical Compose.

## Docker Volumes

| Volume | Назначение |
|--------|------------|
| `homecloud-preview_db_data` | Каноническая PostgreSQL БД |
| `redis_data` | Опциональный Redis; в local baseline выключен |
| `homecloud-preview_storage_data` | Канонические пользовательские файлы |

## Резервное копирование

См. [docs/backup-and-restore.md](docs/backup-and-restore.md).

## Переменные окружения

| Переменная | Локальный baseline | Описание |
|------------|--------------|----------|
| `DB_NAME` | `homecloud_preview` | Имя базы данных |
| `DB_USER` | `homecloud_preview` | Пользователь PostgreSQL |
| `DB_PASSWORD` | Внешний сильный секрет | Пароль PostgreSQL |
| `JWT_SECRET` | Внешний сильный секрет | Секрет для access токенов |
| `JWT_REFRESH_SECRET` | Независимый внешний секрет | Секрет для refresh токенов |
| `REDIS_URL` | Пусто; Redis выключен | URL Redis |
| `STORAGE_PATH` | `/storage` | Путь к хранилищу файлов |
| `MAX_FILE_SIZE` | `1099511627776` | Максимальный размер файла (0 = без ограничений) |
| Базовая часть клиента | `10485760` | Константа 10 МиБ с адаптацией по maxChunks; legacy `CHUNK_SIZE` env не управляет текущей UploadQueue |
| `MAX_TOTAL_SIZE` | `2199023255552` | Активные резервы загрузок на пользователя (2 ТиБ) |
| `MAX_UPLOAD_CHUNKS` | `100000` | Максимальное число частей |
| `MAX_CHUNK_SIZE` | `52428800` | Максимальный размер части (50 МиБ) |
| `FRONTEND_URL` | `https://homecloud.localhost` | URL фронтенда для CORS |
| API фронтенда | `/api/v1` относительно frontend URL | Backend наружу не опубликован |
| `PORT` | `3000` | Порт бэкенда |

## Разработка

Канонический запуск — функция `hc` выше и [runbook](docs/operations-runbook.md). Команды ниже предназначены для отдельного запуска исходников при заранее настроенных зависимостях и внешнем runtime config; они не создают второй Compose-стек. Не публикуйте PostgreSQL/backend для обычной работы. Для воспроизводимой установки используйте lock-файлы:

### Backend

```bash
cd backend
npm ci
npm run start:dev
```

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

## Безопасность

Production **NOT_READY / NO_GO**. Используйте существующий [TLS/proxy contract](docs/production-topology.md), [secret lifecycle](docs/secret-lifecycle.md), [backup/recovery](docs/backup-productionization.md) и [external gate checklist](docs/external-input-master-checklist.md). Canonical Compose уже закрывает DB/backend ports; публичный запуск требует фактической приёмки целевого окружения.

## Лицензия

HomeCloud распространяется под лицензией [MIT](LICENSE).

### Native browser download

Bearer POST `/api/v1/native-downloads/:id/prepare` выдаёт short-lived resource cookie; GET `/api/v1/native-downloads/:id` атомарно расходует capability и стримит в download manager. HttpOnly/Strict/host-only/Secure production,120s initiation TTL; JWT и capability не находятся в URL. Same-origin frontend/API, доверенный HTTPS в production. JS file Blob отсутствует; interrupted Range resume требует fresh prepare.

## Архитектура универсальной загрузки

Приём файла проверяет имя и путь, доступ к папке, размер, число частей и квоту. MIME сохраняется как метаданные для выбора превью; неизвестное или неклассифицируемое содержимое получает `application/octet-stream`. Прежний `ALLOWED_UPLOAD_MIME_TYPES` больше не задаёт политику хранения. Скачивание сохраняет исходное имя и регистр расширения через безопасный UTF-8 `filename*`. Если превью недоступно, интерфейс сообщает об этом; загрузка и скачивание остаются доступны.

`UploadQueue` обслуживает максимум два файла одновременно, по одной части на файл. `File.slice` ограничивает чтение размером части; память для списка метаданных растёт с размером очереди. Основные состояния: `selected → queued → preparing → uploading/retrying → completing → completed`. Дополнительные состояния: `pausing/paused`, `needs-file`, `error`, `cancelling/cancelled`. Пауза останавливает планирование частей, прерывает ожидание повтора и позволяет текущему запросу завершиться. Она не вызывает серверную отмену и не освобождает резерв квоты. Продолжение получает сведения о серверной сессии, сверяет принятые части и пропускает их при передаче. Отмена ждёт текущий запрос и подтверждение `DELETE`; неподтверждённая очистка остаётся ошибкой с возможностью повторить отмену. После потери ответа финализации клиент сверяет результат с сервером: уже сохранённый файл не удаляется как незавершённая загрузка.

`localStorage` хранит метаданные отдельно для каждого владельца: идентификатор сессии, имя, размер, папку, подтверждённый прогресс, отпечаток выборки, время допустимого повтора и намерение отмены. JWT, пароли и содержимое файлов в эти метаданные не входят. После перезагрузки браузер не восстанавливает обычный объект `File` автоматически. Пользователь повторно выбирает файл с тем же именем и размером. Клиент сравнивает отпечаток выборки объёмом до трёх блоков по 64 КиБ, если он был сохранён, затем SHA-256 каждой ранее принятой части. Выборка не является полным хешем файла: изменение ещё не загруженных байтов вне выборки может остаться незамеченным. Для обнаруженной серверной сессии без локального отпечатка всё равно проверяются все принятые части.

WebCrypto для проверки хешей требует защищённого контекста браузера: HTTPS или поддерживаемого браузером localhost. Если проверку выполнить невозможно, продолжение с ранее принятыми частями блокируется с понятным сообщением. Доступность `localStorage` в приватном режиме зависит от настроек браузера; обнаружение активных серверных сессий остаётся способом найти незавершённую загрузку. Safari использует обычный выбор файла. Автоматическое восстановление доступа через файловые дескрипторы не реализовано.

Прогресс учитывает принятые сервером байты и не превышает 99% до успешной финализации или подтверждения уже завершённой сессии. Пауза сохраняет `Retry-After`, продолжение соблюдает установленный срок. Для части доступны три попытки; отдельное автоматическое ожидание ограничено 60 с, суммарное ожидание — пятью минутами на окно повторов. Исчерпание попыток сохраняет сессию для явного продолжения. Потеря ответа создания не приводит к повторному `POST`: клиент обнаруживает серверные сессии и предлагает повторно выбрать исходный файл для подходящей загрузки.

`MAX_FILE_SIZE` по умолчанию равен `1099511627776` байтам (1 ТиБ на файл). Это настраиваемый инфраструктурный предел. `MAX_TOTAL_SIZE=2199023255552` ограничивает суммарный объём активных резервов; `MAX_UPLOAD_CHUNKS=100000`, `MAX_CHUNK_SIZE=52428800`. Квота проверяется сервером. Нулевой предел размера файла или суммарного резерва отключает соответствующий отдельный предел; нулевая квота даёт нулевую ёмкость. Срок жизни сессии по умолчанию составляет 24 часа и является абсолютным: истёкшая сессия не продолжается. Пустые файлы текущий API сессий не поддерживает; интерфейс показывает отдельную ошибку. Перетаскивание папок отложено. Выбор файлов и перетаскивание отдельных файлов используют одну очередь.
