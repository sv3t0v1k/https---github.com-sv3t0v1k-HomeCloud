# D5.1.4 — Image Security Policy & Base Qualification

Дата: 2026-10-14. **BLOCKED; Production NO_GO.** Это квалификация и предложение
разделить ответственность проверок, не разрешение ослабить существующий gate.
Merge/tag/release/GHCR/deployment и изменение реальных данных не выполнялись.

## Действующая блокировка

Существующий общий gate требует успеха всех jobs, включая четыре raw base scans.
Любые HIGH/CRITICAL, в том числе без fix, продолжают блокировать каждый image scan.
Ни одно исключение, allowlist, ignore-unfixed или continue-on-error не добавлено.
Новые проверки DB freshness только усиливают fail-closed поведение.

| Контур | Что должно проверяться | Решение о релизе сейчас |
|---|---|---|
| Backend/frontend runtime | Фактическая собранная пара linux/amd64, затем exact published digests при отдельно разрешённой публикации | 0 HIGH/CRITICAL обязательно; medium видимы и требуют triage |
| PostgreSQL | Exact digest реально выбранного PG16, server version и security advisories отдельно от OS/gosu | Обязательный runtime gate; текущие 1C/24H не сняты |
| Build/deps | Node/npm, установленные компиляторы и build dependencies фактически исполняемых stages | Raw Node gate остаётся обязательным; дополнительно требуется квалификация stages |
| CI execution | Exact container после apt-install и исполняемые инструменты | Raw CI base gate остаётся обязательным; inventory не заменяет scan |
| Ingress и дополнительные сервисы | Exact production ingress; Redis отдельно при включении profile | Непокрытый ingress блокирует release qualification; Redis не квалифицирован для включения |

Разделение контуров нужно для определения владельца исправления и пути эксплуатации.
Оно не делает build/CI безопасными: они исполняют входные данные зависимостей и влияют
на артефакты. Чистый финальный runtime не закрывает уязвимость build pipeline.

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

Менять обязательность raw base gate сейчас не предлагается: полное покрытие реально
исполняемых build/CI/PG/ingress ещё не достигнуто. Возможная будущая замена raw-base
блокировки на квалификацию производных images требует отдельного согласования,
предварительной проверки exact images и индивидуального решения остаточных CVE.
