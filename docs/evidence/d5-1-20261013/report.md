# D5.1 — фактический аудит и локальные проверки

Дата: 13 октября 2026, часовой пояс пользователя Asia/Vladivostok. Статус: IMPLEMENTED_LOCALLY /
GITHUB_ACCEPTANCE_PENDING, release BLOCKED, Production NO_GO. Сервер в этом этапе не опрашивался.

## Git: наблюдаемые факты до изменений

Репозиторий Mac: `/Users/aleksejkozemakin/Desktop/HomeCloud`.
Remote fetch/push: `https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud.git`.
GitHub API: PUBLIC, viewerPermission ADMIN; default branch main. `gh auth` работает при разрешённом
сетевом доступе; sandbox ранее сообщил невалидный token/недоступный DNS, это не реальное отсутствие credentials.
Значения token/секретов в evidence не сохранены.

| Ref / окружение | Full SHA / статус |
|---|---|
| Mac main / HEAD | b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4 |
| origin/main cached | b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4 |
| GitHub main / HEAD (ls-remote) | b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4 |
| испытания/d4-проект | 48fb9c0e8982f23dea835cf1a2e36f83d4e38f3b |
| D4 parent | e6551678a219f1f08bce563c1a338ae97a6ef2ce |
| D4 parent-parent | b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4 |
| Сервер SOURCE_REVISION по предыдущему отчёту | 48fb9c0e8982f23dea835cf1a2e36f83d4e38f3b, REPORTED_NOT_LIVE_VERIFIED |
| Другой локальный checkout toothsome-roll | 8ea84d2f9dd65891079265f66ed0385097634fee; не изменялся |

`main...испытания/d4-проект`: 0/2 (D4 впереди на два коммита, без diverged history).
В момент аудита all refs содержали 254 commits. Remote heads содержит только main; D4 удалённо отсутствует.
Tracked Mac checkout чистый; посторонние closure-checkpoint.json/closure-controls.json и запрещённый
untracked audit сохранены. Содержимое audit не читалось/искалось/хешировалось/изменялось/staged.
Для последующих status/diff/log использован explicit exclusion.

Локальные и remote tags совпали по tag object refs:
backup-phase-5, phase-1-4-baseline, phase-5-backup-dr-complete, security-phase-4-batch-1,
v0.9.0-local.1, стабилизация-этапа-5-2. Ни один существующий ref не переписан.
GitHub release: `v0.9.0-local.1` — prerelease, опубликован 2026-10-06 (UTC API дата).
CI runs: пустой список. Actions enabled, allowed_actions=all, sha_pinning_required=false.
Main branch protection: отсутствует (API404); environments: отсутствуют. Policies не менялись.
GHCR доступ/публикация образов проекта в D5.1 **не проверены**.

## Изменения

Отдельный worktree `d5-ci`, ветка `этап/d5-1-ci`, исходная база48fb9c0. Mac HEAD не переключался.
CI PR/push и manual tag+SHA workflow с раздельными минимальными permissions; full SHA action pinning;
Buildx version/BuildKit digest и base image locks. Dockerfile defaults сохранены, CI передаёт pinned args.
Новый CI candidate manifest связывает source/tag object, CI run, schema source и image digests;
offline reconciliation выводит drift/UNKNOWN. Существующие D1 manifests/Compose не изменены.
Только draft prerelease после gates; автоматического CD нет.

Registry digests node20-alpine, node20-bookworm CI, nginx1.28-alpine, postgres16-alpine и BuildKit
проверены `imagetools inspect` только чтением registry. Action SHAs проверены official Git refs.
Это проверка reference, не image smoke или CVE qualification.

## Реальные локальные проверки

| Проверка | Фактический результат |
|---|---|
| Release/audit negative tests | 16 tests PASS; invalid/lightweight tag, dirty source, mixed identity/platform/digest, malformed audit/evidence |
| Actionlint1.7.12 (checksum verified) | PASS; shellcheck интеграция отключена, отсутствие shellcheck не заявляется PASS |
| Compose base / local / production / project-test config | 4 PASS, synthetic env, config only |
| D4 preflight/config fixtures | 72 PASS |
| Startup gate fixtures | 43 PASS |
| Frontend full suite | 22 files / 278 tests PASS |
| Frontend lint / build | PASS |
| Backend lint / build | PASS; 15 existing lint warnings, 0 errors |
| Compiled file-type runtime | PASS |
| Backend full suite на Mac | **FAIL**: 956 PASS, 38 FAIL, 154 SKIP; 63 passed/4 failed/12 skipped suites |
| Backend Linux/native + PostgreSQL CI | **NOT_RUN**; не выдаётся за PASS |
| Linux/amd64 image builds / remote GHCR verification | **NOT_RUN**; workflow подготовлен |
| GitHub CI / GHCR publish / draft release | **NOT_RUN**, необходим owner-approved push и дальнейшие gates |

Первая sandbox попытка backend suite остановилась на запрете временного HTTP listener EPERM.
Повтор вне sandbox удалил DATABASE_URL/HOMECLOUD_TEST_DATABASE_URL из окружения и выполнил assertions.
38 failures в четырёх suites: secure-filesystem, upload-workspace, ingress-file-cleanup.interceptor,
upload-rate-limit. На darwin нет Linux native addon/admission workspace; последний suite получает
503 от этого gate вместо ожидаемого успешного upload/rate-limit пути. Существующий business code
не исправлялся ради зелёного Mac результата. PostgreSQL suites154 assertions skipped, отдельная DB
не создавалась. После JSON summary Jest остался на open handles; остановлен только собственный
PID62420. Полный backend gate остаётся не пройденным; Linux runner должен дать самостоятельное evidence.

Gitleaks8.30.1 (checksum verified): full reachable history с forbidden pathspec exclusion →48 findings.
Независимый reviewer подтвердил36 SHA256 false positives и12 synthetic fixtures. Exact38 fingerprints
в .gitleaksignore относятся только к этим неизменяемым historical commit/lines. Повтор history scan:
0 unresolved findings. Собственный implementation staged diff: scanner stdin PASS (0 findings), bash syntax всех workflow run blocks PASS.
Перед внешней публикацией снова сверяются refs и собственный staged/committed diff.
Это не доказательство абсолютного отсутствия секретов и не исключение npm advisories.

## Security gate и ограничения

Свежий npm audit: backend production17 (1critical/5high), full backend55 (2critical/13high),
frontend12 (2critical/7high). [Counts](./npm-audit-summary.json). Audit high/critical gate BLOCKED,
автоматических upgrades/исключений не сделано. Низкие/средние тоже видны. CVE reachability не установлена.
Node20 EOL сохранён как open risk; supported runtime transition и base OS CVE scans — отдельный scope.

Независимое review первого варианта нашло два P2 offline evidence-контракта; они исправлены и
проверены негативными тестами. Remote tag object фиксируется до CI и перепроверяется до writes/draft.
Повторное независимое review: APPROVE локальной подготовки, оба P2 закрыты, новых P0/P1 нет.
Main фиксируется в validate; tag API check и writes не атомарны, tag protection обязателен.
Независимый review не заменяет запуск GitHub runner/registry workflow.

Локальный implementation checkpoint: `280c93cd1d10e94347a6a55e90acf0257293ffa7`.
Documentation/evidence фиксируются отдельным коммитом; актуальный ref проверяется `git rev-parse этап/d5-1-ci`.

## Acceptance, публикация и D5.2

D5.1 COMPLETE не установлен. Не создан новый release/tag и не выполнены push/PR/GHCR writes.
Нужны: подтверждение push отдельной ветки/draft PR в PUBLIC repo; реальные CI results; исправление
high/critical advisories с независимым review; owner-approved main protection и интеграция без потери
D4; явно утверждённые tag/SHA; фактический Linux build/publish/digest/provenance/draft acceptance.
Release команды и version policy: [release-management.md](../../release-management.md).

Reconciliation сейчас: Mac/GitHub/D4 source различия объяснимы; release/GHCR digests/full applied schema
UNKNOWN. Snapshot [deployment-reported.json](./deployment-reported.json) — данные предыдущего отчёта,
не свежая проверка target.

Mini-PC не подключался и не обновлялся. Никаких Docker daemon/service/container/volume/mount/DNS/data
изменений Mac или сервера не делалось. D5.2 (approved target update, preflight/backup/health/rollback)
не начат и требует отдельного разрешения.


## Разрешённая публикация и первый реальный CI

После отдельного подтверждения владельца опубликована ветка `этап/d5-1-ci` и создан
[draft PR №1](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/1).
Main остаётся b5c954f; tags/GHCR/Release/CD не изменялись.

Первый PR CI на513e395: [run38397115671](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38397115671).
Frontend и secrets PASS. Linux native addon compiled; все12 PostgreSQL suites выполнились без skips.
Полный backend:1121PASS/27FAIL/0SKIP,79suites (77PASS/2FAIL). Runtime правильно отказал root-процессу
в двух storage suites (`privileged-runtime-refused`). Configuration: четыре Compose merges и43startup
PASS;70preflight PASS/2ERRORS. [Числа и source identity](./github-ci-initial.json).
Security gates FAIL по известным high/critical; они не обходились.

Подготовлено минимальное исправление CI: полный backend suite выполняется под обычным `node` user
через runuser; собственный checkout ephemeral runner перед этим получает соответствующее ownership.
Ни production/runtime guard, ни service credentials не ослаблены. Независимое review APPROVE;
исправление27failures ещё требует нового CI результата.

Preflight source теперь сопоставляет mounts по уникальному target, а не позиции в Compose JSON:
ровно6unique targets, exact data+5gate mounts, все source/type/readonly/no-create требования сохранены.
Перестановка valid mounts допустима; duplicates/extra mounts отказывают. Добавлены4regressions,
76/76локальноPASS и independent review APPROVE. Код mini-PC не обновлялся.

D5.1 остаётся GITHUB_ACCEPTANCE_PENDING / RELEASE_BLOCKED. Последующие реальные результаты
отражаются в PR checks/body; успешный infrastructure job не заменяет dependency/release/registry gates.


### Linux backend gate PASS, normalized Compose API pin

Второй PR [run38398153980](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38398153980)
на b0a8439 подтвердил1148/1148backend tests,79/79suites,0FAIL/0SKIP,12PostgreSQL suites PASS;
backend lint и compiled file-type/build PASS. Frontend и secrets PASS.
[Artifact counts](./github-ci-backend-pass.json). Security gate сохраняет BLOCKED.

Configuration всё ещё отказал: runner Compose2.38.2 сериализует create_host_path=false как bind={}.
Это отдельно воспроизведено official checksum-verified2.38.2 renderer без Docker daemon.
[Исходная omitempty схема](https://raw.githubusercontent.com/compose-spec/compose-go/v2.7.1/types/types.go)
и [зависимость Compose2.38.2](https://raw.githubusercontent.com/docker/compose/v2.38.2/go.mod).
Прежняя order dependence действительно устранена, но это не была единственная причина CI failure.
Missing false не принимается как подтверждённый запрет создания bind source: production check не ослаблен.

Configuration CI теперь pins tested Compose5.1.3 official Linux binary с фиксированным SHA256.
PATH shim рядом с binary работает и при очищенном environment fixture; принимает только compose.
Pin действует только в ephemeral CI job; global Mac/server Compose не изменялся. Новый configuration
результат требуется подтвердить реальным runner. Другие normalized Compose versions не квалифицированы.
