# Storage Registry & Secure Resolver — операторский контракт MS-2

Production остаётся NOT_READY / NO_GO. Пользовательские bytes доступны только legacy UUID
`f2f5c4b0-8d57-4c49-9f8c-0d095b344601`, machineKey/mountKey `legacy-storage`, deployment
root `STORAGE_PATH` (канонически `/storage`). Несколько locations, API/admin/UI и policy
не включены. Schema/IDs/File bridge, workspace/chunks/finalizer algorithms не меняются.

## Registry и интерфейсы

`StorageMountRegistry` принимает immutable список operator-only `ApprovedRoot`: id,
machineKey, mountKey, root, writable, profile, requireMount, requireMarker. `approved`
сверяет identity/key allowlist; roots из DB/API/browser никогда не разрешаются.
`inspect(id, writeProbe)` возвращает состояние и capabilities без root/секретов;
`assertAccess` проверяет fresh identity; `close` освобождает identity marker anchors.
`StorageRegistry` отдельно валидирует logical File placement/bridge/object key. Он возвращает
пути только legacy, даже если additional binding зарегистрирован для diagnostics.
`openSecure` всегда отказывает: **secureOpen=false** во всех профилях MS-2.
Default runtime bindings создаются из operator deployment config, не из rows DB.
Schema immutable keys/triggers MS-1 сохраняются; неизвестный DB UUID не обходит allowlist.

## Bootstrap и запуск

Production Node process требует Linux exact mountpoint `/proc/self/mountinfo`, без
stacked/nested mounts, и ранее provisioned `.homecloud-storage-identity`. Обычный пустой
каталог под mountpoint не принимается. Backend не выполняет mount, не получает root,
не создаёт mount root/marker на startup. UID/effective UID0 отвергается adapter/bootstrap.

Оператор перед rollout проверяет approved existing volume и его container-visible root,
владение runtime UID, отсутствие group/world write и child mounts, запрещает concurrent
root/mount mutations. Enrollment — явная отдельная команда **от UID сервиса**, после
проверки actual mount (и host backing identity там, где она требуется):

```text
STORAGE_PATH=/storage node dist/storage/bootstrap-storage-identity.js
```

Команда создаёт только новый marker `O_EXCL|O_NOFOLLOW` mode600, записывает version1,
legacy UUID/machineKey/mountKey, fsync file и parent. Никогда не mkdir/overwrite/repair.
Повторный bootstrap отказывает; уже существующий правильный marker проверяется registry,
не переписывается. Wrong marker требует остановки и операторского расследования, не auto-fix.
При ошибке fsync команда завершается ошибкой, marker может остаться. Следующий startup
может принять его корректное содержимое: registry не знает прошлый fsync outcome. Наличие
marker не доказывает успешный fsync/durability; продолжение требует решения оператора.

При startup выполняется actual exclusive write/readback/fsync/unlink probe до `.tmp` mkdir.
Probe internal namespace `.hc-probe-*` и marker запрещены как File object keys. Probe не
является capacity admission, measured throughput или power-loss qualification.
При observed identity failure cleanup не трогает replacement tree; возможен оставшийся
probe/artifact на старом volume, который надо отдельно reconcile. Нет fallback directory.

## Identity и состояния

Identity состоит из exact Linux mount tuple (mount ID/parent/device/root/point/type/source),
root dev/ino/realpath, statfs **type** и bounded marker FD validation. Mount и superblock
`ro` проверяются оба. statfs не содержит unique физического FS ID и не заменяет mountinfo.
Marker читается nonblocking/no-follow FD, regular/nlink1/dev/owner/mode/size проверяются.
Первый marker FD удерживается до shutdown: реальный Linux тест показал немедленное reuse
inode и coarse timestamps, поэтому timestamps сами по себе недостаточны. Marker pin также
содержит bigint ctimeNs/mtimeNs; fresh pathname identity сравнивается с process pin, который
не переустанавливается после failure. Identity anchors не являются user secure-open adapter.

| State | Значение |
|---|---|
| online | Trusted legacy identity допустима; actual probe PASS при writeProbe=true/startup |
| read-only | Writable выключен, mount/superblock ro либо write access/probe отказал; writes запрещены |
| offline | Root отсутствует либо exact mount отсутствует/неоднозначен/имеет descendant mount |
| identity-mismatch | Wrong/missing/unsafe marker, replacement root/mount/marker либо unverifiable identity |
| degraded | Adapter/security profile недоступен, privilege/ownership/read access/IO/probe cleanup failure |

Состояние включает security readiness. Additional verified writable mount остаётся degraded
с reason secure-open-unavailable, read/write=false; readonly additional mount может иметь
state read-only, но read/write=false. `logicalResolution=true` обозначает наличие approved
binding, а не разрешение выдавать пользовательский byte path.
Portable non-production constructor на macOS/Linux допускает заранее существующий trusted
exclusive directory без marker/mount qualification. Это dev/test/migration профиль; его
online НЕ доказывает физический mount. Production non-Linux fail closed, автоматического
переключения на portable нет. Existing read-only legacy resolver может читать, но writable
StorageService startup требует write capability (MS-2 не добавляет read-only product mode).

## Доказанные и недоказанные гарантии

Доказаны тестами: key/path/identity allowlist, strict bridge, malformed/traversal/absolute
rejection без нормализации, static symlink/root replacement rejection, directory UID/mode
и dev boundary, Linux mountinfo descendant/stacked/escaped fields/ro parsing, marker/FIFO
checks, observed identity failure до write/probe и no root creation. Consumer regressions
и canonical runtime результаты отдельно в evidence; не выводить их из healthy alone.

**Предполагается**: оператор/UID сервиса доверенные, exclusive directories, отсутствие
concurrent ancestor/root/mount replacement во время операции. Legacy fs path операции
между check→open сохраняют TOCTOU. O_NOFOLLOW/fstat download guards сохранены, но parents
не race-free. Hardlinks через доверенного локального writer, privileged host и mount
namespace attacks не квалифицированы. No openat2 protection. New/untrusted locations blocked.

Marker — label, не секрет и не аттестация физического mount. Копия правильного marker на
другом mount через restart может быть принята; process pin не переживает restart. Нужна
operator/host enrollment authority для физического диска. Linux container exact mount
не доказывает Mac backing disk, propagation, отдельный HDD/SSD или capacity failure domain.
Docker Desktop VM и NFS/SMB (reconnect, file handles, fsync/power loss, coarse identity)
требуют отдельной qualification. Sync filesystem calls могут зависать на broken remote FS;
bounded remote worker/cancellation здесь не реализованы.

MS-2 не меняет mounts или архитектуру backup/restore. Существующий reconcile.py лишь
исключает marker/probe metadata из inventory пользовательских файлов. Marker новый
internal metadata artifact; его recover/enrollment после restore проверяет оператор до
production startup. Существующий backup включает его обычным root payload, но это не
N-location/physical identity DR qualification. Исторический 50 GiB PASS не повторяется и
не доказывает новый resolver либо SSD→HDD finalizer. MS-3 автоматически не начинается.

Источники платформенных ограничений:
[Node20 fs](https://nodejs.org/docs/latest-v20.x/api/fs.html),
[openat2](https://man7.org/linux/man-pages/man2/openat2.2.html),
[mountinfo](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html),
[Docker bind mounts/Desktop](https://docs.docker.com/engine/storage/bind-mounts/).


## Два назначения на доверенном сервере, подготовка этапа 1

`STORAGE_PATH` и `legacy-storage` сохраняют единственное постоянное размещение
File и источник скачивания. Опциональный `trusted-upload` binding предназначен
только для временного SSD workspace; его UUID запрещён File resolver и прежним
DB placement guard. Generic дополнительные хранилища с profile `blocked`
продолжают отказывать. `secureOpen=false` в Registry diagnostic не изменён:
descriptor upload boundary принадлежит отдельному `SecureFilesystem`.

SSD mount mapping задаётся оператором, immutable в экземпляре Registry и
проверяется при каждом SSD admission; source/fsroot/fs type проверяются также
при первом обращении после restart. Marker/root/mount pin и отсутствие nested
mount защищают от наблюдаемой смены. HDD доступность и legacy startup контракт
сохранены; недоступный опциональный SSD не переключает API на fallback directory.
Подробности конфигурации и границы проверок:
[Upload Workspace operations](upload-workspace-operations.md#подготовка-ssd-workspace-этап-1-2026-10-12).

Подключение реальных дисков, запись marker, изменение deployment и перенос
старого `STORAGE_PATH` на физический HDD в этом этапе не выполняются. Если legacy
storage ещё находится на другом носителе, код не может превратить его в HDD:
нужна отдельно согласованная операторская миграция.
