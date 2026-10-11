# Независимый runtime review recovery и disposable ext4/XFS

2026-10-11. **ACCEPT только R2.1B_GATE=BLOCKED / R2.1_GATE=BLOCKED.**
Отдельные disposable-FS сценарии имеют подтверждённые положительные результаты;
Docker supplier mapping, container recreation, trusted attestation и reboot ещё
не проверены. Production NO_GO, secureOpen=false, extras disabled сохраняются.

Отдельный AI reviewer, не human audit. Read-only local raw review: recovery-result,
root-run-result/journal, post-run-readonly, cleanup-readonly и check-cleanup.py;
сравнение с прежним reviewed helper и historical preflight baseline. SSH, root,
device calls и новые эксперименты reviewer не выполнял. Offline assertions
пересчитаны самостоятельно, без запуска перезаписывающего verifier.

## Recovery первого failed run

Recovery status OWN_LOOP_DETACHED. Pinned image expected Linuxdev2081/inode64225325/
size67108864 совпал с root raw loop8 metadata: back-inode64225325,
BACK-MAJ:MIN **`       8:33 `**, offset0/sizelimit0. Root raw row и immediate
recheck равны. Записанный unused proof:387 inspected processes, old namespace
absent, mount/open block FD users0. Этот summary удостоверяется reviewed execution
flow, не сохранёнными отдельными process records; reviewer заново /proc не обследовал.

Detach только exact old loop8 rc0; kernel LOOP_GET_STATUS64 errno6/ENXIO подтвердил
non-bound состояние. Recovery initial/final26-container records и host mountinfo равны.
Old image не удалялся. Actual root padded value этого же backing object подтверждает
formatting incompatibility прежнего literal guard; original failed-attempt root row
не существовал, поэтому его bytes нельзя восстановить как непосредственный raw факт.

## Source/namespace proof и сырые данные

Executed helper SHA256
`5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49`
совпадает с предварительно reviewed bytes и последующей source сверкой.
Child rc0, stderr пуст.35journal records равны result.records, parsed child_stdout
и journal_raw. Namespace proof: host mntns4026531841, child4026533239,
initial userns4026531837, childPID731471/starttime10335798. Child≠host проверено
до make-rprivate. Child mountinfo83rows без shared/master/propagate_from.

Fresh images создавались под собственным v2 DATA на одобренном ext4 parent;
mkfs только inherited pinned regular file FD, оба rc0. Ext4 image64MiB
inode64225329; XFS384MiB inode64225332, оба uid0/backingdev2081. Это настоящие
disposable ext4/XFS loopback filesystems, не tmpfs substitution и не запись на
physical XFS /mnt/data. Loop8 повторно используется последовательно после
подтверждённого освобождения, не два одновременно.

## Независимо подтверждённые scenario outcomes

| Сценарий | ext4 | XFS | Граница |
|---|---|---|---|
| Новый process | PID731485, directory handle прежний | PID731523, handle прежний | Same child namespace; root process, не container recreation |
| Copy marker в другой directory object | Directory и marker handles различны; reported equal bytes | То же | Два собственных a/b objects; не full-FS clone и не production enrollment |
| Nested same-object bind | Handle прежний, unique mount ID иной, NO_XDEV errno18 | То же | Handle сам по себе не обнаруживает same-object bind |
| Same-object stacked bind | Handle прежний, unique mount ID иной | То же | Подтверждён distinction object/mount-instance |
| Live bind a→b над view | Fresh pathname даёт b; retained FD остаётся a | То же | Пин FD не удостоверяет current pathname или host source |
| Actual inode reuse | iteration1, inode17, handle изменился | iteration120, inode786560, handle изменился | По одному наблюдавшемуся reuse, не universal collision-free guarantee |
| rw→ro→rw remount | Handles прежние; actual mountinfo ro/rw | То же | Same mounted FS, не mount replacement/reboot |
| Clean unmount/re-mount same image | Directory и marker handle прежние; unique mount instance иной | То же | Same loop/image, normal fsync/unmount; не crash/power-loss/reboot |
| Cleanup собственных filesystem mounts/loops | remaining_mounts0/errors0, ENXIO after detach | То же | Kernel observation после каждой FS, без broad cleanup |

Raw handle examples: ext4 root a type1/8bytes `0c000000ea26a5ac`; XFS a
type129/12bytes `830000000000000023ba7f99`. Все сравнения выполнены opaque
type/length/bytes внутри конкретной FS. ext4 reused inode17 меняет handle
`110000001cc77cf8`→`110000005385224b`; XFS inode786560
`80000c00000000002c67b429`→`80000c00000000002d67b429`.
Finite generation/collision space остаётся ограничением, не доказанным отсутствием коллизий.

Clean remount: ext4 unique4295031384→4295031389; XFS4295031390→4295031395.
Directory/marker pins закрывались до clean unmount в reviewed source; retained
FD закрывается после live-bind теста. Copy marker bytes выводятся из reviewed
write/copy procedure и raw marker_equal=true; отдельного content hash после
каждой topology mutation в этом runtime evidence нет.

## Наблюдавшиеся идентификаторы, не являющиеся durable uniqueness

- Child namespace inode4026533239 совпал с failed-run child namespace ID после
  recovery proof, что old namespace исчезла. Это наблюдавшееся numeric reuse:
  namespace inode вместе с boot ID сам по себе не perpetual identity. Нужны
  runtime lifetime/holder/PID-starttime/fresh observation binding и anti-replay policy.
- Ordinary mount ID1025 повторён после clean remount на обеих FS;1044/1045 также
  повторяются между bind instances. В то же время unique mount IDs различались.
  Нельзя использовать обычный ID как durable/current instance fence.
- st_dev1800 (Linux7:8) и loop8 одинаковы для distinct fresh ext4/XFS images.
  Поэтому st_dev/loop pathname не FS provenance и не lifetime enrollment scope.
  Оpaque handles требуют отдельного trusted approved FS binding.

## Cleanup и сохранность

Оба v2 detach records содержат kernel_errno6/unbound=true; оба cleanup clean_tests=true,
remaining_mounts=[], errors=[]. Follow-up read-only отдельно видит loop8 block rdev7:8
и sysfs backing_file ENOENT, exact childPID731471 /proc/stat ENOENT. Listing содержит
NAME/null row, что подтверждает ошибочность прежней empty-array проверки; null
сам по себе не используется как доказательство cleanup.

В recovery initial/final, v2 initial/final и post snapshot independently проверены
26 уникальных контейнеров, все running и одинаковые ID/name/image/start/restart/health
records. Полный host mountinfo равен historical baseline; SHA256
`0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Post17 old R2.1 fixtures metadata/content равны historical baseline. Boot/self
namespaces continuity также сохраняется. PID1 readlink permission denied не
позволяет утверждать равенство self/PID1 namespace.

Это measured state equality, не гарантия отсутствия transient latency/atime,
изменений любых чужих bytes или агрегатной resource нагрузки. Fresh own image и
evidence trees остаются для reproduction; logical images old64+new64+384=512MiB.
Actual final allocated disk bytes и все new image metadata отдельно в данном scope
не пересчитаны. Loop освобождение не удаляет block-device node /dev/loop8.

## Что остаётся BLOCKED

Qualification выполнена privileged owner root в isolated disposable namespace.
Она не устанавливает штатный app/container deployment profile, container recreation
на этих writable FS, supplier/daemon-host view при Docker rprivate и continuity
host→container source. Нет actual trusted attestation issuance/freshness/challenge/
rollback/revocation/monitor-failure experiment или lifecycle интеграции enrollment.
Boot/kernel/оператор и quiescent hs/root writers доверены; privileged host adversary,
FS clone/physical provenance и hostile same-UID writers механизмом не закрыты.
Чистый remount не квалифицирует crash, host reboot, power loss или USB lifecycle.
Cross-filesystem live replacement под одним view и production FD admission/recovery
не испытаны. R2.2/MS-4 остаются за пределами авторизованного research checkpoint.

Следующее owner decision должно явно задавать disposable Docker supplier topology
и attestation модель, сохраняя production mounts/config/services. Нельзя повысить
gate за счёт handle equality или поменять production propagation ради эксперимента.

## Привязка к raw bytes

- recovery-result.json: `b141d0a8a2d6f219cb859f08120f8c959aeac3b1cc287de4c06b80fc8c177734`;
- root-run-result.json: `c4fc883c8a3156c3dbaa2eb1b5ec64feb45a8a87c61a861f6b39005b91b06e47`;
- root-run-journal.ndjson: `b061714dab86cac3cbaa3e4e0fff2d403e9d36d1c4914fec2ce68e3693f2f21a`;
- post-run-readonly.json: `07533ffa27ca3ec227517bc986db9980b1a4129680da56308882e20ed951d586`;
- cleanup-readonly.json: `298f3c492a225652937af17ad884d6fc50887ae9575e244d18531ec1974c77e0`.

Git HEAD/status/commit allowlist reviewer в этом runtime scope не проверял.
Запрещённый audit не читался/не искался/не хешировался. Никаких push/tag/release.
