# Предлагаемый R2.1D: isolated daemon-source qualification

Это предложение, НЕ разрешение запуска и НЕ следующий начатый checkpoint.
Текущий R2.1C остановлен, оба gates BLOCKED. На существующем26-service Docker daemon
никакие namespace/mount mutations не выполнять. Владелец должен отдельно подтвердить
выделенную disposable native AMD64 VM и лимиты до creation/configuration/privileged run.

## Требования к среде и review перед выполнением

- Native x86_64 Linux VM, отдельный Docker daemon и собственный VM disk. Physical host
  /mnt/1TB, /mnt/3TB, /mnt/data и реальные Docker volumes/ports в VM не передавать.
- Размер images: initial design ext4≤64MiB + XFS≤384MiB; FS creation только fresh regular
  images, verified inode/owner/pinned FD. Loops принадлежат VM, не initial host kernel.
- Preliminary budget: one128MiB consumer и один trusted attestor at a time; полный VM
  RAM/CPU/disk cap утверждается по read-only ресурсам выделенного host. Не обещать
  отсутствие влияния при размещении на нынешнем8GiB home server.
- До mutations snapshot PID1/daemon/container namespaces и service/mountinfo baselines,
  удерживать namespace FDs и observer/workload epochs. Initial host namespace может
  быть VM namespace; это должно быть явно подтверждено owner. Нет реальных услуг в VM.
- Independently review helper/signer/transport/cleanup до root entrance; agent никогда
  не просит пароль/ключ. Privileged host attestor права внутри disposable VM явно
  утверждены, backend остаётся cap0/default seccomp/NNP/RO/no network/docker.sock.

## Матрица экспериментов

1. Writable disposable ext4/XFS container process/restart/recreation continuity; same-FD
   ownership/workspace/marker handles и no-XDEV профиль; unsupported fail-closed.
2. Trusted observer, authenticated deployment/channel, protected expected/current
   revision and durable revocation/restart state; adversarial challenge поля rejected.
3. Actual daemon-side own-image remount/replacement при rprivate consumer: fresh host
   pathname vs retained host FD vs retained consumer FD измеряются отдельно. Никаких
   предположений о равных namespace/unique-mount ID между host и consumer.
4. Change during attestation/acquisition, ABA, disconnect/stale/delay/wrong epoch/key/
   replay/restart authority; compare sampled protocol vs serialization/FD handoff.
5. Signed revoke при bounded async I/O и blocked/in-kernel operation: next admission,
   drain и publication fencing отдельно; expiry after suspend с BOOTTIME отдельно.
6. Root authority crash/restart/rollback/recovery, cleanup отказ при identity mismatch,
   FD leak/lifetime и собственные loops ENXIO после detach; full final invariants.

## Stop/cleanup/acceptance

Unknown mapping/isolation/ownership, чужой loop/service/disk, RAM shortage либо cleanup
uncertainty→STOP. Никакого автоматического trust или удаления replacement tree.
Остановить только exact own CIDs; drain verified own workers; закрыть FD pins; снять только
проверенные own mounts и detach own loops; сохранить source/raw/signed evidence и hashes.
Если full gate не доказан, оба gates BLOCKED. Даже research PASS не разрешает R2.2/MS-4.
Physical privileged-host/clone/power-loss guarantees не добавляются. После R2.1D снова
остановиться и предоставить checkpoint владельцу.
