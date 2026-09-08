# HomeCloud

**Self-hosted облачное хранилище файлов** с поддержкой chunked upload, публичных ссылок, превью и веб-интерфейсом.

![Backend](https://img.shields.io/badge/Backend-NestJS_10-red)
![Frontend](https://img.shields.io/badge/Frontend-React_18%2B_Vite%2B_Tailwind-blue)
![Database](https://img.shields.io/badge/Database-PostgreSQL_16-blue)
![Cache](https://img.shields.io/badge/Cache-Redis_7-red)

## Возможности

### Управление файлами
- Загрузка файлов любого размера через chunked upload (разбивка на части)
- Возобновляемую загрузку при обрыве соединения
- Создание, переименование, перемещение и копирование файлов
- Древовидная структура папок
- Корзина с восстановлением и окончательным удалением
- Поиск файлов по имени
- Drag & drop загрузка в веб-интерфейсе

### Безопасность
- JWT аутентификация с access/refresh токенами
- Защищённые API endpoints через JWT guard
- Rate limiting (100 запросов/минуту)
- Helmet, CORS, валидация входных данных
- Шифрование паролей (bcrypt, 12 раундов)
- Парольная защита публичных ссылок (bcrypt)

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
- **Cache**: Redis 7
- **Auth**: JWT (passport-jwt), bcrypt
- **File processing**: Sharp (thumbnails), file-type
- **Real-time**: Socket.IO (подключён)
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
DB_PASSWORD=changeme

# JWT (обязательно изменить в production!)
JWT_SECRET=changeme-change-in-production
JWT_REFRESH_SECRET=changeme-change-in-production

# Redis
REDIS_URL=redis://redis:6379

# Хранилище
STORAGE_PATH=/storage
MAX_FILE_SIZE=0
CHUNK_SIZE=10485760

# Frontend
FRONTEND_URL=http://localhost:5173
API_URL=http://localhost:3000
```

**Важно**: для production обязательно измените `JWT_SECRET` и `JWT_REFRESH_SECRET` на надёжные случайные строки.

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
| Health check | http://localhost:3000/api/v1/health | Статус сервисов |

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
│       │   └── guards/
│       │       └── rate-limit.guard.ts
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

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/v1/uploads/session` | Создать сессию загрузки |
| POST | `/api/v1/uploads/session/:uploadId/chunk` | Загрузить чанк |
| POST | `/api/v1/uploads/session/:uploadId/complete` | Завершить загрузку |
| DELETE | `/api/v1/uploads/session/:uploadId` | Отменить загрузку |
| GET | `/api/v1/uploads/sessions` | Список активных сессий |

### Sharing

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/v1/sharing` | Создать публичную ссылку |
| GET | `/api/v1/sharing` | Список ссылок пользователя |
| DELETE | `/api/v1/sharing/:id` | Отозвать ссылку |
| GET | `/api/v1/sharing/public/:token` | Информация о ссылке |
| POST | `/api/v1/sharing/public/:token/verify` | Проверить пароль |
| POST | `/api/v1/sharing/public/:token/download` | Скачать по ссылке |

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
| `uploads_data` | Временные файлы при chunked upload |

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
