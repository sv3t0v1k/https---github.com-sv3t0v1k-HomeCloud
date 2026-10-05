# HomeCloud

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
- Шифрование паролей учётной записи (bcrypt, 12 раундов)
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
- **Routing**: React Router 6
- **HTTP Client**: Axios
- **Deploy**: Nginx Alpine (multi-stage Docker build)

## Требования

- Docker Engine 20.10+
- Docker Compose 2.0+
- 2 GB свободной RAM
- 5 GB свободного дискового пространства

## Быстрый старт

### 1. Клонирование репозитория

```bash
git clone https://github.com/yourusername/homecloud.git
cd homecloud
```

### 2. Настройка окружения

Скопируйте файл с переменными окружения и при необходимости измените значения:

```bash
cp .env.example .env
```

Доступные переменные в `.env`:

```env
# База данных
DB_NAME=homecloud
DB_USER=homecloud
DB_PASSWORD=change-me-in-production

# JWT (обязательно изменить в production!)
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=change-me-in-production

# Redis
REDIS_URL=redis://redis:6379
REDIS_PASSWORD=change-me-in-production

# Хранилище
STORAGE_PATH=/storage
MAX_FILE_SIZE=0
CHUNK_SIZE=10485760

# Frontend
FRONTEND_URL=http://localhost:5173
API_URL=http://localhost:3000
```

**Важно**: для production обязательно измените `DB_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET` и `REDIS_PASSWORD` на надёжные случайные строки.

### 3. Запуск

```bash
docker compose up -d
```

### 4. Проверка статуса

```bash
docker compose ps
```

### 5. Создание пользователя

После запуска создайте пользователя через API:

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123",
    "name": "User Name"
  }'
```

## Доступ

| Сервис | URL | Описание |
|--------|-----|----------|
| Frontend | http://localhost | Веб-интерфейс |
| Backend API | http://localhost:3000/api/v1 | REST API |
| Health check | http://localhost:3000/api/v1/health | Статус приложения |

## Структура проекта

```
HomeCloud/
├── docker-compose.yml          # Оркестрация сервисов
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

Архитектура больших файлов: durable unique chunk metadata и компактные counters; streaming finalization с server disk peak≈2S. Лимиты1ТиБ/file и2ТиБ/active user sessions — настраиваемая policy; quota действует отдельно. Подробнее и фактический статус квалификации: [remediation evidence](docs/evidence/large-file-remediation-20261004/report.md).


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
| GET | `/api/v1/health` | Статус приложения |

## Docker Volumes

| Volume | Назначение |
|--------|------------|
| `db_data` | Данные PostgreSQL |
| `redis_data` | Персистентность Redis |
| `storage_data` | Загруженные пользовательские файлы |

## Резервное копирование

См. [docs/backup-and-restore.md](docs/backup-and-restore.md).

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `DB_NAME` | `homecloud` | Имя базы данных |
| `DB_USER` | `homecloud` | Пользователь PostgreSQL |
| `DB_PASSWORD` | `changeme` | Пароль PostgreSQL |
| `JWT_SECRET` | `changeme-change-in-production` | Секрет для access токенов |
| `JWT_REFRESH_SECRET` | `changeme-change-in-production` | Секрет для refresh токенов |
| `REDIS_URL` | `redis://redis:6379` | URL Redis |
| `STORAGE_PATH` | `/storage` | Путь к хранилищу файлов |
| `MAX_FILE_SIZE` | `0` | Максимальный размер файла (0 = без ограничений) |
| `CHUNK_SIZE` | `10485760` | Размер чанка для загрузки (10 MB) |
| `FRONTEND_URL` | `http://localhost:5173` | URL фронтенда для CORS |
| `API_URL` | `http://localhost:3000` | URL бэкенда для фронтенда |
| `PORT` | `3000` | Порт бэкенда |

## Разработка

### Backend

```bash
cd backend
npm install
npm run start:dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Безопасность

- Измените `JWT_SECRET` и `JWT_REFRESH_SECRET` в production
- Используйте надёжный пароль для PostgreSQL
- Настройте `FRONTEND_URL` для ограничения CORS
- Для production рекомендуется настроить reverse proxy (Nginx/Traefik) с HTTPS
- Убедитесь, что порт 5432 (PostgreSQL) не открыт наружу

## Лицензия

MIT

### Native browser download

Bearer POST `/api/v1/native-downloads/:id/prepare` выдаёт short-lived resource cookie; GET `/api/v1/native-downloads/:id` атомарно расходует capability и стримит в download manager. HttpOnly/Strict/host-only/Secure production,120s initiation TTL; JWT и capability не находятся в URL. Same-origin frontend/API, доверенный HTTPS в production. JS file Blob отсутствует; interrupted Range resume требует fresh prepare.

## Архитектура универсальной загрузки

Приём файла проверяет имя и путь, доступ к папке, размер, число частей и квоту. MIME сохраняется как метаданные для выбора превью; неизвестное или неклассифицируемое содержимое получает `application/octet-stream`. Прежний `ALLOWED_UPLOAD_MIME_TYPES` больше не задаёт политику хранения. Скачивание сохраняет исходное имя и регистр расширения через безопасный UTF-8 `filename*`. Если превью недоступно, интерфейс сообщает об этом; загрузка и скачивание остаются доступны.

`UploadQueue` обслуживает максимум два файла одновременно, по одной части на файл. `File.slice` ограничивает чтение размером части; память для списка метаданных растёт с размером очереди. Основные состояния: `selected → queued → preparing → uploading/retrying → completing → completed`. Дополнительные состояния: `pausing/paused`, `needs-file`, `error`, `cancelling/cancelled`. Пауза останавливает планирование частей, прерывает ожидание повтора и позволяет текущему запросу завершиться. Она не вызывает серверную отмену и не освобождает резерв квоты. Продолжение получает сведения о серверной сессии, сверяет принятые части и пропускает их при передаче. Отмена ждёт текущий запрос и подтверждение `DELETE`; неподтверждённая очистка остаётся ошибкой с возможностью повторить отмену. После потери ответа финализации клиент сверяет результат с сервером: уже сохранённый файл не удаляется как незавершённая загрузка.

`localStorage` хранит метаданные отдельно для каждого владельца: идентификатор сессии, имя, размер, папку, подтверждённый прогресс, отпечаток выборки, время допустимого повтора и намерение отмены. JWT, пароли и содержимое файлов в эти метаданные не входят. После перезагрузки браузер не восстанавливает обычный объект `File` автоматически. Пользователь повторно выбирает файл с тем же именем и размером. Клиент сравнивает отпечаток выборки объёмом до трёх блоков по 64 КиБ, если он был сохранён, затем SHA-256 каждой ранее принятой части. Выборка не является полным хешем файла: изменение ещё не загруженных байтов вне выборки может остаться незамеченным. Для обнаруженной серверной сессии без локального отпечатка всё равно проверяются все принятые части.

WebCrypto для проверки хешей требует защищённого контекста браузера: HTTPS или поддерживаемого браузером localhost. Если проверку выполнить невозможно, продолжение с ранее принятыми частями блокируется с понятным сообщением. Доступность `localStorage` в приватном режиме зависит от настроек браузера; обнаружение активных серверных сессий остаётся способом найти незавершённую загрузку. Safari использует обычный выбор файла. Автоматическое восстановление доступа через файловые дескрипторы не реализовано.

Прогресс учитывает принятые сервером байты и не превышает 99% до успешной финализации или подтверждения уже завершённой сессии. Пауза сохраняет `Retry-After`, продолжение соблюдает установленный срок. Для части доступны три попытки; отдельное автоматическое ожидание ограничено 60 с, суммарное ожидание — пятью минутами на окно повторов. Исчерпание попыток сохраняет сессию для явного продолжения. Потеря ответа создания не приводит к повторному `POST`: клиент обнаруживает серверные сессии и предлагает повторно выбрать исходный файл для подходящей загрузки.

`MAX_FILE_SIZE` по умолчанию равен `1099511627776` байтам (1 ТиБ на файл). Это настраиваемый инфраструктурный предел. `MAX_TOTAL_SIZE=2199023255552` ограничивает суммарный объём активных резервов; `MAX_UPLOAD_CHUNKS=100000`, `MAX_CHUNK_SIZE=52428800`. Квота проверяется сервером. Нулевой предел размера файла или суммарного резерва отключает соответствующий отдельный предел; нулевая квота даёт нулевую ёмкость. Срок жизни сессии по умолчанию составляет 24 часа и является абсолютным: истёкшая сессия не продолжается. Пустые файлы текущий API сессий не поддерживает; интерфейс показывает отдельную ошибку. Перетаскивание папок отложено. Выбор файлов и перетаскивание отдельных файлов используют одну очередь.
