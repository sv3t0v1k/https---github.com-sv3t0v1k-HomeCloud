# R1 implementation design и threat model

2026-10-11. Целевой build Linux amd64, разработка macOS Docker Desktop.
Реализация выполнена; qualification BLOCKED. Глобальная secureOpen capability не повышается.

## Trust and assets

Защищаются upload ingress/staging/chunks, hashes и accounting, canonical user bytes.
API/DB paths недоверены. Kernel, application code/native binary и deployment ancestors
доверены; runtime UID владеет private `.tmp`. Противник подменяет descendant/ancestor
names и symlinks между admission и I/O, включая concurrent swaps и traversal.
Same-UID arbitrary content/hardlink/rename-out sabotage, root/namespace administrator,
physical device substitution/power loss требуют иных механизмов и не закрыты R1.
Descriptor-relative lookup защищает lookup, не делает открытый inode неподвижным.

## Capability acquisition

Native root открывает `/` как ancestor FD, затем absolute root relative key через openat2
BENEATH/NO_SYMLINKS/NO_MAGICLINKS. NO_XDEV при acquisition не ставится: storage root может
быть отдельным mounted FS. Native root должен быть directory owned by euid. Проверяется
соответствие native FD существующему legacy anchor по dev/ino; последующая legacy root
admission sticky при observable replacement. Missing workspace не создаётся.
При root acquisition выполняется descendant openat2 probe с полной protection mask.
ENOSYS/EPERM/EINVAL и отсутствие addon дают отказ без downgrade.

Это process-local acquisition, не durable enrollment. First-seen legacy authority после
restart остаётся прежней; marker/dev/ino не удостоверяют generation/physical provenance.
R2 не реализован и не начат; дополнительные UUID/capabilities запрещены.

## Operations and ownership

Native external capability private к TypeScript object; close идемпотентный, GC fallback
закрывает оставшийся FD. Node file FD передаётся конкретному stream или lexical owner,
не одновременно им обоим. Streams autoClose; borrowed hashing — async fs.read callbacks
с explicit offsets и64KiB buffer, expected-byte bound, без stream ownership.

Все descendant opens: BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV,
CLOEXEC|NOFOLLOW|NONBLOCK. File flags только r/rw/wx; exclusive create0600;
fstat regular/euid/nlink1. Directory opens O_DIRECTORY/euid. NUL/absolute/traversal
keys отказываются. JS принимает только canonical absolute bridge внутри operator root.

mkdirat, renameat2(NOREPLACE), unlinkat и enumeration используют pinned parent FDs
и один basename. mkdir EEXIST переоткрывается полной protection mask. Enumeration
открывает fresh directory FD, fdopendir владеет им; root capability не закрывается.
Recursive deletion не следует symlink и не пересекает mount, depth≤64; root deletion
запрещена. ENOENT при cleanup допустим, прочие ошибки не превращаются в pathname rm.
Rename EXDEV отказывается; source не копируется. Parents fsync после namespace mutations.

## Real integration

| Component | Descriptor operation / lifetime |
|---|---|
| UploadsModule Multer useClass | Existing legacy root acquisition, ingress mkdir; Nest teardown closes factory resolver |
| abortableDiskStorage | Exclusive FD before bytes, FD write stream, callback after close; abort stops stream, close owns cleanup |
| cleanup interceptor | Pending writer не удаляется рано; последующая cleanup relative to capability |
| create session | Descriptor mkdir after DB transaction; failure deletes orphan session row |
| upload chunk | Held ingress FD for validated size/hash; original stage FD for Buffer; same FD fsync and post-rename inode check before DB metadata |
| retry / hydration | One FD fstat/hash/fsync; published path identity check; no accounting inflation |
| finalizer input | One FD fstat/hash/read; expected-byte stream limit. Finalizer output protocol unchanged |
| cancel/expiry/orphan/stale/recovery | FD enumeration/inspection/unlink/recursive cleanup; existing DB locks/outcome handling retained |

A post-rename identity check refuses substitution before metadata commit. It does not
atomically prevent a fully authorized same-UID actor from changing content/names after
that check. Private staging/deployment ownership и исключение sabotage обязательны.
Unexpected publication может оставить orphan; нельзя выдавать это за repair чужих bytes.

## Build and evidence gates

Node-API addon compiled directly against Node headers, no node-gyp/new runtime dependency.
Docker builder adds gcc/musl-dev/linux-headers; runner only binary, USER1001. Addon resolved
from fixed app path, never storage/env lookup. Canonical services не обновлялись.

Kernel LinuxKit native arm64 passes production ingress/adversarial/PG/recovery evidence.
Production Docker amd64 build passes; amd64-emulated runtime returns ENOSYS before bytes.
Точная причина не установлена. Native Linux amd64 production host UNQUALIFIED.
Independent review completed with limitations; implementation checkpoint does not
close target qualification or authorize R2/production activation.
