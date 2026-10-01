# Production Readiness — Architecture & Release Gate

Дата: 2026-09-30, Asia/Vladivostok. Ненумерованный owner-approved checkpoint после Failure & Security Testing. Исходный HEAD `b77e8162e32c06be949884d69a3a29773d30138c`; status — только запрещённый untracked audit. Audit не читался, не изменялся и не включается в commit.

## Контракт и границы

[Фактическая topology/gap matrix](./production-topology.md) и [исполняемый порядок release/migration/rollback](./release-and-rollback.md). Поддерживаемый контракт — один backend, один PostgreSQL, постоянный storage, frontend nginx, внешний TLS ingress с maintenance barrier. Redis optional, не runtime/readiness dependency. Zero downtime, HA и previous-version schema compatibility не заявляются.

Production config валидируется ConfigModule до TypeORM initialization: разные access/refresh secrets ≥32 символов; PostgreSQL URL с credential ≥16, совпадение DB_PASSWORD при его наличии; optional metrics token ≥32; абсолютный storage root; явный HTTPS frontend origin. Очевидные placeholders и повторяющиеся secrets отклоняются; это baseline, не измерение entropy. Errors содержат только названия settings. Пустой metrics token означает disabled endpoint. Production startup не требует неиспользуемого Redis; старые development/test validators сохранены.

Release helper имеет независимые режимы config/artifact/migrations/runtime. Он не разрешает public traffic: отдельно blocking build provenance/immutable digests, reviewed migration inventory, consistent backup, rollback inputs, auth/file smoke, acceptance window и go-live TLS/secrets/backup requirements. Artifact проверяет наличие dist и отсутствие tracked diff, а не reproducible build или untracked files; запрещённый audit не читается.

## Проверки

- Focused configuration: 2 suites / 40 tests PASS.
- Release helper negative/runtime policy: 6 tests PASS.
- Full backend с disposable PostgreSQL: 58 suites / 674 tests PASS, без skipped integrations.
- Backend lint: 0 errors / 15 прежних warnings; build и typecheck PASS.
- Frontend build/typecheck PASS; source/config не менялись, frontend suite не запускался.
- Compose config quiet PASS, без вывода секретов. Script syntax и diff-check PASS.
- Backup/restore implementation не менялся; повторные backup safety suites не требуются. Реальный paired restore evidence остаётся в завершённом [Failure/Security checkpoint](./failure-security-checkpoint.md).

## Drill

Harness `scripts/tests/release-rollback-runtime.py` использует production mode, чистую временную PostgreSQL, явные synthetic settings, canonical temporary storage и минимальный inherited env; deployment .env не читается. CLI show/apply transaction all исполняются до старта приложения, затем gate подтверждает отсутствие pending migrations. Новый synthetic account получает fixture quota 1 MiB SQL provisioning (default quota нового пользователя 0), загружает поддерживаемый PNG; download сравнивается по точным bytes. Приложение останавливается, контролируемый bad process завершается exit42; возврат того же compiled artifact должен восстановить readiness и неизменные DB snapshot/download bytes. Свой container удаляется.

Это ограниченный same-artifact recovery drill. Не доказывает откат на предыдущую версию, frontend rollback, destructive schema rollback, production TLS или offsite restore. Изначальные harness ошибки TCP readiness race, chunk HTTP201 вместо фактического200, неподдерживаемый text MIME и отсутствие fixture quota исправлены по текущим контрактам; product behavior не менялся.

## Блокеры go-live и следующий блок

OVERALL_PRODUCTION_READINESS: NOT_READY. Внешний TLS/HTTPS redirect и exposure policy отсутствуют; nginx client IP forwarding и backend trust proxy требуют совместного проверенного контракта (сейчас лимитеры видят proxy IP). Production listener frontend ещё 80:80, health/metrics проксируются общим /api/. Не реализованы secret lifecycle/защищённая доставка, encrypted/offsite backup, утверждённые retention/RPO/RTO, backup alerts и scheduler с write barrier. Immutable image manifest — обязательный input будущего deployment, в реальный registry здесь не публиковался. DB restart/recovery policy и storage UID1001 provisioning требуют operator validation. Existing restore стартует app до migrations: внешний traffic barrier обязателен.

Сохранены access JWT до TTL после logout, process-local rate limits/metrics, post-commit unlink orphan risk, optional unused Redis. Phase 11–13, redesign/quota fix, Observability и Failure/Security COMPLETE сохранены. Общий Production Readiness остаётся INCOMPLETE. Новая Phase не создана.

Минимальный следующий owner-approved блок: TLS ingress + sanitised forwarding/trusted proxy + private metrics/health exposure и тест client-IP rate limiting. Автоматически не начинается.

Drill итог: PASS в указанных границах. Evidence `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-release-drill-_yzban9v/result.json`: no pending migrations, auth/upload/download, exit42, readiness recovery, unchanged DB+bytes, own container cleanup — true. PNG SHA256 `f3ec9e14b9c085b55edc96155f7bd26b6fdeda2462f02af4e0279d8319b365e3`. Temporary artifacts могут удаляться ОС; воспроизводимый harness сохранён.

## Итоговая классификация

INDEPENDENT_REVIEW: APPROVE. Reviewer проверил фактические diff, scripts, evidence и документы; найденная неоднозначность deployment cwd/.env исправлена одним bounded correction cycle. Неразрешённых MUST_FIX нет.

- PRODUCTION_TOPOLOGY_CONTRACT: PASS
- MIGRATION_RELEASE_POLICY: PASS
- CONFIG_VALIDATION_BASELINE: PASS
- RELEASE_GATE: PASS (детерминированный checklist + узкие helpers; не go-live допуск)
- ROLLBACK_DRILL: PASS (ограниченный same-artifact recovery)
- PRODUCTION_READINESS_ARCH_RELEASE_CHECKPOINT: PASS
- OVERALL_PRODUCTION_READINESS: NOT_READY


## Production Readiness — TLS / Proxy Boundary & Private Operational Exposure

Дата: 2026-09-30, Asia/Vladivostok. Следующий ненумерованный owner-approved checkpoint. Исходный HEAD `b82048a3229935b2ab2a634e2d6545574ade9ccd` и status (только запрещённый untracked audit) точно совпали. Audit не читался/не изменялся/не stage/commit. Architecture & Release Gate выше остаётся завершённым историческим checkpoint; его перечисление TLS-пробелов описывает состояние до этого блока. Phase 11–13, redesign/quota fix, Observability и Failure/Security COMPLETE сохранены.

### Исходная network gap matrix

| Проверка | До изменения | Проверенный результат |
|---|---|---|
| Public service | frontend `80:80`, без TLS ingress в repo | Отдельный production Compose: только ingress 80/443 |
| Backend reachability | Без host port, общая bridge network | Без host ports; отдельная internal frontend/backend network, ingress backend не видит |
| Forwarded authority | nginx только X-Real-IP, остальные headers не очищались | Каждый proxy перезаписывает XFF/XFP/XFH; точные socket peers |
| Express trust proxy / client IP | Default false, req.ip=frontend socket | Exact TRUSTED_PROXY_IP; нормализованный clientIp, safe fallback |
| IP rate limits | Один frontend IP для внешних клиентов | Независимые клиентские budgets; spoof rotation не обходит limit |
| Request logging | IP не логировался, request ID присутствовал | Privacy сохранена; correlation проходит nginx |
| Health/readiness/metrics | Общий nginx /api пропускал наружу, metrics Bearer | Оба nginx 404; internal readiness200, metrics401/401/200 |
| Security headers | Backend Helmet, HSTS даже на HTTP; frontend policy отсутствовала | TLS ingress владеет HSTS/CSP/headers, HTTP HSTS отсутствует |
| HTTP→HTTPS | Не реализовано | Canonical308, HTTPS с чужим Host421 |

Trust model и exposure подробно в [topology](./production-topology.md). Два перехода: ingress socket `172.29.0.10` → frontend; frontend socket `172.30.0.10` → backend. Backend доверяет только одному literal IP, default no trust; CIDR/true/hop count не используются. Невалидные multi-hop chains сбрасывают forwarded authority. Все IP limiter keys используют один helper, mapped IPv4 и IPv6 canonicalization. IP logging/high-cardinality labels не добавлены. Frontend same-origin API/share URLs; произвольный cross-origin VITE_API_URL production-контракт не поддерживает.

Ingress HTTPS задаёт HSTS без preload/includeSubDomains, nosniff, Referrer-Policy, DENY и CSP frame-ancestors none, минимальный Permissions-Policy. CSP допускает same-origin assets, fonts self+data, inline styles и blob previews. Health/readiness/metrics полностью приватны; отдельный public health route не заявляется. Metrics Bearer остаётся обязательным внутри сети; ingress не пропускает его даже с token. Public external uptime проверяет HTTPS `/`, probes используют private backend.

### Acceptance evidence

- Focused proxy/security/production config: 3 suites / 54 tests PASS. Direct/trusted/untrusted spoof, malformed/multi-hop headers, protocol/host, IPv4/IPv6 normalization, request ID и limiter key regressions покрыты.
- Full backend: 59 suites / 686 tests PASS, без skipped PostgreSQL integrations, отдельная disposable DB. Backend lint 0 errors / 15 прежних warnings; build и typecheck PASS. Два новых test-style warnings устранены, focused/lint/build повторены; production logic после full gate не менялась.
- Frontend production build/typecheck PASS; frontend source не менялся, unit suite не запускался. Chromium smoke проверил login/files/fonts без CSP/page errors.
- Original и standalone production Compose `config --quiet` PASS без вывода secrets. Frontend/ingress `nginx -t` PASS в runtime. Hostname positive/negative boundary tests, shell syntax, Python syntax и `git diff --check` PASS. Release helper tests 6/6 PASS; первоначальный sandbox запрет localhost listener устранён разрешённым тестовым запуском, продукт не менялся.
- `scripts/tests/tls-proxy-runtime.py`: PASS. Evidence canonical path `/private/var/folders/mg/0kv7ncvj7x33c4gkz6d9k47r0000gn/T/hc-tls-proxy-fl2pazjd/result.json`. HTTP308 с canonical Location и без HSTS; TLS root + headers; 12 JS/CSS/font assets200; private route aliases404; internal metrics401 без token/401 wrong/200 valid; readiness200; trusted client IP/proto/host; два client budgets независимы; direct/ingress spoof rotation ограничена; backend без published port.
- Actual production-mode backend через два nginx: register/login, files root, chunk upload, complete, download и anonymous share metadata/download PASS, bytes совпали. Request ID `tls-proxy-runtime-938475` сохранён. PNG SHA256 `f3ec9e14b9c085b55edc96155f7bd26b6fdeda2462f02af4e0279d8319b365e3`.

Harness собирает disposable dependencies по текущему lockfile и монтирует текущий compiled backend/dist и frontend/dist. Используется реальный nginx из локального frontend image; это не production image provenance gate. Для IP/protocol наблюдения отдельный test-only Express listener импортирует compiled production trust/limiter helpers; debug endpoint в продукт не добавлен. Browser использовал только подстановку PUBLIC_HOST=localhost в той же ingress template/CSP policy, чтобы не менять системный DNS. Канонический hostname и spoof assertions проверены до подстановки. Self-signed certificate проверяет TLS termination, не public CA provisioning/renewal. Temporary evidence может удаляться ОС; reproducible harness сохранён. Все собственные containers/networks/dependency image удалены; старые containers не изменялись.

### Review и ограниченные исправления

Независимый review product implementation выполнен runtime reviewer, не автором backend/ingress изменений. Его harness отдельно независимо проверен ingress reviewer; основной исполнитель проверил actual diff и result.json. Подтверждённые defects исправлялись по одному bounded cycle: multiline и uppercase canonical hostname validation; Vite data-font CSP; runbook first-start ingress и описание fonts. Harness prerequisites/metrics-token assertions/cleanup исправлены после независимого review. Начальные runtime fixture ошибки stale image dependency, weak synthetic credential, DNS alias/login status/browser mapping не считаются product evidence; финальный успешный consolidated run включает все проверки.

### Остаточные блокеры и границы

Secret lifecycle (доставка/доступ/rotation/revocation/recovery), encrypted/offsite paired backup, retention/RPO/RTO/scheduler/alerts, final production node recovery/acceptance и реальный previous-version rollback остаются незавершёнными. Public CA certificate/key provisioning и renewal, storage UID1001 и node recovery policy требуют operator validation. Maintenance barrier — отдельное обязательное условие перед стартом ingress, а не встроенная функция этого nginx config. Access JWT после logout до TTL, process-local limits/metrics и post-commit unlink orphan risk сохранены. HA/CDN/WAF, auth redesign, secret manager и backup implementation в scope не входили.

Следующий меньший owner-approved блок: Secret Lifecycle — способы доставки/доступа, rotation/revocation/recovery с проверяемым deployment контрактом. Backup Productionization зависит также от lifecycle encryption keys и включает больше recovery/retention задач. Следующий блок автоматически не начинается.

### Итоговая классификация TLS / proxy блока

- TRUST_PROXY: PASS
- CLIENT_IP_BEHIND_PROXY: PASS
- TLS_HTTPS_BOUNDARY: PASS (локальный self-signed TLS; public CA lifecycle не проверен)
- SECURE_HEADERS: PASS
- HEALTH_METRICS_PRIVATE_EXPOSURE: PASS
- RATE_LIMIT_PROXY_BEHAVIOR: PASS
- RUNTIME_PROXY_SMOKE: PASS
- INDEPENDENT_REVIEW: APPROVE
- PRODUCTION_READINESS_TLS_PROXY_CHECKPOINT: PASS
- OVERALL_PRODUCTION_READINESS: NOT_READY

Commits реализации TLS/proxy: `788ada5` — доверенный proxy/client IP; `9e96378` — production ingress/exposure/headers и runtime regressions. Документация checkpoint зафиксирована отдельным последующим commit.

## Production Readiness — Secret Lifecycle

Дата: 2026-09-30, Asia/Vladivostok. Owner-approved ненумерованный блок после TLS/Proxy Boundary. INITIAL_STATE: HEAD `42e1dce180bf6a736ea62c84f1aaa65c2b89355a`, status только запрещённый untracked audit. Audit не читался/не менялся/не stage/commit. Preview и старые containers не использовались. Исторические blockers предыдущих checkpoint описывают состояние на момент их завершения; актуальный status ниже.

[Инвентарь, generation contract, injection, rotation/rollback и leakage boundaries](./secret-lifecycle.md). Реальные secrets: access/refresh JWT, DB password/credential URL, optional metrics, optional unused Redis, external TLS private key; backup encryption key отсутствует. Генератор создаёт external-only exclusive0600 hex64 CSPRNG keys, без вывода значений. Production rejects missing/weak/default/predictable credentials и equal JWT keys до DB initialization, optional metrics empty означает disabled. Формат не доказывает entropy. Docker build contexts исключают env/private-key material. Environment injection сохраняет доступ Docker/root администраторам; secret-manager интеграция не добавлена. Optional production Redis использует private runtime config, пароль не в server/healthcheck argv.

### Gates и runtime evidence

- Focused backend config/auth/observability: 8 suites / 106 tests PASS; production-config отдельно39 PASS. Generator regression1 PASS (0600, independent hex64 values, no output, overwrite/repo/symlink refusal).
- Full backend59 suites / 702 tests PASS, без skipped PostgreSQL integrations; отдельная disposable DB. Lint0 errors / 15 прежних warnings; backend build/typecheck PASS. Frontend source не менялся, tests/build не запускались; изменён только exclusion file.
- Обе Compose `config --quiet` PASS, syntax Node/Python и `git diff --check` PASS. Найденная YAML quote ошибка Redis healthcheck исправлена одним bounded correction cycle, quiet gate повторён.
- Final compiled runtime smoke `scripts/tests/secret-lifecycle-runtime.py`: PASS. Sanitized evidence `/private/tmp/homecloud-secret-lifecycle-final-smoke.json`. Production missing/weak startup fails; initial readiness/access/metrics valid; после simultaneous JWT cutover old access403/refresh401, new login/refresh работает; refresh reuse + descendant revocation401. Access-only и refresh-only semantics выведены из unchanged source, отдельно runtime не проверялись.
- Metrics old401/new200. DB actual ALTER ROLE cutover: old TCP password rejected, new connection/readiness200; rollback: new TCP password rejected, old readiness/login restored. Это single-role maintenance downtime, не overlap/zero-downtime. Все generated secrets/passwords/access/refresh tokens отсутствуют в backend/PostgreSQL logs. Own disposable container/volume и sensitive temporary files удалены. Preview/user data/старые containers не трогались.
- Optional Redis command smoke PASS: `/private/tmp/homecloud-redis-secret-smoke.json`, authenticated PONG, unauthenticated отказ, config0600, no secret in logs/process argv, cleanup. Actual Compose command исполнен в disposable Redis после Compose dollar-unescape; full topology/Redis rotation не проверены.
- Это compiled backend localhost + isolated PostgreSQL; production image provenance, ingress/frontend/public deployment, TLS key runtime rotation и external custody recovery не доказаны. TLS mount/build exclusion contract проверен статически; CA provisioning/renewal остаётся отдельным блокером. Temporary evidence может удалить ОС; harness сохранён для воспроизведения.

### Independent review и status

Independent reviewer не автор изменений; inventory audit и фактический diff/generator/runtime/runbook reviewed. INDEPENDENT_REVIEW: APPROVE; reviewer не автор изменений, независимо воспроизвёл generator1/1, quiet production Compose и diff-check, проверил final runtime JSON и ограничения. Secret Lifecycle не объявляется go-live readiness. JWT модель — explicit maintenance invalidation без previous key window; rollback может вернуть допустимость старых unexpired/unrevoked JWT, при compromise запрещён. DB и metrics имеют executable rollback, previous revision custody обязан проверить оператор. Auth/session UX не менялись, vendor lock-in/new Phase/backup encryption/certificate renewal implementation отсутствуют.

OVERALL_PRODUCTION_READINESS: NOT_READY. Остались encrypted/offsite paired backup, retention/RPO/RTO/scheduler/alerts, final node recovery/acceptance и реальный previous-version rollback, public certificate/key provisioning/renewal, storage UID1001 и node recovery operator validation. Access JWT после logout до TTL, process-local limits/metrics и post-commit unlink orphan risk сохраняются. Следующий рекомендуемый блок — encrypted/offsite backup; автоматически не начинается.

Итоговые классификации: SECRET_INVENTORY PASS; PRODUCTION_SECRET_VALIDATION PASS; JWT_SECRET_ROTATION PASS (maintenance invalidation); DB_CREDENTIAL_ROTATION PASS; METRICS_TOKEN_ROTATION PASS; SECRET_LEAKAGE_REVIEW PASS в описанных границах; RUNTIME_ROTATION_SMOKE PASS; INDEPENDENT_REVIEW APPROVE; PRODUCTION_READINESS_SECRET_LIFECYCLE_CHECKPOINT PASS; OVERALL_PRODUCTION_READINESS NOT_READY. Compose negative missing/empty DB_PASSWORD/JWT_SECRET/JWT_REFRESH_SECRET — три отказа без secret values PASS.

## Production Readiness — Backup Productionization

Ненумерованный checkpoint после Secret Lifecycle. [Контракт/runbook](./backup-productionization.md). Legacy v1 backup/restore сохранены; production coordinator шифрует paired bundle стандартным age, атомарно публикует generation directories и проверяет offsite ciphertext size/hash/manifest до production success. External-only recipients/identities, rotation с custody старых ключей, common lock, write barrier acknowledgement, fail-closed wrong-key/corruption и отдельные retention warnings.

Аудит выявил plaintext-only/local-only baseline, отсутствие encryption key lifecycle, retention без full-set verification и sequential publication. Эти gaps закрыты production wrapper; legacy plaintext entry point не объявляется production success. Defaults: count7 и30days на обоих roots; minimum2 verified generations, replacement verified до retention, partial/invalid ignored с warning. Cleanup unlink не обещает secure erase; crash remnants требуют operator inspection.

Реальный disposable drill `scripts/tests/test-backup-production-drill.sh`: PASS. Evidence `/private/tmp/homecloud-backup-dr.c9ipSH/result.json`: local encrypted copy удалена перед recovery; restore получил encrypted artifact из isolated offsite filesystem target. Snapshot users1/folders2/files4/shares1/uploads1 identical; quota/completed uploads consistent; file SHA256 identical; readiness200; secret leakage scan PASS. Собственные containers/volumes и sensitive key/env/backup staging очищены. Retained sanitized evidence и reproducible harness сохранены; temporary evidence может удалить ОС.

Граница: fixture target находится на том же host и проверяет vendor-neutral mounted filesystem transport/recovery. Реальное физическое offsite размещение/mount failure domain, key custody emergency access, scheduler/alert delivery, полный объём и утверждённые RPO/RTO требуют operator validation перед release. Full encrypted backups — выбранный baseline; incremental engine не добавлен. Исторические RPO24h/RTO30min не доказаны этим малым drill; если full backups не укладываются в budgets, нужен owner decision, не scope expansion.

OVERALL_PRODUCTION_READINESS: NOT_READY. Public certificate/key provisioning/renewal, final recovery/acceptance, previous-version rollback и остальные release/operator checks остаются блокерами. Новая Phase не создана. Следующий меньший блок — public certificate lifecycle; автоматически не начинается.

Gates: production focused34PASS0FAIL; legacy backup safety27PASS0FAIL0SKIP; legacy restore safety15PASS0FAIL1SKIP (`--skip-integration`, legacy destructive integration заменена новым реальным disposable end-to-end drill). Прежние suites выполнены в copied project; global legacy cleanup отключён только в temporary test copy, cleanup ограничен dedicated Compose project. Bash/Python syntax и `git diff --check` PASS. Backend product code не менялся, повторный full backend/lint/build не требовался; current backend image построен для реального drill.

INDEPENDENT_REVIEW: APPROVE после одного bounded correction cycle: validation-only отделён от restore completion, same-second retention стабилен, fixed legacy failure reasons проверены. Основной исполнитель независимо повторил focused34 и real drill на окончательном коде. Security/privacy PASS в описанных границах; private identity/credentials не включены в commit, plaintext staging после штатного завершения отсутствует, offsite содержит только ciphertext+несекретный manifest.

BACKUP_ENCRYPTION_AT_REST: PASS; OFFSITE_REPLICATION: PASS (filesystem transport contract); RETENTION_ROTATION: PASS; BACKUP_FAILURE_SIGNALING: PASS; ENCRYPTED_OFFSITE_RESTORE: PASS; REAL_RESTORE_DRILL: PASS; PRODUCTION_READINESS_BACKUP_CHECKPOINT: PASS. Backup Productionization: COMPLETE в границах реализации/isolated qualification; физический production offsite и remaining operator acceptance не объявлены завершёнными.

## Public Certificate Lifecycle — 2026-10-01

Ненумерованный owner-approved checkpoint после Backup Productionization. Исходный HEAD `7c893e927ddc3711cf1b5b490937c34e52d6d9cd`; status только forbidden audit, не читался/не изменялся/не staged. [Контракт/recovery](./certificate-lifecycle.md).

| Исходный gap | Реализация |
|---|---|
| Flat PEM без activation | External generations0700/current atomic symlink; read-only whole-root mount; key0600 |
| Нет issuance/renewal | Certbot standalone bootstrap, HTTP01 webroot renew; DNS01 contract без provider automation |
| Нет validation/reload | SAN/time/trust/key match/permissions; nginx-test → graceful reload → served fingerprint; rollback/idempotence |
| HTTP308 блокировал HTTP01 | Token exception, symlink denial, missing404; остальной HTTP308; HSTS только HTTPS |
| Нет expiry/failure | JSON; check0/1/2/3 OK/warning/critical/invalid; thresholds30/7days; install/renew failure3 |
| Нет runtime | Native Linux daemon-side read-only bind; local certificates; simulated client result |

Gates: focused10/10 PASS, включая реальный expired2000–2001 fixture; hostname validation, syntax, quiet Compose и diff-check PASS. Backend/frontend source/build path не менялись: full backend/lint/build и frontend build не требовались. Legacy TLS smoke fixture адаптирована к current/ и key0600, полный auth/browser drill не повторялся.

Основной исполнитель повторил runtime: `/private/tmp/hc-cert-runtime-nbsg0jx_/result.json`. Initial install, served fingerprint rotation, expiry45→90days,17 successful health requests during reload, mismatched install, simulated Certbot failure, idempotence, invalid config rollback, HTTP01/redirect/HSTS, key600 PASS. Собственные containers/network/volume/operator image и sensitive fixtures удалены; старые containers не затрагивались.

Docker Desktop/macOS host bind smoke выявил stale symlink после atomic replacement; probe отверг activation. Mac shared bind не поддерживается. Итоговый harness использует native daemon Linux bind из disposable volume mountpoint в ingress read-only, operator volume RW. Это доказывает Linux bind механику, не конечный production host. Docker socket operator root-equivalent trust ограничен controlled CLI.

SECURITY_REVIEW APPROVE. Подтверждённые дефекты corrected bounded cycle: LibreSSL compatibility, current guard до unchanged, fullchain idempotence, served drift reconciliation, external-only state/key. Public CA success не заявляется: ACME protocol не упражнялся.

PUBLIC_CERT_ISSUANCE_CONTRACT: PASS; CERT_RUNTIME_PERMISSIONS: PASS; CERT_RENEWAL_WORKFLOW: PASS; CERT_SAFE_RELOAD: PASS; CERT_EXPIRY_MONITORING: PASS; HTTP01_HSTS_COMPATIBILITY: PASS; CERT_LIFECYCLE_RUNTIME_SMOKE: PASS; INDEPENDENT_REVIEW: APPROVE; PRODUCTION_READINESS_CERT_LIFECYCLE_CHECKPOINT: PASS; OVERALL_PRODUCTION_READINESS: NOT_READY.

Остались public CA/domain qualification, production Linux bind/scheduler/alerts, final recovery/acceptance, previous-version rollback, production offsite/key custody/full-volume RPO/RTO и remaining operator/release checks. Новая Phase не создана; предыдущие COMPLETE сохранены. Следующий рекомендуемый блок — final acceptance/go-live gate, автоматически не начинается.

Independent reviewer (не автор) проверил окончательный harness/diff/native-bind evidence, повторил focused10/10 и diff-check PASS. Public Certificate Lifecycle COMPLETE в ограниченных границах implementation/contract/mechanics.


## Final Production Acceptance / Go-Live Gate — 2026-10-01

Ненумерованная финальная кампания; новая Phase не создана. **OVERALL_PRODUCTION_READINESS: NOT_READY**. Fresh backend702/702 и frontend96/96, locked Docker builds, previous-backend compiled rollback и encrypted same-host offsite recovery PASS в явно ограниченных границах. Полный production deployment/TLS E2E остановлен occupied fixed proxy subnets; существующее preview не менялось. Public DNS/CA/target bind, operational scheduler/alert delivery, independent offsite/key custody/approved measured budgets и полный previous backend/frontend immutable-pair/operator acceptance остаются BLOCKING. Исправлен подтверждённый raw-URI/token logging дефект обоих nginx; raw proxy error diagnostics исключены, status/time и backend безопасные logs сохранены. [Матрица, raw evidence, классификации и operator checklist](./final-production-acceptance.md). Предыдущие COMPLETE checkpoints сохранены; запуск не разрешён, следующий workstream автоматически не начинается.

Independent final review: **NO_GO** по raw evidence. Дополнительно unresolved external-only secret input path legacy backup/restore versus checkout .env; workaround не применён. Dependency audit finding/exposure см. final acceptance.


## External-only backup/restore config — 2026-10-01

Ненумерованная bounded remediation после React Router; исходный HEAD `647aa7b949698f9b84feee3ce5134cb2a7b542de`, status только запрещённый untracked audit. Audit не читался/не изменялся; чужие containers не затрагивались. Shared loader и [контракт](./backup-productionization.md#единый-внешний-config-для-recovery-helpers): обязательный external absolute env file либо явно выбранный direct environment; exports выше файла, missing/unsafe config fail-closed, no shell execution, no implicit checkout dotenv. DB identifiers проверяются до SQL; Compose file paths абсолютные, project явный, nested calls с `--env-file /dev/null`; reconcile принимает тот же config.

Final disposable smoke evidence: `/private/tmp/homecloud-backup-dr.ldiKuX/result.json`; harness `scripts/tests/test-backup-production-drill.sh`. Actual checkout helpers запускались из disposable CWD, через `env -i` только PATH/HOME/HOMECLOUD_ENV_FILE; repo `.env` не открывался. Custom DB `hc_dr_db`/user `hc_dr_user`; encrypted/offsite-capable generation, удаление local encrypted copy, fetch/decrypt restore после DB/storage mutation, reconciliation и readiness200 PASS. Rows users1/folders2/files4/shares1/uploads1 identical, SHA256 bytes identical, quota/completed upload consistent. Secrets из external config/age identity отсутствуют в captured logs; собственные resources/sensitive inputs очищены. Transport — same-host filesystem fixture, физическая offsite независимость не доказана.

Fresh gates: external contract11/11, production backup34/34, backup safety27/27, restore validation15 PASS/0 FAIL/1 integration SKIP (заменён реальным paired drill выше). Python AST4/4, Bash syntax9/9, local docs references и diff-check PASS. Backend/frontend suites не запускались: app sources не изменены. Независимый review финальных diff/docs/evidence: APPROVE; предварительный evidence gap исправлен повтором с чистым окружением.

CHECKOUT_ENV_DEPENDENCY: RESOLVED. EXTERNAL_CONFIG_CONTRACT: PASS. ARBITRARY_CWD: PASS. SECRET_LEAKAGE: PASS. REAL_BACKUP_RESTORE_EXTERNAL_CONFIG_SMOKE: PASS. PRODUCTION_BLOCKER_EXTERNAL_BACKUP_CONFIG: RESOLVED. Общий **NOT_READY / NO_GO**: real Linux/DNS/public CA/native bind, scheduler/delivered alerts, independent offsite/key custody/measured budgets и immutable release/previous-pair rollback/operator acceptance остаются открыты. Новая Phase не создана; следующая задача автоматически не запущена.
