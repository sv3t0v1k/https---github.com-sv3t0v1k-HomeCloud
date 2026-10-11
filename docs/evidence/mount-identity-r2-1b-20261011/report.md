# MS-3B-R2.1B — остановленный preflight и helper для ручного запуска

2026-10-11, Asia/Vladivostok. **R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.**
Испытания loopback ext4/XFS, remount/stacked/live mutation и attestation не начаты:
Доступный SSH не предоставляет привилегированный вход. Это остановка среды, не отрицательный
результат проверки persistent identity. Production NO_GO, secureOpen=false,
additional workspaces disabled. R2.2/MS-4 не начаты, production исходники не изменены.

Начальный HEAD `1fd5c1d0f95d6b75210c9738a8fe2512f41df91e`, `main`, совпал с expected.
Три прежних untracked сохранены; запрещённый audit только виден в Git status,
не прочитан/не искался/не хешировался/не stage. Два разрешённых JSON отдельно
проверяются по прежним SHA. Итоговый HEAD документального checkpoint сообщается
в финальном ответе: SHA нельзя включить в собственный commit. Единственный roadmap
остаётся docs/ROADMAP.md. Прочитаны architecture, R2.1 report/reproduce и узкий runner.

## Доказательства остановки

Read-only SSH, BatchMode, StrictHostKeyChecking=yes. Ubuntu kernel6.8.0-134-generic,
x86_64, UID1000 hs. Оба разрешённых test parent — hs:hs/0700; прежние R2.1 subdirs
существуют. 17 записей их inventory, metadata и SHA обычных файлов равны до/после.
На физическом XFS `/mnt/data` root www-data:33/0755, отдельного approved writable
test root не дано. Записей туда нет, каталог не создавался.

- `sudo -n true`: rc1, password required. `sudo -n -l`: ALL требует пароль;
  NOPASSWD только ipset/birdc. Эти исключения не используются для обхода.
- `unshare --user --map-root-user --mount --propagation unchanged`: rc0;
  child userns4026533239/mntns4026533240, UID0→host1000. Host mntns4026531841.
  Это доказательство новой namespace, **не доказательство private propagation**:
  специально не выполнено даже `mount --make-rprivate`.
- `unshare --mount --propagation unchanged /bin/true` без userns: rc1/EPERM.
  Нет доступного входа в mount namespace с полномочиями initial user namespace.
- `/mnt/1TB` и `/mnt/data` имеют shared propagation; наследовать это без проверки
  нельзя. PID1 namespace readlink недоступен (errno13), совпадение self с PID1 не заявлено.

Root в child userns не эквивалентен host root. В upstream
[Linux6.8 ext4 registration](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/ext4/super.c)
нет FS_USERNS_MOUNT. Наличие CapEff в child не разрешает считать ext4/XFS loopback
mount доступным. На этом host реальная попытка mount/loop setup не выполнялась.
Изоляция loop device не доказана: **loop allocations глобальны и не изолируются mount
namespace**. Для их создания/удаления требуется отдельный строго ограниченный host
privilege path или отдельная VM; существующее согласие на namespace tests это не расширяет.

## Экспериментальная матрица для продолжения

Все строки ниже **NOT_RUN в R2.1B**. Предыдущие PASS R2.1 — исторические результаты,
не новый прогон; tmpfs не заменяет ext4/XFS. Матрица задаёт acceptance; подготовленный
isolated-helper.py покрывает часть FS сценариев, но не Docker lifecycle/attestation.

| Сценарий на disposable ext4 и XFS | Проверка и достаточный evidence |
|---|---|
| Process/recreation | Тот же root/workspace/marker opaque type+length+bytes через O_RDONLY FD; новый PID и namespace; container config/capabilities |
| Marker copy / directory replacement | Одинаковые marker bytes не принимают новый directory handle; handles marker и directory проверяются отдельно |
| Inode recycling | Все pins закрыты; bounded create/delete, например максимум2000 итераций/30с; PASS только при фактическом повторе inode и другом handle, иначе UNQUALIFIED |
| Чистый unmount/re-mount same image | fsync+закрытие всех FD/child processes перед unmount, тот же filesystem/object handle после нового mount instance; это не reboot/power-loss |
| Remount rw→ro→rw | Раздельно с unmount/re-mount; проверить flags/object identity/instance, изменения только собственного FS |
| Same-object stacked/nested bind | Handle может сохраниться; mount-instance/topology должны различаться; NO_XDEV crossing=EXDEV |
| Replacement bind от другого object/FS | Новый handle или trusted FS binding mismatch; одинаковый handle другого FS не считается equality без FS scope |
| Live mount mutation и retained FD | Сопоставить старый FD и новый pathname lookup; pinned FD может остаться на старом mount — это не доказательство текущего path/source |
| FD-based verification | Expected извне, безопасное acquisition, handle/statx/topology по тому же FD; повторный pathname open исключён |
| Ordinary Docker rprivate | Новые cap-drop ALL/NNP/default-seccomp контейнеры; привязка source namespace явно зафиксирована, host/supplier mutation сравнивается с pinned container view |
| Attestation freshness/replay | Отказ для старого boot/namespace/mount instance/revision, сменённого challenge/container instance; monitor unavailable→offline до I/O/cleanup |

## Граница host→container attestation (design-only)

Operator approval связывает enrollmentId/revision, immutable location/workspace IDs,
mountKey/purpose, FS профиль и внешний trusted expected root/workspace/marker handle.
Runtime observation отдельно связывает boot ID, host/supplier mount namespace,
текущий unique mount-instance ID и topology, workload/container instance+namespace,
nonce/challenge и active revision. Обычный mount ID без boot/namespace недостаточен.
Сравнение handle действует внутри одобренной FS; UUID/marker не доказывают physical uniqueness.
Клонированная FS и privileged host/kernel adversary вне доказанного механизма.

На container recreation разрешается новая workload observation только при прежнем
operator enrollment и повторном подтверждении supplier/host continuity. Нельзя требовать
равенства container mount-instance ID после recreation. При host/supplier unmount/re-mount
нужна operator-controlled повторная аттестация, даже если object handles прежние.
На reboot требуется новый boot-bound snapshot; persistence handles через reboot не проверена.
Подпись без trusted current revision/anti-rollback и freshness не закрывает replay.

[Docker bind documentation](https://docs.docker.com/engine/storage/bind-mounts/)
задаёт default rprivate и source на daemon host. Из этого следует отдельный риск:
container view не доказывает current host path при mount mutation. Это **вывод для дизайна**,
не проведённый live experiment. Не менять propagation production mounts на shared ради
monitoring. Bind source, смонтированный лишь в private helper namespace, обычный Docker
daemon не увидит как этот FS: нужно явно квалифицировать источник daemon/supplier namespace.
Поэтому loopback remount tests сами по себе не закрывают Docker host attestation.
Privileged service, CAP_SYS_ADMIN, docker.sock и seccomp unconfined приложению не нужны
и не допускаются. Trusted operator/host/kernel и controlled writers — предпосылки модели.

## Протокол безопасного продолжения, ещё не исполнен

Минимальный недостающий вход: владелец выбирает отдельную disposable native AMD64 VM
с root либо обеспечивает **ручной разовый запуск проверенного ограниченного helper**
на данном host. Для второго варианта требуется явное согласие на host-global allocation
только собственных loop devices, не blanket sudo/privileged Docker. Пароли в чат/evidence
не передавать. Физический XFS test root не нужен при одобренных disposable XFS images.

До первого mkfs/mount helper должен сравнить parent/child mntns, убедиться child≠host,
перевести child tree в rprivate и проверить отсутствие shared/master propagation.
Сам переход private выполняется лишь внутри доказанной child namespace. После этого
fresh exclusive 0700 subdir, open O_EXCL|O_NOFOLLOW image, fstat S_ISREG/nlink1/owner,
protected ancestor chain и неизменный inode; mkfs только на этом обычном файле, не на
device и никогда не /dev/sd*. Не принимать произвольные пути/команды от приложения.
Loop setup только для этого pinned образа, проверить backing file/dev/inode и ownership
allocation; cleanup лишь собственных loops после нормального unmount всех собственных FS.
Namespace не изолирует writes в inherited real FS: мутации allowlisted только собственного tree.
Проверка одинакового SHA runner перед ручным root запуском обязательна.

Предлагаемые budgets для согласования: sequential ext4≤64MiB и XFS≤384MiB sparse
images, один FS одновременно, общий logical≤448MiB, test timeout≤180с,
memory≤256MiB/CPU≤25% где cgroup доступен; без массового recycle/parallel workloads.
Размер/поддержка mkfs.xfs проверяются до allocation; версия может требовать иной минимум,
при выходе из budget остановиться. Limit subprocess duration и resource measurements
не заменяют host-wide isolation. Не использовать существующие fixtures для обхода collision.

## Сохранность и проверки

Baseline/final records: 26 контейнеров IDs/images/start time/restart/running/health равны;
все running. Полный host `/proc/self/mountinfo` byte-equal,
SHA256 `0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Boot ID/self namespace одинаковы. Старые R2.1 fixtures metadata/content равны.
Baseline записан после первых read-only ознакомительных проверок и до сохранённой
серии preflight; это не retroactive snapshot до самого первого SSH.
Read atime не включён в invariant; read-only не обещает отсутствие atime updates.
User/mount probe namespaces завершились вместе с краткими процессами.

В пределах baseline/final preflight новых server files/images/loops/mounts/containers/networks/volumes0;
cleanup объектов0. Позднее подготавливается только source для ручного запуска:
это отдельный server project artifact, не выполненные filesystem tests.
Фактически переданы ровно два source файла в
`/home/hs/homecloud-test/r2-1b-20261011-01a12a22` (hs-owned0700, files0600):
helper SHA `8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426`,
launcher SHA `3c1954013386be053e22e04a7a4b5486582c5e69b13cb7f03cd5633d74e6a44a`.
Uploaded bytes совпадают с independently reviewed SHA; [upload evidence](helper-upload.json)
подтверждает container records и mountinfo SHA прежние до/после source write.
DATA ещё не создан, own loop allocation0, helper не исполнен.
Нет service/config/mount state изменений по исполнявшимся командам и mountinfo evidence;
весь чужой data tree и временная latency не измерялись, zero-impact не заявляется.
Source/baseline/final/offline verifier сохранены локально. Backend/PG suites/lint/build
не запускались: production/dependencies не менялись. Выполнена только offline проверка
согласованности preflight; её PASS не снимает BLOCKED.

Независимый scoped AI security review принял только historical preflight BLOCKED:
[review](independent-review.md). Это отдельный AI reviewer, не внешний human audit.

После остановки владелец выбрал ручной однократный запуск проверенного helper и
**отдельно разрешил создание/удаление только его disposable loop-устройств**.
Это снимает ambiguity авторизации loop allocation, но не даёт агенту доступного sudo.
Подготовлен [isolated-helper.py](isolated-helper.py), ограничения и аварийные действия
описаны в [manual-run.md](manual-run.md). Initial helper review обнаружил потерю partial
evidence при сбоях; исправлены durable journal и сохранение parent baseline/raw/final.
Последний verdict и проверенный SHA — в [helper-review](helper-review.md).

Snapshots RAM available4668→4660MiB, swap1892→1892MiB; transient minima/latency не измерены.
Next action — **ручной root запуск владельцем** после final helper review, затем read-only
сбор result/journal и проверка фактических FS результатов/cleanup. До получения evidence
R2.1B/R2.1 остаются BLOCKED. R2.2/MS-4 не переходят автоматически.
Документальный checkpoint включает только evidence/research helper и roadmap,
без push/tag/release. Final Git SHA/status сообщаются в итоговом ответе.
