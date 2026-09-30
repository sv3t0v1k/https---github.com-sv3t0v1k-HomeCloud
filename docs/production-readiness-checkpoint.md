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
