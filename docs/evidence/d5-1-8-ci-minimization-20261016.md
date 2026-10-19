# D5.1.8 — Минимизация фактических CI-окружений

**BLOCKED / Production NO_GO.** Исходный HEAD `31273c1`, PR №1 остаётся draft.
Это ограниченная итерация по решению владельца; D5.2 не начинается.

## Изменения и граница покрытия

Все 15 hosted workloads удаляют только предустановленный, не принадлежащий dpkg
SDK `/usr/share/dotnet` до выполнения workload. Workflow использует Node, Python,
shell и Docker; .NET в нём не вызывается. Проверка запрещена на Mac, self-hosted
runner и внутри контейнера. При symlink, изменённой структуре, package ownership
или неудаче удаления выполняется fail closed. Сохраняются source/event SHA,
run/attempt/job, состав верхнего уровня и размер SDK до удаления, отсутствие после.
Запись включается в environment evidence и повторно проверяется после сканов.

Backend уже выполняется в закреплённом Node-контейнере; его окружение не меняется.
Остальные jobs остаются на самом hosted host. Provider host/daemon не скрываются
переносом в контейнер. Полный rootfs scan каждого фактического окружения,
анализаторы, exclusions, package inventory, UNKNOWN, freshness и severity gates
сохранены. Лимит rootfs остаётся 60 минут. Ожидаются те же **16/16** окружений.

В D5.1.7 скан base-node-ci остановился на .NET DLL после 60 минут. Это объясняет
выбор SDK для минимизации, но не доказывает единственную причину timeout.
Устранение timeout и полнота нового source подтверждаются только итоговым CI;
на момент этого checkpoint они ещё **PENDING**, baseline остаётся 15/16 INCOMPLETE.

## Единственная индивидуальная CVE-классификация

Владелец условно разрешил `not_affected` только CVE-2025-68121 в gosu SHA256
`52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0`.
Фактически сверены retained ELF и frozen binary evidence: 2962 symbol records,
51 package, `crypto/tls` отсутствует, положительные main/os controls присутствуют.
GO-2026-4337 связан с этим CVE и только crypto/tls. Доказательства и exact
manifest/config перечислены в [индивидуальной записи](./d5-1-8-gosu-disposition-20261016.json).

Standalone qualifier читает exact target из фактического CI OCI archive,
проверяет manifest/config/layers, SHA256, lock, frozen proofs и срок. Изменение
бинарника/артефакта/evidence либо наступление `2026-11-15T00:00:00Z` даёт INVALID.
Усечённый срок консервативен: классификация не действует с начала 15 ноября UTC.
Никаких других CVE эта запись не покрывает. Бинарный анализ не восстанавливает
runtime call graph; сохранённая Go DB имеет last_modified 2026-10-08.

Raw PostgreSQL scan выполняется независимо от результата qualifier. Raw 1C/24H
не вычитаются из severity gate; все 24H остаются открытыми. Результат ACTIVE
в standalone report означает только доказанную применимость разрешённого
индивидуального решения, не Production GO и не принятие других findings.

## Инструменты, проверки и остановка

Текущие official release metadata повторно проверены одним запросом на компонент:
Gitleaks8.30.1, Compose5.6.0, BuildKit0.34.0 не изменились. Проверенного полного
version-only fix нет; 1C/35H Gitleaks (applicability INCONCLUSIVE), 4H Compose,
npm/esbuild/BuildKit остаются блокерами. Для npm12.2 bundle доказаны лишь частичные
исправления; major upgrade и ручная пересборка bundle не квалифицированы.
esbuild0.28.2 выходит за Vite6 `^0.25.0`; прежние две неудачи binary analysis
не повторяются. Непроверенные обновления, подавления и новые CVE decisions не введены.

Целевые проверки: runner minimization8, environment23, coverage10, gosu11 —
**52 PASS**; actionlint PASS. Полный backend локально не повторялся: application
code не менялся; полный набор, lint/build и secret gate остаются в итоговом CI.
Независимое pre-review выявило и исправило github.sha mismatch и порядок qualifier:
теперь raw scan/binding предшествуют qualifier, который имеет `if: always()`.

Локальная упаковка retained OCI остановлена после двух отказов sandbox при
создании skopeo temp в `/var/tmp`; обходов нет. Она не объявляется квалификацией.
Actual OCI qualifier выполняется на disposable GitHub runner.
Разрешён один итоговый GitHub CI; второй запуск возможен только как единственная
корректирующая попытка по конкретной проблеме, без третьего цикла.

Итоговые HEAD, CI, canonical coverage, scan counts и независимый review фиксируются
в отчёте `outputs/d5-1-8-20261016/report.md` проекта и в draft PR после выполнения.
Merge, tag/release, GHCR publish, deployment, mini-PC, Docker/данные Mac не затрагиваются.
Запрещённый audit-файл не читается, не ищется, не хешируется и не stage.
