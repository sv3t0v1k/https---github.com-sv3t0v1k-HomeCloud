# Final Production Acceptance / Go-Live Gate

Дата: 2026-10-01, Asia/Vladivostok. Ненумерованная финальная сводная проверка. **OVERALL_PRODUCTION_READINESS: NOT_READY**. Это итог кампании, не новая Phase и не разрешение deployment.

## Исходное состояние и границы

HEAD `bb01b5f35ace220e9bf34b8984297784edf629e8`; status содержал только запрещённый untracked audit. Audit не читался, не изменялся и не включался в artifacts/commit. Source экспортирован через git archive в `/private/tmp/homecloud-final-acceptance/release-source`; builds не использовали audit или production .env. Старые/preview контейнеры не изменялись.

Топология: один native Linux Docker host, один backend, PostgreSQL и persistent storage; внешний maintenance barrier; ingress TLS → frontend nginx → backend. Fixed proxy networks172.29/172.30 должны быть свободны. Docker Desktop daemon Linux29.4.1 доступен при разрешённом доступе к socket; первичная ошибка sandbox не является отсутствием daemon. Docker Desktop/macOS cert bind rotation по-прежнему unsupported. Конечный production host/domain/operator inputs не предоставлены и не квалифицированы.

## Финальная acceptance matrix

| Критерий | Класс | Факт / итог |
|---|---|---|
| Чистый source и release builds | BLOCKING | PASS: git archive ожидаемого HEAD, lockfile npm ci в Docker builds; immutable local image IDs ниже. Bit-for-bit reproducibility не заявляется |
| Release manifest / предыдущая image pair | BLOCKING | INCONCLUSIVE: registry digests и предыдущая backend/frontend пара для deployment не квалифицированы |
| Production config / Compose | BLOCKING | PASS на disposable inputs; target production inputs не проверены |
| Migrations / preflight | BLOCKING | PASS в backend rollback fixture, no pending; target manifest/schema gate не упражнялся |
| Полная deployment последовательность / readiness | BLOCKING | SKIPPED: полный documented release drill не выполнен |
| TLS ingress / client-IP / private endpoints | BLOCKING | Prior qualified baseline; fresh полный TLS harness остановился на occupied subnets до deployment; logging correction проверяется отдельно |
| Реальный public DNS/CA / renewal / chain/SAN | BLOCKING | INCONCLUSIVE: нет qualified domain/DNS/public ACME evidence; local CA не заменяет этот gate |
| Native Linux bind на целевом host | BLOCKING | INCONCLUSIVE: previous native daemon-side mechanics PASS, target host не проверен |
| Secret delivery/rotation/custody | BLOCKING | Prior mechanics PASS; реальные operator/recovery custody inputs не квалифицированы |
| Encrypted backup / isolated restore | BLOCKING | PASS свежий fixture, строки/quota/shares/uploads/bytes/readiness совпали |
| Физический offsite / аварийный доступ к keys | BLOCKING | INCONCLUSIVE: same-host target не доказывает независимый failure domain |
| Scheduler / delivered alerts / retries | BLOCKING | INCONCLUSIVE: команды и JSON exits есть, wired timer/cron и доставка оператору не представлены |
| Previous-version application rollback | BLOCKING | FAIL как полный gate: previous backend compiled-artifact subtest PASS; предыдущая frontend/image pair и documented deployment rollback не проверены |
| Интегрированный recovery | BLOCKING | PASS в encrypted same-host offsite fixture; target disaster recovery не заявляется |
| Полный E2E / desktop/mobile | BLOCKING | SKIPPED: fresh full supported ingress smoke не состоялся; unit/UI suites не заменяют его |
| Logs/metrics/readiness privacy / operations | BLOCKING | INCONCLUSIVE общего gate: baseline и отдельное proxy privacy исправление; target observation/alerts не квалифицированы |
| Operator commands / maintenance / host restart | BLOCKING | Checklist ниже; реальный external barrier, DB restart/recovery mechanism не упражнялись |
| External-only backup/restore input integration | BLOCKING | INCONCLUSIVE: legacy checkout .env/custom DB identifier boundary не квалифицирован; нельзя копировать secrets в checkout как workaround |
| Runtime dependency exposure review | BLOCKING security-review input | RESOLVED для GHSA-wrjc-x8rr-h8h6: React Router 7.18.2, bounded review и regression ниже; общий SECURITY_OPS_ACCEPTANCE остаётся INCONCLUSIVE |
| Backup volume / disk / maintenance / agreed RPO/RTO | BLOCKING | INCONCLUSIVE: нет approved launch-volume budgets и замеров; fixture не доказывает24h/30min |

Отсутствующее evidence не понижено до advisory. Runbook policy требует real public CA/domain/bind qualification до go-live: [certificate lifecycle](./certificate-lifecycle.md), [topology](./production-topology.md). Исполняемая процедура и local smoke недостаточны.

## Release artifact qualification

Свежие Docker builds из source archive используют npm ci и production Dockerfiles. Образы не публиковались; local IDs не равны registry RepoDigests:

- Backend `sha256:456fc0642a589a427adcc4b7121917c07646139b11ee7251555a84da44dc064b`.
- Frontend с bounded logging correction `sha256:4531c73886b880fdecdfd61a109efd6c85fa4ebcb07f8665e715d0b0d9442d1f`.
- Host build manifest backend363 files SHA256 `e65c97bbe5c6b9890a31cc4e74142fa0955ad8e6f59a01325bbe44766978cca9`; frontend13 files `a154c4f30ae3a4eeccf85631ce8f514555a27c4ec9704ee2d9f5bdf6c8e631ba`.

Это source/build qualification, не подтверждение deploy этих images на production. Backend artifact unchanged by proxy correction. Никакого schema rollback не заявляется.

## Свежие drills и raw evidence

Raw evidence root: `/private/tmp/homecloud-final-acceptance/`. Временные файлы ОС может удалить; точные boundaries сохранены здесь. Raw logs не коммитятся без privacy review.

- `previous-rollback-result.json`, `previous-rollback-corrected.log`, `rollback-recovery-audit.json`: current backend bb01b5f → controlled exit42 → compiled backend commit `9e96378f3454029af7de1827c1c58fcc6c14d278`. Migration/entity sources unchanged; readiness/auth/upload/download, DB snapshot и bytes PASS. Main.js hash одинаков, dist tree отличается validator. Closest immediate previous commit7c893e9 имеет те же application trees, поэтому не использован как самостоятельная previous application version. Нет frontend/TLS/schema rollback. Own DB container удалён.
- `fresh-recovery-result.json`, `fresh-backup-recovery.log`; оригинал `/private/tmp/homecloud-backup-dr.DFXnhK/result.json`: локальная encrypted copy удалена, backup fetch/decrypt/paired restore из isolated offsite target после DB/storage mutation. Users1/folders2/files4/shares1/uploads1; identical rows/SHA256, quota/completed uploads consistent, readiness200, secret scan PASS, cleanup PASS. Same-host filesystem transport; аварийная потеря production host не моделировалась.
- `tls-extended.log`: harness abort `Proxy smoke subnet already occupied`, own resources cleanup PASS. Existing preview не остановлен; subnet substitution не выдана за поддерживаемый production drill. Полная maintenance→backup→migrations→backend→frontend/ingress→smoke sequence не упражнялась.

## Один bounded correction cycle

Security reviewer обнаружил наследуемые nginx combined access/error logs с raw URI и share tokens. Effective stock nginx config подтвердил `$request` в access log. Оба proxy теперь пишут только status/bytes/duration; raw nginx error records направлены в `/dev/null`, поскольку могут содержать URI/upstream URL. Это сознательная потеря деталей proxy errors: оператор использует status/time, nginx -t, private readiness и безопасные backend JSON logs с request ID. Никакой секрет не должен передаваться через request ID.

Одновременно harness fixtures release/rollback и TLS использовали алфавитные synthetic JWT/metrics, которые текущий validator справедливо отклоняет. Fixture secrets заменены CSPRNG; product validator не ослаблен. Test-only timeout в отдельном logging fixture ограничивает время upstream-failure probe; production timeout не менялся. Независимый security review и raw proxy privacy result фиксируются дополнением ниже.

## Full final gates

| Gate | Свежий результат |
|---|---|
| Backend full | 59 suites /702 tests PASS,0 skipped; disposable PostgreSQL cleanup PASS |
| Frontend full | 12 files /96 tests PASS |
| Release/secret focused | 7/7 PASS |
| Certificate focused | 10/10 PASS |
| Backup production focused | 34/34 PASS с cached age |
| Restore validation | 15 PASS,0 FAIL,1 integration SKIP; fresh integrated restore выше PASS |
| Hostname / shell syntax | PASS;11 shell files |
| Backend lint | 0 errors,15 existing warnings |
| Frontend lint | PASS |
| Backend build/typecheck / compiled file-type | PASS |
| Frontend production build | PASS |
| Compose quiet / production config / artifact helper | PASS disposable env |
| nginx config / privacy | Отдельное fresh logging fixture; не full TLS acceptance |

Первичные sandbox loopback/socket failures исправлены разрешённым доступом. Первичный legacy restore run с отсутствующими prerequisites (13 reported PASS/2 FAIL/1 SKIP) не принят как validation evidence; повтор с prerequisites дал15 PASS/0 FAIL/1 explicit skip. Legacy destructive suite не повторялась: её broad cleanup не требуется для этого gate; prior backup27/restore15 qualified evidence и свежий paired recovery явно отделены от full fresh suite. Final script syntax/diff review фиксируются перед commit.

## Known limitations classification

| Ограничение | Класс / причина / mitigation |
|---|---|
| Access JWT после logout до TTL | ADVISORY candidate, не приписывать owner acceptance; ограниченный TTL, emergency secret cutover по secret runbook |
| Process-local rate limits | ADVISORY candidate для одного backend; restart reset известен, replicas нельзя расширять без пересмотра |
| Process-local metrics | ADVISORY candidate; counters reset, private external scrape/history требует операционной настройки |
| Post-commit unlink orphan | ADVISORY candidate; capacity observation и осторожный reconciliation, не обещать автоматическую безопасную очистку |
| Физический offsite против same-host fixture | BLOCKING до подтверждения independent mount/failure domain и key custody |
| Real public CA/domain | BLOCKING; local certificate не production trust |
| macOS Docker Desktop stale cert bind | ADVISORY вне supported Linux production; target native bind qualification BLOCKING |
| RPO/RTO на полном объёме | BLOCKING до approved launch volume/budgets и измерений; historical24h/30min не SLA |
| Plaintext staging secure erase | ADVISORY candidate при encrypted filesystem/ACL и controlled crash cleanup; unlink не secure erase |

Risk candidates не называются ACCEPTED без отдельного owner decision. Изменения auth, rate limits и orphan semantics не выполнялись.

## Operator acceptance checklist

Checklist выполняется на выбранном Linux host, из защищённого deployment checkout; полные команды/inputs находятся в [release/rollback](./release-and-rollback.md), [secrets](./secret-lifecycle.md), [certificates](./certificate-lifecycle.md), [backup](./backup-productionization.md). Проверки не разрешают открыть traffic при любом unresolved blocker.

1. Зафиксировать release commit, new/previous backend/frontend registry digests, schema compatibility manifest и owner/budgets. Подтвердить project/volume names, storage UID1001, свободные fixed networks, DB/host restart recovery mechanism, внешний maintenance barrier и операторов escalation.
2. Проверить real PUBLIC_HOST DNS A/AAAA, TCP80/443, внешний challenge и chain/SAN/expiry; выполнить Certbot bootstrap/install по certificate runbook на host. Qualify native coherent bind, renew/reload и served fingerprint. Не применять self-signed fallback.
3. Получить external secret env-file0600 в directory0700 по secret runbook; не выводить config/resolved env. Проверить recovery custody env/age identity вне host failure domain. Выбрать release-images.yml c `image: registry/path@sha256:...` для backend/frontend.
4. `export COMPOSE_FILE="$PWD/docker-compose.production.yml:$PWD/release-images.yml"` и фактический `COMPOSE_PROJECT_NAME`; STOP, пока не квалифицирована передача external env-file также nested helper Compose calls и custom DB_NAME/DB_USER: текущие legacy helpers читают checkout .env, а secret contract требует external-only delivery. Copy/symlink .env не принят как workaround. После устранения gate задать external secret file явно всем Compose вызовам по secret runbook. `docker compose config --quiet`; `docker compose pull backend frontend`. Проверить maintenance barrier, остановить writes и `docker compose stop frontend backend`.
5. Задать BACKUP_PRODUCTION_DIR/BACKUP_OFFSITE_DIR/AGE_RECIPIENTS_FILE и acknowledgements только после проверки barrier/offsite mount. `bash scripts/backup-production.sh`; проверить JSON success, ciphertext manifest/hash, freshness, retention и isolated restore point. Если job nonzero — stop release, не открывать traffic.
6. Новым backend image выполнить config validator, `migration:show`, сопоставить reviewed list; `migration:run --transaction all`, затем no-pending verifier — exact команды release runbook. Schema incompatibility блокирует app rollback и требует отдельного recovery decision.
7. `docker compose up -d --no-build --no-deps backend`; private readiness200 и storage writable. Затем frontend, ingress; оба `nginx -t`. Maintenance остаётся закрыт.
8. Проверить externally trusted HTTPS `/`, headers/challenge, public health/metrics404; internal ready200/metrics bearer policy; spoofed forwarded headers. Выполнить login, root/nested/list/grid/folder/upload/download bytes/preview/share create+revoke/trash+restore/logout+relogin; desktop/mobile rendering.
9. Проверить actual scheduler timers/jobs: renew дважды/сутки, check ежедневно, backup по approved RPO с write barrier/validate/retention и freshness. Выполнить failure/stale alert injection, подтвердить получение оператором, acknowledgement, bounded retry и escalation владельцу. Скриптов/exit code без доставки недостаточно.
10. Rollback trigger: config/migration/readiness/smoke/privacy failure или устойчивый рост5xx после release. Barrier закрыт, stop backend/frontend; export RELEASE_BACKEND_IMAGE/PREVIOUS и frontend pair по runbook, pull и up backend→ready→frontend→smoke. Не rollback schema без доказанного плана; DB/storage не удалять.
11. Recovery entry: `bash scripts/restore-offsite.sh GENERATION --validate-only`, затем при явном incident decision `--yes` в закрытом isolated/maintenance target; проверить migrations/reconciliation, rows/quota/shares/uploads/bytes и ready200. Restore может стартовать backend до migrations; внешний barrier обязателен независимо от exit.
12. Post-launch: только после GO/all blockers, owner sign-off и recorded prerequisites. Наблюдать минимум согласованное окно (minimum15min по release runbook; выбранный checklist input30min, не SLA): external HTTPS, private ready,5xx/latency/storage capacity, backup freshness и реально served cert. При trigger закрыть barrier и rollback. Назначить on-call и следующий restore/expiry контроль.

## Итоговые классификации

RELEASE_ARTIFACTS: PASS (local locked builds; target registry manifest отдельно unresolved).
PRODUCTION_DEPLOYMENT_DRILL: SKIPPED.
PUBLIC_DNS_CA: INCONCLUSIVE.
SCHEDULER_ALERTING: INCONCLUSIVE.
PREVIOUS_VERSION_ROLLBACK: FAIL (полный gate; previous backend subtest PASS).
FINAL_RECOVERY_DRILL: PASS (same-host encrypted recovery boundary).
END_TO_END_SMOKE: SKIPPED.
SECURITY_OPS_ACCEPTANCE: INCONCLUSIVE.
INDEPENDENT_FINAL_REVIEW: NO_GO. Независимый reviewer проверил raw suite/build/runtime/proxy evidence и actual diff: все BLOCKING критерии не доказаны; топология ясна; previous rollback только backend; recovery только same-host fixture; lifecycle не полностью operationalized; owner risk acceptance не приписывается.
OVERALL_PRODUCTION_READINESS: NOT_READY.

Минимальные оставшиеся группы блокеров: (1) реальный Linux production target/DNS/public CA/native bind; (2) wired scheduler и delivered alerts; (3) физически независимый offsite/key custody и approved measured recovery budgets; (4) полный immutable-pair release/previous-version rollback/TLS E2E/operator host-recovery acceptance; (5) external-only helper config integration. Runtime React Router advisory закрыт bounded review ниже; перечисленные пять групп остаются blocking. Следующая работа автоматически не начинается; production deployment не выполнен.


## Финальное raw evidence и оставшиеся input gaps

Proxy privacy: сохранённый `scripts/tests/proxy-privacy-runtime.py` выполнен на окончательных configs; `proxy-privacy-repo.log`, raw `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-proxy-privacy-v3lxx_76/`. `nginx -t` обоих PASS; success200 и upstream timeout504, один499 client disconnect в предыдущем probe; token/query/Referer/User-Agent marker отсутствует в обоих proxy logs. Result fixture первоначально описывал error как502: это неточная строка, actual raw status504 имеет приоритет. Description исправлен, raw evidence сохранён. Cleanup PASS. Первичная http-level correction не подавляла stock same-context logs; финальная server-level override проверена отдельно, только её считать исправлением. Raw proxy errors отсутствуют намеренно. Python AST syntax3/3 и `git diff --check` PASS.

Source review выявил ещё один **BLOCKING operator-input integration gap**: secret-lifecycle требует external env-file и запрещает production .env в checkout; release/legacy backup/restore runbooks/helpers рассчитывают на checkout .env. Restore обнуляет DB_NAME/DB_USER/DB_PASSWORD перед чтением .env; nested Compose вызовы не наследуют CLI `--env-file` внешнего запуска. Fixture recovery содержит .env и не доказывает external-only production delivery/custom DB identifiers. Это не утверждение, что любой restore сломан: local PostgreSQL socket может обходиться без password. Требуется qualification единого external input path для helper+Compose до release; копия/симлинк секретов в checkout не принята как workaround. Второй implementation цикл не начат.

Frontend Docker npm ci сообщил5 vulnerabilities (4 moderate,1 high). Build PASS не является dependency security qualification; runtime/dev exposure выясняется read-only audit, никаких dependency upgrades в этой кампании. До подтверждения exposure finding нельзя скрывать.

Independent reviewer: **NO_GO**. Общий итог остаётся **NOT_READY**.


Read-only dependency exposure review (`frontend-npm-audit.json`, `frontend-dependency-paths.log`): high brace-expansion и moderate Vitest/mocker относятся к dev/build tooling; frontend runtime nginx не содержит их node_modules. React Router6.30.6 — bundled runtime: [backslash redirect advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6). SSR hydration advisory не соответствует текущему static CSR deployment. Login return path отвергает `//`, но не backslash; источник history state.from не доказан как remotely attacker-controlled, поэтому exploit не подтверждён, а exposure review остаётся незакрытым input final SECURITY_OPS_ACCEPTANCE. Не утверждать все findings dev-only и не принимать риск без owner decision. Upgrades не выполнялись.

Независимый security reviewer отдельно подтвердил bounded proxy correction PASS по actual diff/effective configs/raw200/504 marker scan; overall ops INCONCLUSIVE. Финальный frontend image пересобран после server-level correction; backend image unchanged. Только исправленная пара IDs выше относится к итоговому candidate. Final image evidence `final-images-corrected.txt`; superseded image96feeeff не считать окончательным.


## Закрытие React Router advisory — 2026-10-01

Исходный HEAD `2ca166f5d9969520b0573415fd260edf15160805` и единственный untracked запрещённый audit совпали с заданием. Audit не открывался и не изменялся. Ненумерованная ограниченная задача; backend, инфраструктура и контейнеры не изменялись. Исторический read-only finding выше относится к прежнему candidate.

**GHSA_WRJC_X8RR_H8H6_PACKAGE_AFFECTED: YES до обновления / NO после. HOMECLOUD_RUNTIME_EXPOSURE: NOT_CONFIRMED. REMEDIATION_REQUIRED: YES (package finding). REACT_ROUTER_ADVISORY_ITEM: RESOLVED. OVERALL_PRODUCTION_READINESS: NOT_READY / NO_GO.** Закрытие относится к source/lockfile; существующие release images не пересобирались и не объявляются исправленными этим checkpoint.

[GitHub advisory](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) подтверждает affected `>=6.0.0,<7.18.0`, patched `7.18.0`; исправленный 6.x в источнике не указан. До изменений `npm ls`: react-router-dom/react-router **6.30.6**, React/react-dom **18.3.1**, Vite **6.4.3**. Lockfile и установленное дерево совпадали; успешный сетевой `npm audit --json` подтвердил finding (первый sandbox запуск не достиг registry, не принят как audit evidence).

Минимальная доступная major-линия с исправлением — 7.x. Итог exact `react-router-dom: 7.18.2`, транзитивный react-router **7.18.2**. Начальная 7.18.0 устраняла целевой advisory, но current audit выявил RSC-only [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2), affected `>=7.12.0,<7.18.2`; поэтому выбран минимальный дополнительный patch 7.18.2. Этот RSC finding не применим к режиму HomeCloud. Не выполнен переход на Framework/Data mode; imports/API и application source сохранены. Изменения lockfile ограничены Router pair, удалением прежнего @remix-run/router и добавлением обязательных cookie/set-cookie-parser; прочие версии не менялись.

Совместимость: peer React/react-dom >=18, Node >=20; React18.3.1 и локальный Node20.19.4/существующий Docker node:20-alpine подходят. [Changelog v7](https://github.com/remix-run/react-router/blob/v7/CHANGELOG.md) проверен: react-router-dom сохраняется как re-export, новые требования Node/React соблюдены. HomeCloud не использует splat-relative navigation, lazy React imports внутри компонентов, loaders/actions/fetchers/manual hydration; Framework CSRF/proxy изменения не относятся к static CSR. Existing gate проверяет реальные auth/file/breadcrumb flows. Browser E2E на production host в этот bounded gate не входит.

### Матрица навигации

| Источник | Доверие / контроль | API | Экспозиция HomeCloud |
|---|---|---|---|
| App sidebar/root, error links, authenticated login | Константы /files, /files/trash, /login | Link, NavLink, Navigate | Внешний target не поступает |
| Выбор папки из API | id от сервера, имя может быть пользовательским; destination всегда /files/folders/${id} | useNavigate | Имя не используется как путь, нет attacker-controlled leading separators |
| Breadcrumbs | history crumbs фильтруются positive safe integer id, API ancestry; фиксированный /files/folders/ prefix | Link | Внешний destination не найден |
| ProtectedRoute → LoginPage | from = same-origin location.pathname в локальном history state, не query/API redirect URL | Navigate → useNavigate | Локальный state можно подменить; удалённый источник внешнего target не обнаружен. Старый readReturnPath пропускал /\target; это недостаточная проверка формы, но не доказательство remote exploit |
| URL folderId / public share token | folderId positive safe integer, token кодируется для sharing URL; ни один не передаётся как navigation target | Route params / URL construction | Advisory-style external navigation surface не найден |

Declarative mode: BrowserRouter + Routes/Route, createRoot без SSR. Redirect helpers/Data/Framework/RSC APIs отсутствуют. App-level sanitizer не добавлялся: genuine remotely controlled navigation target не обнаружен; обновление пакета исправляет выявленное поведение без расширения scope.

### Воспроизведение и gate

`frontend/src/routing/router-security.test.tsx`: package-level BrowserRouter/useNavigate probe, без нового публичного ввода. На 6.30.6 нормальные /files, /files/folders/7, /files/trash и //target проходили; три смешанных slash/backslash target проваливали проверку внутреннего pathname, browser history отвергал cross-origin URL и Router пытался вызвать location.assign. jsdom не выполняет внешнюю загрузку: это подтверждает unsafe navigation attempt, не полноценный browser exploit. На исправленном пакете все targets остаются на исходном origin с ожидаемым внутренним pathname. Дополнительно существующий LoginPage проверяется с локально injected history state: internal folder/trash сохраняются, protocol-relative/https отклоняются существующей проверкой, slash-backslash target безопасно обрабатывается пакетом. Эти synthetic local state tests не доказывают remote controllability.

- Focused advisory: **12/12 PASS**; auth/protected/file focused до дополнительного patch: **43/43 PASS**.
- После финального 7.18.2 и `npm ci --ignore-scripts --no-audit`: полный frontend **13 files /108 tests PASS**, lint PASS, TypeScript + Vite build PASS. Ignore-scripts используется для проверки lockfile/install, обычная сборка отдельно PASS.
- `npm ls` после чистой установки: единственная Router pair 7.18.2, React18.3.1/Vite6.4.3 сохранены. `git diff --check` PASS.
- Финальный npm audit: react-router/react-router-dom findings отсутствуют; остаются прежние dev tooling findings @vitest/mocker, Vitest, brace-expansion, не исправляемые этой задачей. Raw audit `/private/tmp/homecloud-router-audit-final.json` временный, классификация сохранена здесь.

Related Router review: [SSR hydration GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) не применим к Declarative mode и исправлен7.18.0; [RSC XSS GHSA-h8fp-f39c-q6mh](https://github.com/advisories/GHSA-h8fp-f39c-q6mh) и RSC CSRF выше не применимы без unstable RSC; [Framework DoS GHSA-chx6-hx7r-mcp5](https://github.com/advisories/GHSA-chx6-hx7r-mcp5) не применим к CSR и исправлен7.18.0. [GHSA-jjmj-jmhj-qwj2](https://github.com/advisories/GHSA-jjmj-jmhj-qwj2) по актуальному диапазону уже исправлен исходным dom6.30.6 (affected6.30.2–6.30.5; v7 affected7.9.6–7.12.0, patched7.13.0). Новых применимых Router findings в итоговом resolved tree audit не выявлено; отсутствие любого будущего advisory не обещается.

Независимый security reviewer: **APPROVE** по actual final diff, официальным диапазонам advisories, минимальности Router graph, CSR exposure matrix и regression evidence. Blocking замечаний нет; ограничения jsdom и старых release images сохранены. Остальные production blockers без изменений. Следующий рекомендуемый минимальный blocker — external-only backup/restore helper config integration; автоматически не запускается.
