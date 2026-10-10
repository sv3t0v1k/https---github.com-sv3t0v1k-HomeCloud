# MS-3B-R — узкий design и threat model перед syscall-probe

2026-10-11, Asia/Vladivostok. INITIAL_HEAD: `36216688e48d4d4b526bcd95498ac0e49fe0b858`.
Production **NOT_READY / NO_GO**. Дополнительная activation выключена.

## Активы, доверие и противник

Активы: существующие File/chunk bytes, immutable session/workspace binding, quota,
отказ от записи в underlying directory при отсутствующем mount. Недоверенные API/DB
paths не выбирают root. Исследуем подтверждённую замену ancestor symlink между guard
и I/O и подмену `.tmp` перед новым процессом. Kernel и оператор deployment доверенные;
root/namespace-administrator и физическая подмена устройства требуют host authority.
Same-UID attacker может менять contents/hardlinks/rename каталоги; openat2 ограничивает
разрешение пути, но не предотвращает sabotage или rename-out ранее открытого inode.
Нельзя обещать confinement к текущему pathname после arbitrary rename-out. Для полного
контракта нужны защищённые ancestor directories и модель допустимого изменения дерева.

## Реальный API и минимальный будущий boundary

Node20 fs API предоставляет pathname open и работу с уже открытыми file descriptors;
публичного dirfd/openat2/renameat/unlinkat API нет. Не заменять это realpath/lstat,
O_NOFOLLOW только для leaf или `/proc/self/fd/<dirfd>/...` как новым pathname API.
Предпочтение — отдельно reviewed Node-API addon, один module-owned root capability,
без shell/subprocess на запросах, без root, без третьих runtime dependencies.
Не загружать addon из workspace или writable пользовательского path. Сборка в Linux
с pinned toolchain/headers, CI на каждой архитектуре; ENOSYS/EPERM/EINVAL fail closed,
без downgrade на pathname operations. Probe C ниже — **не adapter и не production code**.

Root открывать от доверенного ancestor FD; сравнивать `fstat` + `statx(AT_EMPTY_PATH)`
обычный mount ID и STATX_MNT_ID_UNIQUE (при поддержке) самого FD с operator enrollment и exact mountinfo. Descendant openat2 требует
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`.
Flags фиксированные по операциям: CLOEXEC/NOFOLLOW/NONBLOCK, exclusive create mode0600;
fstat regular, nlink1, expected mount/ownership, bounded read. Returned file FD используется
stream/read/write/hash/fsync без повторного pathname open. FD lifetime/close ownership
и отмена stream обязаны исключать leaks/use-after-close и запись после revocation.

mkdirat/renameat2/unlinkat/fstatat/readdir работают с проверенными parent FDs и одним
валидированным basename. Rename no-overwrite для publication; EXDEV без copy fallback.
Hash/inode adoption и concurrent leaf replacement требуют immutable ingress ownership,
а не только безопасного parent. Recursive cleanup обходится по FD, symlink не следует,
при неизвестной identity/DB outcome сохраняет bytes. Fsync file и parent до DB commit.
Crash/orphan recovery сохраняет нынешний protocol; основной finalizer не переписывается.

## Обязательная карта реальной интеграции

- Multer create/write, abort/remove; module ingress mkdir.
- cleanup interceptor и chunk-ingress unlink.
- service session mkdir; ingress validation/hash; staging/create/adopt/rename/sync;
  canonical chunks, retry, hydration/reconcile.
- finalizer **чтение** chunks через безопасные FD; выходной finalizer protocol вне MS-3B-R.
- orphan/stale ingress enumerate/stat/remove; cancel/expiry/recovery recursive cleanup.

Один secure open wrapper не закрывает эту карту. `secureOpen=true` запрещён до реально
используемого adapter и adversarial/lifecycle acceptance. В blocked alternative production
код, DB/schema, binding, config и существующие bytes остаются без изменений.

## Durable operator enrollment, контракт до реализации

Record располагается **вне storage/workspace**, runtime получает защищённую read-only
configuration с доверенным ancestor tree. В нём version/workspace UUID/mountKey,
boot ID и mount namespace context, expected exact mountpoint/root/source/fstype/device,
root и workspace object identity, marker identity/token и attestation provenance оператора.
UID/mode/nlink/size config проверяются по FD; writable runtime enrollment не authority.
Marker сам по себе cloneable и не является доказательством physical device.

Runtime не создаёт root, `.tmp`, marker или enrollment. Missing/unknown/changed config,
absent mount, empty underlying directory, substituted `.tmp` или несовпадающий FD mount
дают отказ до записи и без fallback. Новый процесс только сверяет заранее enrollment,
не принимает first-seen identity. Наблюдаемая потеря sticky, активные sessions не меняются.

Mount ID не stable across reboot/remount и может переиспользоваться; device major/minor
также не durable physical identity. Даже в одном boot/namespace dev/ino могут переиспользоваться; нужен проверенный FS-specific
object generation/persistent identity либо явно ограниченная trusted operator attestation.
Cloneable marker не закрывает этот blocker. Предлагаемый первый контракт после этой проверки: process restart
в том же boot/namespace и том же enrolled mount/object. Unmount/remount/reboot/namespace
recreation требуют explicit operator re-attestation на host с подтверждением устройства,
не auto-update по скопированному marker. Physical host/UUID/clone provenance в Docker
Desktop из VM `/dev/vda1` не выводится. NFS/SMB отдельно не квалифицированы.

## План доказательств и стоп-условие

1. Disposable non-root/cap-drop ALL tmpfs, без `/storage`, DB и network: actual openat2,
   traversal/static/ancestor symlink отказ, pinned-parent rename/unlink, NO_XDEV,
   concurrent symlink swap, bounded fixture write/fsync, no outside bytes.
2. Actual restart counterexample **production compiled Multer/resolver**, не secure PASS.
3. Default-seccomp unshare EPERM; отдельный test-only unconfined private user/mount
   namespace может разрешить actual tmpfs tests, uid0 отображается только host UID1001.
   Это не runtime root/helper и не physical SSD/NVMe qualification. Все mounts cleanup сразу.
4. Targeted → full backend real PostgreSQL → lint/typecheck/build; read-only canonical
   row/FS inventory и health smoke до/после; никакого canonical rollout.
5. Два независимых scoped reviews, максимум один remediation cycle для harness/design.

Если whole lifecycle adapter, trusted enrollment или реальные target mount tests не
доказаны, checkpoint **BLOCKED**, activation disabled, `secureOpen=false`. Возможность
syscall в test executable не означает его использование Nest/Multer runtime. Не начинать
MS-4, не делать migration/UI/API/deploy,50GiB/push/tag/release.

Источники: [Node20 fs](https://nodejs.org/docs/latest-v20.x/api/fs.html),
[openat2](https://man7.org/linux/man-pages/man2/openat2.2.html),
[statx](https://man7.org/linux/man-pages/man2/statx.2.html),
[Docker Desktop bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

## Уточнение после независимого review и actual tests

Same boot/namespace dev/ino не дают persistent object identity. Actual fresh tmpfs remount
повторил **весь** обычный tuple `(dev, root ino, mnt_id, workspace dev/ino)`, не только
mount ID; скопированный label не различил mounts. Kernel STATX_MNT_ID_UNIQUE поддержан
и различил две mount instances. Это mount-instance discriminator в одном boot, не
physical disk proof и не inode generation для `.tmp` внутри того же mount. Внешний
enrollment должен проверять эти ограничения; никакая версия manifest не реализована.

Actual mount tests доступны только в отдельно созданном private user/mount namespace
с test-only seccomp=unconfined; normal unmount/remount и process SIGKILL выполнены.
Production остаётся non-root/cap-drop, без изменения seccomp, mounts или binary.
