# Локальная предпроизводственная версия HomeCloud

Дата: 6 октября 2026. Версия: `v0.9.0-local.1`. Это первая нумерованная локальная версия; прежние теги были тематическими checkpoints. `backend/package.json` 1.0.0 и frontend 0.0.0 — версии пакетов, не прежний общий GitHub release convention. Номер не обозначает процент готовности. GitHub Release помечается prerelease.

## Подтверждённый продуктовый контракт

- Универсальное хранение принимает произвольные расширения, MIME и содержимое; тип определяет превью. Авторизация, ownership, safe path/name, квота и инфраструктурные пределы обязательны.
- По коду и Compose defaults: `MAX_FILE_SIZE=1099511627776` (1 ТиБ/file), `MAX_TOTAL_SIZE=2199023255552` (2 ТиБ активных резервов/user), `MAX_UPLOAD_CHUNKS=100000`, `MAX_CHUNK_SIZE=52428800` (50 МиБ), базовая часть клиента 10 МиБ; клиент увеличивает её до ceil(fileSize/maxChunks) в пределах maxChunkBytes. `GET /uploads/limits` возвращает effective limits. Нулевые file/aggregate caps отключают отдельный cap; нулевая storage quota означает нулевую ёмкость. Число частей может дополнительно ограничить достижимый размер. 50 ГиБ — квалификационный размер, не максимум; передача 1 ТиБ не квалифицирована.
- Chunk ingress disk-backed; принятые части имеют durable unique metadata и SHA-256, счётчики обновляются без полного повторного JSONB обхода. Finalization streaming с bounded RAM; линейные DB round trips и session lock сохраняются. Планировать server disk около 2S плюс concurrent ingress; это не constant-time finalization.
- Скачивание private original: Bearer prepare → короткая resource capability в HttpOnly/Strict/host-only cookie → same-origin native GET в менеджер браузера. В production Secure/HTTPS; initiation TTL 120 с, однократное потребление; повторный Range требует fresh prepare. File body не собирается в frontend Blob.
- Multiple selection, batch и file DnD используют очередь: максимум два файла одновременно, по одной части на файл. Folder DnD и пустые файлы не поддерживаются.
- Pause прекращает планирование и даёт in-flight запросу завершиться; сессия/части/квота сохраняются. Resume сверяет серверные части и их SHA-256, продолжает тот же uploadId. Cancel ждёт подтверждения DELETE; ошибка оставляет неподтверждённую отмену с повтором. Потерянный complete response сначала сверяется с сервером.
- Восстановление сети ограничено числом повторов/Retry-After; исчерпание бюджета сохраняет сессию для явного продолжения. После reload пользователь повторно выбирает исходник; автоматическое возвращение File access не реализовано. Проверяются имя/размер, сохранённый sampled fingerprint и SHA-256 принятых частей; ещё не переданные изменённые байты вне выборки могут остаться незамеченными. Browser restart сохранность local metadata зависит от браузера; нет квалификации автоматического восстановления File handle. Session TTL 24 ч абсолютный. Server discovery возвращает до 200 активных сессий, pagination отсутствует.
- Sharing: password/expiry/revoke/maxDownloads, fail-closed ownership/subtree checks, public children и scoped download; streamed folder ZIP, один download slot на архив, сохранение имён/пустых папок. Полный/Range ответ расходует отдельную попытку; 416/missing file до допуска не расходует, обрыв после допуска слот не возвращает. [Access contract](./PHASE-10.1-ACCESS-CONTROL.md), [приёмка](./frontend-functional-acceptance.md).
- Access JWT в памяти, refresh в sessionStorage, upload metadata в owner-scoped localStorage без секретов/содержимого. HttpOnly native cookie не является auth refresh storage. Logout не отзывает уже выданный access JWT до TTL; maintenance key cutover инвалидирует затронутые ключами tokens.

## Единственное локальное окружение

`homecloud-preview`: production Compose + local override, четыре healthy сервиса (db/backend/frontend/ingress), Redis выключен. HTTP UI/API: `http://localhost:8080`; HTTPS ingress: `https://homecloud.localhost`; HTTP ingress перенаправляет на HTTPS. DB/backend ports не опубликованы. [Исполняемые команды](./operations-runbook.md#единственный-локальный-baseline-homecloud).

Existing external volumes `homecloud-preview_db_data` → `/var/lib/postgresql/data`, `homecloud-preview_storage_data` → `/storage`. Config/TLS/challenges: `$HOME/Library/Application Support/HomeCloud/{config,tls,challenges}` вне repo, защищённые права. Новый host должен сначала создать/восстановить согласованный volume baseline; local override fail-closed при отсутствии volumes. Legacy Compose не является обычным запуском. Preservation archives/legacy volumes удерживаются локально; это не квалифицированный внешний backup.

Dev auth хранится в приватном local config; release не содержит пароль. Квота dev-аккаунта 100 ГиБ; новые пользователи через register API получают 0 и требуют operator quota provisioning. UI экрана регистрации и quota/role API нет.

Local self-signed TLS имеет SAN и проходит проверку с явным local CA; не установлен в системное доверие. Public CA не квалифицирована. Docker Desktop/macOS atomic symlink activation требует ingress recreate; Linux lifecycle qualification не переносится автоматически на Mac.

## Квалификация и реальные границы

[50 ГиБ IAB E2E 2026-10-06](./evidence/browser-50gib-qualification-20261006/report.md): 53 687 091 200 байт, исходник/сервер/browser saved copy имеют одинаковый SHA-256; 5120 частей, Pause, точечный transport interruption, reload/reselect с сохранением 479 частей, отдельный Cancel, сохранность исходных данных и cleanup. Независимый review ACCEPT. Обрыв относился к chunk connection, полное отключение сети браузера не проверялось. Память отдельной вкладки и recreate со всем файлом 50 ГиБ не квалифицированы.

[Safari функциональные сценарии](./evidence/universal-storage-upload-ux-20261005/report.md) PASS для произвольных типов, batch/file DnD/Pause/Resume/Cancel/reload-reselect. **Safari полный 50 ГиБ: UNQUALIFIED.**

**Production: NOT_READY / NO_GO.** Требуются реальные Linux host/mount/failure domain, public DNS/CA, registry auth/TLS/platform/retention, независимый offsite и key custody, owner-approved measured RPO/RTO, scheduler/alerts реальному получателю, окончательный operator/endpoint acceptance. Локальные observability/backup/DR/TLS/immutable-pair механизмы не доказывают эти внешние gates. [Master checklist](./external-input-master-checklist.md), [go-live](./go-live-checklist.md).

Аудит release обнаружил несовместимость legacy restore gate с текущими девятью таблицами. Gate теперь допускает только точные известные наборы 7/8/9 и проверяет каждую таблицу перед storage switch. Проверка конкретного schema gate не является новым полным destructive restore drill; target-host recovery остаётся обязательным. [Финальные проверки и независимый review](./evidence/local-release-20261006/report.md).
