# MS-3B — threat model и решение до квалификации

INITIAL_HEAD: `6f73cc53fe882326861d90e7918cf6318b0bb11d`, фактически подтверждён.
Дата: 2026-10-10, Asia/Vladivostok. Production NOT_READY / NO_GO.

## Threat model

Защищаем исходные файлы, подтверждённые chunks, immutable session/workspace binding,
quota reservations и отказ от записи на underlying directory вместо исчезнувшего mount.
Недоверенные входы: API uploadId/paths, persisted paths/keys, concurrent requests,
подмена symlink/ancestor между проверкой и I/O, неправильный либо скопированный marker,
неверный mount после restart, interruption, EXDEV. Оператор provision/mount authority
доверенный; произвольный root/kernel/service-UID attacker не исключается одним marker.
Угроза privileged namespace replacement требует отдельного deployment contract.

Legacy сохраняет ранее принятый trusted exclusive-directory профиль. Его known TOCTOU
не может считаться гарантией для нового workspace. Фактический boundary — только
legacy UUID/key/type + exact tempPath bridge; никакой persisted/API path не выбирает root.

## Предварительная capability matrix

| Платформа | Реальное доказательство | Activation |
|---|---|---|
| Linux native local FS | Здесь нет отдельного физического SSD/NVMe; syscall/seccomp и removal/remount не квалифицированы | UNQUALIFIED, disabled |
| Linux container Docker Desktop | Canonical Node20.20.2, Linux6.12.76-linuxkit, UID/EUID1001, CapEff0, seccomp2; fs/openat/openat2/renameat/unlinkat и RESOLVE flags отсутствуют | BLOCKED |
| macOS native | Production non-Linux adapter отказывает; portable fixtures только tests | UNQUALIFIED, disabled |
| macOS Docker Desktop host disk | Виден VM ext4 `/dev/vda1` named volume, не host SSD identity | UNQUALIFIED, disabled |
| NFS/SMB | Нет подключённой qualified share; reconnect, stale handles, durability и bounded I/O не проверены | UNQUALIFIED, disabled |

Kernel version сам по себе не доказывает доступность openat2 через runtime/seccomp.
Node API inventory подтверждает отсутствие callable adapter; наличие syscall kernel
отдельно не проверено. fdinfo mnt_id можно прочитать, но это не descriptor-safe I/O.

## Решение и границы

Проверяем разрешённую альтернативу: BLOCKED с activation disabled. Production код,
DB/schema/config/mounts не меняются, новых approved workspaces нет. Добавляем только
регрессионные проверки и воспроизводимые qualification evidence. Сначала targeted,
затем full backend с реальным PostgreSQL, lint/typecheck/build. Canonical runtime без
rollout; read-only identity/snapshot и прежний small fixture smoke, если нужен.

Native dependency/root/shell helper не вводится. Узкий openat2 wrapper сам по себе
недостаточен: ingress create, chunk publication rename, reads, unlink/rmdir/recovery и
finalizer должны использовать удерживаемые directory descriptors, безопасную FS boundary
политику и mount identity после restart. `/proc/self/fd/<dirfd>/...` содержит magic link,
не эквивалент RESOLVE_NO_MAGICLINKS; realpath/lstat/check→open неприемлемы.
Без подтверждённой deployment authority и physical mount qualification добавление wrapper
не закрывает acceptance. Это технический blocker, не обещание невозможности будущего adapter.

Registry marker+FD pin ограничен lifetime процесса; clone+restart — явный disqualifier.
Multer destination вычисляется один раз для legacy, до пользовательских запросов; session
binding проверяется до Multer, но destination не маршрутизируется по additional workspace.
Нельзя включать новый binding даже если root/marker доступны. Ingress и chunks должны
совпадать по FS; EXDEV не копируется. Finalizer сейчас собирает напрямую в legacy finalPath
из chunk streams; чтение с другого FS технически возможно, но secure cross-FS publication,
recovery и durability не квалифицированы и MS-4 здесь не реализуется.

Qualification scratch: один disposable `--rm` test container без network для FS probe,
UID1001, cap-drop ALL, отдельный tmpfs, без canonical volume. Actual tmpfs mount/empty
ordinary directory/EXDEV — kernel observations. Host removal/remount/SSD qualification
не подменяется этими результатами. Deterministic symlink interleaving производится только
в собственном scratch; наблюдённая unsafe legacy write — disqualification, не PASS security.

Независимые read-only reviews: descriptor security, mount identity, ingress/lifecycle,
DB integrity. Один remediation cycle на finding, затем BLOCKER. Запрещённый audit исключён
из всех поисков, не читается/изменяется/staged. Три исходных untracked сохраняются.

Источники: [Node20 fs API](https://nodejs.org/docs/latest-v20.x/api/fs.html),
[Linux openat2](https://www.man7.org/linux/man-pages/man2/openat2.2.html),
[Docker bind mounts/Desktop](https://docs.docker.com/engine/storage/bind-mounts/).
