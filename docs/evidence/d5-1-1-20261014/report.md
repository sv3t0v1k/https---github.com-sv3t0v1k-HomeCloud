# D5.1.1 — Security Remediation, 2026-10-14

Статус: **HIGH_CRITICAL_REMEDIATED / REVIEWED / RELEASE_BLOCKED**. Production **NO_GO**. Работа в отдельном Mac worktree `этап/d5-1-ci`, существующий [draft PR №1](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/1). Baseline: `e0c5e00655067b052d2e105e6a27e939eb22eeff`.

## Фактический аудит

Числа npm audit — записи уязвимых пакетов, включая inherited/meta findings. Это не количество независимых CVE. До/после использован полный tree, production subset посчитан отдельно. Ошибки registry не приняты за чистый audit.

| Tree | Всего до → после | Critical до → после | High до → после | Moderate до → после | Low до → после |
|---|---|---|---|---|---|
| Backend full | 55 → 30 | 2 → 0 | 13 → 0 | 36 → 30 | 4 → 0 |
| Backend production | 17 → 9 | 1 → 0 | 5 → 0 | 10 → 9 | 1 → 0 |
| Frontend full | 12 → 0 | 2 → 0 | 7 → 0 | 3 → 0 | 0 → 0 |
| Frontend production | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

Backend: 40 уникальных GHSA → 5 (35 устранены). Frontend: 9 → 0; часть GHSA пересекается с backend, суммы нельзя выдавать за независимые уязвимости. Все **55 backend и 12 frontend записи** с исходными/новыми версиями, прямыми GHSA, inherited причинами, доступными npm suggestions и lock dependency paths: [backend register](./backend-register.md), [frontend register](./frontend-register.md), [машинный реестр](./audit-register.json). Raw snapshots: [backend before](./backend-audit-before.json), [after](./backend-audit-after.json), [frontend before](./frontend-audit-before.json), [after](./frontend-audit-after.json).

## Исправления и совместимость

| Уязвимый пакет/цепочка | Решение | Фактический результат |
|---|---|---|
| Nest → Multer1.4.5-lts.2 | exact2.4.0 и scoped Nest override на тот же direct dependency | High/low multipart advisories устранены; общий Multer instance |
| Sharp0.33.5 / native codecs | exact0.35.5; integrity-locked native binaries | High findings устранены; libvips8.18.7/librsvg2.63.2 |
| Nest config → Lodash4.17.21 | scoped4.18.1; deprecated4.18.0 исключён | High/moderate устранены |
| proxy-addr2.0.7 | patch2.0.8 | Critical CIDR spoofing устранён |
| Handlebars4.7.9 | patch4.7.10 | Critical/moderate устранены |
| CLI10 / Angular17 / chokidar3 → braces3 | dev-only Nest CLI11.0.18 | Удалена уязвимая compiler chain; runtime Nest10 сохранён |
| glob / picomatch / brace-expansion / tmp / ajv / fast-uri / webpack | совместимые lock updates либо исправленная CLI chain | Full audit больше не содержит этих findings |
| Nest platform → Express/body-parser → qs | scoped Express4.22.3/body-parser1.20.8; все qs6.16.0 | Low parser и moderate qs устранены без runtime framework major |
| Vitest3.2.7 → tinypool / mocker | exact Vitest4.1.11 | Critical tinypool удалён из graph, mocker patched |
| Tailwind3 → braces / selector-parser | удалён неиспользуемый compiler; сохранены обычный CSS reset и `.sr-only` | Уязвимая build chain удалена; авторские стили сохранены |
| Frontend brace-expansion / source-map-js | patches1.1.21/5.0.12 и1.2.2 | Остальные frontend findings устранены |

Major updates инструментов ограничены двумя необходимыми изменениями: CLI11 (dev-only, вместо более широкого npm suggestion CLI12) и Vitest4 (patched release, прежняя ветка3 не закрывает findings). [Vitest migration](https://v4.vitest.dev/guide/migration.html), [Nest CLI11.0.18](https://github.com/nestjs/nest-cli/releases/tag/11.0.18). Runtime Multer1→2 — отдельный необходимый major для закрытия multipart advisories; его транспортные границы проверены helper и регрессиями. Никаких mass `audit fix --force`, framework migration, отключения gate или broad overrides. Sharp0.x смена minor также требует регрессии native codecs — она выполнена локально, production musl проверяется отдельным CI job.

Multer2.4 самостоятельно делает fileSize/parts inclusive. Старое HomeCloud `N+1` добавляло лишний разрешённый байт, parts3 разрешал лишнюю часть. Getter теперь возвращает N, production parts2. Проверки принимают N и отвергают N+1/третью часть. Проверены crafted multipart field names и synthetic callback cleanup после abort; физическое удаление на target этим helper не квалифицировано.

Tailwind utilities в runtime33 TS/TSX files: только `.sr-only` (6 мест);149 class tokens проверены AST и manual review dynamic attrs/Icon spreads. Сохранены preflight/reset и авторский index.css; убраны14 неиспользуемых utility selectors и5 container media rules из прежнего compiler output. [279-node CSS parity](./parity.json) и [четыре browser probes](./browser-parity.json) PASS: Chromium/WebKit,1440×900/390×844, focused controls/computed styles и before/after PNG bytes совпадают. MIT notice включён в исходный reset и minified production CSS. Это synthetic DOM с настоящими CSS/fonts, не полный application E2E/Firefox/старые браузеры.

## Оставшиеся уязвимости — не исключены из audit

| Leaf / путь | GHSA / severity | Минимальное исправление и причина отсрочки |
|---|---|---|
| direct `@nestjs/core10.4.22` | [SSE injection](https://github.com/advisories/GHSA-36xv-jgw5-4q75), moderate | ≥11.1.18; согласованный runtime framework migration, не принудительный override |
| direct `file-type19.6.0`; Nest common →20.4.1 | [ASF infinite loop](https://github.com/advisories/GHSA-5v7r-6r5c-r473); Nest20 дополнительно [ZIP bomb](https://github.com/advisories/GHSA-j47w-4g3g-c36v), moderate | ≥21.3.2 для обоих; требует ESM/Node/runtime/Nest compatibility проверки |
| Jest → load-nyc-config → js-yaml3 → argparse1 → `sprintf-js1.0.3` | [format DoS](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), moderate | опубликованного patch нет; убрать цепочку после отдельной оценки parent updates; npm suggestion downgrade ts-jest27 не принят |
| Nest TypeORM10.0.2 → exact `uuid9.0.1` | [buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq), moderate | ≥11.1.1; direct uuid уже11.1.1, nested требует parent update/cross-major compatibility; override9→11 не добавлен |

30 full/9 production записей распространяются от этих4 leaves/5 GHSA. Moderate — severity npm; CVSS uuid7.5 не скрывается и не переименовывается. Отдельный security gate по утверждённой политике блокирует high/critical и неисправный audit ответ, но PASS этого gate не означает отсутствие moderate или Production GO.

Exposure: `fileTypeFromBuffer` вызывается для untrusted upload headers до4100bytes в uploads.service/ssd-mime. ASF payload может быть55bytes: размер header и try/catch не доказывают защиту от event-loop hang. Это **реальный открытый release risk**, нужен отдельный fix/explicit risk decision; exploit runtime не запускался. SSE `@Sse`/SseStream вызовов в backend source не найдено, условие user-controlled id/type не доказано, пакет всё равно остаётся vulnerable. UUID advisory относится к v3/v5/v6 с custom buffer/offset; путь Nested Nest TypeORM сохранён, отсутствие достижимого использования этих APIs не принято за исправление. sprintf-js находится в dev tooling, не production subset; выполнение attacker-controlled format strings не квалифицировано.

## Проверки и независимое review

Локально после финальных patches: clean backend npm ci PASS, build PASS,61 targeted tests PASS; compiled dependency helper7/7 PASS (HTTP multipart bounds/crafted fields, synthetic abort, Sharp JPEG/PNG, proxy CIDR). Независимый reviewer:44 targeted PASS, helper7PASS/actionlintPASS; frontend full278PASS/lint/buildPASS и279-node CSS parity. [Security review — APPROVE](./independent-review.md), без P0/P1 findings для изменения; residual vulnerabilities остаются.

Root: actionlint PASS; release negative16, preflight76, startup43 PASS;4 Compose config merges PASS, только synthetic env, без daemon mutations. Первый root preflight запуск без HOMECLOUD_TEST_ROOT ошибочно искал `/opt/homecloud` и завершился setup error; с явным worktree root76PASS. Это correction harness invocation, не изменение safety gate. Mac native Linux-only targeted failures сохранены в истории; полный Linux/PostgreSQL suite будет оценён только по свежему CI, прежний D5.1 baseline1148PASS не используется как proof новых dependency versions.

CI добавляет backend helper и Linux/amd64 backend/frontend image builds (`push:false`, `load:true`, read-only permissions). Backend ephemeral image smoke: UID1001, musl native addon load и реальный JPEG→PNG decoder. Без mounts/DB/app startup/network внутри smoke; OS/native physical storage qualification остаётся открытой. GHCR login/write отсутствуют в PR CI.

## Блокеры релиза и D5.2

1. High/critical remediation и свежий GitHub CI PASS на source SHA ниже; D5.1 release acceptance остаётся открытым, COMPLETE не установлен.
2. Остаточные moderate, прежде всего untrusted ASF parsing, требуют отдельной remediation/risk acceptance. Node20 EOL и OS/base image CVE scan/qualification не решены этим изменением.
3. GitHub main protection/required checks и tag protection ещё не квалифицированы; approved tag/SHA отсутствует.
4. GHCR publish, remote digest/provenance reconciliation и release flow не выполнялись и не считаются PASS.
5. D5.2 **NOT_STARTED**; deployment/target preflight/backup/restore/health/rollback остаются отдельными gates. Новый tag/release/merge/deployment не разрешены и не выполнялись.

Исходный Mac main b5c954f, D4/server-reported48fb9c0 и его parent e655167 сохраняются. Сервер не опрашивался, мини-ПК/данные/Compose/Docker daemon не менялись. Запрещённый audit файл и посторонние untracked не читались и не изменялись.

## Реальный GitHub CI — PASS

[PR CI38482225216](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38482225216) и [push CI38482221084](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38482221084) завершены **SUCCESS**, все9jobs PASS, source head `2f671f1fb86b60c4a8c7b0d58a5f51f322b4cc97`. [Raw run/job statuses и test summary](./github-ci.json). PR реально checkout GitHub merge ref `c8c2bc69543867f5e1fb8f95cd88b491c832deb0`; push CI — exact source head. Source, tag и deployment не смешиваются.

Backend: **1148/1148 tests,79/79 suites,0FAIL,0SKIP**,12PostgreSQL suites/154tests; native compile, lint (0errors/15existing warnings), compiled file-type/build и7/7 dependency runtime PASS. Frontend:278/278tests в22files, lint/build PASS. Configuration:4Compose merges,76preflight,43startup;16release negative PASS. Fresh CI audit: backend30moderate, frontend0, high/critical0. Secrets scan PASS.

Обе Linux/amd64 images собраны; musl secure-fs addon load и Sharp JPEG decoder PASS. Это локальные images disposable GitHub runner, **GHCR publish и release digest/provenance NOT_RUN**. Нативный smoke не заменяет target qualification. Runner сообщает deprecation pinned Actions Node20 runtime и принудительный runtimeNode24; app/test/buildNode20 EOL сохраняется отдельным blocker.

Последующий коммит содержит только этот evidence/roadmap; его PR/push CI оценивается отдельно по GitHub checks. Raw evidence выше относится к указанному source head и не выдаётся за результат ещё не запущенного SHA.

## Нестабильное измерение Retry-After в CI

На documentation head864c55c [PR CI38482861251](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38482861251) PASS, [push CI38482857360](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38482857360) FAIL: frontend277PASS/1FAIL, реальный Date.now интервал999ms против>=1000ms. Lint/build этого frontend job не выполнялись после test failure; общий gateFAIL не скрыт. [Raw incident](./github-ci-timing-incident.json).

Точечное изменение только frontend/src/files/ssdUpload.test.ts: fake Date/timers и window restub, на999ms нет следующего admission/session; на1000ms следующий запрос, оба интервалаexact1000. SHA256 реальных байтов, одна session/publication сохранены. finally dispose/clear/restore timers/window. Production source/Retry-After scheduling не изменены, threshold не снижен. Причина конкретного1ms отклонения не доказана; [Node timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args) не гарантируют точный момент callback. Проверяется model scheduling contract, не абсолютная точность реальных часов.

Одна локальная implementation iteration: SSD13/13, полныйfrontend278/278/22files, lint/build PASS. Независимое read-only review APPROVE и13/13SSD PASS; findings нет. Следующий source HEAD с этим test fix запускает полный PR/push CI; его фактический итог проверяется отдельно в PR checks и итоговом task evidence, а предыдущий PASS не подменяет новый запуск. Новых dependencies/business changes/gate exceptions нет.
