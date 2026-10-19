# D5.1.12 — PostgreSQL Image Integration Preparation

18.10.2026, Владивосток. **Подготовка выполнена в разрешённом scope; интеграция
BLOCKED. Production NO_GO, Release BLOCKED, COMPLETE не установлен.**

## Git и границы

Начало: ветка `этап/d5-1-ci`, HEAD `8e8a356e93620f3e0c88904aea74d14c90292b1e`,
чистое рабочее дерево; fetch подтвердил remote `cbb74d22db9b0309f030b6a85738df0d88c2c935`,
ahead2/behind0. Оба локальных коммита `e111126` и `8e8a356` сохранены без reset/rebase.
Read-only GitHub snapshot подтвердил PR№1 draft. Push не выполняется; финальный
локальный HEAD/ahead фиксируются в output checkpoint после коммитов.

Созданы только preparation files и выбранные копии evidence; обновлён единственный
`docs/ROADMAP.md`. Действующие Compose, production image lock, gates/dispositions,
workflows, backend и deployed images не изменены. Mac Docker, mini-PC и реальные
данные не использованы. Никаких build/scan/CI/push/merge/tag/release/GHCR publish/deploy.
Запрещённый audit-файл не читался/не искался/не хешировался/не изменялся/не staged;
посторонние untracked не удаляются.

## Подготовленные артефакты

- [`qualification.lock.json`](../../../ops/postgres/qualification.lock.json): exact
  manifest/config/archive, platform, build vs qualification origin, gosu/APK/Go pins,
  SBOM и25 evidence hashes; UNSIGNED и непринятые риски явно сохранены.
- [`Dockerfile`](../../../ops/postgres/Dockerfile) и `.dockerignore`: pinned official
  base, exact gosu и vendor APK, hash checks и offline APK install; наследуются
  runtime defaults. Это новый production-recipe candidate, не новый qualified image.
- [`prepare.py`](../../../ops/postgres/prepare.py): offline evidence/OCI verification
  и минимальный новый context с отказом при подмене/symlink/overwrite. Не исполняет
  переданные binaries, не обращается к registry и не загружает image в daemon.
- [`check_compose.py`](../../../ops/postgres/check_compose.py) и
  [`compose-contract.json`](./compose-contract.json): статическая проверка exact OCI
  и существующего db Compose contract; вывод не объявлен полным CLI merge.
- [`README`](../../../ops/postgres/README.md): отдельные пути сохранения точных OCI
  bytes и новой сборки, reproducibility protocol, signing/retention/maintenance и
  условия разрешения интеграции.
- [`rollback`](../../postgres-image-rollback.md): cold/logical backup, globals, write
  freeze, DB+HDD consistency, rollback без потери текущих записей только после
  проверки копии; recovery в отдельный каталог и явное решение о возможной потере.

## Evidence и результаты

Повторно использованы10 ранее проверенных qualification references +12 файлов
fresh scan evidence; добавлены прежние hashes/report/independent review, всего25
неизменных копий. Их SHA подтверждены при копировании и offline verifier. SBOM
CycloneDX связан с exact manifest/config/rootfs,45 OS packages; он и provenance
остаются UNSIGNED. Полный OCI tar сохранился в локальном mirror, не в Git.

Exact manifest `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`,
config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`,
archive SHA `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
Снова прочитаны/проверены manifest/config и14 referenced layers, без распаковки/запуска.

Исторический scan 18.10.2026 08:34 Владивосток, DB около4ч: **0C/0H/1M/1UNKNOWN**,
zlib1.3.2-r1/CVE-2026-85091 отсутствует. Moby/user CVE-2026-61801 Medium и x/sys
CVE-2026-39824 UNKNOWN остаются открытыми, риски не приняты. Старый hash-bound gosu
disposition не перенесён; новая не создана. Freshness — на время того scan, не навсегда.

Исторические26 migrations/no-op, compressed schema/fixture restore и init/entrypoint
PASS не повторялись. Прежние154 app tests относятся к D5.1.10, на текущий exact OCI
не перенесены. Прежний previous→candidate→previous PGDATA PASS относится к previous
производному image; прямой current↔official под production gate ещё не доказан.

## Новые целевые проверки

- 8/8 `ops/postgres/test_prepare.py` PASS: только synthetic bytes/temp directories;
  hashes, copy mutation, symlink/overwrite, evidence traversal/tamper,
  manifest/config/platform mismatch. Реальный retained evidence hash check PASS.
- Exact retained archive verifier PASS;14 referenced layers и config проверены.
- Exact gosu и vendor APK восстановлены только из двух указанных layer members,
  hashes совпали с pins; `materials-binding.json` фиксирует источник. Реальный
  `prepare-context` PASS (`context-result.json`), четыре файла и их hashes сохранены
  в локальном output. Bytes не исполнялись, контейнер не собирался.
- Static Compose contract PASS: PG16.15/PGDATA, inherited root entrypoint, official
  rollback pin, production gate argv, SSD bind/create_host_path=false, healthcheck
  env,1g limit, network/logging, отсутствие опубликованного порта БД. Это analysis
  известных db fields, не full Compose merge/interpolation и не runtime test.
- Python syntax3files PASS. `git diff --check` проверяется до коммитов/при завершении.

Полный app suite/lint/build и прежние migration/runtime suites пропущены: backend
не изменён, цели тестов уже подтверждены для exact OCI; повтор без новой причины
запрещён scope. Контейнерная сборка нового recipe, Compose CLI merge и runtime
startup-gate/rollback не запускались: изоляция/новый CI/builder в этот запуск не
включены, работающий Mac Docker и реальные данные запрещены. Это границы результата,
а не PASS невыполненных проверок. Dockerfile целиком runtime ещё не квалифицирован.

## Воспроизводимость, rollback и review

Равенство build inputs закреплено; minimal context детерминирован по bytes/mode/mtime.
**Воспроизводимость всего OCI UNPROVEN**. Pin/epoch не устраняют автоматически apk.log
или exporter/history differences. Две прежние сборки подтвердили только gosu на
одном runner. Existing BuildKit candidate остаётся BLOCKED; новый build без отдельного
решения не запускается. Любой новый manifest — новые SBOM/provenance/scan/runtime
qualification и независимый review; reuse не переносится по названию/version.

Rollback **спроектирован, production recovery UNQUALIFIED**. Official rollback image
сам имеет исторические1C/24H; runbook не делает его security approved. Нужны прямой
synthetic current↔official под production gate и DB+storage restore drill с RTO/RPO.

Независимый review этого пакета — **PASS только preparation**, без блокирующих
дефектов в разрешённом scope: [`independent-review.md`](./independent-review.md).
Reviewer отдельно проверил фактические source files,8/8 новых tests,25 evidence
hashes,exact archive/14 layers, context hashes/modes/mtime и Compose input hashes.
Основной исполнитель сверил11 hashes source/derived artifacts из review с текущими
файлами — все совпали. Runtime/reproducibility/production approval не даны. Прежний
D5.1.11 review остаётся только экспериментальным и не подменяет этот review.

## Оставшиеся блокеры и одно решение владельцу

Открыты: непринятые Medium/UNKNOWN, UNSIGNED trust chain, воспроизводимость нового
recipe, долговечное хранение материалов до expiry16.11.2026, назначение ответственного
за image, full Compose CLI/runtime gate/direct official rollback/DB+HDD recovery;
прежние Gitleaks/Compose/esbuild/BuildKit/mandatory CI rootfs также не закрыты.

**Решение:** принять пакет подготовки без интеграции; отдельно разрешить только
одноразовый Linux/amd64 synthetic drill exact OCI ↔ pinned official с production
startup-gate fixture и DB+storage recovery, без mini-PC/Mac Docker/реальных данных,
после выбора gate-compliant инструментов. Это не разрешение на новый build,
publish, изменение production Compose или production GO. Production NO_GO сохраняется.
