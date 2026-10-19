# PostgreSQL image — подготовка D5.1.12

18.10.2026, Владивосток. **PREPARATION ONLY; Production NO_GO; Release BLOCKED.**
Эта директория не подключена к Compose, workflow или release gates. Dockerfile —
минимальный кандидат производственного рецепта, его результат ещё не собран и не
квалифицирован. Новый roadmap здесь не ведётся: единственный — `docs/ROADMAP.md`.

## Объект и доверие

Источник истины для bytes — `qualification.lock.json`, для доказательств —
`docs/evidence/d5-1-12/{scan,qualification}/`. Сохранены 25 выбранных evidence, SHA-256
сверены с D5.1.11. Локальные абсолютные пути в старых raw records — исторические,
исполнять их нельзя; используйте новые относительные пути сохранённых копий.

- Exact manifest `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`.
- Config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`.
- OCI tar SHA-256 `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
- Только Linux/amd64, PostgreSQL 16.15. Это platform manifest, не registry URL и не
  multiarch index. Registry-путь собственного образа не создан и не публиковался.
- Origin: run 39015752148, commit `d3770c4e49c9d45572f7c0dc70daf3021d8055bd`,
  artifact 12095095760. Build origin отличается от qualification commit `8e8a356`.
  GitHub artifact expires 16.11.2026 18:01:14 Владивосток; локальная копия сохранена
  в mirror `outputs/d5-1-11-resume-20261017/candidate.oci.tar`. В Git большой tar не внесён.
- Provenance и SBOM **UNSIGNED**. GitHub API origin + hashes дают byte binding,
  но не криптографическое подтверждение доверенного builder. Новая подпись поверх
  старого отчёта не превратит прошлую сборку в signed build provenance.
- CycloneDX SBOM hash `24004d905b756af5d3ac15c7eb4df482a284b2c02298e0185866e7f63d4f8f47`;
  45 OS packages + gosu modules, binding к manifest/config/rootfs сохранён.

18.10.2026 08:34:26–08:34:27 Владивосток Trivy 0.76.0 дал 0C/0H/1M/1 UNKNOWN,
DB UpdatedAt 18.10.2026 04:34:28 Владивосток, возраст около 4 часов с проверкой
`0 <= age < 86400` до/после. Это исторический snapshot; текущую свежесть он не
доказывает. zlib CVE-2026-85091 отсутствует. Moby/user CVE-2026-61801 Medium и
x/sys CVE-2026-39824 UNKNOWN открыты и **не приняты**. Прежняя hash-bound gosu
disposition не переносится даже при совпадении имени/версии; для данного gosu SHA
никаких новых disposition/VEX/waiver нет. Независимый PASS относится только к эксперименту.

## Два способа получить образ

**A. Сохранить квалифицированные bytes.** Offline `verify-archive` сверяет полный tar,
platform manifest, config и все referenced layer digests без распаковки и запуска.
Позднейший перенос OCI с сохранением digest потребует отдельного разрешения и
проверки destination manifest/config/layers. Конверсия media type, пересборка,
добавление labels или встраивание attestation могут изменить digest. Отдельный
registry referrer должен быть привязан к subject digest и проверен отдельно.
Несовпадение tar SHA — STOP строгого verifier; один лишь другой tar wrapper ещё не
доказывает другой image, но требует отдельной проверки byte binding, без автоприёмки.

Из checkout, Python >=3.9, только чтение:

```sh
python3 ops/postgres/prepare.py evidence
python3 ops/postgres/prepare.py verify-archive /absolute/path/to/candidate.oci.tar
```

**B. Собрать из закреплённых материалов.** Это новый кандидат, без наследования
квалификации A. Dockerfile наследует pinned official PG; заменяет только gosu и
ставит проверенный vendor zlib APK `--no-network`, проверяя оба SHA в RUN. Не
изменяет entrypoint, CMD, ENV, USER или PGDATA. APK signature validation остаётся
штатной; `--allow-untrusted` нет. `.dockerignore` оставляет ровно четыре входных файла.

Для нового context передать сохранённые файлы gosu и zlib APK, а не произвольные
файлы с теми же названиями. `prepare-context` проверит hashes, создаст исключительно
новый каталог, перепроверит copied bytes, установит фиксированные modes/mtime.
Не читает `.env`, не загружает зависимости, не запускает Docker/BuildKit.

```sh
python3 ops/postgres/prepare.py prepare-context \
  --gosu /absolute/materials/gosu --apk /absolute/materials/zlib.apk \
  --output /absolute/new-disposable-directory/context
```

Gosu source commit `6456aaa0f3c854d199d0f037f068eb97515b7513`, Go 1.26.9 archive
SHA-256 закреплён в lock. Если исходный бинарник утрачен: восстановить clean checkout,
проверить toolchain archive, `go.mod/go.sum` и `go mod verify`; два независимых пути
исходников/module/compiler caches; GOTOOLCHAIN=local, CGO_ENABLED=0, GOOS=linux,
GOARCH=amd64, GOAMD64=v1, GOFLAGS=-mod=readonly. Прежний build argv:
`go build -trimpath -buildvcs=true -ldflags='-d -w'`; metadata должны иметь точный
vcs.revision и vcs.modified=false. Требуется совпадение pinned binary hash.
Иной hash — новый бинарник, STOP reuse; отдельная квалификация и security review.
APK проверяется по pinned hash; потеря исходного vendor APK — STOP, не floating download.
В текущем запуске оба точных материала восстановлены чтением allowlisted members
существующего OCI (без запуска/общей распаковки); layer hashes и paths закреплены в
`docs/evidence/d5-1-12/materials-binding.json`. Новый локальный context подготовлен
в mirror `outputs/d5-1-12-20261018/context`, его hashes сохранены в context-result.
Это дополнительная рабочая копия материалов, не независимый долговечный архив.

### Отложенный isolated build protocol

**Сейчас не выполняется.** До запуска владелец отдельно разрешает builder и выделяет
одноразовый Linux/amd64 runner без production mounts/credentials и Mac Docker socket.
В lock есть прежний pinned BuildKit candidate: он остаётся BLOCKED существующим
security gate и не считается разрешённым builder. Сначала закрыть blocker или
согласовать другое gate-compliant средство с отдельным pin/review, без исключения.
Записать digest/version builder, buildctl executable hash/version и используемый
встроенный frontend (без floating `#syntax`), exporter options, рецепт/context hashes.

После этого оператор задаёт явный isolated `D512_BUILDKIT_ADDR`, новые `D512_CONTEXT`,
`D512_OUTPUT`, `D512_METADATA`. Заготовка команды (в текущей задаче не запускалась):

```sh
buildctl --addr "$D512_BUILDKIT_ADDR" build \
  --frontend dockerfile.v0 \
  --local context="$D512_CONTEXT" --local dockerfile="$D512_CONTEXT" \
  --opt platform=linux/amd64 --opt no-cache \
  --opt build-arg:SOURCE_DATE_EPOCH=1792224036 \
  --output "type=oci,dest=$D512_OUTPUT,oci-mediatypes=true,rewrite-timestamp=true" \
  --metadata-file "$D512_METADATA"
```

Registry source access нужен только для pinned base; RUN network=none. Не использовать
`--load`, Docker daemon exporter или registry push. Две изолированные сборки с разными
caches/путями, одними pins/epoch/options; сравнить selected manifest, config, ordered
DiffIDs, layer digests и payload inventory. Tar wrapper hash учитывать отдельно.
SOURCE_DATE_EPOCH и exporter timestamp rewrite уменьшают недетерминированность, но
не гарантируют одинаковый content, например apk.log может содержать время транзакции.
Не нормализовать файлы, не удалять apk.log и не менять allowlist ради равенства:
расхождение исследовать, после двух попыток остановиться с evidence.

**Воспроизводимость всего OCI UNPROVEN**. Старые две сборки подтверждают только gosu
на одном runner. Этот новый Dockerfile имеет другую историю слоёв; равенство старому
manifest не обещается. Любой новый image digest требует своего provenance/SBOM,
fresh scan и targeted runtime/init/entrypoint, 26 migrations/no-op, compressed restore,
официальный→новый→официальный rollback; результаты прошлого OCI на него не переносятся.
Исправленные и неизменные компоненты/44 прочих packages/apk scripts проверять
отдельно, а не только итоговую таблицу CVE. Подписанные attestations создаются
доверенным процессом для нового subject с записью identity/builder/materials.

Техническая основа протокола: [Docker SOURCE_DATE_EPOCH](https://docs.docker.com/build/ci/github-actions/reproducible-builds/),
[BuildKit reproducibility](https://github.com/moby/buildkit/blob/master/docs/build-repro.md).

## Совместимость Compose и rollback

Проверяется конфигурационный контракт, не deployment. Базовый Compose — Mac с named
`db_data`, production override — SSD bind; нельзя подменять один другим. Candidate
сохраняет PGDATA `/var/lib/postgresql/data`, PG16.15, UID/GID70 и штатный entrypoint.
Production entrypoint `[sh, /run/homecloud/startup-gate.sh, db]` выполняет mount/marker
admission до `/usr/local/bin/docker-entrypoint.sh postgres`; его нельзя обходить
новым USER или entrypoint. Healthcheck использует `pg_isready`, inherited env и
отложенное `$${POSTGRES_USER}`/`$${POSTGRES_DB}`. Порт БД не публикуется.

Offline check подтверждает эти поля exact OCI и неизменный db contract Compose.
Повторяемая проверка (Python >=3.9, PyYAML 6.0.3; OCI только читается):

```sh
python3 ops/postgres/check_compose.py --archive /absolute/path/to/candidate.oci.tar
python3 ops/postgres/test_prepare.py
```

Полный Compose merge/interpolation CLI не запускался: Docker CLI/daemon в scope не
используются; существующий Compose tool security blocker сохраняется. Реальное
выполнение startup gate с exact OCI и прямой возврат на official image под этим
production override ещё **UNQUALIFIED**, нужны disposable fixture tests.

[Пошаговый rollback, резервные копии и условия STOP](../../docs/postgres-image-rollback.md).

## Сопровождение и условия разрешения интеграции

Владелец назначает ответственного за образ и заместителя, фиксирует response SLA и
окно обслуживания до интеграции. Предлагаемый процесс: ежедневный triage новых
PostgreSQL/Alpine/Go/gosu advisories, еженедельная проверка pinned inputs и retention,
плановый ежемесячный refresh; Critical/High — немедленная оценка воздействия и
приостановка продвижения до исправления по существующей policy. Это требования
процесса, расписание/автоматизации здесь не создавались.

Для каждого обновления: issue с причиной → один набор immutable pins → isolated
build → новый SBOM/provenance и свежая DB <24ч на момент scan → сравнение inventory/
findings → targeted compatibility/migrations/restore/rollback → независимый review →
отдельное решение владельца. Максимум две попытки на blocker; успешные тесты не
повторять для неизменного exact OCI без причины. Major PostgreSQL upgrade, platform
change или изменение extensions/collation — отдельный проект migration/rollback.

Хранить OCI, все build inputs (включая APK/Go/source/modules), SBOM, logs и provenance
как минимум весь срок использования образа + согласованное rollback window. До expiry
GitHub artifacts нужен независимый долговечный архив с hashes/access controls и
проверкой восстановления; одна локальная копия не считается надёжным хранением.
Подпись и digest не отменяют CVE/expiry review. Раз в квартал и после изменения
backup tooling — synthetic recovery drill с измеренными RTO/RPO.

Интеграция может рассматриваться только после закрытия всех условий:

1. Digest/runtime contract точен; выбран путь A либо квалифицирован новый путь B.
   Для B — доказанная воспроизводимость или явное отдельное решение владельца о
   допустимой модели сборки в рамках действующих gates, без автоматического PASS.
2. Доверенная provenance/signing цепочка подготовлена; UNSIGNED не объявлена signed.
   Текущее состояние доверия не даёт production approval.
3. Остаточные Medium/UNKNOWN имеют допустимое решение по действующей policy и
   владельцу риска; сейчас такого решения нет. Новых исключений здесь нет, старый
   hash-bound gosu disposition не переиспользуется.
4. Gitleaks, Compose, esbuild, BuildKit и mandatory CI rootfs gates закрыты, успешные
   обязательные checks относятся к выбранному release; этот пакет их не заменяет.
5. Изолированно проверены exact production startup-gate path и прямой rollback на
   pinned official; backup/restore включает DB globals и storage consistency,
   достаточно места для исходника/копии/restore, измерены RTO/RPO.
6. Назначены сопровождающие, retention/обновления, утверждены окно/rollback trigger;
   отдельно согласованы Compose diff и затем deploy. PR остаётся draft до отдельного
   решения. Пока все пункты не выполнены — Production NO_GO.
