# Независимый scoped security review — MS-3B-R2.1C / final V4

Reviewer: отдельный AI subagent `/root/security_review`, не автор прототипа. Работа только
read-only: сервер/Docker/root/native tests reviewer не запускал, файлы не изменял.
Выполнены собственные локальные проверки сохранённого evidence через Python/Node.
Review не является human audit. Этот текст сохранён primary из final reviewer message.

**Verdict: ACCEPT_SCOPED_RESEARCH_EVIDENCE. R2.1C_GATE=BLOCKED; R2.1_GATE=BLOCKED.**
Production NO_GO, secureOpen=false, additional workspaces disabled. R2.2/MS-4 не разрешены.

Проверены AGENTS.md, предыдущий R2.1B report, релевантный Multi-Storage contract,
bridge/consumer/host runner/C observation/collector, exact execution deltas,
design/report/reproduction/next-scope, все четыре native attempts, final inventory
и offline verifier. Final runner SHA256
`9f2f4d607fc757086fe92aa237af92d20e1a214427c2d4c35d0afd2e4c982266`;
все7V4 и7retained V3 sources независимо совпали с соответствующими executed manifests.
Это source/evidence consistency, не независимая remote binary attestation.

Выявлены и устранены N-API argument check/dup errno diagnostics, запись result после
exclusive-mkdir collision и numeric mtime_ns precision loss. Primary own audit
дополнительно выявил V3 signer context overwrite через consumer-object spread.
V4 strict factory требует exact4challenge keys, string64hex nonce/epoch и trusted
deployment equality, а trusted authority fields создаёт явно; unexpected consumer
fields не могут их переопределить. Reviewer проверил delta и потребовал explicit string
types, которые добавлены до run. V3 cooperative transcript не использовал лишние поля;
исторический defect и exact V3 sources сохранены. В report исправлены «mounts0» и
ошибочное описание4factory tests как четырёх negative tests. Неразрешённых material
defects в ограниченных final research claims не найдено.

Независимая локальная crypto verification всех4retained Ed25519 envelopes PASS:
3lease и1revoke; подписи, trusted context/expected identity, kind/sequence проверены.
Lease nonce/epoch/observation точно совпадают с последними raw native challenges.
Public key опубликован; private key не сериализуется. Это authenticated transcript,
не trusted independent backend measurement.

Raw V4 подтверждает3native x64 lifetimes rc0: lease acceptance; прежний epoch DENIED
при restart/recreation; duplicate replay DENIED; signed revoke и real timer expiry
DENIED для следующего cooperative admission. Scoped ext4 own-directory и read-only
XFS-root handles сохраняются через lifetimes. Namespace number/ordinary mount IDs
повторяются, unique mount instances различаются. Directory substitution/ABA измеряет
retained HOST FD, не consumer FD во время подмены.32native/local model checks и126offline
evidence checks правильно отделены от full gate.

Собственное Python сравнение original precise baseline → native initial → native final
→ final inventory подтвердило все6invariant groups, включая26container records и17fixtures
с exact decimal-string nanoseconds. Все4exact RUN label listings пусты; cleanupErrors
пусты.9own CIDs созданы/удалены за4прогона; только own CIDs подвергались lifecycle
operations. Docker временно создавал штатные собственные mounts; ручных mount/umount/
loop операций не было, final host mountinfo byte-equal. Failed compiler/stdin attempts
честно сохранены. Первый JS fixture comparison был lossy и не выдаётся за exact
nanosecond equality того мгновения. Latency/все чужие bytes/transient resource effects
не измерены; zero-impact не заявлен.

Обязательные blockers сохраняются: trusted daemon/container namespace lifetime/topology
и source→FD mapping; signed workload поле consumer не проверяет; daemon namespace
observation EACCES; durable protected enrollment/revision/revocation/key distribution
не реализованы; sampled acquisition допускает TOCTOU/ABA; actual live daemon-host
remount не выполнен; writable disposable XFS continuity/remount не квалифицированы.
Revoke измеряет следующий допуск после завершённого read, не in-flight I/O cancellation/
publication fencing. Linux hrtime awake-only; suspend-inclusive freshness и hard
completion bounds не доказаны. Physical uniqueness/clone, privileged host adversary
и power-loss durability вне гарантий.

Report/design принимаются только как documentary research checkpoint с обоими BLOCKED
gates. next-scope.md — проверяемое предложение отдельной native AMD64 disposable VM/
daemon, без передачи физических host roots, с owner resource/scope approval и
pre-execution review; VM не создана. После R2.1C автоматически продолжать нельзя.
Final Git diff/commit SHA, original untracked preservation и отсутствие production
изменений проверяет основной исполнитель перед завершением.
