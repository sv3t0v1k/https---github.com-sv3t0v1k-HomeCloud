# Final Production Acceptance / Go-Live Gate

Дата: 2026-10-01, Asia/Vladivostok. Ненумерованная финальная сводная проверка. **OVERALL_PRODUCTION_READINESS: NOT_READY**. Это итог кампании, не новая Phase и не разрешение deployment.

## Исходное состояние и границы

HEAD `bb01b5f35ace220e9bf34b8984297784edf629e8`; status содержал только запрещённый untracked audit. Audit не читался, не изменялся и не включался в artifacts/commit. Source экспортирован через git archive в `/private/tmp/homecloud-final-acceptance/release-source`; builds не использовали audit или production .env. Старые/preview контейнеры не изменялись.

Топология: один native Linux Docker host, один backend, PostgreSQL и persistent storage; внешний maintenance barrier; ingress TLS → frontend nginx → backend. Fixed proxy networks172.29/172.30 должны быть свободны. Docker Desktop daemon Linux29.4.1 доступен при разрешённом доступе к socket; первичная ошибка sandbox не является отсутствием daemon. Docker Desktop/macOS cert bind rotation по-прежнему unsupported. Конечный production host/domain/operator inputs не предоставлены и не квалифицированы.

## Финальная acceptance matrix

| Критерий | Класс | Факт / итог |
|---|---|---|
| Чистый source и release builds | BLOCKING | PASS: git archive ожидаемого HEAD, lockfile npm ci в Docker builds; immutable local image IDs ниже. Bit-for-bit reproducibility не заявляется |
| Release manifest / предыдущая image pair | BLOCKING | RESOLVED локально: immutable manifest, full prior release pair rollback/rollforward PASS; одинаковые app trees, границы и evidence ниже |
| Target registry distribution | BLOCKING | PARTIALLY_RESOLVED: disposable push/pull/current→previous→current PASS; external production provider/auth/TLS/retention/target platform NOT_QUALIFIED |
| Production config / Compose | BLOCKING | PASS на disposable inputs; target production inputs не проверены |
| Migrations / preflight | BLOCKING | PASS в backend rollback fixture, no pending; target manifest/schema gate не упражнялся |
| Полная deployment последовательность / readiness | BLOCKING | SKIPPED: полный documented release drill не выполнен |
| TLS ingress / client-IP / private endpoints | BLOCKING | Prior qualified baseline; fresh полный TLS harness остановился на occupied subnets до deployment; logging correction проверяется отдельно |
| Реальный public DNS/CA / renewal / chain/SAN | DEFERRED_OWNER_INFRASTRUCTURE_INPUT; обязателен перед READY | OPEN / INCONCLUSIVE: нет qualified domain/DNS/public ACME evidence; local CA не заменяет этот gate |
| Native Linux bind на целевом host | DEFERRED_OWNER_INFRASTRUCTURE_INPUT; обязателен перед READY | OPEN / INCONCLUSIVE: previous native daemon-side mechanics PASS, target host не проверен |
| Secret delivery/rotation/custody | BLOCKING | Prior mechanics PASS; реальные operator/recovery custody inputs не квалифицированы |
| Encrypted backup / isolated restore | BLOCKING | PASS свежий fixture, строки/quota/shares/uploads/bytes/readiness совпали |
| Физический offsite / аварийный доступ к keys | BLOCKING | INCONCLUSIVE: same-host target не доказывает независимый failure domain |
| Scheduler / delivered alerts / retries | BLOCKING | PARTIALLY_RESOLVED: disposable systemd runtime и controlled receiver delivery PASS; production host/barrier/human recipient NOT_QUALIFIED |
| Previous release backend/frontend pair rollback | BLOCKING | RESOLVED локально: оба immutable artifacts переключились, data/schema unchanged; different application/schema evolution не заявляется |
| Интегрированный recovery | BLOCKING | PASS в encrypted same-host offsite fixture; target disaster recovery не заявляется |
| Полный E2E / desktop/mobile | BLOCKING | SKIPPED: fresh full supported ingress smoke не состоялся; unit/UI suites не заменяют его |
| Logs/metrics/readiness privacy / operations | BLOCKING | INCONCLUSIVE общего gate: baseline и отдельное proxy privacy исправление; target observation/alerts не квалифицированы |
| Operator commands / maintenance / host restart | BLOCKING | Checklist ниже; реальный external barrier, DB restart/recovery mechanism не упражнялись |
| External-only backup/restore input integration | BLOCKING | RESOLVED: explicit external shared config, custom DB identifiers, arbitrary CWD, fresh encrypted recovery/secret scan PASS; evidence ниже |
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
4. `export COMPOSE_FILE="$PWD/docker-compose.production.yml:$PWD/release-images.yml"` и фактический `COMPOSE_PROJECT_NAME`; Задать HOMECLOUD_ENV_FILE абсолютным external path по recovery contract; loader передаёт проверенные значения nested Compose без auto dotenv. Checkout .env не используется; copy/symlink secrets в checkout запрещён. Для release commands загрузить общий recovery-config.sh по release runbook; explicit DB/Compose/project settings должны соответствовать target. `docker compose config --quiet`; `docker compose pull backend frontend`. Проверить maintenance barrier, остановить writes и `docker compose stop frontend backend`.
5. Задать BACKUP_PRODUCTION_DIR/BACKUP_OFFSITE_DIR/AGE_RECIPIENTS_FILE и acknowledgements только после проверки barrier/offsite mount. `bash scripts/backup-production.sh`; проверить JSON success, ciphertext manifest/hash, freshness, retention и isolated restore point. Если job nonzero — stop release, не открывать traffic.
6. Новым backend image выполнить config validator, `migration:show`, сопоставить reviewed list; `migration:run --transaction all`, затем no-pending verifier — exact команды release runbook. Schema incompatibility блокирует app rollback и требует отдельного recovery decision.
7. `docker compose up -d --no-build --no-deps backend`; private readiness200 и storage writable. Затем frontend, ingress; оба `nginx -t`. Maintenance остаётся закрыт.
8. Проверить externally trusted HTTPS `/`, headers/challenge, public health/metrics404; internal ready200/metrics bearer policy; spoofed forwarded headers. Выполнить login, root/nested/list/grid/folder/upload/download bytes/preview/share create+revoke/trash+restore/logout+relogin; desktop/mobile rendering.
9. Проверить actual scheduler timers/jobs: renew дважды/сутки, check ежедневно, backup по approved RPO с write barrier/validate/retention и freshness. Выполнить failure/stale alert injection, подтвердить получение оператором, acknowledgement, bounded retry и escalation владельцу. Скриптов/exit code без доставки недостаточно.
10. Rollback trigger: config/migration/readiness/smoke/privacy failure или устойчивый рост5xx после release. Barrier закрыт, stop backend/frontend; guarded previous manifest override с exact applied migration inputs по runbook, up без build backend→ready→frontend→smoke; registry pull требует отдельной distribution qualification. Не rollback schema без доказанного плана; DB/storage не удалять.
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

Минимальные оставшиеся группы блокеров: (1) реальный Linux production target/DNS/public CA/native bind; (2) wired scheduler и delivered alerts; (3) физически независимый offsite/key custody и approved measured recovery budgets; (4) target registry distribution/TLS и browser E2E/operator host-recovery acceptance. Локальная immutable previous release pair mechanics закрыта дополнением ниже; evolving schema compatibility не заявляется. External-only helper config integration закрыт bounded remediation ниже. Runtime React Router advisory закрыт bounded review ниже; перечисленные четыре группы остаются blocking. Следующая работа автоматически не начинается; production deployment не выполнен.


## Финальное raw evidence и оставшиеся input gaps

Proxy privacy: сохранённый `scripts/tests/proxy-privacy-runtime.py` выполнен на окончательных configs; `proxy-privacy-repo.log`, raw `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-proxy-privacy-v3lxx_76/`. `nginx -t` обоих PASS; success200 и upstream timeout504, один499 client disconnect в предыдущем probe; token/query/Referer/User-Agent marker отсутствует в обоих proxy logs. Result fixture первоначально описывал error как502: это неточная строка, actual raw status504 имеет приоритет. Description исправлен, raw evidence сохранён. Cleanup PASS. Первичная http-level correction не подавляла stock same-context logs; финальная server-level override проверена отдельно, только её считать исправлением. Raw proxy errors отсутствуют намеренно. Python AST syntax3/3 и `git diff --check` PASS.

Исторический source review (исправление и свежая qualification ниже) выявил **BLOCKING operator-input integration gap**: secret-lifecycle требует external env-file и запрещает production .env в checkout; release/legacy backup/restore runbooks/helpers рассчитывают на checkout .env. Restore обнуляет DB_NAME/DB_USER/DB_PASSWORD перед чтением .env; nested Compose вызовы не наследуют CLI `--env-file` внешнего запуска. Fixture recovery содержит .env и не доказывает external-only production delivery/custom DB identifiers. Это не утверждение, что любой restore сломан: local PostgreSQL socket может обходиться без password. Требуется qualification единого external input path для helper+Compose до release; копия/симлинк секретов в checkout не принята как workaround. Второй implementation цикл не начат.

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


## External-only backup/restore config — 2026-10-01

Ненумерованная bounded remediation после React Router; исходный HEAD `647aa7b949698f9b84feee3ce5134cb2a7b542de`, status только запрещённый untracked audit. Audit не читался/не изменялся; чужие containers не затрагивались. Shared loader и [контракт](./backup-productionization.md#единый-внешний-config-для-recovery-helpers): обязательный external absolute env file либо явно выбранный direct environment; exports выше файла, missing/unsafe config fail-closed, no shell execution, no implicit checkout dotenv. DB identifiers проверяются до SQL; Compose file paths абсолютные, project явный, nested calls с `--env-file /dev/null`; reconcile принимает тот же config.

Final disposable smoke evidence: `/private/tmp/homecloud-backup-dr.ldiKuX/result.json`; harness `scripts/tests/test-backup-production-drill.sh`. Actual checkout helpers запускались из disposable CWD, через `env -i` только PATH/HOME/HOMECLOUD_ENV_FILE; repo `.env` не открывался. Custom DB `hc_dr_db`/user `hc_dr_user`; encrypted/offsite-capable generation, удаление local encrypted copy, fetch/decrypt restore после DB/storage mutation, reconciliation и readiness200 PASS. Rows users1/folders2/files4/shares1/uploads1 identical, SHA256 bytes identical, quota/completed upload consistent. Secrets из external config/age identity отсутствуют в captured logs; собственные resources/sensitive inputs очищены. Transport — same-host filesystem fixture, физическая offsite независимость не доказана.

Fresh gates: external contract11/11, production backup34/34, backup safety27/27, restore validation15 PASS/0 FAIL/1 integration SKIP (заменён реальным paired drill выше). Python AST4/4, Bash syntax9/9, local docs references и diff-check PASS. Backend/frontend suites не запускались: app sources не изменены. Независимый review финальных diff/docs/evidence: APPROVE; предварительный evidence gap исправлен повтором с чистым окружением.

CHECKOUT_ENV_DEPENDENCY: RESOLVED. EXTERNAL_CONFIG_CONTRACT: PASS. ARBITRARY_CWD: PASS. SECRET_LEAKAGE: PASS. REAL_BACKUP_RESTORE_EXTERNAL_CONFIG_SMOKE: PASS. PRODUCTION_BLOCKER_EXTERNAL_BACKUP_CONFIG: RESOLVED. Общий **NOT_READY / NO_GO**: real Linux/DNS/public CA/native bind, scheduler/delivered alerts, independent offsite/key custody/measured budgets и immutable release/previous-pair rollback/operator acceptance остаются открыты. Новая Phase не создана; следующая задача автоматически не запущена.


## Immutable release manifest / previous pair rollback — 2026-10-01

Ненумерованная bounded remediation; исходный HEAD `37b2eae7f8375a01c0b7207f70317c57ee3ae01d`, status только запрещённый audit. Audit не читался/не менялся; старые containers `29c17227fd0a`, `983714f1deaa` и preview не затрагивались. [Контракт/operator sequence](./release-manifest.md), [сохранённое sanitized evidence](./evidence/immutable-release/qualification.json), [current manifest](./evidence/immutable-release/current-manifest.json), [previous manifest](./evidence/immutable-release/previous-manifest.json).

| Исходный gap | Итог |
|---|---|
| Только ручные digest inputs | Machine-readable deterministic manifest связывает пару IDs, commit, source/Compose hashes и schema contract |
| Compose содержит build contexts | Guarded YAML override с `build: !reset null`, `pull_policy: never`; реальный merged production config не содержит build |
| Previous rollback только backend | Current → previous → current: оба actual image IDs совпали с выбранной manifest pair |
| Нет executable schema guard | Exact migrations + entities/data-source hashes + live applied classes; unexpected migration блокирует rollback |
| Target registry не доказан | Отдельная NOT_QUALIFIED distribution boundary сохранена; local IDs не объявлены RepoDigests |

Current source `37b2eae7f8375a01c0b7207f70317c57ee3ae01d`: backend `sha256:59a609d268e2a3a0370e425a2807fb26044884a5b3f8ea630b1325ced69c35b9`, frontend `sha256:c5e5e47b9cd1b3beea195d786a63f5d44707803cb3493b7610a852d16a5d46a3`. Previous source `647aa7b949698f9b84feee3ce5134cb2a7b542de`: backend `sha256:62fd9b1206373e59c5cb3a71d5f5f80ee564edaa1652b64299817b7cc4f603cd`, frontend `sha256:837d77529cc39b64c7cd04f10dfb4b0bc4d1778d5f8ea36b228e237009c78031`. Оба checkpoint собраны стандартными production Dockerfiles из exact-commit archives, без checkout env/audit. Это retained outputs, не обещание bit-for-bit rebuild: свежие build timestamps/base resolution могут менять IDs.

Previous — known-good checkpoint исправленного React Router. Backend/frontend application trees, 18 migration sources и entities совпадают с current. Это full previous **release artifact pair** qualification; совместимость различных application generations или изменённой схемы не заявляется. Исторический backend-version drill выше остаётся отдельным доказательством. Выбор identical application checkpoint сознательный: older vulnerable frontend не рекомендован для production rollback.

Final raw root `/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-pair-drill-uhgs8ns8/`; reproducible harness `scripts/tests/release-pair-runtime.py`. Current migrations applied один раз до app; exact no-pending current/previous/current и actual live extra migration refusal PASS. Controlled app outage не менял DB/storage. Readiness200, ingress root/index+2 referenced assets exact SHA256, bearer file download, representative share/trash API PASS на всех трёх этапах. Все public table row hashes, schema dump, migration table, storage SHA256 tree и quota `136/1048576` совпали. Login отдельно после invariance proof PASS (нормальная запись refresh token не выдаётся за unchanged snapshot). Down migrations не выполнялись. Собственные containers, три networks и storage volume удалены; TLS private keys удалены, operation logs secret scan PASS. Квалифицированные локальные images удержаны как rollback artifacts.

Fixture использует self-signed TLS ingress и случайные сети с dynamic trusted proxy substitution, а не production fixed subnets/public DNS/CA/native target bind. UI artifact HTTP checks не заменяют desktop/mobile browser acceptance. Guard предполагает reviewed migration discipline и trusted builder; manual DDL drift, подписанная provenance и registry/multi-platform pull не квалифицированы. Manifest/JSON evidence не содержит secret values; raw logs в commit не включены.

Gates: release helper6/6, manifest26/26 (включая real Compose reset merge, missing/mutable/mixed/source/ID/nonexistent/schema/applied/unsupported-name/duplicate-class failures), обе пары production builds, production Compose effective configs3/3, migration preflight3/3, final rollback+rollforward, Node/Python syntax и diff-check PASS. Application sources не менялись; full suites не повторялись: latest passing backend59 suites/702 и frontend12 files/96 записаны выше. Первый fixture stop ожидал502 вместо timeout; исправлен test-only критерий outage. Независимая Compose-проверка выявила JSON null merge flaw; заменён явным YAML reset и финальный drill повторён на окончательном коде.

INDEPENDENT_REVIEW: APPROVE. Reviewer не автор: actual final code/docs/raw evidence проверены; focused32/32 и обе actual Docker manifest/source validation PASS, diff-check PASS. Sanitized evidence сверено с raw, оба сохранённых manifest byte-identical originals.

IMMUTABLE_RELEASE_MANIFEST: PASS; CURRENT_PAIR_QUALIFIED: PASS; PREVIOUS_PAIR_QUALIFIED: PASS; SCHEMA_COMPATIBILITY_GUARD: PASS; FULL_PAIR_ROLLBACK: PASS; DATA_PRESERVATION: PASS; REGISTRY_DISTRIBUTION: NOT_QUALIFIED; PRODUCTION_BLOCKER_PREVIOUS_PAIR_ROLLBACK: RESOLVED (локальная full prior release pair mechanics). Общий **NOT_READY / NO_GO**: real Linux/DNS/public CA/native bind, target registry distribution, scheduler/delivered alerts, independent offsite/key custody/approved measured budgets и final browser/operator/host-recovery acceptance остаются открыты. Новая Phase не создана; следующая задача не запущена. Следующий рекомендуемый меньший блок — scheduler и delivered alerts, после выбора target/receiver inputs.


## Scheduler / delivered alerts — 2026-10-01

Ненумерованный bounded remediation, исходный HEAD `aa08dca35615080d5d6d4f9dd011678d3608f307`; status только запрещённый audit (не читался/не менялся/не staged). [Контракт](./scheduler-alerting.md), [raw qualification](./evidence/scheduler-alerting/qualification.json), [receiver requests](./evidence/scheduler-alerting/receiver.json), [systemd runtime](./evidence/scheduler-alerting/systemd-runtime.json).

SCHEDULER_CONTRACT: PASS. SYSTEMD_RUNTIME: PASS — disposable Debian/systemd PID1,8 units verify/install,4 active timers, manual+accelerated timer execution, systemctl nonzero14/70/75, safe journal, concurrency block. Persistent=yes inspected; настоящий target reboot/missed-run replay не выполнен. ALERT_DELIVERY_MECHANICS: PASS. ALERT_DEDUP_RECOVERY: PASS — actual loopback HTTP acceptance, repeated failure suppression, time-adjusted escalation, recovery/stale,500/unavailable/timeout retries и nonzero delivery failure.

BACKUP_SCHEDULED_ALERTING: PASS (existing coordinator/real age + controlled legacy fixtures, offsite failure exit14 → receiver → verified success/recovery; actual production maintenance-wrapper ещё не квалифицирован). CERT_SCHEDULED_ALERTING: PASS (actual self-signed isolated check warning/critical/invalid, actual renewal failure; successful/unchanged renewal recovery adapter тестируется mock, ACME/public CA/production nginx этим не доказаны).

Fresh gates: focused22/22 Linux, production backup34/34, external config11/11, cert lifecycle10/10, legacy safety27/27, restore validation15 PASS/1 destructive integration SKIP; Python7/Bash9 syntax,8 systemd units, local docs references и diff-check PASS. Backend/frontend suites не запускались: app sources не изменены. Independent review: **APPROVE**; raw evidence, source hashes и независимый focused запуск проверены, [вердикт](./evidence/scheduler-alerting/review.md).

**SCHEDULER_RUNTIME_QUALIFIED: YES (disposable Linux mechanics). ALERT_DELIVERY_MECHANICS_QUALIFIED: YES (controlled receiver). PRODUCTION_RECIPIENT_DELIVERY_QUALIFIED: NO / NOT_QUALIFIED. PRODUCTION_BLOCKER_SCHEDULER_ALERTS: PARTIALLY_RESOLVED. Общий NOT_READY / NO_GO.**

Оператору нужно предоставить выбранный Linux host/timezone, approved maintenance/RPO и внешний barrier-wrapper, реальный HTTPS alert endpoint с secure external auth config, получателя/канал и подтверждение TEST receipt/acknowledgement/escalation owner. Credentials не передавать в чат/Git. Test receiver не квалифицирует human notification. Остальные blockers: real Linux/DNS/public CA/native bind, registry immutable push/pull/platform, independent offsite/key custody/measured recovery budgets, final browser/operator/host-recovery acceptance. Следующий blocker автоматически не начинается.

## Реальный Linux / DNS / public CA — discovery 2026-10-01

Исходный HEAD `30f13a98a1c312d9e5c11e1811d690c725d04b4d`, исходный status только запрещённый audit, не открывался/не менялся. [Discovery, prerequisites и operator commands](./certificate-lifecycle.md#реальный-linux--dns--public-ca-входы-и-qualification--2026-10-01). Реальные SSH target/public IP/FQDN/timezone/ACME contact/external paths отсутствуют; contract ports80/443, whole-directory bind, /opt/homecloud и root scheduler paths найдены. Example values не являются deployment inputs. Текущий unattended cert renew поддерживает HTTP-01 webroot; DNS-01 требует отдельного plugin flow qualification.

Local cert10/10, scheduler22 tests/1 age integration SKIP, hostname/syntax/quiet Compose PASS. Fresh disposable Linux daemon-side native bind smoke:18 healthy requests during reload; rotation/idempotency/mismatch/config/simulated renewal failure retention и cleanup PASS, raw `/private/tmp/hc-cert-runtime-b35yp793/result.json`. Это прежняя поддерживаемая локальная механика, не production target и не public CA. Application sources не менялись; full app suites не запускались. Target systemd timers не квалифицированы.

| Production classification | Итог |
|---|---|
| REAL_LINUX_TARGET | NOT_AVAILABLE |
| PUBLIC_DNS | NOT_AVAILABLE |
| PUBLIC_REACHABILITY_80_443 | INCONCLUSIVE |
| PUBLIC_CA_ISSUANCE | SKIPPED |
| NATIVE_CERT_BIND_RELOAD | SKIPPED |
| REAL_RENEWAL_PATH | SKIPPED |
| PRODUCTION_BLOCKER_LINUX_DNS_CA | DEFERRED_OWNER_INFRASTRUCTURE_INPUT / OPEN |

**OVERALL_PRODUCTION_READINESS: NOT_READY / NO_GO.** Остались actual Linux/DNS/public CA/native bind, registry distribution, scheduler production recipient/target, независимый offsite/key custody/approved measured recovery budgets и final browser/operator/host-recovery acceptance. Минимальные operator inputs перечислены в certificate doc; credentials только target/out-of-band. Новая Phase не создана. Следующий blocker автоматически не начинается.

INDEPENDENT_REVIEW: APPROVE — reviewer не автор; final docs diff, raw runtime JSON, focused10/10 log, discovery и действующие source/mount/nginx/systemd contracts проверены. Подтверждённых дефектов нет, correction cycle не потребовался; production blocker OPEN и общий NOT_READY сохранены. git diff --check PASS.


## Отложенные входы Linux / DNS / public CA — 2026-10-01

По решению владельца **LINUX_DNS_CA_OWNER_INPUT: DEFERRED / OPEN; DEFERRED_OWNER_INFRASTRUCTURE_INPUT**. Это не PASS и не устранение blocker. Он не препятствует независимой registry qualification; повторный target/CA drill в этом workstream не выполняется. Перед READY для принятой политики публичного production endpoint все прежние критерии обязательны. Точный неизменённый список SSH/user/IP, FQDN/A/AAAA control, timezone, NAT/firewall/HTTP-01, ACME account/contact и абсолютных external paths сохранён в [certificate prerequisites](./certificate-lifecycle.md#target_input_discovery--operator_inputs_required). Общий **NOT_READY / NO_GO**.


## Registry distribution immutable pair — 2026-10-01

Ненумерованный bounded workstream; исходный HEAD `2f6767983d27f8996ccc4f86d254ac2c7e470fd0`, status только запрещённый untracked audit. Audit не открывался/не менялся/не staged; старые containers и preview не затрагивались. **OVERALL_PRODUCTION_READINESS: NOT_READY / NO_GO**. Linux/DNS/CA: **DEFERRED_OWNER_INFRASTRUCTURE_INPUT / OPEN**; точные прежние operator prerequisites сохранены.

| Исходный registry gap | Итог |
|---|---|
| Manifest хранит local image_id, repository/tag/digest отсутствуют | registry-digest mode: repository + sha256 digest обеих ролей под одним release_id; прежний schema/source contract сохранён |
| Local override never, нет pull boundary | prepare загружает всю пару/проверяет provenance до изменения active services; registry default always, переход после prepare с обязательным --pull never |
| External registry/provider/auth отсутствуют | Disposable HTTP registry:2 и чистый docker:27-dind; EXTERNAL_PRODUCTION_REGISTRY NOT_QUALIFIED |
| Current/previous outputs удержаны только локально | Оба pairs retag/push без rebuild; pull обеих пар в отдельный daemon, app refs отсутствовали до pull |
| Registry/config/local IDs смешивались | Push result = Registry API digest = SHA256 raw manifest bytes; platform config digest отдельно сопоставлен с pulled actual Image |

[Registry contract и operator sequence](./release-manifest.md#registry-digest-contract). [Сохранённое evidence](./evidence/registry-distribution/qualification.json), [current registry manifest](./evidence/registry-distribution/current-manifest.json), [previous registry manifest](./evidence/registry-distribution/previous-manifest.json), raw registry/platform manifest bytes и [focused gates](./evidence/registry-distribution/gates.tap). Исходные distributed manifests сохранены byte-identical; embedded manifests в sorted qualification JSON служат только evidence, не operator input.

Чистый nested Docker daemon первоначально image-empty. Затем импортированы только вспомогательные PostgreSQL/nginx/Alpine, чтобы исключить внешний network dependency; ни один app image не импортировался. Все четыре app digest refs отсутствовали перед фактическим pull. Host retained outputs не удалялись и не использовались как deploy identity. Outer registry push исходных qualified IDs и nested pull происходили в разных image stores: Desktop/containerd ID здесь равен OCI manifest digest, nested classic Image — config digest. Оба значения выведены из registry response, не выдуманы из local ID. Конвертация fail closed требует original qualified ID = pulled config ID либо registry digest; same-label иной artifact отвергается. Provenance labels/manifest канал предполагают trusted builder; криптографическая подпись и multi-platform target не заявляются.

Current → previous → current: оба container Config.Image равны manifest repository@digest (asserted harness), actual Image равны expected registry config digests. Production Compose merged3/3 без build, pull_policy:always; отдельная isolated topology с random networks и self-signed ingress развёрнута из resolved refs. Это не запуск public production host. Readiness200, ingress index +2 assets SHA256, bearer download, sharing/public/trash flows и final login PASS. Все public table row hashes, migration table, schema dump, storage tree SHA256 и quota136/1048576 сохранены; no pending migrations3/3. Down migrations не выполнялись. Current/previous application/schema trees совпадают: квалифицированы различные release artifact pairs, не evolving-schema compatibility.

Failures: registry stop, nonexistent digest, malformed digest, previous backend substitution в current, controlled HTTP401 auth denial — отказ prepare, container IDs active pair неизменны, readiness200. Auth denial подтверждён отдельным actual Docker pull stderr; test registry не содержит real secrets. Mutable current tags обоих repositories перемещены на previous content; current digest pulls/deploy stable. Focused tests дополнительно отвергают tag-only refs, mixed metadata, RepoDigests mismatch, identity tampering, unknown credential fields и same-label content substitution. Failed second pull не запускает inspection/deploy. Никаких stop/app update при failed prepare.

Gates: release6 + manifest26 + registry17 = **49/49 PASS**; actual merged Compose3/3, live migration/schema guard, deploy/rollback/rollforward, Node/Python syntax и git diff --check PASS. Production app images не пересобирались: retained qualified outputs доступны. Full application suites не повторялись: app source не менялся. Credentials/account не обнаружены в authoritative registry contract; их поиск/печать не выполнялись. Manifest содержит только repositories/digests/provenance/schema hashes. Runtime logs secret scan PASS; TLS keys, own containers/networks/volumes и outer daemon/registry удалены. Unencrypted daemon API только disposable loopback, operator/root-equivalent trust, без mount Docker socket; auth401 fixture симулирует denial, не реальный provider flow.

**REGISTRY_DISTRIBUTION_MECHANICS: PASS; REGISTRY_MANIFEST_DIGESTS: PASS; REGISTRY_PUSH_PULL_MECHANICS: PASS; CURRENT_PAIR_FROM_REGISTRY: PASS; PREVIOUS_PAIR_ROLLBACK_FROM_REGISTRY: PASS; DIGEST_IMMUTABILITY: PASS. EXTERNAL_PRODUCTION_REGISTRY: NOT_QUALIFIED; PRODUCTION_BLOCKER_REGISTRY_DISTRIBUTION: PARTIALLY_RESOLVED.** Политика запуска не принимает disposable HTTP registry как production target.

Требуемые внешние operator inputs: registry hostname и backend/frontend repositories; auth method и credential helper/DOCKER_CONFIG placement вне repo; TLS/CA trust requirements; retention/GC и immutability policy, сохранение current+previous blobs/digests; target architecture/platform и доступность с deployment host. Credentials в чат/Git не передавать. External auth/TLS/availability/retention ещё не квалифицированы.

Remaining: deferred Linux/DNS/public CA/native bind; внешний registry; target scheduler/maintenance и human alert recipient; independent offsite/key custody/approved measured recovery budgets; final browser/operator/host-recovery acceptance. Следующий blocker автоматически не начинается. **INDEPENDENT_REVIEW: APPROVE.** [Независимый review](./evidence/registry-distribution/review.md): raw digests/byte-identical manifests, clean pull, полный pair transition/data retention и failures проверены; focused17/17 повторены, full49/49 evidence inspected. Замечания о позднем pull, same-label content substitution и historical wording устранены.
