# MS-3B-R2.1B — disposable ext4/XFS runtime qualification

Испытания: 2026-10-11; документальный checkpoint: 2026-10-12, Asia/Vladivostok.
**R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED.**
Ручной owner v2 запуск завершился rc0. Low-level object/mount identity сценарии
на disposable ext4 и XFS подтверждены. Own-loop cleanup завершён. Дополнительный
non-root native Docker probe подтвердил отдельный namespace source mismatch при
restart/recreation. Однако container continuity на этих XFS/ext4 images, live daemon-host
remount и trusted host→container attestation остаются UNQUALIFIED; никакого production PASS/активации из этого прогона не следует.
Production NO_GO, secureOpen=false, additional workspaces disabled. R2.2/MS-4 не начаты.

Initial research HEAD `1fd5c1d0f95d6b75210c9738a8fe2512f41df91e`, main.
HEAD перед v2 result follow-up `9f9a85bb2b7e920e140c56957640777b15462c90`, main.
Final documentary SHA/status сообщаются после commit в итоговом ответе и локальном
git-checkpoint.json: self SHA нельзя включить в тот же commit. Production code,
dependencies/schema/config не менялись. Три исходных untracked сохранены; два
разрешённых JSON отдельно проверены по прежним SHA. Запрещённый audit не читался,
не искался, не хешировался, не изменялся и не stage. Push/tag/release отсутствуют.

## Recovery и изоляция

Владелец ввёл sudo password только в TTY и выполнил SHA-verifying launcher.
Agent root entry не выполнялся. [Recovery raw](recovery-result.json) подтвердил
old regular image dev2081/inode64225325/size64MiB и его own loop8 association.
Проверены387 process records: old namespace отсутствует, loop mount/open block FD
users0; association повторно совпала перед detach. Отключён только этот loop8,
kernel LOOP_GET_STATUS64 вернул ENXIO6. Recovery initial/final26/mountinfo равны.
Actual root BACK-MAJ:MIN — `       8:33 `: padded-format defect первого helper
подтверждён recovery observation и прежним буквальным guard. Старый image сохранён.

Exact executed v2 helper SHA
`5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49`.
[Root result](root-run-result.json) содержит child rc0, stdout/raw journal/final
invariants. [Journal](root-run-journal.ndjson) совпадает с parsed records и raw stdout.
Host mntns4026531841; child mntns4026533239, initial userns4026531837 одинакова.
Child PID731471/starttime10335798 подтверждён до первой mount операции.
Make-rprivate выполнен только внутри distinct child namespace; полный snapshot83rows
не имеет shared/master/propagate_from. Fresh images/loops/mkfs идут после этой проверки.
Реальная host mount namespace не изменялась; физические FS/disks не mount/umount/format.
Loop devices global, отдельное owner согласие на own associations учитывается.

В root-owned exclusive approved DATA subdir созданы regular pinned-FD images:
ext4 64MiB/dev2081/inode64225329 и XFS384MiB/dev2081/inode64225332. Mkfs обоих rc0
только через inherited `/proc/self/fd/4`, не block device. Последовательно использован
loop8, до/после каждого FS backing inode/numeric device/offset0/sizelimit0 проверены.
XFS внутри image — это не запись в реальный `/mnt/data`; writable каталог на physical
XFS не создавался и дополнительное согласие на него не потребовалось.

## Экспериментальная матрица

PASS_OBSERVED ниже ограничен single disposable native AMD64 root-helper run,
trusted quiescent operator/hs/root/kernel, O_RDONLY same-FD acquisition/observations.
Handle сравнивается как opaque type+length+bytes внутри одной одобренной FS.
Контейнеры/CAP-drop/default-seccomp/application UID этим helper не проверены.

| Сценарий | ext4 | XFS | Доказательство и граница |
|---|---|---|---|
| name_to_handle_at/statx из O_RDONLY FD | PASS_OBSERVED | PASS_OBSERVED | opaque type1/len8 и type129/len12; root probe |
| Новый process | PASS_OBSERVED | PASS_OBSERVED | PID731485/731523 отличаются от731471, handle/unique mount ID сохраняются; не container recreation |
| Copied marker / другой directory object | PASS_OBSERVED | PASS_OBSERVED | equal marker content при разных directory и marker handles |
| Actual inode recycling | PASS_OBSERVED | PASS_OBSERVED | inode17 повторён на итерации1; inode786560 на120; opaque handle меняется в обоих случаях |
| Nested same-object bind / NO_XDEV | PASS_OBSERVED | PASS_OBSERVED | handle сохраняется, unique mount ID меняется; crossing rc-1/EXDEV18 |
| Stacked same-object bind | PASS_OBSERVED | PASS_OBSERVED | same handle, new unique mount instance |
| Live bind replacement другим directory той же FS | PASS_OBSERVED | PASS_OBSERVED | новый pathname→object b; retained FD остаётся на object a/старом mount |
| rw→ro→rw remount | PASS_OBSERVED | PASS_OBSERVED | actual ro/rw mountinfo flags; handle и unique mount instance сохраняются |
| Чистый unmount/re-mount того же image | PASS_OBSERVED | PASS_OBSERVED | directory/marker handles сохраняются, unique mount instance меняется; перед unmount scoped fsync/закрытие pins |
| FD-based observation | PASS_OBSERVED | PASS_OBSERVED | fstat/NTH/statx одного pinned FD; это не trusted external expectation/production acceptance |
| Container restart/recreation на этих images | NOT_RUN | NOT_RUN | historical R2.1 ext4 результаты отдельно; XFS workload/container continuity не квалифицирована |
| Replacement другим filesystem/FS clone | NOT_RUN | NOT_RUN | same-FS bind replacement не закрывает cross-FS scope и clone |
| Docker source namespace / default rprivate | PARTIAL_OBSERVED | UNQUALIFIED | отдельный non-root probe: daemon-host ext4 source отличается от private tmpfs supplier при replacement/restart/recreation; не live daemon-host remount и не XFS container qualification |
| Trusted runtime attestation/freshness/replay | UNQUALIFIED | UNQUALIFIED | design boundary ниже, implementation/native end-to-end test отсутствуют |
| Reboot/power-loss/physical uniqueness | UNQUALIFIED | UNQUALIFIED | clean remount не crash/reboot; physical uniqueness не доказывается |

## Обнаруженная граница runtime identity

Ordinary mount ID1025 повторился при clean re-mount и между ext4/XFS, но unique
mount IDs изменились: ext4 initial4295031384→remount4295031389; XFS initial4295031390
→remount4295031395. Сам rw/ro flag remount сохраняет unique instance. Unique ID
описывает runtime mount instance, не persistent object и не physical drive identity.

Оба sequential FS получили Linux st_dev1800 (7:8): loop number/dev_t повторно
используется, поэтому st_dev не persistent FS binding. Raw handle equality нельзя
сравнивать между FS без отдельно доверенного filesystem/enrollment scope.
Также child namespace inode4026533239 повторился после завершённой первой попытки:
recovery доказал old namespace absent, затем v2 получил тот же номер. Numeric
namespace inode+boot сам по себе не доказывает continuity lifetime. Trusted observer
должен удерживать namespace FD либо давать проверяемый lifetime/observer epoch;
PID/starttime здесь различают исследовательские процессы, не заменяют complete attestation.

Pinned FD при live replacement остаётся на старом object/mount. Это подтверждает
правильную descriptor continuity и одновременно показывает: FD identity не доказывает
current pathname/host mount source. Nested/stacked same-object handle сохраняется,
поэтому handle без mount-instance/topology observation не обнаруживает эту границу.

## Native private supplier→Docker mapping и lifecycle

После root FS прогона выполнен независимый от него [non-root probe](rprivate-probe.py),
exact source SHA `6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696`.
До первого child mount доказаны distinct user/mount namespaces, UID0→host1000 и
own-userns CAP_SYS_ADMIN, затем private propagation83rows. Linux6.8
[tmpfs registration](https://raw.githubusercontent.com/torvalds/linux/v6.8/mm/shmem.c)
разрешает FS_USERNS_MOUNT. Только fresh own source/private-fs targets, tmpfs4MiB
и binds внутри child; root entry/loops/mkfs/host namespace mount не выполнялись.
Tmpfs здесь проверяет namespace mapping и не заменяет ext4/XFS persistent identity tests.

Initial-host hs Docker client создал два sequential own containers из exact cached
native test image, без pull/anonymous volumes. UID1000, cap-drop ALL, effective/permitted
capabilities0, NNP1, Seccomp2, read-only root/bind, networknone,96MiB memory/noextra
swap,0.1CPU,pids16. Docker.inspect подтверждает default bind propagation rprivate;
seccomp unconfined/CAP_SYS_ADMIN/privileged/docker.sock контейнерам не предоставлялись.

| Фаза | Private supplier | Обычный container / daemon-host source |
|---|---|---|
| Первый create | tmpfs object a, PRIVATE_A, dev108/ino3 | HOST_SOURCE, исходный ext4 object |
| Private stacked bind replacement a→b, затем restart того же CID | PRIVATE_B, dev108/ino5 | прежний HOST_SOURCE/dev/ino |
| Remove и recreate с новым CID под private b | PRIVATE_B | прежний HOST_SOURCE/dev/ino |

[Actual result/config/observations](rprivate-result.json): private supplier view меняется,
Docker берёт source из daemon-host namespace. Caller в этом опыте находился в initial
host namespace, Docker CLI внутри private supplier не запускался. Это native доказательство
различия этих views, **не** direct experiment live mutation в daemon-host namespace и
не квалификация rprivate propagation при таком host remount. Mount source строкой
не связывает отдельно одобренный private supplier с workload. Namespace inode4026533241
повторился во всех трёх consumer lifetimes; ordinary mount ID2698 повторился при restart/
recreate. Numeric inode/mount ID нельзя считать fresh workload observation.

Оба own CID удалены; own plans записаны до create, exact label/new-CID/bind guards
защищают cleanup. Supplier child rc0, own mounts/errors[], tmpfs освобождён. Result
initial/final совпали с26/mountinfo baseline, [final follow-up](final-readonly.json)
также подтвердил все17 fixtures и пустой exact own-label container listing.
[Static probe review](rprivate-probe-review.md) разрешил только scoped non-root run;
[независимый runtime review](rprivate-runtime-review.md) отдельно проверяет actual outcome.

## Host→container attestation — остающийся design-only blocker

Operator approval отдельно связывает enrollmentId/revision, immutable workspace/
location IDs, purpose/mountKey, trusted expected root/workspace/marker handles и
одобренный FS профиль. Runtime observation должна связать current boot, observer
epoch и удерживаемую supplier/host namespace lifetime, unique mount instance и
topology, workload/container instance+namespace, challenge/nonce и active revision.
UUID/marker/raw handle/st_dev/namespace integer отдельно insufficient; physical
uniqueness и privileged host/kernel adversary вне модели.

При container recreation требуются новая workload observation и повторная проверка
supplier continuity; равенство container mount IDs не ожидается. После supplier/host
clean unmount/re-mount handles могут сохраниться, однако mount instance новый:
нужна operator-controlled повторная аттестация. rw/ro flag change отдельный observed
сценарий и должен проверяться по policy. При boot/observer/namespace lifetime смене
нужна новая boot/epoch-bound observation; stale snapshots/revisions/challenges
отвергать. Подпись без freshness/anti-rollback/current revision не закрывает replay.
Monitor недоступен или mapping не доказан→offline до I/O/cleanup.

[Docker bind documentation](https://docs.docker.com/engine/storage/bind-mounts/)
описывает default rprivate и source на daemon host. Private helper mount не становится
daemon-visible FS через тот же path; narrow namespace mismatch теперь наблюдался
на native probe выше. Нужен отдельный bounded research протокол
daemon/supplier/workload mapping и native replay/freshness/recreation эксперименты.
Это критичный blocker, а не основание менять propagation реальных накопителей.
Production container не получает privileged, CAP_SYS_ADMIN, docker.sock или seccomp
unconfined. [Ранняя матрица/trust boundary](../report.md) остаётся исторической;
нынешний отчёт уточняет runtime observations и reuse namespace number.

## Сохранность, cleanup и проверка

Recovery initial/final, research initial/final и [post-run read-only snapshot](post-run-readonly.json):
26 unique running selected container records равны original preflight, полный host
mountinfo byte-equal. SHA256 `0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Boot/self namespaces исходные. Все17 старых R2.1 fixture metadata/content записей
совпали. Root FS helper не создавал Docker objects. Последующий non-root mapping probe создал
и удалил ровно два own containers, без собственных networks/volumes.
Observed available RAM4476→4511MiB, swap1875→1877MiB; transient minima, OOM/latency/
все чужие data bytes не измерялись, zero-impact не заявляется. Atime не invariant.

Ext4 и XFS cleanup: own mount stacks опустошены, errors[], clean_tests=true;
после каждого detach kernel ENXIO6. Global associations не оставлены по этому
root evidence. [Последующая проверка](cleanup-readonly.json): loop8 backing_file
sysfs ENOENT, exact child PID/proc/stat ENOENT. NAME/null listing дополнительно
сохранён, но null не используется как самостоятельное доказательство unbound.
Loop8 device node остаётся обычным host device, association очищена, а не удалён весь node.
Child namespace завершилась; numeric inode может быть reused и не считается остатком.

Сохранены только собственные source/evidence projects двух root RUN и root-owned DATA
trees/images для review/reproduction: old ext4 64MiB + new ext4 64MiB + XFS384MiB,
всего512MiB logical sparse image budget. Physical allocated size здесь не измерен:
hs не читает protected DATA trees, лишний root entry ради size не выполнялся.
Все FS mounting/mutations были в approved isolated disposable scope. Service/config,
real mount state и data вне approved test directories не менялись исполнявшимися командами.
Protected retained images без дополнительных owner действий не удаляются.
Дополнительно сохранены own hs-owned0700 rprivate project/control/results/plans и
approved ext4 DATA source marker/empty targets. Tmpfs и оба контейнера освобождены;
дополнительных images/loops нет. Финальный swap/RAM snapshot приведён в final-readonly.json,
не измеряет transient effects.

[Offline verifier](verify-runtime.py): **95 checks PASS**, непосредственно проверены
raw recovery/journal/loop identities, FS handles/mount transitions, reuse, cleanup,
five host invariants, original fixtures и reviewed source SHA. Это проверка actual
evidence, не runtime Docker/attestation qualification. [Results](runtime-verification.json).
Дополнительный [mapping verifier](verify-rprivate.py): **36 checks PASS**, exact source,
private proof, lifecycle/config/effective profile, source object mismatch, own cleanup
и full final26/mountinfo/fixtures invariants. [Results](rprivate-verification.json).
Ещё5 offline syntax/atomic publication/mocked consumer parsing checks PASS,
[rprivate-offline verification](rprivate-offline-verification.json); это не runtime qualification.
Backend/PG suites/lint/build не запускались: production/dependencies неизменны.
Независимый scoped AI reviewer отдельно проверяет raw outcomes; verdict и ограничения
в [runtime review](independent-runtime-review.md). Это отдельный AI review, не внешний human audit. Финальная согласованность отчёта
и checkpoint проверяется в [final report review](final-report-review.md).

После смены дня сохранён отдельный [checkpoint snapshot](checkpoint-readonly.json),
2026-10-12 07:50:06 Asia/Vladivostok (2026-10-11T21:50:06Z). Исходные26/mountinfo/
boot/self namespaces/17fixtures по-прежнему равны baseline, exact own label пустой:
[7 final consistency checks PASS](checkpoint-verification.json). Прежние reviewed raw
snapshots не перезаписывались.

Next action — отдельный исследовательский checkpoint для trusted host/supplier→Docker
attestation bridge, namespace lifetime/observer epoch и replay/freshness, container
recreation на XFS и live daemon-host disposable remount,
с сохранением запрета host physical mount mutations и production привилегий.
До native evidence критичных сценариев оба gates **BLOCKED**, production NO_GO.
Данный rc0 не разрешает R2.2/MS-4. Старые launcher не повторять: output/DATA exclusive,
все необходимые own-loop detach уже завершены.
