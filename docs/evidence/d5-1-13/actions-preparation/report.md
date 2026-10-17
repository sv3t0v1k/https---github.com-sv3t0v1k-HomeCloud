# D5.1.13 — подготовка GitHub-hosted исполнения

18.10.2026, Asia/Vladivostok. **PREPARATION_READY / RUNTIME_BLOCKED**.
Production NO_GO; Release BLOCKED; COMPLETE не установлен. Это продолжение
исходного BLOCKED_ENVIRONMENT, а не выполненный recovery drill.

## Что подготовлено

Новый `.github/workflows/pg-recovery-preflight.yml` имеет только workflow_dispatch,
один GitHub-hosted `ubuntu-24.04` job, timeout25мин, общую concurrency group без
cancel-in-progress, contents/actions read и checkout полного approved_sha без
сохранения credentials. Нет secret references, environment, services, workflow_call,
build, Docker load/run, privileged container, publish/deploy или release calls.
Первый шаг создаёт минимальный status до checkout. `always()` сохраняет частичные
evidence и hashes; upload retention1день. Финальный job намеренно красный:
`BLOCKED_BEFORE_RUNTIME`, все сценарии NOT_RUN, RPO/RTO null. Это не зелёный gate.
При потере runner, принудительном cancel или общем timeout upload не гарантирован;
scan ограничен14мин (+15сек kill grace), чтобы оставить время для evidence.

`experiments/d5-1-13/preflight.py` проверяет hosted Linux/amd64, manual event,
repository, attempt1, approved source, job identity через API, локальный daemon,
пустые containers/volumes и отсутствие custom networks. Известные remote-runtime/
credential environment settings вызывают STOP; значения env не выгружаются.
Это не доказательство полного отсутствия произвольных секретов или маршрутов:
workflow не получает production secrets, не создаёт runtime mounts и не проверяет
связность с production. Полная runtime isolation остаётся NOT_PROVEN.

Затем проверяются artifact origin/run/attempt/retention, pinned ZIP digest/size,
единственный allowlisted ZIP member и tar+manifest+config+все referenced layers
через существующий `prepare.verify_archive`. OCI не загружается в daemon и не
пересобирается. Official platform manifest/config (либо amd64 child из index)
проверяются по digest без запуска;
official layer bytes ещё не получены/проверены, security approval отсутствует.

Используются существующие minimize-runner и checksum-pinned Trivy0.76.0,
scan-environment/environment-evidence/scan-policy без изменений. Полный actual
rootfs, global npm и executed Go tools (gh/docker/trivy) проходят прежний gate.
Новая scan scope не вводится, runner rootfs не заменяется scan одного бинарника.
Отсутствие/ошибка inventory, stale DB, scanner failure, HIGH/CRITICAL блокируют job.
Medium/UNKNOWN остаются непринятыми findings, UNSIGNED provenance/SBOM и полная
воспроизводимость OCI UNPROVEN сохраняются. Сам скан выполняет инструменты
до их квалификации, как существующий CI; он не разрешает запуск runtime.

## Проверенные исходные данные

Начальный HEAD182a41e, cached ahead6/behind0; разрешённая рабочая область чистая.
Read-only API подтвердил open/draft PR№1, remote head cbb74d2, public repository,
default main защищена и имеет HEAD b5c954f35b7ea9d81ffc4aa41d78e56fc7fc8ec4.
В top-level main нет `.github`: ручной workflow ещё не зарегистрирован.
Snapshot: `github-readonly.json`; artifact/build origin: `origin.json`.
Actions включены, allowed_actions=all; default token read, approval PR от Actions
запрещён. Workflow сам уменьшает permissions до contents/actions read, все actions
закреплены SHA независимо от отсутствия обязательного pinning в repo settings.
Legacy branch-protection endpoint вернул404; действующие rulesets main проверены
отдельно (`main-rules-readonly.json`): обязательны PR,1независимое approval,
approval после последнего push, resolution discussions и strict check `gate`
от GitHub Actions app15368; deletion/force-push запрещены. Rules не изменялись.

Exact artifact12095095760 из run39015752148, build d3770c4, attempt1, name
d5111-experimental-image-1: not expired; expiry16.11.2026 18:01:14 Владивосток.
ZIP SHA256 c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83,
API size116311061bytes. Это текущая доступность на момент чтения, не обещание
retention; workflow повторит проверку непосредственно перед использованием.
Никакой automatic rebuild fallback при expiry/404/hash mismatch нет.

Remote ZIP download начат один раз, остановлен по180сек timeout на медленном
соединении; **полный remote payload NOT_VERIFIED**, частичный temp удалён.
Автоматического повтора нет (`remote-download.json`). Доступность metadata API
не подменяет проверку downloaded ZIP. Метод изменён: сохранённый локальный tar
проверен по полному archive SHA, manifest/config и14referenced layer hashes,
результат `local-identity.json` — PASS только этих bytes. Ни пересборки, ни переноса
локального tar в GitHub не было. Будущий hosted preflight обязан заново скачать и
проверить pinned ZIP; медленный transfer также завершит его BLOCKED.
Official metadata сохранена отдельно в `official-metadata.json`: текущий pin
`sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`
уже platform-manifest Linux/amd64, не multiarch index. Manifest/config hashes и
PG_VERSION16.15 проверены; config/layer descriptors записаны. Layer bytes не
скачивались, official runtime/security не квалифицирован. Первое чтение выявило
неверное предположение parser об index; после исправления и targeted regression
выполнено одно успешное metadata-only чтение с тем же pin, без его замены.
Исторические отчёты не переписаны; старые успешные runtime/migrations/scan suites
не повторяются. Большие tar/ZIP не добавляются в Git.

## Почему полного runtime workflow пока нет

Hosted runner решает отсутствие машины, но не закрывает actual rootfs/tool gate.
Official pin из lock сохраняет исторические security findings; immutable digest
не означает разрешение на исполнение. В этой задаче новые CVE exceptions не
разрешены. Поэтому автоматический переход к контейнерам не добавлен даже при
успешном preflight. Исполнимый runtime harness и настоящий mount/marker fixture
ещё нужно реализовать и независимо проверить после устранения gate blockers.
Здесь спроектирован их контракт ниже; отсутствие harness не скрыто флагом
`run_anyway` и не названо готовностью полного drill.

## Контракт отложенного runtime harness

Полная исходная матрица: [report D5.1.13](../report.md). Она остаётся обязательной.
Будущее расширение использует один hosted job, timeout не более30мин, без matrix,
один dispatch за согласование, без auto retry; не более двух попыток одного blocker.
Перед первым контейнером нужны fresh actual environment/tools PASS и reviewed
security qualification обоих exact runtime images; Medium/UNKNOWN не принимать.
Смена source/tools/image требует нового preflight и review, старый PASS не переносить.

Namespace `d513-${run_id}-${attempt}`; отдельная internal Docker network, без ports,
host network, device passthrough, docker.sock mounts или privileged containers.
Все ресурсы имеют run label, создаются исключительно заново и записываются в
resource ledger; cleanup удаляет только ledger resources этого run. Docker prune
и поиск/удаление по общему префиксу запрещены. Оригиналы, cold копии, HDD, backups
и restore targets раздельны; новые пути только под RUNNER_TEMP этого job.

Реальный `deploy/linux/startup-gate.sh` копируется с hash binding без изменения
логики и запускает штатный entrypoint. Gate требует настоящий ext4/xfs block/mount
identity, mode/UID/marker и bind records; named volume сам по себе недостаточен.
Допустимый будущий fixture: отдельные loopback filesystems только из новых файлов
под RUNNER_TEMP, host mount/UUID metadata read-only, без block device access внутри
контейнера. Для создания mounts/metadata может потребоваться sudo только на
одноразовой hosted VM; отдельный review должен проверить это до реализации.
Модель не защищает от root/Docker admin. Если hosted VM не позволяет удовлетворить
gate без подмены metadata или privileged container, STOP; gate не эмулировать.

Synthetic DB: отдельная роль/db, фиксированный schema/migration ledger (не выдавать
его за 26 app migrations), владельцы/constraints и таблица file references:
event_id, generation, file size/hash, confirmed UTC и monotonic timestamp.
HDD содержит детерминированные bytes; полный DB+file checker отвергает dangling
refs, missing/extra bytes, wrong generation/hash/owner/schema. Каждый event
подтверждается только после fsync файла и DB commit; in-flight отдельно.
Production app и automatic migrations не запускать; app-level qualification
остаётся открытой, если этот harness использует только fixture schema.

Последовательность с single writer и проверкой clean shutdown:

1. Official → exact → official → exact на одном synthetic generation: после
   каждого switch записать actual config/image/platform и выполнить полную integrity.
2. После новых candidate rows/files остановить writer, clean-stop и создать
   отдельную cold copy PGDATA. Direct rollback на official проверяет именно эту
   копию текущего состояния и сохраняет новые rows/files; не старую backup-точку.
3. При freeze всех writers сделать согласованные cold PGDATA+HDD и отдельно globals
   + compressed logical DB dump + HDD. Snapshot manifest: generation, schema,
   ownership, timestamps, sizes, hashes, подтверждённые events; backup immutable.
4. Добавить подтверждённую дельту после backup. Зафиксировать synthetic failure;
   restore на отдельные targets из проверенного backup, original сохранить.
   Cold и logical restore измеряются раздельно. Globals restore: новый уникальный
   bootstrap role, без конфликтов; `psql ON_ERROR_STOP=1`, `pg_restore --exit-on-error`;
   decompression с pipefail/проверкой exit status. Любая SQL ошибка — STOP.
5. Negative copies: missing/wrong marker, missing/wrong mount, forbidden symlinks;
   missing/empty/corrupt/incompatible PGDATA без молчаливого re-init; missing/corrupt
   HDD; DB/HDD generation mismatch; corrupt/incomplete backup, missing DB/HDD member.
   Записать exit/log, pre/post hashes originals и доказательство отсутствия initdb/
   promotion/writes. PG readiness не заменяет integrity. Faults только на copies.

RPO для каждого restore: последний подтверждённый согласованный event до failure
минус последний восстановленный event; сохранить отдельно lost event count/bytes,
UTC event times, in-flight writes, backup snapshot/completion. Direct rollback
может иметь RPO0 только по фактическим событиям. RTO: monotonic interval от failure
до startup gate+readiness+полной DB/HDD read-only integrity. Backup validation после
failure входит в RTO. Время получения runner не входит. Сохранить DB/HDD размеры и
все stage timestamps. Измерение fixture не обещает production write availability.
Независимый reviewer проверяет raw evidence и acceptance, а не только job summary.

## Точный план публикации — сейчас НЕ выполнен

Без дополнительного согласия: никаких GitHub writes/push/dispatch/merge/tags/releases,
GHCR publish/deploy. PR№1 draft. Локальные русскоязычные commits допустимы.

1. После согласия опубликовать текущую ветку `этап/d5-1-ci` одним push. Это включает
   шесть прежних commits и новые commits подготовки, а не только новый workflow.
   Существующий ci.yml не имеет paths filter: ожидаются **2 HomeCloud CI runs**
   (push + PR synchronize), каждый18 jobs, сумма timeout1702job-мин.
   В накопленном diff есть experiments/d5-1-11/qualify.py: дополнительно
   **1 pg-residual-experiment run**, один job, timeout30мин. Госu experiment не
   затронут, release вручную не вызывается. Итого **3 auto runs,37 jobs,
   сумма timeout3434job-мин**, без rerun/cancel. Это лимиты, не прогноз длительности.
2. Для workflow_dispatch нужен файл на default main. Подготовлен registration.patch:
   только manual workflow, без включения CI/release и без изменения production.
   Создать отдельную русскую ветку от актуальной main и draft bootstrap PR можно
   лишь после отдельного согласия. По проверенному дереву main/patch у этой ветки
   нет push/pull_request workflows: ожидается0 Actions runs при её push/PR.
   Main защищена: требования branch protection проверяются перед публикацией;
   если обязательные checks нельзя удовлетворить, STOP без bypass. Слияние
   bootstrap PR требует отдельного решения владельца, **сейчас не запрашивается**.
   PR№1 остаётся draft; merge всего PR№1 для регистрации не предлагается.
   **Известный blocker регистрации:** standalone registration.patch не создаёт
   обязательный check `gate`, поэтому сам по себе не готов к merge в main.
   Нельзя добавить фиктивный зелёный gate, skip CI или ослабить ruleset. Нужен
   отдельный reviewed путь внесения настоящего CI с выполненным gate; текущий
   security status этого не обеспечивает. До решения dispatch недоступен.
3. Только после reviewed регистрации файла на main и отдельного согласия на запуск:
   **1 manual preflight run,1 job, timeout25мин**, approved_sha — полный HEAD
   опубликованного review checkpoint. Workflow на main checkout именно этот SHA;
   drift branch не подменит source. Ожидаемый итог BLOCKED_BEFORE_RUNTIME, а не drill.
   Контейнерных запусков0. Один dispatch, rerun запрещён; при blocker ≤2 попыток
   только после анализа и нового согласования. 37auto+1manual=38jobs,3459job-мин лимитов.
4. Реальный drill пока не dispatchable: сначала закрыть blockers, реализовать
   runtime harness по контракту и получить review; затем новый точный запрос согласия
   с diff, source/image/tool pins и лимитом30мин. Разрешение на preflight его не покрывает.

Повторно проверить remote head/main/workflow triggers и branch protection перед
каждым разрешённым push; любое отличие меняет расчёт и требует нового плана.
Организационные webhooks/внешние integrations не инвентаризировались.

## Расходы и предел точности

API подтвердил public repository. По [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
standard GitHub-hosted compute публичного репозитория бесплатен: ожидаемая плата
за compute этих запусков **$0**. Большие runners не используются. Это не означает
нулевой storage bill: quota/usage/budget аккаунта не проверены. Нынешние обычные CI
сохраняют собственные artifacts на7/14дней; их объём заранее неизвестен.
Новый preflight не публикует повторно OCI/ZIP или executed-tools binaries, evidence
retention1день, caches не создаёт. Storage сверх quota — $0.25/GiB-месяц, по фактическим
GB-hours; например256MiB на1день ≈$0.0021 при30-дневном месяце. Это пример, не
измеренный размер и не общий лимит счёта. Точный total bill без account usage и
фактических artifact sizes назвать нельзя. Если репозиторий станет private,
расчёт меняется: Linux standard $0.006/мин сверх quota ([тариф](https://docs.github.com/en/billing/reference/actions-runner-pricing)).

Правило default branch: [GitHub manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Проверки и границы

Targeted6 boundary/regression tests PASS; actionlint1.7.12 PASS. Shellcheck отсутствует,
actionlint запущен с явным отключением shellcheck; snippets отдельно проверяются
`bash -n`. Full app tests/lint/build не запускались: app не изменён, связанные
успешные suites уже сохранены, полный запуск может обращаться к запрещённой области.
Runner scans и runtime tests локально не выполнялись. Read-only download/OCI/official
metadata verification проверяет текущую доступность bytes, а не runtime security.
Финальный независимый review записывается отдельно; замечания основным исполнителем
проверяются по diff/фактическим checks. Запрещённый audit-файл и sources не затронуты.
