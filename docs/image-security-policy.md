# Image Security Policy — D5.1.5

Дата: 2026-10-19. **BLOCKED; Production NO_GO.** Владелец одобрил отдельную границу риска для GitHub-hosted runner. Ни одного индивидуального CVE disposition/исключения не принято.

Локальный CI Reset v1 от 2026-10-25 добавляет отдельный `pr-fast-backend` job.
Его фактический pinned container и установленные зависимости получают собственные
обязательные rootfs/component/tooling reports со строгим HIGH/CRITICAL gate.
Теперь PR требует 13 execution environments, `main`/`release` — 17. Это
расширение coverage, не исключение или изменение порогов. GitHub run ещё не
подтвердил новую схему; Production NO_GO сохраняется.

## Действующая блокировка

Общий gate требует все существующие функциональные/dependency/secret проверки и полную квалификацию следующих контуров:

| Контур | Обязательная проверка | Блокировка |
|---|---|---|
| Production runtime | Exact linux/amd64 backend, frontend, PostgreSQL, ingress; OCI archive/manifest/config/source/scan binding; smoke того же app artifact | Любой HIGH/CRITICAL или неполное evidence |
| Build execution | Фактические deps/builder stages обеих сборок и exact BuildKit worker | Любой HIGH/CRITICAL; rebuilt stage export не считается исходным окружением |
| Pinned CI containers | Полный rootfs фактических `backend` и `pr-fast-backend` job containers, inventories, tools, npm и application dependencies каждого job | Любой HIGH/CRITICAL или неполное evidence |
| GitHub-hosted runner platform | Полный host rootfs scan, package inventory, свежая vulnerability DB, GitHub-hosted identity (`ImageOS`, `ImageVersion`, OS/arch), source/run/job binding | Принимается только `ImageOS=ubuntu24` вместе с фактическим Ubuntu 24.04 rootfs. `ImageVersion` проверяется по формату и сохраняется для аудита, но этот код не подтверждает свежесть или lifecycle-статус образа. Неполное/просроченное scan evidence и неизвестная идентичность блокируют. Полные host findings остаются в raw report и относятся к provider-platform risk; они не объявляются исправленными и не считаются findings HomeCloud images |
| Release publisher tools and apt closure | Exact `docker`, `gh`, `skopeo` binaries; for `skopeo`, baseline/final dpkg inventory, recursive installed `Depends`/`Pre-Depends` closure (including versioned `Provides` and Debian `Multi-Arch` qualifiers) plus ELF loader closure, native architecture, exact package versions, `apt-get update --error-on=any` success log hash, apt source/config/index/trust-keyring hashes, downloaded `.deb` SHA-256, package-owned file hashes, runner/source/run binding; APT's built-in authenticated-index verification is a trust premise from the identified GitHub-hosted Ubuntu image, not an independent signature verifier | Missing/unknown dependency, unsupported dependency syntax or `Provides` expression, insecure apt source/config override, absent update log/keyring/index/source/hash/file/report evidence, or any HIGH/CRITICAL in the exact closure blocks before GHCR login/write. Provider host findings outside this closure remain platform evidence |
| Raw upstream bases | Четыре pinned базовых образа с полным исходным findings report | Обязательная диагностика; неправильный target, stale DB или ошибка скана блокируют CI; severity оценивается в фактических обязательных контурах выше |

Medium/low/unknown сохраняются в evidence для triage. Unfixed и dev dependencies включены. HomeCloud runtime/build/support images, pinned job containers, application dependencies и executed tools сохраняют строгую блокировку HIGH/CRITICAL без исключений. Для стандартного GitHub-hosted Ubuntu 24.04 rootfs не применяется severity-wide подавление: полный список host findings сохраняется и относится к отдельной provider-managed границе. Невалидная идентичность runner, пропуск пакетов, ошибка сканирования или stale evidence остаются блокирующими. PR jobs не получают production secrets, write token или private-network access; публикация допускается только отдельным доверенным workflow.

Эта граница опирается на ephemeral GitHub-hosted runner и отсутствие production secrets/private-network access в PR workflow; она не утверждает, что host findings безопасны или неэксплуатируемы. Release workflow изолирован от PR workflow и его write permission ограничен отдельным job публикации. Владелец должен отслеживать GitHub runner-image/security notices и lifecycle статусы перед выпуском и при инцидентах провайдера: проверка версии ImageVersion в коде служит идентификации, а не независимому подтверждению патч-SLA. При невозможности установить ожидаемую платформу или получить complete scan gate остаётся BLOCKED.

Публикационный `skopeo` проверяется отдельно от provider rootfs: apt-closure связывает точный установленный dependency graph и ELF libraries с исходной/final dpkg inventory, Ubuntu runner image identity либо подписанными apt indices и SHA-256 скачанных package archives и установленных файлов. Полный rootfs Trivy report остаётся неизменным platform evidence; findings пакетов closure оцениваются строгим HIGH/CRITICAL gate. Evidence привязано к source commit, run/attempt, `ImageOS`/`ImageVersion`, closure hash и rootfs report hash. Проверка в release workflow выполняется до GHCR login.

`skopeo` apt closure квалифицируется в release job `images`: проверяются фактически установленные пакет и ELF closure, полный rootfs report и зарегистрированные publication tools; неполное evidence или HIGH/CRITICAL блокирует до GHCR login/write. Эта проверка выполняется в том же job и перед обеими операциями входа в registry. Отдельный PR `skopeo-qualification` удалён: это был отдельный ephemeral runner и его PASS не удостоверял бинарники в `image-build`/`support-images`, где `skopeo` тоже устанавливается из apt. Эти jobs работают без registry-write credentials; их OCI outputs проверяются существующими exact digest, manifest/config, scan, source и provenance bindings. Локальная смена job-графа не заявляет per-job apt-closure qualification; при требовании policy доказать closure каждого такого экземпляра понадобится отдельная работа. Release проверяет собственную фактически установленную publisher closure до login и не наследует PR PASS. Изменённый workflow ещё не подтверждён GitHub run.

PR CI теперь пропускает четыре прямых диагностических скана upstream bases (`node`, `nginx`, `postgres`, `node-ci`). Исключаются только эти base reports и четыре соответствующие base environment records; production/runtime/support image scans, application/dependency/secret checks и обязательные bindings остаются в PR gate. Recovery workflow не менялся. Прямой push в `main` и reusable CI, вызванный release workflow, запускают все четыре скана. Release явно передаёт обязательный `qualification_profile: release`; профиль не выводится из `github.event_name`, поскольку reusable workflow наследует контекст caller. `policy-coverage` маркирует результаты профилем: `pull-request`, `main` или `release`; неизвестный профиль блокируется. PR evidence profile v2 не принимается release validator: публикация требует профиль `release`, все 17 environments, все четыре raw base reports и все прежние runtime/build evidence. Ошибка или неожиданный skip блокирует `gate`; разрешён только `base-image-scan` skip в PR-профиле. Эта оптимизация локально проверяется, но hosted execution не подтверждён. Production остаётся NO_GO.

Backend/frontend квалифицируются из однократно собранных OCI archives; будущая публикация должна использовать их же без пересборки и пройти отдельную строгую проверку publication environment. Профили `main` и `release` сохраняют source/run/attempt, четыре runtime, пять build artifacts, семнадцать execution environments и четыре raw diagnostics. PR-профиль требует все runtime/build и остальные тринадцать environments, но не включает четыре upstream-base diagnostics. Release validator принимает только release-профиль. Collector/final gate проверяют evidence и не производят исполняемый release artifact. Полный список и ограничения: [реализация](./evidence/d5-1-5-policy-implementation-20261015.md).

Формат closure evidence — `homecloud-skopeo-apt-closure-v2`: он привязывает native Debian architecture и сохраняет `Provides`/`Multi-Arch` из dpkg inventory. Resolver учитывает установленные provider-пакеты и версии virtual Provides, применяет архитектурные qualifiers, а неизвестные/неподдерживаемые выражения по-прежнему блокируют. Это уточнение учёта closure, не изменение severity gate или disposition findings.

## Candidate check 2026-10-19 — BLOCKED

Production ingress remains pinned to NGINX `1.30.6-alpine` amd64 digest `sha256:959ae6b898852db82e5b29b929388e59914f42be0a8f4d44c89a4c1f53b49208`. The official NGINX `1.31.7-alpine3.24` candidate at amd64 digest `sha256:138af827713b7671ef4ee2deea73bc6f08ae265130ce350307e3e7b52cd4b51b` is still reported with `expat 2.8.5-r0`, below the upstream-fixed Alpine package `2.9.0-r0`; it is not a replacement. The official Debian-based `1.30.6-trixie` candidate at amd64 digest `sha256:ae4728846c1b66db51449372bd4230027d10dc951dad9ea0c05ca75ccdccfab7` is also below its fixed Expat package version. These are registry metadata checks, not HomeCloud Trivy scan results. No image pin changed and no candidate scan was run because neither official candidate met the fixed-version prerequisite. Sources: [NGINX 1.31.7 Alpine image](https://hub.docker.com/layers/library/nginx/1.31.7-alpine3.24/images/sha256-138af827713b7671ef4ee2deea73bc6f08ae265130ce350307e3e7b52cd4b51b), [Alpine libexpat 2.9.0-r0](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/libexpat), [Debian CVE tracker](https://security-tracker.debian.org/tracker/CVE-2026-77214).

The official esbuild `0.28.2` source pins Go `1.26.5`; the recorded Go CVE fix floor is `1.26.9`. Vite `6.4.3` requires esbuild `^0.25.0`, so `0.28.2` is incompatible with the current Vite line; moving to Vite 8 would be a major migration and would not fix the embedded toolchain finding. The npm tarball and Linux binary were not obtained for byte-level verification: two registry attempts ended without package data, with the direct registry request failing DNS resolution. Therefore no actual-binary PASS is claimed. Sources: [esbuild go.version](https://raw.githubusercontent.com/evanw/esbuild/v0.28.2/go.version), [Vite 6.4.3 package manifest](https://raw.githubusercontent.com/vitejs/vite/v6.4.3/packages/vite/package.json), [Go vulnerability record 1](https://pkg.go.dev/vuln/GO-2026-6609), [Go vulnerability record 2](https://pkg.go.dev/vuln/GO-2026-6611).

PostgreSQL/ingress закреплены точными amd64 child digests в production override. Это фиксация идентичности, а не устранение CVE. Redis выключен opt-in profile и не квалифицирован для включения. Mac Docker, mini-PC и реальные данные не затрагиваются.

## Историческая квалификация D5.1.4

Следующие данные сохранены как исходное evidence D5.1.4; упоминания прежнего raw-base gate и coverage gaps описывают прежнее состояние. Они не заменяют новые фактические сканы и не являются CVE dispositions. Бинарная квалификация D5.1.5 хранится отдельно в docs/evidence/d5-1-5-20261014/.

## Проверенные факты

Исходный HEAD `745bfebcd422ab8be39d29d58c977458f5fe44da`, PR №1 draft.
[PR CI D5.1.3](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38564105901)
подтверждён через GitHub; свежий запуск этой задачи фиксируется отдельно после публикации diff.
Не следует использовать `outputs/d5-release-readiness-20261014`: это старые scans D5.1.2.

| D5.1.3 scan | Critical | High | Medium |
|---|---:|---:|---:|
| Backend runtime | 0 | 0 | 2 |
| Frontend runtime | 0 | 0 | 2 |
| Node Alpine base | 0 | 8 | 13 |
| nginx Alpine base | 0 | 3 | 3 |
| PostgreSQL Alpine base | 1 | 24 | 28 |
| CI Node Bookworm base | 4 | 60 | 113 |

Полный перечень HIGH/CRITICAL по package/CVE/installed/fixed, исходные counts всех
severities и SHA256 каждого сохранённого JSON: [findings.json](./evidence/d5-1-4-20261014/findings.json).
Числа означают package findings: например, пять util-linux CVE повторяются в восьми
библиотеках/пакетах; 64 findings CI не означают 64 уникальные CVE.

Прочитаны только manifest/config metadata Docker Hub; Docker daemon не использовался.
Текущие теги Node24.21.0-alpine, nginx1.30.5-alpine, postgres16-alpine и
Node24.21.0-bookworm-slim всё ещё разрешаются в прежние digests. Индексы и
linux/amd64 children совпадают с `images.platforms.json`; CI Node уже pinned прямо
на amd64 child. Исходные manifests сохранены в evidence. Обновление тега не даст fix.

Backend удаляет bundled npm/npx в runner: все восемь high Node относятся к их
package paths. Они остаются в build/deps/CI. Frontend обновляет libexpat
2.8.4-r0 → 2.8.5-r0 (CVE-2026-93990), pcre2 10.48-r0 → 10.49-r0
(CVE-2026-103111), tiff 4.7.1-r0 → 4.7.2-r0 (CVE-2026-4775).
Следовательно runtime/base delta объяснена изменением состава итогового filesystem.

## PostgreSQL: конкретный critical и 24 high

PG_VERSION=16.15, gosu=1.19, Go stdlib=v1.24.6. Все 25 HIGH/CRITICAL относятся к
`/usr/local/bin/gosu`, ни одна запись не относится к PostgreSQL server или Alpine OS.
Нулевой результат OS scan не доказывает полноту проверки PostgreSQL, собранного из source.
PG16.15 сверён с [официальными security fixes](https://www.postgresql.org/support/security/).

Critical [CVE-2025-68121](https://pkg.go.dev/vuln/GO-2026-4337) затрагивает TLS
session resumption при изменении CA config; fixed Go1.24.13/1.25.7/1.26.0-rc.3.
Исходники gosu1.19 и его user dependency выполняют чтение local passwd/group,
setgroups/setgid/setuid и exec, не TLS handshake. Это доказательное предположение
о недостижимости, не одобренное исключение и не анализ точного бинарного call graph.

Все 24 high, их affected APIs, installed/fixed versions и ссылки на официальную
Go OSV разобраны отдельно в [PostgreSQL qualification](./evidence/d5-1-4-20261014/postgres-qualification.md).
В частности CVE-2026-39836 Windows-only, CVE-2026-39822 относится к os.Root APIs,
которые не найдены в проверенных исходниках. Нельзя автоматически удалить все
findings stdlib на основании этих примеров.

Рабочие варианты для последующего решения: точный binary govulncheck без исключений
и индивидуальная оценка CVE либо проверенная пересборка только gosu с patched Go
при неизменном PG16/entrypoint. Нельзя подменять gosu su-exec без UID/GID/group и
startup qualification. Ни один вариант пока не внедрён; raw base gate остаётся красным.

## Поддерживаемые альтернативы: ограниченная проверка

Сделаны ровно два новых remote scans новых кандидатов, не повторные scans прежних баз.
Один запуск Node до анализа остановился из-за shared-cache lock; повторён последовательно.
Сканер0.75.0, linux/amd64, unfixed включены, config/ignorefile=/dev/null. DB schema2,
UpdatedAt=2026-10-14T07:11:52Z, NextUpdate=2026-10-15T07:11:52Z, metadata сохранены.

| Кандидат | Index digest | Результат | Вывод |
|---|---|---|---|
| postgres16.15-bookworm | `sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4` | 4C/87H/199M | Хуже; тот же gosu. Не принят |
| node24.21.0-trixie-slim | `sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66` | 0C/51H/70M | Меньше findings, но не чистый; смена distro не оправдана этим результатом. Не принят |

Переход PG Alpine → Debian потребует disposable restore/migrations и проверки
locale/collation/ICU, extensions ABI, UID и permissions. Совпадение major16 само
по себе этого не доказывает. Реальные PGDATA, volumes и миграции не затронуты.

## Node/nginx/CI: исправимость и ограничения

Полная [квалификация баз](./evidence/d5-1-4-20261014/base-qualification.md) содержит
версии и первичные ссылки. Обновление npm до12.2.0 не гарантирует устранение его
bundled findings: upstream lock всё ещё содержит brace-expansion5.0.9/undici6.28.0.
Для CVE-2026-93748 нет подтверждённого поддерживаемого fix;
[upstream оспаривает finding](https://github.com/kornelski/http-cache-semantics/issues/56).
Custom npm distribution с ручной подменой bundled deps не создан.

Адресная правка CI устанавливает и проверяет `perl-base=5.36.0-7+deb12u4`:
CVE-2026-13221/42496/8376 (3C), CVE-2026-42497/48962/57432/57433 (4H).
[Debian фиксирует эту версию](https://security-tracker.debian.org/tracker/CVE-2026-13221).
Реальная установка подтверждается финальным CI и package inventory. Это исправление
CI execution environment, а не изменение исходного immutable base: его 4C/60H
не вычитаются и не объявляются новым scan result.

Индивидуальные кандидаты на not-affected, пока ACCEPTANCE_PENDING:
CVE-2023-45853 — Debian отмечает отсутствие сборки уязвимого contrib/minizip;
CVE-2026-8376 — 32-bit trigger; CVE-2026-16742 — systemd-homed.
Требуются exact-image binary/config evidence; ни одна запись не подавлена.

## Свежесть и соответствие target

JSON D5.1.3 содержит CreatedAt, Trivy0.75.0, amd64 config и identity, но не DB metadata.
Лог PostgreSQL job показывает загрузку DB из mirror.gcr.io в12:28:58Z; это
подтверждает download, но не UpdatedAt самой DB. Старые local metadata нельзя
выдавать за metadata той CI job. Поэтому точный возраст DB D5.1.3 не доказан.

Теперь каждый scan сохраняет `*.evidence.json`: exact requested reference,
ArtifactName/ImageID/RepoDigests, scanner version, platform и DB metadata.
Проверяются schema2, UpdatedAt не старше24ч, NextUpdate ещё не наступил и корректный
DownloadedAt; будущее время допускается только в пределах5мин clock skew.
Несовпадение target/platform/scanner или отсутствие metadata блокирует scan.
Java DB не используется для текущих targets; обнаруженный jar требует отдельной
квалификации. `evidence_status=PASS` означает только валидность evidence, не
прохождение HIGH/CRITICAL gate. Report сохраняет все severities.

Остаются конкретные coverage blockers: db в базовом Compose — floating16-alpine,
production override не задаёт exact digest; ingress — floating nginx1.28-alpine,
не совпадает с frontend nginx1.30.5. CI apt inventory не является post-install scan;
build stages после npm/apk также не сканируются как отдельные исполняемые images.
Redis7-alpine выключен по умолчанию profile и требует отдельной квалификации до
активации. Конфигурация работающего Mac Docker/production не менялась.

## Порядок индивидуального решения

Для каждого исключения нужны: CVE, exact image/architecture/digest, package+version,
primary advisory, проверенный путь эксплуатации или доказательство отсутствия API,
владелец, compensating controls, срок истечения и условие повторного открытия.
Запрос должен показывать исходный finding и предлагаемый disposition отдельно.
Действие возможно только после явного решения владельца; severity-wide исключения
и скрытое подавление недопустимы.

Изменение архитектуры raw diagnostics / strict actual runtime-build-CI явно согласовано владельцем в D5.1.5. Это согласование не принимает ни одну из перечисленных CVE. При оставшихся HIGH/CRITICAL обязательных проверок итог остаётся BLOCKED.
