# MS-3B-R2.1 — Persistent Identity Qualification

2026-10-11, Asia/Vladivostok. **R2.1_GATE=BLOCKED.** Исследование завершено в
разрешённых границах; полная persistent identity квалификация не пройдена.
`name_to_handle_at` экспериментально пригоден для ряда проверок object identity на
ext4, но не является самостоятельным trusted-mount enrollment.
Production **NOT_READY / NO_GO**, `secureOpen=false`, additional activation disabled.
R2.2/MS-4, production integration, release/tag/push не выполнялись.

Начальный HEAD `5a1ad420e421533a0d7c842d1c4d80226a0c9865`, ветка `main`, совпал с
ожидаемым; tracked clean и три прежних untracked. ROADMAP — единственный источник
статуса. R1/R1Q PASS остаётся ограниченным descriptor-safe R1 scope; он не расширяется
этим исследованием. Runtime HomeCloud, SQL/schema, upload bindings и конфигурация
приложения не изменялись; production исходники не менялись.

## Среда и границы испытаний

BatchMode SSH с проверенным known host доступен, интерактивные пароли не использованы.
`hs@192.168.3.44`: Ubuntu 22.04.5, kernel `6.8.0-134-generic`, native x86_64, Docker
28.2.2, builtin seccomp/AppArmor; 26 исходных работающих контейнеров.
Прежние R1Q отчёт и probe, `backend/native/secure-fs.c`, registry и workspace resolver
прочитаны. Registry хранит первую identity в process memory, workspace pin также
process-lifetime: новый процесс не располагает внешним операторским expected handle.

| Mount | Source / FS UUID | FS | Failure domain / действия |
|---|---|---|---|
| `/mnt/1TB` | `/dev/sdc1`, `88b84cf3-019b-4aa1-85a7-411a4807fba3` | ext4 | sdc; новые fixtures только под разрешённым test root |
| `/mnt/3TB` | `/dev/sdc2`, `ccf122c6-c7a7-4d8e-86bd-06059730ee35` | ext4 | тот же sdc; только mount/device inventory |
| `/mnt/data` | `/dev/sdb2`, `ef9dde17-a742-45c4-9442-5203bade1ca1` | XFS | другой sdb; root metadata-only probes, без создания test directory |

Три FS — два физических disk failure domain. USB serial/by-id не аттестованы; table
не доказывает криптографическую physical identity. XFS root принадлежит www-data:33,
0755, и не используется как workspace.

Созданы эксклюзивно, без замены существующих paths:

- `/home/hs/homecloud-test/r2-identity-20261011-01a12a10`, hs:hs/0700;
- `/mnt/1TB/homecloud-test/r2-identity-20261011-01a12a10`, hs:hs/0700.

Проверены владельцы/0700 обоих разрешённых parent и отсутствие symlink ancestors.
Standalone C probe ничего не пишет, не монтирует и не открывает по сохранённому handle.
Он получает FD через `openat2` от `/` с `BENEATH|NO_SYMLINKS|NO_MAGICLINKS`, затем вызывает
`name_to_handle_at(fd, "", AT_EMPTY_PATH)` и для директории `name_to_handle_at(fd, ".", 0)`.
Для descendants используется также `NO_XDEV`. Acquisition исходного root допускает
пересечение mounts, как production adapter; сама по себе она не аттестует mount origin.
Это исследовательский probe, а не полный production owner/permission/enrollment gate.

Основной FD — O_PATH. Дополнительный source, полученный точной заменой O_PATH→O_RDONLY,
подтвердил те же handles host/container для ext4 directory и XFS root. Production adapter
использует O_RDONLY; его интеграция с enrollment не выполнялась.

Использован уже имеющийся R1Q runner image по immutable ID
`sha256:8694a91c8306b7f43e6d5d93f693973ddb5d302010dee477d0e6fc7f83cb4e52`;
свежая компиляция probes — native host `cc -std=c11 -O2 -Wall -Wextra -Werror -static`.
В контейнерах выполнялся только этот binary, HomeCloud entrypoint не запускался.
Последовательные short-lived containers: 64 MiB RAM, 64 MiB memory+swap, 0.25 CPU,
32 pids, UID1000/1001, cap-drop ALL, no-new-privileges, network none, read-only rootfs
и read-only binds. Нет privileged, дополнительных capabilities, host network,
docker.sock, published ports, новых image downloads, services/volumes/networks.
Docker daemon создал только обычные binds в namespaces новых disposable контейнеров.
Внутри workload `CapInh/Prm/Eff/Bnd/Amb=0`, `NoNewPrivs=1`, `Seccomp=2`.

## Матрица фактических результатов

Термин PASS ниже относится только к указанной проверке, не к всему gate.
Raw records: [research.ndjson](research.ndjson), [O_RDONLY follow-up](readonly-fd.ndjson).

| Сценарий | Наблюдение / verdict | Что не доказано |
|---|---|---|
| Получение handle из FD без capabilities | O_PATH: ext4 host UID1000 и container UID1000/1001 rc0, type1/8 bytes; XFS root host/container UID1000 rc0, type129/12 bytes. O_RDONLY host/container **UID1000** совпал с O_PATH: **PASS** | UID1001 O_RDONLY, admission прав, owner gate, безопасность доверия source path |
| Новый процесс, ext4 | PID695808→695809, handle `1f00d403fa607ba3` равен: **PASS** | Reboot, power loss, remount |
| Container stop/start и recreation, ext4 | Handle `2600d403394c822c` равен host и всем трём запускам: **PASS** | Recovery приложения/DB по внешнему enrollment |
| Mount-instance distinction при restart | Обычный mountID1388 повторён; uniqueID `4295026047→4295026228→4295026474`: **PASS для различения наблюдавшихся instances** | Durable identity через reboot; uniqueID не persistent enrollment |
| Rename исходной директории | Handle прежний: **PASS** | Handle не связывает объект с неизменным pathname |
| Replacement директории по тому же path | Новый inode/handle отличается, скопированный marker не помогает: **PASS** | Host physical mount replacement |
| Скопированный marker | Равные 31 bytes/SHA, разные directory и marker handles: **PASS** | Полная block-level clone и замена оригинальных bytes in-place |
| Delete/recreate с фактическим inode reuse, ext4 | Все FD закрыты/процессы завершены. В первой попытке inode64225321 повторён; `2900d4034613eb97→2900d40361d59f5e`: **PASS для одного наблюдавшегося reuse** | Бесконечная collision-free уникальность: generation имеет конечную ширину |
| In-place изменение marker | Содержимое изменено, handle прежний: **подтверждённое ограничение** | Object identity не является content integrity |
| Disposable bind source swap | В новом контейнере `/qualified` связан с другим собственным directory b; handle отличается: **PASS** | Live overmount, реальный disk swap, reconnect |
| Nested same-object bind | Handle прежний, хотя mountID1389/uniqueID другой: **handle-only detection FAIL** | Полная production mountinfo/root policy не тестировалась |
| Lookup через nested bind | `openat2(rootfd, "nested", NO_XDEV)` возвращает EXDEV18: **PASS** | Защита до acquisition root и against privileged live stack mutation |
| Stacked bind / privileged namespace unmount | **UNQUALIFIED**, не выполнялись | Нужны отдельно разрешённые полностью disposable FS/namespace resources |
| Real FS remount, USB detach/replacement | **UNQUALIFIED**, реальные mounts не изменялись | Persistent handle после remount и доверенный операторский lifecycle |
| XFS process и host/container root capability | `800000000000000000000000`, ino128/generation0, одинаковый: **PASS только metadata capability** | XFS workspace replacement, recycle, writable lifecycle, restart/remount/recovery |
| Overlayfs container root | O_PATH empty/dot: EOPNOTSUPP95: **unsupported в этом профиле** | Все overlayfs configurations; production denial enforcement здесь не реализован |
| UID1001 / foreign-owned directory | AT_EMPTY_PATH rc0, dot EACCES13 на owner1000/0700: **raw capability only** | Такой объект production R1 owner gate должен отвергнуть; PASS ownership не заявляется |
| Host→container attestation | Равенство handles одного object в проверенных mappings: **частичное подтверждение** | Physical provenance, непрерывность host mount, authenticity свежего startup manifest |
| Crash/power-loss persistence | **UNQUALIFIED**: fixtures без fsync, SIGKILL/reboot/power-off не выполнялись | Никакие process/container PASS не заменяют durability |

Полный автоматический research runner завершился rc0; доп. O_RDONLY runner rc0.
Offline [verify-evidence.py](verify-evidence.py) проверяет source hash, equality/mismatch,
реальный recycle, capabilities, O_RDONLY derivation, overlay95 и host invariants;
[результат](evidence-verification.json) — PASS. Это проверка согласованности evidence,
не независимый security oracle. Research label `PASS_WITH_UNQUALIFIED_SCENARIOS`
в raw log не означает `R2.1_GATE=PASS`.

## Модель угроз и сравнение альтернатив

| Кандидат | Пригодность / ограничение |
|---|---|
| UUID/содержимое marker | Полезен для logical binding; copy/in-place rewrite воспроизводит ожидаемые bytes |
| st_dev/st_ino, timestamps | Runtime diagnostics; наблюдавшийся reuse повторил inode, stat не содержит generation. Device номера и timestamps не durable provenance |
| Обычный mount ID / mountinfo | Нужны для текущей topology; ID повторён при restart, не сохранять как долговременный object ID |
| STATX_MNT_ID_UNIQUE | Полезен для живого mount-instance fence вместе с trusted host lifecycle; меняется при container restart, не persistent object ID |
| FS UUID / by-id / USB serial | Операторские признаки FS/device mapping. Не идентифицируют directory; UUID копируется вместе с FS, serial может отсутствовать/подменяться |
| fstatfs f_fsid | Diagnostic only; в XFS наблюдалось device-derived значение, не доказанный durable FS UUID |
| Opaque file handle | Различает ext4 replacement/recycle в тестах, устойчив к rename/restart. Только within-FS object identity; отдельный trust binding FS обязателен |
| Signed marker / app secret | Подпись подтверждает issuance bytes, копия сохраняет подпись. App-readable secret не решает arbitrary same-UID/root sabotage |
| open_by_handle_at | Не требуется для compare и не применяется: требует CAP_DAC_READ_SEARCH и расширяет возможности открытия вне path confinement |

Linux6.8 source: [fhandle.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/fhandle.c)
не содержит capability gate для `name_to_handle_at` с AT_EMPTY_PATH; capability требуется
для `open_by_handle_at`. [Moby28.2.2 seccomp](https://raw.githubusercontent.com/moby/moby/v28.2.2/profiles/seccomp/default_linux.go)
разрешает name_to_handle_at обычным профилем. Эксперимент это подтвердил для данного host/image.

ext4 регистрирует generic inode32+generation encoding:
[ext4/super.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/ext4/super.c),
[libfs.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/libfs.c).
[XFS encoding](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/xfs/xfs_export.c)
также содержит inode+generation, не FS UUID/physical serial. Full block-level clone
может сохранить FS UUID, marker и handles — это вывод из форматов, **не проведённый clone
experiment**. Особенно root XFS с ino128/generation0 нельзя считать доказательством
происхождения FS. Совпадение handle не является криптографической аттестацией.

Threat profile требует trusted operator/host/kernel и контролируемых writers.
Произвольный процесс с тем же UID может менять исходные bytes/rename objects, а host root
может подменить manifest, mounts, device или kernel. От таких adversaries данный механизм
защиты не даёт. R1 descriptor confinement сохраняет свои границы; произвольный same-UID
sabotage не становится допустимой моделью угроз через enrollment. Generation конечна;
один reuse PASS не доказывает отсутствие всех коллизий.

## Рекомендация для будущего enrollment, без реализации

1. Внешний host-admin-owned enrollment вне storage tree и изменяемой app DB; protected
   parent chain, container read-only view. Read-only bind недостаточен, если host source
   writable application UID. Runtime не создаёт отсутствующую запись/identity и не принимает
   первую увиденную identity автоматически.
2. Запись должна связывать active revision/enrollmentId, immutable existing location/workspace
   UUID, mountKey/containerRoot/purpose, generation namespace, FS profile и opaque
   `(handle_type, handle_bytes, bytes)` storage root/workspace/marker. Host FS/device mapping
   задаётся отдельно. Оpaque bytes не разбираются runtime как inode и не сравниваются без
   type/length/profile. Operator revocation/current revision и rollback policy обязательны.
3. Acquisition получает FD безопасно, проверяет его собственные ownership/permissions,
   handle и FS/topology against внешнее expected; **тот же проверенный FD** остаётся
   capability для I/O. Pathname check с последующим повторным root open не закрывает race.
   Проверка marker не заменяет проверку workspace object. Probe не реализовал этот production lifecycle.
4. На restart/recovery сверяются existing immutable session bindings и внешний enrollment;
   mismatch/absence/unsupported → offline/quarantine до bytes и cleanup, без mkdir(root),
   marker/stat downgrade, remapping, automatic repair или изменения upload bindings.
5. Mount topology/live instance и physical host mapping — отдельный gate. Нужно определить
   доверенное происхождение свежей host attestation, binding к boot/mount namespace/instance,
   защиту revision от rollback и поведение при недоступности monitor. Handle equality не
   разрешает remount. Процедура обновления attestation при обычном container restart versus
   operator-required remount остаётся предметом отдельного design/qualification, а не
   решённой гарантией. [Docker bind semantics](https://docs.docker.com/engine/storage/bind-mounts/)
   требуют проверять source на daemon host; container-visible path не доказывает device.

## Independent review и gate

Независимый narrow subagent review (требование repo AGENTS.md) проверил актуальную
архитектуру/код, Linux/Moby sources, probe source и raw records. Независимо пересчитаны
source hash, 26 container invariants и host mountinfo equality. Verdict:
**ACCEPT только BLOCKED/disabled outcome**, [review](independent-review.md).
Это отдельный AI reviewer, не внешний human audit, и не замена experiment.

**Причины R2.1_GATE=BLOCKED:**

- persistent object identity после реального FS remount/host reboot не квалифицирована;
- XFS writable workspace replacement/recycle/restart/remount не квалифицированы;
- stacked/live mount mutation не проверены;
- host→container trusted FS/mount attestation и operator lifecycle не доказаны;
- production external enrollment/recovery/unsupported denial не интегрированы и не тестировались
  (сознательно за границей research-only), clone/root/same-UID гарантии не предоставляются.

Следующий предлагаемый checkpoint: **продолжение R2.1**, отдельно согласованные disposable
ext4/XFS images или owner-prepared XFS test root, с isolated namespace remount/replacement
и согласованным host attestation design. Для capability-requiring namespace tests нужно
прямое разрешение владельца; реальные `/mnt/1TB`, `/mnt/3TB`, `/mnt/data` не размонтировать.
Не переходить к R2.2 автоматически и не ослаблять gate ради PASS.

## Сохранность, cleanup, проверки

Основной before/after: 26 исходных container IDs/images/start times/restarts/running/health
byte-equal; полный `/proc/self/mountinfo` byte-equal, все три real mount неизменны.
Повторная [финальная сверка после O_RDONLY follow-up](final-integrity.json) также
подтвердила все 26 исходных records и host mountinfo equality; probe containers0.
Все собственные 10 disposable контейнеров удалены (основной runner8 плюс follow-up2;
один контейнер запускался дважды). OOMKilled=false в inspect всех этих контейнеров.
Label `homecloud.research=MS-3B-R2.1` в финальном `docker ps -a` пуст.
Новые сети/volumes не создавались. Docker daemon config, firewall, user services, partitions,
mount state/options и application runtime не изменялись. Полная содержательная проверка
всех чужих user data не выполнялась; не заявляется zero-impact для общей машины.

Основной resource snapshot: MemAvailable4659→4649MiB, swap1893→1893MiB;
после follow-up MemAvailable4629MiB. Не измерены transient minimum, сервисные latency,
длительная стабильность и OOM host-wide. Лимиты контейнеров подтверждены inspect; host
compiler работал кратковременно без отдельного cgroup limit, OOMKilled=false относится
к probe containers. [Финальный inventory](final-inventory.txt).

На host оставлены только собственные source/binaries/results в новом project subdir
(2152KiB до финального inventory) и disposable ext4 fixtures40KiB для воспроизведения.
Ни один старый R1Q fixture не удалён. XFS mutations0. Широкий cleanup/prune не выполнялся.

Exact tests: основной `run-research.py` через BatchMode SSH с JSON source stdin;
дополнительный `run-readonly-fd.py` аналогично; native compile с flags выше;
`python3 verify-evidence.py`. Runner paths эксклюзивны; повторный запуск того же RUN
должен отказать, а не перезаписать оставленные артефакты. Перед повтором оператор должен
выбрать новые согласованные exclusive subdirs. Для исполнения remote runner используется
`python3 -c` с shell-quoted source, stdin содержит JSON `{source: contents(identity-probe.c)}`.
C bytes, scripts, raw logs, checks и hash manifest хранятся вместе с отчётом.

Первый read-only preflight отказал из-за Docker template для отсутствующего Health field,
**до создания ресурсов**; исправлен через `index` и повторён. Сохранён
[preflight-error.txt](preflight-error.txt). Не было двух одинаковых неудач или обхода защиты.
Full backend/PG suites, lint и production build не запускались: production код и зависимости
не менялись; результаты прежнего R1Q не выдаются за новый прогон. Targeted C compilation
и evidence checks выполнены.

Git checkpoint содержит только этот research evidence и добавление статуса ROADMAP.
Final HEAD — SHA документального commit, сообщается после commit в итоговом ответе.
Перед commit проверены exact diff/status и allowlist; три исходных untracked сохраняются.
Два разрешённых JSON SHA256 до documentation update:
`1b579e8f3f25462c45bd3ac1fbfabd2987a4165e2a971cb65ca46af8130518ff` и
`26e0b0f92a23e0be631427752552c680d8372de726ec86a13c5c28582c33b9d4`.
Запрещённый audit не читался, не искался, не хешировался, не modified/staged/committed;
его имя видно только в Git status. Никаких push/tag/release/deploy.
