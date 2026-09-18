# Phase 10.1 — Access-Control Matrix & Folder-Sharing Semantics

> **Scope:** docs-only mini-stage. Текущий `HEAD`: `09dea37` (`main`).
> **Не изменяет:** код, тесты, БД, миграции. `maxDownloads`, Range/resume и dedicated rate limiting намеренно отложены на последующие mini-stage-и Phase 10 (см. §7).

## 0. Термины

- **Owner** — пользователь, чей `userId` совпадает с `files.userId` / `folders.userId` конкретного объекта.
- **Shared object** — `FileEntity` (включая «зеркальную» запись папки с `isFolder = true`), на который ссылается `share_links.fileId`.
- **Token** — публичный идентификатор ссылки (`share_links.token`, UNIQUE), 122 бит энтропии (UUIDv4).
- **Anonymous** — доступ без JWT (только token).

---

## 1. Access-Control Matrix (CURRENT vs TARGET)

| Action | Endpoint | Owner | Authenticated non-owner | Anonymous |
|---|---|---|---|---|
| Create share | `POST /sharing` | ✅ `userId` из JWT; ownership проверяется `files WHERE {id, userId}` | ❌ 401 (JwtGuard) | ❌ 401 |
| List own shares | `GET /sharing` | ✅ `WHERE {userId, isActive}` | ❌ 401 | ❌ 401 |
| Revoke share | `DELETE /sharing/:id` | ✅ `WHERE {id, userId}` | ❌ 401 | ❌ 401 |
| Share info | `GET /sharing/public/:token` | ✅ (token) | ✅ (token) | ✅ anonymous |
| Verify password | `POST /sharing/public/:token/verify` | ✅ (token) | ✅ (token) | ✅ anonymous |
| Download | `POST /sharing/public/:token/download` | ✅ (token) | ✅ (token) | ✅ anonymous |

### 1.1 Ownership enforcement (CURRENT)

- `createShareLink(userId, fileId)`: `fileRepository.findOne({ where: { id: fileId, userId } })` → `NotFoundException`, если файл не принадлежит пользователю (неявный ownership check). [sharing.service.ts:55-60]
- `revokeShare(userId, shareId)`: `WHERE { id: shareId, userId }` → `NotFoundException`. [sharing.service.ts:164-170]
- `getShareById(userId, shareId)`: `WHERE { id, userId }` → `NotFoundException` (метод существует, но **не экспортирован** через endpoint). [sharing.service.ts:189-200]
- Public endpoints (`findShareByToken`, `verifySharePassword`, `incrementDownloadCount`): **без `userId`** — доступ строго по token. [sharing.service.ts:111-162]

### 1.2 Целевой контракт (TARGET, фиксируется на будущую реализацию)

- Все owner-only endpoint-ы: `JwtGuard` + `WHERE { ..., userId }` (конфликт имён → 404, а не 403, чтобы не раскрывать существование ID). **Сохранить.**
- Public endpoint-ы: token-основанный доступ без userId; **единый access-policy слой** (см. §3) обязателен перед любым доступом к файловому содержимому.
- `getShareById` — либо удалить, либо зафиксировать гарантии (сейчас не проверяет `isActive`/`expiresAt`).

---

## 2. Состояния ссылки и их enforcement (CURRENT)

```
[active] --(revoked: isActive=false)--> [revoked]   --(DB CASCADE on user/file delete)--> removed
  |
  --(expired: expiresAt < now)--> [expired]  (в БД isActive всё ещё true)
```

| State | isActive | expiresAt | findShareByToken | verifySharePassword | incrementDownloadCount | download |
|---|---|---|---|---|---|---|
| active, no password | true | future | ✅ | n/a | ✅ | ✅ |
| active, password | true | future | ✅ (requiresPassword=true) | ✅ bcrypt.compare | ✅ | ✅ (verify first) |
| expired | true | past | ❌ NotFoundException | ⚠️ **no expiry check (HIGH)** | ✅ | ⚠️ finds then fails |
| revoked | false | future | ❌ NotFoundException | ❌ NotFoundException | ❌ NotFoundException | ❌ NotFoundException |

**Ключевые наблюдения (CURRENT):**
- `expiresAt` — `nullable: true` в entity; в миграции `TIMESTAMP` без явного `NULL`/`NOT NULL` (Postgres default NULL). Ни один код-путь не создаёт ссылку без `expiresAt` (default 7 дней). [share-link.entity.ts:28-29; migration line 10; sharing.service.ts:84-86]
- `verifySharePassword` **не проверяет `expiresAt`** — только `WHERE { token, isActive: true }`. [sharing.service.ts:125-127] — **HIGH risk.**
- `getShareById` не проверяет `isActive`/`expiresAt`.

### 2.1 Целевая модель состояний (TARGET)

- `expiresAt` — NOT NULL с default; «никогда не истекает» только через явный `expiresInDays = null` (decided in 10.x).
- `verifySharePassword` — обязательная проверка `expiresAt` (fail-closed).
- Revoked (`isActive=false`) — моментальное fail-closed на все public endpoint-ы; DB-backed, без кэша (см. §2.2).

### 2.2 Revocatoration consistency (CURRENT vs TARGET)

- CURRENT: `isActive=false` в БД; никакого кэша/invalidation layer не опознано; Helmet/CORS применяются к public. [security.config.ts:45-64]
- TARGET: `Cache-Control: no-store` на public endpoint-ах; revocation = DB truth. (Rate limiting + per-token throttle → 10.x, см. §7.)

---

## 3. File vs Folder sharing — текущее поведение (CURRENT)

### 3.1 File

- `downloadShare`: `findShareByToken(token)` → `share.file` (FileEntity, `isFolder=false`) → `fs.createReadStream(share.file.storagePath).pipe(res)`. [sharing.controller.ts:123-138]
- `Content-Type` из `share.file.mimeType`; `Content-Disposition: attachment; filename="..."` (экранирование `"`).
- Проверка существования файла: `fs.existsSync(storagePath)` → `NotFoundException("File not found on storage")`.
- **Нет HTTP Range/resume.** Прямой `pipe` без backpressure-контроля.
- MIME/size разрешения: `!file.isFolder && file.size > maxShareSize` ❌; `!file.isFolder && !allowedShareMimeTypes.includes(file.mimeType)` ❌. [sharing.service.ts:70-76]

### 3.2 Folder

- Папка хранится как `FileEntity` с `isFolder=true` (зеркальная запись); структура дочерних объектов — в таблице `folders`/`files` через `parentId`. [file.entity.ts:17-79; folder.entity.ts]
- `downloadShare` для `share.file.isFolder === true`: **возвращает JSON-метаданные**, а не контент:
  `{ file: { id, name, mimeType, size, isFolder } }`. [sharing.controller.ts:111-121]
- `mimeType` папки = `application/zip` (тестовое значение); `size = 0`.
- **Нет**: traversal listing, recursive zip streaming, доступ к дочерним объектам.
- Folders **не проверяются** на `maxShareSize` и `allowedShareMimeTypes` (только `!file.isFolder`). [sharing.service.ts:70,74]

### 3.3 Target folder-sharing semantics (TARGET — фиксируется здесь, реализуется в 10.x)

1. **Scope доступа.** Shared folder открывает доступ ко всем **не удалённым** (`isDeleted=false`) потомкам того же `userId` — файлы и подпапки по `parentId`. Доступ к ребёнку **только через родительскую share link** (child-first direct token не поддерживается).

2. **Унаследованная политика.** Все потомки наследуют `password`/`expiresAt` родительской ссылки. `verifySharePassword` и `incrementDownloadCount` вызываются один раз на сессию share, а не на каждый файл.

3. **Операции:**
   - **Listing** — `GET /sharing/public/:token/children?parentId=` (или `path=`): список непосредственных детей (files + folders), scoped `WHERE userId = owner AND isDeleted=false`.
   - **Download файла из папки** — `POST /sharing/public/:token/download` с `path`/`fileId`: проходит те же policy checks, затем range-aware stream (см. §7).
   - **Download папки целиком** — рекурсивный zip-stream (streaming, сжатие на лету) либо 400 («архив недоступен»), **decided in 10.2**.

4. **IDOR / ownership на потомках.** Каждый дочерний объект обязателен scope по `userId = owner share-ссылки`; никогда не выдаётся дочерний объект другого владельца.

5. **Конфликты с транзакциями Phase 7.** Перемещение/удаление потомков фиксируется в DB и немедленно отражается в листинге share (DB — source of truth, нет кэша).

### 3.4 Поведение при удалении/перемещении (TARGET)

| Операция над объектом | Текущий эффект на share | Целевой эффект |
|---|---|---|
| Soft-delete (trash) shared файл | share **остается** активной, но `fs.existsSync` → 404 | `isActive=false` + 410 Gone (decided 10.x) |
| Permanent delete shared файла | FK `ON DELETE CASCADE` удаляет share_links | немедленно 404/410 |
| Move shared файла в другую папку | `storagePath`/`parentId` обновлены, share работает | share следует за объектом (привязка к `fileId`) |
| Soft-delete/permanent-delete родительской папки share | CASADE на `files` удалит mirror-record → share удаляется | share тоже инвалидируется |

> Требование: invariant — **share ссылка никогда не выдаёт контент удалённого/`isDeleted` объекта.**

---

## 4. Public access rules summary (CURRENT)

- **Auth:** анонимный доступ по token только.
- **Password:** bcrypt.compare (cost 10); **нет lockout/throttle** (HIGH → 10.x). [auth: sharing.service.ts:137]
- **Expiry:** проверяется в `findShareByToken` и `incrementDownloadCount`, но **НЕ в `verifySharePassword`** (HIGH).
- **Revocation:** `isActive=false`, моментально fail-closed.
- **Rate limit:** только глобальный `100 req/min/IP` на `/api/v1/*` (включая public) — нет dedicated tier для `/sharing/public/*` (HIGH → 10.x).
- **Security headers/CORS:** Helmet + CORS применяются ко всем route-ам включая public (CSP отключён).
- **Storage path:** `fs.createReadStream(share.file.storagePath)` без path confinement (MED → 10.x). [sharing.controller.ts:123-126]

---

## 5. DoD mapping (Phase 10 — ROADMAP.md:253-257)

| DoD item | Статус | Где покрыто |
|---|---|---|
| Access-control matrix documented | ✅ (this doc, §1) | PHASE-10.1-ACCESS-CONTROL.md §1 |
| Folder-sharing semantics documented | ✅ (this doc, §3) | PHASE-10.1-ACCESS-CONTROL.md §3 |
| Public endpoints check link state/password/expiry/ownership/file-folder policy | ⚠️ частично (CURRENT). Full target → §1.2, §2.1 | Phase 10.x реализация |
| Streaming/range/download-count tested; revocation без перезапуска | ⚠️ partial. Revocation ✅ DB-backed. Range/download-count tests → §7 | Phase 10.2+ |
| README/API соответствуют реализации; ROADMAP updated | ⚠️ README синхронен с endpoint-ами, но не описывает folder behavior/pagination/rate-limit; ROADMAP → обновить после 10.1 commit | §6 (docs drift) |

---

## 6. Docs drift (observed, not fixed here)

- README: claims bcrypt **12 раундов**; код использует **10** (sharing.service.ts:90).
- README env: `MAX_FILE_SIZE=0` в quick-start `.env` блоке; `.env.example` → `1073741824`.
- README API Reference не описывает `isFolder`/`expiresInDays`/`password` параметры POST `/sharing`, не описывает `requiresPassword`/`downloadCount` в ответе `GET /sharing/public/:token`, и не описывает folder metadata-only behavior.

---

## 7. Deferred to later Phase 10 mini-stages (NE ТРЕБУЕТ реализации)

| # | Capability | Current state | Target mini-stage |
|---|---|---|---|
| 1 | `maxDownloads` / download-limit policy | ❌ absent (no column, no check) | 10.2 |
| 2 | HTTP Range/resume on `/download` | ❌ direct `pipe`, no `Accept-Ranges` | 10.2 |
| 3 | Dedicated rate limit tier `/sharing/public/*` (+per-token throttle) | ❌ global 100/min only | 10.2 |
| 4 | Password attempt lockout (bcrypt brute-force) | ❌ none | 10.2 |
| 5 | Path confinement on `storagePath` → `createReadStream` | ❌ none | 10.2 |
| 6 | Expiry check in `verifySharePassword` | ❌ absent (HIGH) | 10.2 |
| 7 | Folder traversal/listing/zip download | ❌ metadata only | 10.2+ |
| 8 | `Cache-Control: no-store` + revocation cache invalidation | ⚠️ none | 10.2 |

---

## 8. Консенсус по семантике folder sharing (acceptance для 10.2+)

1. Shared folder = доступ ко всем active non-deleted потомкам того же owner по `parentId`.
2. Политика (password/expiry/isActive) применяется к share link как единое целое; потомки не имеют собственных состояний.
3. Listing и download потомков должны проходить тот же access-policy check, что и download файла.
4. Удаление/перемещение потомка немедленно отражается (DB source of truth).
5. Revoke share или expiry/expire link немедленно отключают доступ ко всем потомкам (DB-backed, без кэша).
