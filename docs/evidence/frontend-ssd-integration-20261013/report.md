# Frontend SSD Integration — ограниченный checkpoint, 13 октября 2026

**Браузерная интеграция и ограниченный Docker gate подтверждены. SSD OFF по умолчанию; COMPLETE не установлен; production NO_GO сохраняется. Мини-ПК и постоянный preview stack не использовались.**

Реальный исходный HEAD точно совпал с `cbeca1d04ab543def8273bd7749d3458f3e5a362`. Репозиторий: `/Users/aleksejkozemakin/Desktop/HomeCloud`; каталог ChatGPT-проекта сам Git-репозиторием не является. До реализации прочитаны фактические `docs/ROADMAP.md` и `docs/evidence/ssd-hdd-integration-20261012/report.md`. Tracked дерево было чистым; два прежних untracked closure JSON сохранены. Запрещённый аудит не читался, не искался, не хешировался и не изменялся; synced sources и прочие посторонние файлы не изменялись.

## Изменения в утверждённом scope

- Dependency-free инкрементальный whole SHA-256: последовательный read slice не более 2 МиБ, обработка views по 256 КиБ, реальные task boundaries для UI/AbortSignal. Один ограниченный read, состояние SHA и tail; whole-file ArrayBuffer не создаётся. BigInt кодирует 64-bit bit length без 32-bit truncation; результат lowercase64. Алгоритм сверялся с [NIST FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf), опубликованные векторы — с [RFC 6234](https://www.rfc-editor.org/rfc/rfc6234#section-8.5).
- `GET /api/v1/uploads/limits` определяет требования нового admission. При `storageMode=ssd` / `wholeSha256Required` whole hash вычисляется до POST session и передаётся как `expectedSha256`. Legacy OFF допускает отсутствие этих additive flags, не вычисляет и не отправляет whole hash. Backend production source, migrations и постоянная конфигурация не менялись.
- UI различает подготовку/хеширование, отправку, финализацию на HDD, завершение. Хеширование показывает обработанные байты; загрузка — принятые сервером bytes. 100% загрузки только после подтверждённого complete/replay, финализация остаётся на 99%; процент копирования HDD не придумывается. Pause/Cancel доступны до финализации; in-flight multipart сначала settles, затем выполняется подтверждённая отмена.
- Локальные resume metadata сохраняют whole hash собственных admissions. Повторный выбор файла сверяет whole digest, включая изменения вне sampled fingerprint; server session и hashes принятых chunks проверяются до докачки. Обнаруженные server sessions без локального whole hash опираются на chunk verification и серверную immutable whole проверку при complete: API metadata whole hash не раскрывает.
- Busy/server/network повторы ограничены тремя попытками на операцию, суммарным wait budget 300 с, максимальным отдельным ожиданием 60 с; явный Resume открывает новое ограниченное окно. Для 503 добавляется positive jitter до 25%; Retry-After seconds/date сохраняется, ранний replay вместо чрезмерного wait запрещён. Capacity 503 не повторяется автоматически и имеет отдельный текст. Backend сообщение `unavailable or busy` не позволяет строго отделить outage от contention, поэтому UI честно сообщает оба варианта.
- Admission network/500 не повторяется: без idempotency key нельзя исключить уже созданную reservation. Определённый busy/429 до admission допускает bounded replay. Pause в backoff сохраняет Retry-After, но не создаёт ложный lost-ACK state.
- Complete failure сначала сверяет GET receipt, затем bounded idempotent POST replay: GET completed сам не освобождает глобальный cleanup barrier. Resume со completed receipt также запускает POST. Повторной File/quota publication нет, DELETE после возможной публикации не выполняется. Если известный File уже на HDD, но replay не подтверждён, UI честно сохраняет error/99% и предлагает действие. Обычные HTTP calls имеют timeout 120 с, complete — 30 мин на попытку; cancel DELETE ограничен 10 с, последующая GET/replay reconciliation общим deadline/AbortSignal 5 с.

## Gate и baseline comparison

| Проверка | Фактический результат |
| --- | --- |
| Exact baseline frontend full | 218 PASS, 0 FAIL, 0 skipped |
| Final targeted frontend | 114 PASS, 0 FAIL |
| Final candidate frontend full | 278 PASS, 0 FAIL, 0 skipped |
| Сверка test instances | Все 218 baseline статусов совпали; 60 новых PASS; missing/changed 0 |
| Full frontend lint | exit 0, ошибок/предупреждений нет |
| TypeScript + Vite production build | `npm run build`, exit 0 |
| Real Chromium browser gate | 14/14 checkpoints PASS |
| Independent critical review | unresolved MUST_FIX 0 |

[Checks](checks-final.json), [baseline comparison](baseline-comparison-final.json), [baseline raw](baseline-frontend.json), [final candidate raw](candidate-frontend-final.json), [targeted raw](targeted-final.json), [independent review](review-final.md). Targeted и full пересекаются, их числа не суммируются. Сверка использует путь/name/ordinal/status, а не утверждение о неизменности test source: две прежние receipt-failure cases расширены недоступным receipt и ожиданиями bounded replay. Полный backend набор в этом frontend scope заново не запускался; прежние 1148 native PASS и 71 macOS failures из предыдущего этапа здесь не объявляются перепроверенными/исправленными.

## Реальный браузер и одноразовый Docker

Chromium запущен на Mac против двух собственных Linux ARM64 backend-процессов с ON/OFF. Использованы существующий тестовый образ `homecloud-stage24-candidate:arm64` и PostgreSQL 16 Alpine; текущий backend src компилировался внутри своего контейнера, native модуль — из указанного образа. Отдельные random network/containers/SSD volumes/schema, DB на tmpfs в окончательном прогоне; HDD overlay и SSD volume имеют разные `stat.dev`. Read-only bind mounts; флаг ON только внутри disposable процесса. Изменение host mounts, реальных дисков, mini-PC, действующих DB/volumes или preview не выполнялось.

[Browser JSON](browser-e2e.json) содержит network timestamps и SQL snapshots:

1. SSD payload 4 МиБ + 137 bytes: lowercase whole hash совпал с Node oracle; наблюдались реальные UI stages, HDD File и cleaned receipt; UI download bytes exact и browser HTTP Range 206 `bytes=13-77` exact.
2. Pause после принятых chunks → reload → reselect → resume той же session, единственный admission; точные download/Range повторно подтверждены.
3. Cancel после chunks: server status aborted, нового File нет, UI не объявляет неподтверждённую отмену.
4. Два injected busy503 на complete: ровно 3 POST, реальные waits 1013/1023 мс при Retry-After 1 с. Admission busy exhaustion — ровно 3 попытки, новой session нет. Capacity503 — одна попытка, отдельная actionable UI ошибка.
5. После настоящего durable store commit injected HTTP500: GET receipt → два complete POST суммарно → cleanupState cleaned; File один, quota +1024 один раз, DELETE 0. Следующая обычная SSD-загрузка 1280 bytes завершилась, exact UI download/Range прошли: глобальный barrier освобождён.
6. OFF legacy upload → HDD/download/Range: expectedSha256 отсутствует. Неизменённый baseline UI на ON реально получил admission400 без whole hash; новых sessions/files 0. Это фактическое browser baseline сравнение.

Busy/capacity введены middleware только тестового процесса; это не физическое заполнение диска и не квалификация реальной конкуренции writers. Postcommit fault — HTTP500 после commit, не доказанный TCP disconnect. Реальные payloads малы. [Manifest сборок/исполненных harness](artifact-manifest.json), [готовность ON](fixture-on-ready.json), [готовность OFF](fixture-off-ready.json). Root проверил побайтовое совпадение static copies с прошедшими build outputs и actual repository frontend/backend sources с проверенным snapshot. Исполненные originals сохранены в evidence; переносимый harness находится в `backend/test/frontend-ssd-browser/`, его адаптация путей явно отличается от original execution.

## Неуспешные и промежуточные результаты

- Первоначальный запуск unit gate не начался из-за записи Vite temp в внешние symlink dependencies; зависимости скопированы в собственный workspace. Ошибки рабочих каталогов были startup failures, не acceptance tests.
- Initial targeted 90 PASS / 2 FAIL: прежние тесты ожидали error после receipt response loss, а новая автоматическая receipt сверка показывала completed. Fixture расширена недоступным receipt; manual recovery и bounded replay проверены, исходные test-instance статусы снова PASS. После исправления cleanup replay две timing assertions первоначально не выдержали сохранённый 1-секундный notBefore; timeout assertions изменён до 2 с, ранний retry не разрешён.
- Подготовка Docker выявила отсутствие su-exec, путь загрузки harness, необходимость `/storage/.tmp`; причины исправлены только в owned fixture. [Сохранённые excerpts](fixture-preparation-failures.log).
- Первый Chromium запуск имел 0 checkpoints: static bind mount ссылался на удалённый каталог сборки; `/login` дал500. Исправлен только owned mount; [failed JSON](browser-e2e-first-failed.json), [server log](browser-run1-server-failure.log).
- Промежуточные 12 PASS оказались недостаточными: после postcommit500 GET видел File, но cleanupState оставался pending. Root evidence audit обнаружил барьер, reviewer подтвердил global unique slot. Narrow actual next upload получил500 трижды и не создал File; diagnostic assertion ошибочно ожидала503 и сохранена как FAIL, а не relabeled PASS. [Промежуточный JSON](browser-e2e-intermediate-12.json), [диагностика](browser-postcommit-barrier-audit.json). Клиентский replay исправлен отдельным commit; окончательный свежий 14-check gate проверяет cleaned state и следующую загрузку.

## Сохранность, Git и граница остановки

Небольшие русскоязычные commits: `59a6bca` — whole SHA256; `5eb4157` — frontend admission/UI/retry; `e7556469625b20648d5c79d1dc9b0b1190c44633` — cleanup replay и bounded cancellation. Переносимый test harness зафиксирован `e052df2`; этот отчёт фиксируется отдельным documentation commit. Финальный documentation HEAD/status приведены в итоговом сообщении и closure-state рабочего workspace, чтобы не создавать самоссылочный Git hash в tracked документе.

Контрольные hashes двух прежних untracked JSON проверены при сохранении. Запрещённый файл исключён из всех content reads/searches/hashes/diffs; его сохранность не проверялась запрещённым чтением. Проверка tracked diff выполнена по явному allowlist frontend/harness/docs; посторонние изменения не добавлялись в Git.

Cleanup удаляет только exact-owned именованные containers/network/SSD volumes и подтверждённый own DB anonymous mount; [cleanup](fixture-cleanup.json). Финальный DB на tmpfs, implicit anonymous DB volume не создаётся. Для ранних failed-start anonymous DB volumes исходного полного inventory не было, а retained event ring не даёт доказать их IDs. Неизвестные volumes сохранены; отсутствие таких residuals не заявляется. Blanket prune не выполнялся. Root повторно проверил Docker inventory: подтверждённых собственных containers/SSD volumes/networks не осталось, четыре preview containers сохранили прежние names/images/ports. [Final inventory](final-docker-inventory.json).

**Следующий gate только по отдельному согласованию:** целевая Linux/mini-PC activation с writer fencing, native rebuild и migration/enrollment/rollback preflight; исторические journals/operator reconciliation; физические SSD/HDD, mount outages/EXDEV, SIGKILL/reboot/power loss и реальная 50+ ГиБ/RSS/cgroup qualification на 8 ГБ. Backend metadata не раскрывает cleanupState, а generic complete200 допускает best-effort cleanup warning: эта задача не доказывает восстановление при любой постоянной ошибке cleanup. Safari и большие файлы этим новым frontend gate не квалифицированы.

**SSD OFF по умолчанию. COMPLETE не установлен. После этого ограниченного checkpoint работа остановлена; испытания мини-ПК не начаты.**
