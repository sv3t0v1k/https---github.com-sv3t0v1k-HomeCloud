# D5.1.13 — исполнимый synthetic recovery harness

18.10.2026, Asia/Vladivostok. Исходный HEAD95d3deb, cached ahead8/behind0,
разрешённая рабочая область чистая. Владелец **не разрешил push** и поручил завершить
локальную реализацию. Это продолжение D5.1.13, следующая Phase не начинается.

**LOCAL_IMPLEMENTATION_PREPARED; RUNTIME_UNQUALIFIED; Production NO_GO;
Release BLOCKED; COMPLETE не установлен.** Ни один контейнерный сценарий этого
harness не выполнен. Фактические RPO/RTO — NOT_MEASURED. Локальные значения из
unit tests не выдаются за измерения PostgreSQL. PR№1 остаётся draft по последнему
API snapshot; внешних изменений PR не было.

## Исполнимая реализация

`experiments/d5-1-13/harness.py` имеет два hosted-only этапа: `qualify` и `run`.
Первый получает официальный pinned OCI через skopeo с preserve-digests, проверяет
manifest/config/layers, фиксирует runtime tools и вызывает неизменный strict
`scan-image.sh` для exact и official. Второй выполняет admission и затем весь drill.
Нет параметра skip-gate, unqualified-image, acceptance-file или произвольного image.
На Darwin/arm64 CLI отказывает до Journal/Docker/host mutations; отказ проверен.

`admission.py` заново проверяет текущие source/run/attempt/job, утверждённый полный
SHA и чистоту только исполняемой области checkout. Затем исполняет оригинальные
environment-evidence validation и scan-policy для actual rootfs и tools, включая
полноту inventory, hashes фактических binaries и свежесть DB. Registry включает
gh/docker/skopeo/trivy; остальные runtime executables закрепляются фактическими
path/hash/version до rootfs scan и перепроверяются на admission. Для обоих images
проверяются fresh scan, severity и archive/manifest/config/rootfs binding через
существующие validators. Переданные извне записи PASS не принимаются. Перед
image load требуется как минимум4GiB свободного места; фактическое значение
записывается в admission evidence.

Только после всех gates skopeo загружает уже проверенные archives в локальный
daemon, без пересборки/registry push. Сверяются actual loaded config IDs,
linux/amd64 и ordered rootfs DiffIDs. В daemon используются точные config IDs;
исходный OCI archive и его immutable manifest не переписываются. Формат daemon
manifest не выдается за исходный OCI digest. Загруженные images остаются только
на одноразовой VM до её уничтожения; container/filesystem cleanup не является
Docker image prune.

`runtime_fixture.py` создаёт исключительно новый root
`RUNNER_TEMP/d513-runtime-RUN-1`, namespace `d513-RUN-1`, sparse ext4 backing1GiB,
отдельные PGDATA/HDD/backup/restore slots и ledger. Host mountinfo копируется без
подмены; block metadata содержит реальный UUID/major/minor выбранного loop device.
Metadata node доступен только для stat: нет --device, device-cgroup-rule или block
I/O в контейнере. Gate source не меняется и запускается через /bin/sh, поскольку
исходный файл в Git имеет mode0644. Настоящие mount/marker проверки не эмулируются.

Все DB containers имеют network=none (отдельный network namespace, только docker
exec для клиентов), без ports, named/anonymous volumes, docker.sock, host network,
privileged и restart. Bind paths отдельные и записаны в ledger; source labels,
config ID и все bind mounts проверяются при cleanup. Memory512MiB, swap512MiB,
CPU1, pids128, cap-dropALL с CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID для штатного
root entrypoint, no-new-privileges, ограниченные tmpfs. Root/Docker administrator
одноразовой VM остаётся доверенной границей. Host sudo применяется только после
admission для этих synthetic loop/mount/ownership/copy операций.

Single writer проверяется по фактическому состоянию прежних containers slot.
Fresh-init разрешается только явно fresh slot с пустым PGDATA и только один раз;
первое записанное намерение запуска расходует разрешение даже при timeout. Recovery
slot без PG_VERSION16 не может молча пройти initdb. Readiness требует финальный
postgres PID1, а не временный Unix-socket server во время official initdb,
gate PASS, PostgreSQL16.15, primary mode и фактический UID70.

Cleanup не доверяет флагам/exit status после side effect: наблюдает actual
/proc mountinfo и только loop association точного backing file. Потерянный stdout
после mount/losetup восстанавливается наблюдением. Неизвестный mount/submount,
labels/binds mismatch или недоказанное отсутствие ресурсов дают FAIL с сохранением
root. Перед exact-root deletion повторно проверяется отсутствие всех mounts и loop
association; prune/glob/global deletions отсутствуют. SIGTERM/SIGINT инициируют
best-effort cleanup. При hard kill/потере VM гарантии cleanup/upload нет; always
finish сохраняет оставшийся ledger и INTERRUPTED_RUNTIME вместо ложного NOT_RUN.

## Реализованная матрица

18 случаев записываются в matrix.json по мере фактического выполнения, исходно
все NOT_RUN. Ни реализация, ни локальные тесты не переводят их в runtime PASS.

- Official → exact → official → exact с clean stop, одним writer, проверкой
  фактической image identity, DB rows, schema/constraints/owners/grants/migration
  ledger и всех HDD bytes после переключений.
- Прямой rollback official на отдельной cold copy текущего candidate PGDATA+HDD
  после новых подтверждённых записей, без подмены старой backup-точкой.
- Согласованные cold DB+HDD и globals+compressed custom dump+HDD snapshots при
  остановленном synthetic writer, затем подтверждённая дельта и отдельные targets
  cold/logical restore. Новый logical bootstrap role d513_restore не конфликтует
  с d513_owner из globals; psql ON_ERROR_STOP и pg_restore --exit-on-error/--create.
- Настоящий gate: missing/wrong marker, missing/wrong data mount, WAL symlink.
  Ожидаются STOP, nonzero exit и неизменность проверяемых bytes. Missing data mount
  перекрывает image VOLUME tmpfs, чтобы не создавать анонимный том.
- Missing/empty/incompatible PGDATA отказывают до initdb; corrupt pg_control на
  отдельной копии должен пройти gate и получить конкретный отказ PostgreSQL.
- Missing/corrupt HDD и DB/HDD generation mismatch отклоняются integrity checker.
  Corrupt/incomplete backup отклоняются до создания restore target.

Оригиналы после объявления synthetic failure остаются остановленными и не
используются как restore target. Их inventory/hash/UID/GID/modes, включая корневой
каталог, и полный backup inventory сравниваются до/после отрицательных сценариев.
Backup не монтируется в DB container и сохраняется как hash-bound copy до cleanup;
физически независимый/offsite disaster recovery этим runner не доказывается.

`recovery_model.py` отвергает extra/dangling files, неправильные reference paths,
владельцев, generation, размер/содержимое/hash, symlinks, hardlinks, special files
и неполный backup. Подтверждение event записывается после fsync файловой системы
и успешного synchronous DB commit. Единственный writer позволяет явно учитывать
in-flight=0 в этих сценариях. Schema_migrations здесь **synthetic fixture ledger**,
а не повтор прежних26 app migrations. App-level/production qualification не получена.

RPO/RTO direct/cold/logical считаются отдельно: последний подтверждённый event
минус последний восстановленный event, lost events/bytes и monotonic failure-to-
gate+readiness+full-integrity interval. Сохраняются UTC endpoints и raw monotonic
timestamps, DB/HDD sizes, confirmed events, backup/catalog/rows manifests и raw
startup/negative logs. Backup validation после failure входит в RTO. Failure model
здесь — искусственная недоступность остановленного original; power-cut crash
recovery и production write availability не заявляются.

## Exact artifact: текущая удалённая целостность доказана

После старого180сек timeout исследован ограниченный resumable transfer, без
изменения image или публикации его в другое место. Текущий artifact12095095760,
run39015752148, build d3770c4/attempt1, ZIP116311061bytes; expiry16.11.2026
18:01:14 Владивосток подтверждены read-only API.

Первый новый подход420сек получил87556096bytes и честно NOT_VERIFIED. Второй,
последний подход получил fresh signed URL, HEAD со strong ETag и точный206
Content-Range bytes87556096-116311060/116311061 с If-Match; suffix завершён за148.738сек.
Полный ZIP SHA c0af0e9a0871b0bc2e7618ba36f16b7afc8f92e8e9918912ec69349d1bb89a83
совпал. Существующий verifier подтвердил tar392d…c645, manifest83b8…abbe8,
confige8f7…a7d2,14layers и linux/amd64. Основной исполнитель отдельно сверил полные
ZIP/tar hashes и hash реально выполненного helper source. Неполный префикс не
считался проверенным до окончательного full ZIP SHA.

Production transport `artifact.py` теперь ограничен600сек и двумя sessions:
первая≤300сек, вторая получает остаток с новым URL. Resume разрешён только при
strong matching ETag,206 и exact Content-Range/Content-Length;200 означает полный
restart в пределах того же бюджета. Token не передаётся blob host, URL/query и
upstream exception text не попадают в logs. ZIP/member size caps, exact ZIP SHA
и прежний tar verifier обязательны до возврата candidate. Post-race чужой candidate
не удаляется: cleanup привязан к device/inode собственного созданного файла.

Реальные bytes/Range mechanism проверены двумя описанными подходами; новый
автоматический600сек путь проверен локальными HTTP fakes, но end-to-end на GitHub
ещё не запускался. Это не гарантия скорости/retention/доступности. При expiry,
ошибке Range/hash или истечении бюджета — STOP, без rebuild/подмены. Большие ZIP/tar
остаются только в private temp. [Transport evidence и первичные источники](./artifact-transport.md).

## Минимальный план GitHub Actions — только после отдельного согласования

Изменён существующий manual-only workflow, новый push trigger не добавлен.
`approved_sha` — полный reviewed/published SHA; `run_drill=false` по умолчанию.
Один GitHub-hosted ubuntu24.04/x64 job, без matrix и дочерних workflow. Общая
concurrency group без automatic cancellation, attempt1, никаких auto reruns.
Permissions только contents:read/actions:read, без production secrets, OIDC,
packages:write, deployments или releases. Все external actions закреплены SHA.

Рекомендуемый один будущий dispatch: `run_drill=true`. Порядок: context/origin →
точный artifact/official metadata → post-install tools → оба strict image scans →
actual runner rootfs/tools gate → повторная admission validation → image load →
synthetic drill → owned cleanup → always status/hashes/upload. Любой gate failure
прерывает переход к runtime; `continue-on-error` и diagnostic mode отсутствуют.
На текущих известных security findings ожидается BLOCKED_BEFORE_RUNTIME,
а не обещание успешного drill. Отдельный diagnostic preflight не обязателен.

| Действие | Ожидаемые runs/jobs | Ограничение |
|---|---:|---|
| Сейчас, локальная подготовка | 0/0 | Push не разрешён |
| Будущий один push всей текущей ветки PR№1 | 3/37 | 2 CI×18jobs + residual×1; сумма timeout3434job-мин |
| Standalone registration patch от main | 0/0 auto | Не merge-ready: отсутствует настоящий required gate |
| Один manual dispatch после разрешённой регистрации | 1/1 | run_drill=true, job≤55мин; runtime stage≤8мин |
| Необязательный preflight-only dispatch | 1/1 | run_drill=false, job≤35мин; runtime не запускается |

Manual55мин включает bounded download≤600сек, image qualification step≤12мин,
rootfs step≤15мин и runtime step≤8мин; остаток для checkout/tool setup/evidence.
Rootfs скан ограничен14мин (+15сек kill grace), upload retention1день. Это лимиты,
не прогноз времени. Если общая сумма фактических стадий упирается в55мин, run
должен остановиться; продлевать/повторять его автоматически запрещено. Обычные CI
job timeouts/concurrency/gates не меняются. Push+один drill:38jobs,3489job-мин
суммы настроенных job timeouts (3434+55); это не wall-clock или billing estimate.

**Регистрация всё ещё блокирована:** GitHub требует workflow на default main.
По сохранённым API main не содержит .github и ruleset требует настоящий strict
`gate`, независимое approval и approval последнего push. Новый registration.patch
содержит только manual workflow и сам этот gate не создаёт. Нужен отдельный
reviewed путь внесения настоящего CI с PASS; fake gate, skip и ruleset bypass
запрещены. Код harness и успешный download этот blocker не снимают. Main/PR/rules/
triggers нужно перечитать read-only перед любым согласованным внешним действием.
Merge, bootstrap PR, main writes и dispatch не входят в разрешённую локальную работу.

По последнему snapshot repository public. Standard hosted compute для него
бесплатен ([GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions));
ожидаемый compute charge $0. Storage/account usage не инвентаризированы: total bill
неизвестен, новые evidence хранятся1день, прежние обычные CI artifacts7/14дней.
При изменении visibility/runner типа пересчитать план до согласия.

## Локальная проверка и review

Точная команда: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s experiments/d5-1-13 -p 'test_*.py'`.
После финальных изменений весь узкий D5.1.13 набор — **57 tests PASS**;
actionlint1.7.12, bash syntax, Python compilation и standalone registration patch
apply-check — PASS. Source-bound результаты сохранены в local-checks.json.
Это pure/mock boundary tests, не PostgreSQL runtime acceptance. Полный app suite,
app lint/build, image/env scans и реальные Docker/loop/mount операции локально не
выполняются: application не менялось, runner не допущен, Mac Docker запрещён.
Shellcheck отсутствует, явно выключен в actionlint. Старые успешные app tests и
scans не дублировались. Независимый review завершён на том же source snapshot:
блокирующих замечаний по gate, изоляции/cleanup, artifact verification, false PASS
и workflow permissions не найдено. Зафиксированы P2 ограничения: `always()`/upload
имеют best-effort предел при hard timeout или потере runner; dispatch требует
отдельной регистрации workflow на default branch, которую registration-only patch
без настоящего required gate не выполняет. Review проверил код и локальные
evidence, но не квалифицирует runtime. Подробности и ссылки на проверенные области
в independent-review.md.

Единственный roadmap — docs/ROADMAP.md. Sources/production Compose/mini-PC/реальные
данные и запрещённый audit-файл не читались/не менялись. Ни push, GitHub writes,
CI trigger, merge, tag/release, GHCR publish, deploy, SSH или Mac Docker не было.
Medium/UNKNOWN не приняты; provenance/SBOM UNSIGNED, OCI reproducibility UNPROVEN,
существующие security/tooling и production blockers сохранены.
