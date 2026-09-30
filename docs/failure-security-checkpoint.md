# Failure & Security Testing — проверенный checkpoint

Дата: 2026-09-30 (Asia/Vladivostok). Owner-approved ненумерованное направление после Observability & Operations. Исходный HEAD `7b0d8c7419a8dde6aefeede55f653a0e9b260b15`; исходный status содержал только запрещённый untracked audit. Audit не читался и не изменялся. Phase 13 и observability checkpoint сохраняются COMPLETE. Production readiness не заявляется.

## Матрица инвариантов и результаты

| Инвариант | Проверка | Результат |
|---|---|---|
| Восстановление сохраняет DB↔storage | Реальные существующие backup.sh/restore.sh, сравнение строк/отношений/байтов/квоты, reconciliation | RESTORE_DRILL: PASS |
| DB outage не допускает частичную мутацию | Остановка только disposable PostgreSQL, folder create, сравнение снимков, восстановление чтения | DB_FAILURE_RECOVERY: PASS |
| Storage outage не оставляет upload metadata/quota drift | Disposable root заменён обычным файлом, upload session creation отклонён, снимок БД неизменен, recovery upload | STORAGE_FAILURE_RECOVERY: PASS |
| Чужие объекты недоступны | Два пользователя real PostgreSQL, 17 ownership-сценариев; HTTP folder detail/rename/upload parent | IDOR_OWNERSHIP: PASS |
| Public share policy fail-closed | Existing share/controller/PG regressions: invalid/expired/revoked/deleted/exhausted, password, subtree/sibling/fileId/Range; runtime invalid token | SHARE_ABUSE: PASS |
| Refresh rotation/revocation и access expiry соблюдаются | Existing auth lifecycle; real PG suites для sharing/files/uploads; runtime reuse + descendant denied; 10 real JWT/guard HTTP scenarios | SESSION_AUTH_ABUSE: PASS |
| Abuse budget ограничен и восстанавливается | Existing IP/token independence/password lock reset; runtime share attempt 10→429, auth429, реальный reset после61 s | RATE_LIMIT_ABUSE: PASS |
| Ошибки и восстановление диагностируются без секретов | Correlated JSON completion, readiness, 4xx/5xx metrics, negative markers scan | SECURITY_PRIVACY_REVIEW: PASS |

## Реальный restore drill

Harness `scripts/tests/test-failure-security-restore.sh` копирует неизменённые backup/restore/reconcile scripts в новый temporary project root, создаёт собственный Compose project, DB/storage volumes и synthetic credentials. Repo `.env` и нормальные данные не используются. Образ собран из текущего backend; production-mode backend использует действующие миграции.

Fixture: 1 user, 2 nested folders, 4 file rows (2 folder mirrors + 2 физических файла по14bytes), 1 share, 1 completed upload с total/uploaded/chunk14, storageUsed28. SQL fixture проходит deleted→restored состояние; это проверка сохранённого состояния, не доказательство HTTP trash lifecycle. Последний проверяется отдельными regression suites.

До backup и после restore: строки и отношения совпали, SHA-256 bytes совпали, quota/accounting28 совпали, completed upload accounting согласован. После backup намеренно изменены metadata/bytes и добавлен orphan в disposable storage, затем restore вернул снимок. Reconciliation: missing0, orphan0, size mismatch0, quota drift0, broken share0, stale upload0. Final saved harness evidence: `/private/tmp/homecloud-fs-dr.B4wEPO`; disposable container/volume cleanup проверен. Backend readiness200 с database/storage ok и requestId `fs-dr-restored`.

Первоначальная ошибочная fixture длина13 вместо14 вызвала отказ restore на SIZE_MISMATCH. Исправлена fixture, product code не менялся. Это отдельное подтверждение fail-closed tooling, не product defect.

## Runtime failure campaign

Воспроизводимый `scripts/tests/failure-security-runtime.py` запускает compiled backend, новую PostgreSQL16 без volume и отдельный canonical temporary storage. Backend запускается из temporary cwd с явными synthetic app settings и минимальным inherited env; локальная repo `.env` не подмешивается. Только созданный самим harness контейнер останавливается/запускается/удаляется.

| Сценарий | Наблюдение |
|---|---|
| Healthy | live200 / ready200 |
| DB down | ready503 database unavailable/storage ok, live200; mutation500 |
| DB up | ready200, снимок users/files/folders/uploads неизменен, owner folder read200 |
| Storage unavailable | ready503 storage unavailable/database ok, live200; upload400 Failed to prepare upload session |
| Storage recovery | снимок БД неизменен; ready200; новый upload session201 |
| Foreign folder / rename / upload parent | 404 / 404 / 403 — установленные контракты |
| Invalid share | 404 |
| Refresh reuse / revoked descendant | 401 / 401 |
| Malformed Bearer / signed expired access mutation | 403 / 403 — current JwtGuard contract |
| Share attempt budget | первые10 invalid-token verify404, 11-й429; после61 s снова404 |
| Auth budget | threshold429; после61 s invalid login401 |
| Metrics | dedicated token401/200; 4xx/5xx status-class series, bounded route labels |
| Privacy | 141 JSON lines,0 non-JSON;0 leaks проверенных passwords/JWT/headers/DB+metrics credentials/storage paths |
| Cleanup | own runtime container удалён, отсутствие проверено |

Request IDs `fs-db-mutation`, `fs-storage-upload`, `fs-storage-recovered`, `fs-idor-folder`, `fs-refresh-reuse`, `fs-expired-mutation`, `fs-rate-reset` соединяют API status и JSON completion. Runtime evidence `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-failure-security-3ikstkc7/{result.json,runtime.log,metrics.txt}`; temporary artifacts могут быть удалены ОС. Основное долговечное evidence — воспроизводимые harnesses и тесты.

## Gates

- Focused security/storage/files/uploads/previews/observability:34 suites, 453 tests PASS,0 skipped с `HOMECLOUD_TEST_DATABASE_URL` disposable DB.
- Новые own focused tests после lint correction:2 suites,27 tests PASS;17real-PG ownership +10real-JWT HTTP.
- Backup safety в disposable copied project:27PASS/0FAIL/0SKIP. Restore safety `--skip-integration`:15PASS/0FAIL/1SKIP; skipped integration заменена отдельным real restore drill, а не объявлена выполненной самим safety suite.
- Full backend:57 suites,651 tests PASS,0FAIL/0SKIP; все прежние4 PostgreSQL integration группы реально исполнены.
- Lint:0errors,15прежних warnings. Build/typecheck PASS. Новые TS Prettier, shell syntax, Python syntax и `git diff --check` PASS. Старые formatting exceptions из observability checkpoint не изменялись.
- Frontend source не изменялся; frontend gate не запускался.

Полный gate был повторён после исправления lint размещения assertions нового теста. Product fixes отсутствуют. Initial runtime assertions были уточнены после чтения текущих контрактов403/400; это исправления harness, не смена API semantics.

## Воспроизведение

```sh
# Docker доступен; запуск только disposable harnesses.
npm --prefix backend run build
python3 scripts/tests/failure-security-runtime.py
bash scripts/tests/test-failure-security-restore.sh
# Для suites: HOMECLOUD_TEST_DATABASE_URL указывает только на disposable PostgreSQL.
(cd backend && npm test -- --runInBand)
```

Runtime harness требует Python3, Docker, установленный backend Node runtime/dependencies и собранный dist. Restore harness требует Docker Compose, существующие script prerequisites и возможность собрать backend image. `DR_IMAGE` допускает явно выбранный заранее собранный текущий image; default build выполняется самостоятельно. Нормальные .env/volumes не являются input.

## Независимый review и границы

INDEPENDENT_REVIEW: APPROVE — read-only reviewer независимо проверил final row/byte diffs, readiness, runtime correlation/privacy/rate reset/cleanup и full gates. Замечания к harness initialization/storage-live assertion/upload fixture устранены и перепроверены.
FAILURE_SECURITY_CHECKPOINT: PASS.

Подтверждённых product/security defects в проверенных сценариях не найдено; это не доказательство отсутствия всех уязвимостей. Исправлен устаревший текст threat model о logout: текущий код сравнивает raw token с bcrypt hashes и в транзакции отзывает terminal replacement chain.

Concurrent refresh и logout chain покрыты existing service tests с mocked repositories; runtime доказывает последовательную rotation/reuse/descendant revocation, а не реальный PostgreSQL concurrent refresh race.

Stateless access JWT после logout остаётся действительным до TTL; немедленная access revocation не заявляется. Custom JwtGuard проверяет подпись/expiry, а не состояние пользователя в БД; inactive-user policy этим checkpoint не квалифицируется. Rate limits process-local: multi-replica/global distributed budgets не проверены. Permanent deletion по действующему контракту коммитит DB до unlink; post-commit I/O failure может оставить orphan и требует reconciliation. Отсутствие orphan доказано для restore fixture и проверенного upload failure, не для всех вариантов отказов.

Не проверены power loss/kill в каждом transaction boundary, ENOSPC/inodes, corruption всех архивных форматов, network partition всего deployment, exhaustive combinations или произвольная third-party инфраструктура. CLI migration tooling может писать SQL в локальные DR logs; privacy scan141lines относится к app request/runtime logging, не к migration CLI. Никаких TLS/deployment/secrets/offsite/encrypted backup действий не выполнялось. Redis остаётся неиспользуемой некритичной зависимостью. Нормальные контейнеры и явно запрещённые container IDs не трогались.

Следующий минимальный кандидат: документированный production topology и release/rollback gate с явными требованиями к secrets, TLS, migration и backup. Автоматически не начинается.
