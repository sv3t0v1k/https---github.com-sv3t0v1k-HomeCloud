# D5.1.13 — PostgreSQL Integration & Recovery Drill

18.10.2026, Владивосток. **BLOCKED_ENVIRONMENT до первого runtime-теста.**
Production NO_GO; Release BLOCKED; COMPLETE не установлен. Квалификация перехода
и восстановления DB+HDD не выполнена. Документация блокировки не означает
выполнение drill или acceptance criteria.

## Исходное состояние и минимальная проверка

Локальный HEAD `9c550bea6da8a119ae9a5c526049c7177658f003`, ветка `этап/d5-1-ci`.
Сохранённый upstream `cbb74d22db9b0309f030b6a85738df0d88c2c935`, ahead5/behind0.
Tracked-дерево до изменений чистое; посторонних untracked в разрешённой области
не обнаружено. Запрещённый путь явно исключён из перечисления untracked, его
наличие и содержимое не проверялись. Рабочий репозиторий — вложенный `d5-ci`,
корень mirror не является Git-репозиторием.

Read-only GitHub API подтвердил PR№1: open, draft=true, head=`cbb74d2`, та же ветка.
Ответ сохранён в `pr-readonly.json`; fetch/push и изменение PR не выполнялись.
Начальные sandbox-запросы PR и исторических jobs не подключились к API; один
повтор только PR с разрешённым сетевым доступом успешен. Jobs не повторялись.

Прочитаны D5.1.12 report/review, pins, README и rollback. Четыре SHA-256
lock/README/rollback/Compose-contract совпали с таблицей независимого D5.1.12 review.
Полный OCI присутствует по сохранённому пути без symlink; его повторное хеширование,
проверка слоёв, scan и старые успешные tests не выполнялись. Исторические проверки
OCI из D5.1.12 переиспользованы, текущая runtime identity не заявляется.
Команды текущего минимального Git preflight, hashes входов и результаты проверок
сохранены в [`preflight.json`](./preflight.json).

## Объекты будущего drill

- Exact Linux/amd64 PostgreSQL16.15 manifest:
  `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`.
- Config: `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`.
- Архив из D5.1.12: SHA-256
  `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
- Official rollback pin из lock:
  `docker.io/library/postgres:16.15-alpine@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`.
  Здесь не выполнялось разрешение multiarch index в platform manifest или загрузка
  official; platform/config/layers фактического official runtime ещё нужно записать.
  Этот pin не объявлен security-approved.

## Изоляция и причина остановки

**Изоляция runtime НЕ ДОКАЗАНА. Ни один контейнерный тест не запускался.**
Доступный execution host — Darwin/arm64. Наличие Docker CLI не даёт разрешения
использовать работающий Mac Docker. Docker CLI/API/context/socket не вызывались.
В PATH не обнаружены Podman, Lima, Colima, QEMU system, ctr или nerdctl; выбранного
отдельного Linux/amd64 endpoint и его isolation attestation нет. Это ограниченная
проверка доступной среды, не доказательство отсутствия всех возможных внешних VM.

Исторические квалификации использовали одноразовые GitHub-hosted runners, а не
сохранившуюся доступную сессию. Локальные экспериментальные workflows запускаются
push; выделенного ручного drill workflow среди проверенных workflow-файлов нет.
CI workflow имеет push/pull_request/workflow_call, ручной release workflow ведёт к
публикации и не подходит. Push запрещён, повтор старой квалификации не реализует
новую матрицу. Никакие workflow не dispatch/rerun/cancel и не изменены.

Не созданы контейнеры, тома, сети или runtime-каталоги. Не было SSH, обращения к
mini-PC, production paths/data или Mac Docker; production Compose не читался и не
менялся. Новые файлы — только evidence и checkpoint единственного roadmap.
Невозможно честно назвать конкретные отдельные containers/volumes/network/mounts
до выбора среды. Поэтому обязательный pre-test gate остаётся BLOCKED; уникальный
префикс ресурсов сам по себе не доказал бы отсутствие доступа к реальным данным.

Перед будущим первым тестом нужны проверяемые runner identity/Linux/amd64,
gate-compliant runtime/tools и отсутствие production credentials, host sockets,
shared mounts/volumes и маршрутов к production/mini-PC/Mac Docker. Затем отдельные
synthetic root/DB/HDD/backup/restore paths, контейнеры и сеть без published ports,
allowlist mounts, immutable image/gate/fixture hashes и достаточное место.
Источник startup gate копируется по точному hash в fixture; production Compose не
запускается. Реальные mount/marker проверки должны исполняться без bypass; если
fixture не может их удовлетворить, отдельный BLOCKED. До этого ничего не запускать.

## Сценарии и результаты

Все runtime-сценарии имеют **NOT_RUN / BLOCKED_ENVIRONMENT**, а не FAIL или PASS.
Исторические 26 migrations/no-op и compressed restore не переносятся на новую
квалификацию DB+HDD и прямой official rollback.

| Сценарий | Результат | Необходимое свидетельство |
|---|---|---|
| Official → exact OCI → official → exact OCI, последовательный single writer | NOT_RUN | Фактические image/config digests, PG version/UID, readiness, clean shutdown и неизменность synthetic DB/file references/bytes после каждого перехода |
| Прямой rollback на official после новых candidate-записей | NOT_RUN | Проверка отдельной cold copy текущего PGDATA; сохранение новых DB rows и HDD bytes, без подмены старой backup-точкой |
| Startup gate: штатный mount/marker | NOT_RUN | Реальный gate пропускает только разрешённые synthetic mounts/identity и запускает exact entrypoint |
| Отказы gate: missing/wrong marker, отсутствующий/неверный mount, запрещённый symlink | NOT_RUN | Fail-closed до PostgreSQL/initdb; exit/log и неизменность fixture |
| PGDATA отсутствует/повреждён или несовместим | NOT_RUN | Отказ либо явно разрешённый только fresh-init сценарий, отсутствие молчаливого init поверх recovery target; сохранён original |
| HDD-файл отсутствует/повреждён; несогласованные DB/HDD поколения | NOT_RUN | Integrity checker отвергает missing/hash mismatch/generation mismatch, даже если PostgreSQL ready |
| Cold backup → отдельное согласованное восстановление DB+HDD | NOT_RUN | Write freeze всех synthetic writers, clean stop, immutable backup hashes/metadata; новый target, DB constraints/ownership/migration rows и все file hashes совпадают |
| Globals + compressed logical dump + HDD backup → отдельный restore | NOT_RUN | ON_ERROR_STOP/exit-on-error, явный bootstrap-role plan, точные DB+HDD generation и bytes; без игнорирования SQL ошибок |
| Повреждённая/неполная backup и отсутствующий компонент DB/HDD | NOT_RUN | Отказ до promotion, originals сохранены; successful restore только из проверенной согласованной backup |
| Миграции при необходимости | NOT_RUN | Image switch сам по себе не требует schema change; migration rows/schema сверяются, app startup с автоматическими migrations не запускается вслепую |

## RPO/RTO

**RPO — NOT_MEASURED; RTO — NOT_MEASURED.** Нулевые значения и обещания не даны.
Ожидание среды не является измерением времени восстановления.

При выполнении drill записать объём DB/HDD, число файлов, write/backup/failure
timestamps и monotonic duration. RPO: последнее подтверждённое согласованное
DB+file событие перед отказом минус последнее такое событие после restore,
плюс число потерянных подтверждённых событий/байтов. Отдельно отразить неподтверждённые
in-flight writes. RTO: от зафиксированного synthetic отказа до завершения startup
gate, DB readiness и полной DB+HDD integrity/read-only проверки на восстановленной
точке. Direct rollback, cold restore и logical restore измеряются раздельно;
проверка backup включается в время, если выполняется после отказа. Результаты
малой synthetic fixture не являются обещанием для production SSD/HDD.

## Проверки, ограничения и решение владельцу

PASS только минимального read-only preflight: Git/PR snapshot и четыре hashes
preparation inputs. Runtime isolation — BLOCKED, runtime PASS отсутствует.
Targeted/full tests, lint/build, scans/SBOM, Compose CLI и CI не запускались:
изменений исполняемого кода нет; изоляция не доказана; повтор старых checks
без причины запрещён. Выполняются только целостность нового evidence и Git diff.

Непринятые Medium/UNKNOWN, UNSIGNED provenance/SBOM, **полная воспроизводимость
OCI UNPROVEN**, retention/ответственные и прежние Gitleaks/Compose/esbuild/BuildKit/
mandatory CI rootfs остаются открытыми. Новых exceptions, dispositions или gate
обходов нет. Official runtime и DB+HDD recovery остаются UNQUALIFIED.

Независимый review фиксируется отдельно в `independent-review.md`; его вердикт
может относиться только к обоснованности BLOCKED и сохранности scope, не к drill.
Финальный HEAD/ahead и hashes evidence фиксируются в локальном output checkpoint
после узких коммитов, без push/merge/tag/release/GHCR publish/deploy. PR draft.

**Одно решение владельцу:** предоставить одноразовый Linux/amd64 runner с
проверяемой изоляцией и допустимыми по действующим gates инструментами для этой
матрицы, без изменения запретов на push, production/mini-PC/Mac Docker.
До его появления D5.1.13 BLOCKED_ENVIRONMENT; Production NO_GO сохраняется.
