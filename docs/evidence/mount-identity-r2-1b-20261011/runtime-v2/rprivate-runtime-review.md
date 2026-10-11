# Независимый runtime review private supplier / Docker source

2026-10-11. **ACCEPT scoped negative supplier/daemon mapping observation; gates
только BLOCKED.** R2.1B_GATE/R2.1_GATE не повышаются: secureOpen=false,
extras disabled, production NO_GO. Это не end-to-end trusted mount attestation.

Read-only local raw review result/execution, supplier-private-proof/a/b/result,
container plans и final-readonly; собственные assertions по raw values и
historical baseline. Reviewer не выполнял SSH, probe, mount/Docker mutations
или device operations. Отдельный scoped AI review, не human audit.

## Execution/isolation и наблюдавшийся mapping

Executed source SHA
`6e2ecc1edce6a2b14c0b802dd76e53f480e1d197f69cc7c8286986508bef7696`
совпадает с reviewed source. Execution rc0/errornull, child rc0/stdout/stderr empty.
Private proof соответствует supplier final isolation: host mntns4026531841 /
userns4026531837, child mntns4026533240 / userns4026533239, UID0→host1000/count1,
child CAP_SYS_ADMIN present. Оба child namespaces отличаются от captured host.
Full private proof83rows без shared/master/propagate_from; recorded mounts[]
в proof согласуется с его записью до tmpfs setup в reviewed source.

Own host SOURCE marker: HOST_SOURCE, Linuxdev2081/inode64225336. Private supplier
видит PRIVATE_A на tmpfsdev108/inode3, затем PRIVATE_B на dev108/inode5 через
другой bind над **тем же pathname в child namespace**. Отдельные a/b JSON равны
result/supplier-result observations. Host marker/object identity не изменились.

| Ordinary consumer lifecycle | CID | Фактически увиденный источник |
|---|---|---|
| First create/start under private A | cc9d3cc8f9b0… | HOST_SOURCE, dev2081/ino64225336 |
| Повторный start того же stopped container under private B | Тот же CID | Тот же HOST_SOURCE object |
| Новый container после removal первого under private B | f668362ec528… | Тот же HOST_SOURCE object |

В этом probe Docker CLI работает из **parent initial host namespace**, не из
private supplier. Docker daemon получает pathname и binds host-visible own SOURCE.
Private supplier FS view автоматически не становится daemon source. Это напрямую
наблюдавшийся отрицательный mapping case и важное ограничение helper topology.

## Ordinary consumer profiles независимо проверены

Два distinct containers, три observations. Exact cached image digest
c3ff13b3…ba90f, amd64, Config.Volumesnull. Все recorded configs: Privileged=false,
CapAddnull/CapDropALL, NNP, readonly rootfs, networknone, UID1000:1000,
memory100663296 (96MiB), NanoCpus100000000 (0.1CPU), pids16, own run label.
Single bind own SOURCE→/probe, RWfalse, Propagationrprivate.

Runtime observations CapEff/CapPrm0, NoNewPrivs1, Seccomp2. Каждый /probe
mountinfo record — ro ext4 host SOURCE, не tmpfs supplier. Это штатный bounded
consumer profile без app CAP_SYS_ADMIN/privileged/docker.sock/unconfined seccomp.
Mount/profile/source checks пересчитаны из raw values, не только итогового status.

## ID reuse и точная причинная граница

Все три consumer observations имеют numeric mount namespace inode4026533241,
включая differentCID recreation. Ordinary /probe mount ID2694 при first start,
2698 при повторном start и **2698 снова** при recreation. Эти числа не доказывают
perpetual namespace/mount-instance identity через lifecycle. Unique statx mount ID
в container mapping probe не измерялся; нельзя переносить v2 root-loop uniqueIDs
на этот Docker lifecycle.

Rprivate config подтверждён, но **host-visible source mount не изменялся**.
Probe не испытывает daemon-host live overmount/remount, stale consumer view после
host mutation, physical disk reconnect или continuous host→container monitoring.
Наблюдавшееся отличие private supplier обусловлено отдельной private namespace;
из него нельзя вывести, что причиной именно container rprivate propagation.
Tmpfs4MiB используется только для mapping, не для ext4/XFS identity qualification.
Нет name_to_handle_at из writable disposable ext4/XFS внутри этих consumers.

## Cleanup/host invariants

Supplier final status OBSERVED_PRIVATE_SUPPLIER_REPLACEMENT, mounts[],
cleanup_errors[]; оно равно result.supplier_result. Parent cleanup_errors[],
remaining_owned_containers[], childrc0. Durable plans содержат exact два own names;
final read-only docker ps с exact own label rc0 и пустой stdout/stderr.
Оба own containers removed; ничего не prune, существующие services не менялись.
Namespace exits и normal own unmount согласуются с reviewed source и child success;
loops/mkfs/global loop resources этот probe вообще не создаёт.

Initial/final/final-readonly самостоятельно сравнивались с historical baseline:
26unique running container selected records равны, full host mountinfo byte-equal,
SHA256 `0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Final17 old fixtures metadata/content также равны baseline. Это измеренные
snapshots, не zero-impact/latency/transient resource guarantee или total foreign
data audit. Собственные source/marker/evidence dirs сохраняются, cleanup не удаляет
их. Quiescent trusted hs/root writers и host/kernel остаются premise.

## Оставшиеся gate blockers

Не квалифицирован working supplier/daemon topology для **реальных disposable
ext4/XFS** consumers и restart/recreation с внешним trusted expected identity.
Не реализованы/не испытаны attestation issuance/authenticity/freshness/challenge/
revision rollback/revocation, boot/lifetime/mount-instance fences и monitor-failure
fail-closed I/O/cleanup. Нет host reboot/power-loss/remount lifecycle experiment
в end-to-end deployment. FS clone/physical uniqueness и privileged host adversary
не закрываются marker/stat/namespace numbers; production integration запрещена.

Следующий design decision должен определить trusted supplier authority и source
visibility на daemon host, затем acceptance experiments. Этот negative mapping
result уточняет blocker, а не закрывает его. Не менять production propagation/
mount state или давать application host privileges ради PASS.

## Raw hashes

- rprivate-result.json: `ec6ffbe621358f2a7c2cac3dadae0f0eb07292406a40964a877711dde2f78312`;
- rprivate-supplier-private-proof.json: `db98adcda1328adf91e3a8e6e91efea873aedd052e75ffecf1638a4b64281a6a`;
- rprivate-supplier-result.json: `79aed7d48d85d5a0dc56f4b2e79f1a4190aa6a83f6ba488d2335f4b726886074`;
- final-readonly.json: `370b6fb041f025d47a080d12008c81cc3b765f3c2ba3d934f14bdff720656b0a`.

Git HEAD/status/allowlist не входили в runtime scope reviewer. Запрещённый audit
не читался/не искался/не хешировался. Production NO_GO, R2.2/MS-4 не начинать.
