# MS-3B-R2.1C — trusted attestation bridge: research contract

2026-10-12, Asia/Vladivostok. Research/prototype only. R2.1C_GATE and R2.1_GATE
remain BLOCKED until all mandatory native mapping/lifecycle gates have evidence.
Production NO_GO; secureOpen=false; additional workspaces disabled; no R2.2/MS-4.

## Trust and enrollment

Operator explicitly approves existing enrollmentId/revision, immutable workspace/location
and purpose, generation, FS profile, root/workspace/marker opaque handles, protected
parent ownership, daemon-side source and policy for mount replacement/remount. Expected
identity must live outside app-writable DB/storage and outside backend host UID write
authority. No first-seen enrollment, missing-root mkdir, handle/stat/marker fallback,
automatic revision reset or physical uniqueness claim.

Dedicated trusted host attestor owns private signing key, active revisions and observer
epoch. Backend pins operator-approved public key and context in protected deployment
configuration. A read-only bind alone does not protect a source writable by app host UID.
Prototype runs all host control as trusted hs and holds ephemeral Ed25519 key only in
host-process memory. Prototype public key is generated for the disposable test, NOT
a production enrolled root of trust. Same-UID hostile host writers are outside this test.
XFS existing root is sampled read-only for identity continuity, NOT enrolled as a
workspace. No XFS content enumeration or write. Disposable ext4 marker only is read.

Attestor needs trusted deployment/orchestrator authority to correlate exact CID/image,
container process start/lifetime, retained namespace FD, mount topology and capability.
Backend must never receive Docker socket, host networking, CAP_SYS_ADMIN, privileged,
extra capabilities or relaxed seccomp. Host-side Docker administrative access is trusted
and powerful; it is not made harmless by moving it outside backend.

## Challenge, lease, restart and rollback

Backend starts OFFLINE with fresh random 256-bit verifier epoch and one outstanding
256-bit nonce. Acquisition pins an O_RDONLY directory FD with openat2 and observes
the same FD with fstat/name_to_handle_at/statx. The lease signature covers version,
enrollment/revision, host boot, observer epoch, deployment, verifier epoch, nonce,
exact observation, expected identity, sequence, active state and TTL.

Verifier deadline is computed from its own monotonic time when challenge is emitted,
never extended from token arrival or host wall clock. Each response can be accepted once.
Any absent/stale/wrong signature/context/nonce/identity/sequence response closes admission.
Restart/recreation creates a fresh verifier epoch even if container ID or numeric
mount/namespace inode repeats. New attestor lifetime requires new observer epoch and
trusted operator/deployer update, not acceptance of an arbitrary signed old epoch.

Production authority must preserve current revision/revocation and refuse rollback
across crash/restore. Prototype pins fixed revision and uses volatile state; it does
NOT implement durable authority, revocation recovery, protected operator key delivery
or power-loss durability. Signature authentication is tested; host workload record is
included in signed token but consumer authentication currently rests on fresh verifier
epoch plus dedicated host attach channel, not independent proof of container identity.

## Source mapping and TOCTOU

Docker bind sources resolve on daemon host; default propagation is rprivate.
[Docker authoritative documentation](https://docs.docker.com/engine/storage/bind-mounts/).
Client/supplier namespace pathname is insufficient. A host observer must observe the
actual daemon-side supplier namespace and exact container namespace lifetime. Comparing
raw handles requires trusted FS scope; host/container unique mount IDs need not match.
Numeric namespace inodes, PID, ordinary mount IDs and dev_t can repeat.

Prototype holds its host mount namespace FD, host roots and container root FDs. It
compares sampled scoped FS+handle identities and exact Docker bind configurations.
Read access to daemon namespace may be denied; that denial is retained as evidence.
It does NOT pin daemon/container namespaces or prove their topology from privileged
observer access. Backend-provided observation is not authenticated measurement of an
uncompromised backend. Host inspection metadata alone is not lifetime proof.

Test directory rename substitution demonstrates pathname→object change while pinned
FD stays on original object. Restoring A after intermediate B demonstrates why equal
before/after samples cannot exclude ABA. These are directory changes, NOT live host
mount mutations or evidence for Docker mount propagation.

To claim serializable host-source freshness, cooperating mount/deployment operations
must acquire a trusted host orchestrator lock: fence admissions, drain workers, sample
daemon-source, acquire/pin exact capability, verify consumer mapping, authorize epoch,
then release. Out-of-band mount changes require a trustworthy observer plus bounded
failure lease; polling cannot eliminate unseen transient changes. Alternative guarded
Unix socket and SCM_RIGHTS capability handoff binds I/O to the host-acquired object,
but still does not prove the current pathname after later remount. Socket peer credential,
key/cgroup/deployment authentication and Docker namespace mapping need separate tests.
[Linux openat2 source](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/open.c),
[namespace FD lifetime implementation](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/nsfs.c).

## Revocation and already running I/O

Authenticated revoke message permanently fences local verifier until new enrollment
session. Missing channel/no renewal expires lease. Admission must be checked before
every bounded read/write/chunk/rename/delete/publication/cleanup. Native in-kernel call
or already admitted chunk can finish after revoke. Closing an FD does not roll back
completed I/O or guarantee cancellation of pending calls. A final publication must
serialize against a fencing generation in trusted control and metadata transaction.
Prototype proves cooperative next-operation denial, not forced cancellation, kernel
I/O interruption, durable upload fencing or production cleanup/recovery integration.

No universal timing guarantee: nominal prototype TTL is 3000ms from challenge. It
limits future cooperative admission under advancing local monotonic clock during awake runtime; Linux hrtime excludes suspend; BOOTTIME/no-suspend policy is required for suspend-inclusive freshness; scheduler
delay, blocked syscalls, host suspend, compromised backend and draining duration are
not a hard bound on completion or real-time revocation latency. Authority revocation
after issuance can remain unknown until revoke receipt/lease expiry.

## Alternatives and operator procedure

| Option | Benefit | Cost / unresolved boundary |
|---|---|---|
| Signed file in protected read-only directory | Simple offline delivery | stale replay/revision/freshness; mount a directory so atomic replacement is visible; file bind may retain old inode; needs challenges plus online authority |
| Authenticated local socket host agent | challenge-response + revoke push; no backend Docker privilege | agent/orchestrator access, peer authentication, disconnect/timeout behavior, monitoring and durable state |
| Trusted orchestrator serializes deployment/mount operations | closes cooperating check/acquire race | cannot police uncoordinated privileged changes; drain/fencing and crash recovery required |
| SCM_RIGHTS exact FD handoff | exact host object capability, no backend open_by_handle_at | transport authentication, FS/profile qualification and descriptor lifecycle; current pathname still separate |
| Backend-only mountinfo/handles | low privilege, object continuity diagnostics | cannot prove unseen rprivate host mutations or physical identity |

Operator procedure (design, NOT executed): verify host/daemon namespace lifetime and
FS source; approve protected enrollment+key+revision; fence deployment and drain workers;
start OFFLINE workload; authenticated fresh handshake+same-FD mapping; activate lease
only after full gate. Mount/remount/replacement, boot/observer restart, key rotation,
revoke or DR restore fences first and requires explicit policy-authorized re-attestation.
No automatic TOFU. Missing monitor/key/revision/mapping stays OFFLINE; never cleanup
replacement tree. Keep checkpoint hashes and operator decisions outside app write domain.

## Native safety and remaining experiments

Only fresh /home/hs/homecloud-test/r2-1c-bridge-v4-20261012-01a12cfd and
/mnt/1TB/homecloud-test/r2-1c-bridge-v4-20261012-01a12cfd are writable. Read-only XFS
root observation at /mnt/data repeats prior R2.1 read-only scope. Caches used by exact
image ID, pull never, no volumes/networks/ports. One capped container at a time, UID1000,
ALL caps dropped, NNP, Seccomp2, read-only rootfs; compiler gets only fresh own control
directory writable. New own label+CID guard before stop/remove; no global prune.

No root login/password request. Native writable XFS image continuity requires owner
root entrance for private mount namespace or isolated dedicated VM. Live daemon-host
remount/replacement on current server needs host namespace rights and separate consent:
STOP; no nsenter/mount/umount/propagation changes performed here. Prefer an isolated
daemon+VM for reproducible tests over any change in the 26-service daemon namespace.
Physical clone/root adversary/power loss not guaranteed by attestation.
