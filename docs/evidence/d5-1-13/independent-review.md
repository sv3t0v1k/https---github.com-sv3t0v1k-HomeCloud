# Независимый review D5.1.13 — остановка до runtime

18.10.2026, Владивосток. **PASS только обоснованности BLOCKED_ENVIRONMENT и
сохранения заявленного scope. Drill NOT_RUN; recovery UNQUALIFIED; Production
NO_GO; Release BLOCKED; COMPLETE не установлен.** Reviewer не автор preflight,
отчёта или roadmap. Этот вердикт не подтверждает успешность переключения,
изоляцию какого-либо runtime или восстановление DB+HDD.

## Независимо проверенное

Прочитаны AGENTS.md, три D5.1.13 evidence-файла из таблицы ниже, точный diff
`docs/ROADMAP.md`, все десять inputs из `minimal_input_sha256` и исторический
`docs/evidence/d5-1-11-existing-oci-20261017.md`. Пересчитаны SHA-256 только этих
десяти inputs и трёх новых evidence; все десять совпали с preflight. Четыре hashes
lock/README/rollback/compose-contract также независимо совпали с таблицей прежнего
D5.1.12 independent review. Старые suites, OCI/layers verification и scan не повторены.

Lock подтверждает manifest `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`,
config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`,
archive SHA-256 `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`
и pinned official base. Текущая загрузка образа/identity runtime не заявляется.
Сохранённый PR snapshot содержит open/draft=true и head `cbb74d2`; reviewer не
проверял API заново, финальную актуальность Git/PR контролирует основной исполнитель.

Фактические два experiment workflow имеют только push triggers и GitHub-hosted
`ubuntu-24.04`; CI имеет push/pull_request/workflow_call, а release workflow с
workflow_dispatch содержит публикацию в GHCR. Они не дают готового безопасного
ручного D5.1.13 drill. Исторический отчёт подтверждает одноразовую hosted среду и
удаление прежних контейнеров/томов; исторический PASS не является текущей сессией.
Diff единственного roadmap добавляет только BLOCKED checkpoint, без COMPLETE
или снятия прежних blockers.

## Обоснованность остановки и границы доказательств

Положительного isolation attestation выбранного Linux/amd64 endpoint нет.
Следовательно, требование владельца доказать изоляцию до первого теста не
выполнено; остановка обязательна независимо от полноты поиска других сред.
Один Docker CLI, отдельный префикс ресурсов или старый GitHub runner не доказывают
изоляцию. Отчёт корректно не утверждает отсутствие всех возможных внешних VM.

Host/binary discovery и отсутствие runtime обращений записаны основным
исполнителем в preflight. Reviewer не превращает их в независимый OS/runtime
attestation: не проверял Docker contexts/socket, SSH endpoints, production mounts
или сеть и не запускал probes. Это намеренная граница read-only review, а не
подтверждённая изоляция. Наблюдаемых противоречий между разрешёнными источниками
и решением BLOCKED не обнаружено. Полная сохранность Git/untracked и отсутствие
внешних действий вне этих evidence контролируются основным исполнителем.

## Матрица, recovery и измерения

Все runtime строки честно NOT_RUN/BLOCKED_ENVIRONMENT; ни одна не выдана за PASS.
Матрица отделяет прямой rollback с новыми candidate rows/HDD bytes от возврата к
старой backup-точке; требует single writer, clean shutdown, проверку отдельной
копии PGDATA, реальный fail-closed startup gate и сохранение originals. Отдельно
охвачены missing/corrupt PGDATA, HDD и backup, DB/HDD generation mismatch,
согласованная cold и compressed logical recovery с globals и остановкой на SQL
ошибке. Автоматические migrations не запускаются без проверки schema/migration
rows. Исполнимый harness и фактические fault outcomes пока отсутствуют: матрица
задаёт необходимые свидетельства, но не закрывает acceptance criteria.

RPO/RTO — NOT_MEASURED/null, нулевые результаты не выдуманы. Будущий RPO связан с
разницей подтверждённых согласованных DB+file событий до отказа и после restore,
потерянными событиями/байтами и отдельным учётом in-flight writes. Будущий RTO
ограничен явной точкой gate+DB readiness+полная integrity/read-only проверка.
Это время восстановления synthetic fixture до указанной точки, а не измерение
production write availability; результаты каждого rollback/cold/logical сценария
требуют отдельного monotonic измерения. Ожидание среды не засчитывается как RTO.

## Замечания и сохранённые блокеры

Обнаружена неверная относительная метка архива в первоначальном preflight:
`outputs/...` было relative to mirror root, хотя поле называлось relative_to_repo.
Основной исполнитель исправил значение на `../outputs/d5-1-11-resume-20261017/candidate.oci.tar`
и сообщил о повторном stat без чтения/хеширования OCI. Финальные bytes исправленного
preflight зафиксированы ниже. Reviewer архив самостоятельно не открывал.
После исправления блокирующих дефектов обоснования остановки не осталось.

Medium/UNKNOWN не приняты; UNSIGNED provenance/SBOM и полная воспроизводимость
OCI UNPROVEN сохранены. Gitleaks/Compose/esbuild/BuildKit/mandatory CI rootfs,
retention и ответственные остаются открытыми. Pin official не выдан за
security-approved. Gate exceptions/dispositions/bypass не добавлены. Runtime
изоляция, exact↔official и DB+HDD recovery остаются неквалифицированными.

## SHA-256 проверенных D5.1.13 evidence

| Файл | SHA-256 |
|---|---|
| `report.md` | `abc0688dfcf0e99828a45b5b336e59858898df80cb7809eabbcb4ef807432849` |
| `preflight.json` | `e9470130070c8f2913f2d310bb3bca6bb2632609fc09768050dc0f964a14d15c` |
| `pr-readonly.json` | `cdddad497c1cca0d9ff76c47dec4ef6a5523db64054a1f61de35669892d4134e` |

Reviewer не выполнял Git mutations, network/SSH/Docker/CI/runtime/tests/build/scan
и не читал production Compose или реальные данные. Запрещённый audit-файл не
читался, не искался, не хешировался и не изменялся. Единственная запись reviewer —
этот файл. Допустимое решение владельцу — предоставить disposable Linux/amd64
runner с проверяемой изоляцией и gate-compliant tools в текущих запретах; до
положительного pre-test attestation ничего не запускать.
