# Независимый scoped safety review перед native запуском

2026-10-12. Reviewer: отдельный AI subagent /root/security_review, read-only;
автор prototype: основной исполнитель. Это не внешний human audit.

Verdict: **ACCEPT_SCOPED** только ограниченного research-run.
Exact run-host.cjs SHA256:
`458d7751dc4e353169c010bb9731b8928672f690529be41b7acce6e0d4daca08`.

Reviewer прочитал bridge.cjs/consumer.cjs/protocol-tests.cjs/identity-probe.c/
observe-fd.c/baseline-collector.py и design.md. Найдены и исправлены до запуска:
- N-API чтение неинициализированного аргумента при отсутствии acquire argument;
- диагностический errno0 при отказе dup в inherited FD mode;
- запись result.json при коллизии заранее существующего test project. createdP
  теперь выставляется только после успешного exclusive mkdir; чужой project не трогается.

Только fresh approved P/D, own capped nonprivileged containers, /mnt/data RO metadata.
Никаких mount/umount/loop/host network/docker socket для workload, изменений существующих
CID. Low-load compiler и три последовательных consumer lifetimes допустимы.

Review явно оставляет gaps: sampled mapping/namespace lifetime, workload поле consumer
не проверяет, ABA, Linux monotonic suspend gap, durable revision/revocation/key delivery.
Одобрение безопасного research run НЕ доказывает trusted bridge и НЕ PASS gates.
После native raw evidence обязателен final review и exact payload hash verification.

## V2 fresh retry

Independent reviewer approved exact V2 run-host.cjs SHA256
`a32088634582e7a29cd5593fe9d1cc21979b6e79eb8250b514d27d3950533a00`.
Delta: fresh RUN/CID names, TMPDIR=/control for compiler temporary files.
All consumer mounts remain RO. Failed first run retained separately.

Additional correction independently reviewed before V2: fixture mtime_ns emitted
as decimal strings by collector; execute.py converts original precise Python integers
to strings before passing expected baseline to Node. First run JS numeric equality
was rounded above2^53; it is not claimed as exact nanosecond equality at that instant.
No filesystem mutation scope changed. Final raw Python comparison remains required.
Verdict: ACCEPT_SCOPED only; both gates remain BLOCKED.

## V3 fresh transport correction

V2 compile/model checks succeeded; container stdin closed before response because
OpenStdin was false. V2 records are challenge-only; no lease success is claimed.
Reviewer checked exact diff+SHA of run-host.cjs V3:
`902e42b0e515f99a7d73b313d0281b1f98e3d161bb52fe70eef6736655d454fd`.
Only new exclusive names and --interactive without TTY for stdin transport.
Verdict ACCEPT_SCOPED; unchanged restrictive profile, no privilege relaxation.

## V4 authority-context hardening and token evidence

Primary found V3 signer spread could let unexpected challenge properties overwrite
trusted context; fixed factory uses exact four challenge keys, string-only64hex nonce/
epoch, deployment equality and explicit context construction. Four added negative/model
checks,32total. Context overwrite never exercised by fixed cooperative V3 consumer;
it is nonetheless unsafe for an eventual hostile caller and has been removed.
Reviewer checked exact run-host SHA
`9f2f4d607fc757086fe92aa237af92d20e1a214427c2d4c35d0afd2e4c982266` and bundle delta.
Minor regex-coercion issue was hardened with explicit string types before execution.
Verdict ACCEPT_SCOPED only. V4 retains public key+3signed leases+signed revoke for
independent offline signature checks; no private key is serialized. New names only;
same caps/resource/network/RO profile. V3 exact seven sources/result retained.
