# Исправленный ручной запуск: recovery loop8 и новый RUN

Первый helper остановился до ext4 mount на строковой проверке BACK-MAJ:MIN.
Вероятная причина — padded util-linux output; такой формат подтверждён upstream
исходником, но root raw row этого запуска не был сохранён. Окончательно
подтвердить его padding можно только в recovery-result.json следующего ручного входа.
Остался собственный loop8; сохранён собственный fresh64MiB ext4 image, inode64225325
на Linux dev2081 (8:33). XFS не создавался. User data/current mounts не менялись
по root-run initial/final invariants и последующей read-only сверке.

Повтор старого RUN запрещён. Исправленный helper использует fresh exclusive
`r2-1b-v2-20261011-01a12a22`, числовое сравнение major/minor и raw identity журнал
до guards. Исходные scripts/results/образ остаются для расследования. 10 offline
parser/rejection checks PASS не являются runtime FS qualification.

Условия: trusted operator/kernel/host и quiescent hs/root writers. Не менять оба
test projects/DATA trees во время запуска. Источники проверяются pinned FD+SHA256
перед root execution. Recovery допускает единственный detach loop8 только если
он сейчас совпадает с recorded regular image dev/inode/size/owner/nlink и root
loop metadata. Проверяет отсутствие живой old namespace, mount users и открытых
block-device FD во всех доступных /proc records. Отказ доступа, reuse, mismatch,
busy/unknown state→STOP без detach; нет force, prune, physical umount или удаления образа.
Проверка не atomic относительно hostile root: это исключённая модель угроз.

Recovery сначала сохраняет proof/raw row и проверяет identity ещё раз, затем
detaches только verified loop8 и требует ENXIO от read-only LOOP_GET_STATUS64
(не принимает null JSON как доказательство). При incomplete proof
новый helper не начинается. После успеха — fresh26/mountinfo baseline и sequential
isolated ext4≤64MiB/XFS≤384MiB исследования; old64MiB image сохраняется отдельно.
Если helper аварийно завершится, новые собственные loops могут потребовать recovery
по журналу; namespace exit не гарантирует global loop cleanup. Broad cleanup запрещён.
CPU nice10/RLIMIT_AS256MiB не hard aggregate guarantee; timeouts/limits прежние.

После загрузки reviewed source владелец выполняет **один раз** на Mac:

```sh
ssh -t -o StrictHostKeyChecking=yes hs@192.168.3.44 'sh /home/hs/homecloud-test/r2-1b-v2-20261011-01a12a22/manual-launch-v2.sh'
```

Пароль sudo только в терминале; не отправлять в чат. Агент не выполняет root entry.
Recovery/root research results автоматически сохраняются в own v2 PROJECT; после
выхода агент read-only забирает их и проверяет invariants/cleanup/actual test evidence.
До проверки **R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED**, secureOpen=false, extras disabled,
production NO_GO. Docker mapping/rprivate attestation, reboot, physical uniqueness
не квалифицируются этим helper. R2.2/MS-4 не начинать.
