# Ручной однократный root запуск — пока не выполнен

Владелец отдельно разрешил только собственные disposable loop allocation/detach и
ручной root-вход. Helper не запускается через SSH агентом. Независимый review
исправленного helper допускает ручной запуск с перечисленными ниже ограничениями.
SHA256 helper: `8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426`.

После подтверждённой загрузки reviewed source владелец выполняет на Mac один раз:

```sh
ssh -t -o StrictHostKeyChecking=yes hs@192.168.3.44 'sh /home/hs/homecloud-test/r2-1b-20261011-01a12a22/manual-launch.sh'
```

sudo запросит пароль в вашем терминале. Launcher открывает helper source через
O_NOFOLLOW, проверяет owner/type/mode/size/SHA pinned bytes, затем передаёт SOURCE
в памяти в isolated Python. Введённый пароль не попадает в command/history/evidence.
Не запускать в отсутствие quiescent writers или при несовпадении SHA.

Предпосылка: trusted operator/host/kernel, hs и другие root процессы не меняют
approved parent/project/data paths во время запуска. Parent hs:hs/0700 защищает
от других обычных UID, но не от самого hs; hostile same-UID/root writer вне модели.
Directory ancestry checks не заменяют эту предпосылку. Не запускать одновременно
с работой, меняющей эти test paths. Loop allocation глобален; безопасный отказ
EBUSY или identity mismatch должен остановить helper, без вмешательства в чужой loop.

Helper последовательно использует два fresh images 64MiB ext4/384MiB XFS, root-owned
exclusive 0700 DATA. Остальные root процессы/real mounts/services не меняет.
mkfs получает унаследованный FD доказанного обычного свежего файла; proc FD —
ссылка на этот pinned файл, не физический device. Loop association сверяется с
fstat backing inode и dev, offset/sizelimit0. Mounts — только внутри доказанной
новой namespace после rprivate. Native AMD64 statx ABI проверяется по kernel6.8
ожиданиям; отсутствие нужного syscall/mask→отказ без downgrade.

Root entry parent фиксирует fresh 26-container/mountinfo baseline. Child записывает
fsync journal до loop setup с proposed loop/backing ino/dev и сохраняет partial
evidence при исключении. После child exit parent сохраняет stdout/stderr и final
snapshot даже при ошибке/timeout. Journal и result остаются under own PROJECT,
fresh images под own DATA. Никакой Docker workload не создаётся.

Обычный cleanup делает только нормальные umount собственных подтверждённых
mountpoints и detach matching loop. При timeout/сигнале/kernel failure cleanup
может быть неполным: mount namespace exit освобождает её mounts, **глобальный loop
может остаться**. В этом случае не повторять запуск и не применять prune/umount -a/
losetup -D. Владельцу нужно сравнить только proposed loop из journal с BACK-INO и
BACK-MAJ:MIN fresh image. Несовпадение→не трогать. Совпадение позволяет отдельный
однократный detach только этого loop после проверки отсутствия использования;
cleanup при busy не форсировать. Timeout parent не гарантирует остановку всех
descendants: перед detach доказать завершение formatter/mount процессов и namespace
испытания; одна лишь смерть непосредственного child недостаточна.
Reviewer/агент должен затем сверить результат.

После ручного запуска агент read-only забирает root-run-result.json и journal,
сверяет initial/final snapshot, actual checks/cleanup и прежние fixtures. Не считать
команду rc0 полным PASS: container recreation на private loop FS, Docker rprivate
supplier mapping, trusted freshness/anti-rollback/attestation и reboot UNQUALIFIED.
Дополнительного физического XFS каталога этот helper не требует.

Не повторять existing RUN и не удалять прежние evidence ради collision bypass.
Production source/runtime остаются без изменений: secureOpen=false, extras disabled,
NO_GO; R2.2/MS-4 запрещены.
