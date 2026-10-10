# MS-2 — решения до реализации

INITIAL_HEAD: b83a422d039efac68eaf38f53ffb76fa000bd2c5 (проверен 2026-10-10).
Production NOT_READY / NO_GO; MS-1 COMPLETE. Три исходных untracked сохранены.

## Исходные контракты

Schema: неизменяемый StorageLocation UUID/machineKey/mountKey; File logical pair,
FK RESTRICT и UNIQUE; абсолютный bridge строго совпадает. Миграция/schema не меняются.
Config: STORAGE_PATH deployment-only, default /storage. Только legacy UUID разрешён
для bytes. UploadSession.tempPath/.tmp — прежний compatibility exception.
Consumers: StorageService create/copy/delete; UploadsService final target через placement,
owner/native/share/ZIP/preview через resolveFilePath; прямые fs после проверки существуют.
Health пишет root/.tmp; Multer setup создаёт ingress самостоятельно. Эти два root admission
обхода нужно оградить registry, не меняя ingress/workspace протокол.
MS-1 lstat/realpath/O_NOFOLLOW/fstat не устраняет concurrent ancestor replacement.
Current runtime: Node20.20.2 Linux Docker Desktop, nextjs UID/GID1001; /storage отдельный
rw ext4 bind named volume в mount namespace, dev65025/ino579507 на момент чтения.
No root creation уже действует в StorageService, но отсутствующего mount root недостаточно.

## Решения

1. Registry — immutable operator bindings (id, machineKey, mountKey, root, writable,
   identity/profile), плюс DB identity matching. Только root из operator config; DB/API root
   не используется. Публичного registration/admin endpoint нет. Runtime default содержит
   лишь legacy binding. Другие bindings можно проверять internal interface/tests, но нельзя
   разрешать их для пользовательского I/O в MS-2.
2. Production legacy bootstrap — отдельная operator operation на существующем exact Linux
   mount: exclusive nofollow marker, фиксированные UUID/machine/mount keys; приложение не
   создаёт marker или root автоматически. Проверять marker через fd/fstat с size bound,
   root stat + statfs, exact mountinfo entry; pin fingerprint на срок процесса и сравнивать
   перед resolution/probe. Read-only/absent/wrong marker/identity change не допускают writes.
   Рестарт переустанавливает process pin; marker можно клонировать, это не криптографическая
   аттестация диска. Docker Desktop/NFS/host identity не считается доказанной.
3. Node20 не предоставляет openat2/openat dirfd. В MS-2 native dependency не оправдана:
   byte I/O новых locations всё равно запрещён. Expose explicit secureOpen capability=false
   и fail-closed descriptor request. Legacy использует прежний trusted exclusive-directory
   профиль; root/ancestor/symlink validation усиливается, но adversarial TOCTOU остаётся.
   Untrusted directories и несколько user storage roots запрещены до qualification.
4. Diagnostics различает online/read-only/offline/identity-mismatch/degraded. Реальный
   exclusive write/read/unlink probe только после identity и только trusted legacy; statfs
   свободные bytes не являются capacity admission. Read-only никогда не пробуется записью.
   Неверифицируемый mount/security profile — degraded и запрет writes; paths не возвращаются
   новым locations. Никакого fallback к empty directory.
5. Legacy portable dev/test constructor нужен migrations/isolated tests на macOS временных
   каталогах: явно ограниченный trusted directory profile, root identity pinned при первом
   использовании; не применяется production StorageService. Production non-Linux без
   qualified mount adapter fail closed. Algorithms chunks/finalizer/EXDEV не меняются.

Threat model: приложение/оператор и exclusive legacy namespace доверенные; request/DB keys,
absent mount, случайная подмена volume/marker, symlink input недоверенные. Privileged host,
mount namespace mutation во время syscall, злонамеренный writer той же UID и cloned marker
через restart вне доказанных гарантий. NO_GO сохраняется. Нужны Linux hardware/NFS и
race-free descriptor qualification прежде чем расширять модель доверия.

Primary references: https://nodejs.org/docs/latest-v20.x/api/fs.html ;
https://man7.org/linux/man-pages/man2/openat2.2.html ;
https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html .
