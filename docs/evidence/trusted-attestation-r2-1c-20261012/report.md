# MS-3B-R2.1C — Trusted Attestation Bridge

2026-10-12, Asia/Vladivostok. **R2.1C_GATE=BLOCKED; R2.1_GATE=BLOCKED.**
Research checkpoint сохранён: native transcript protocol и read-only object continuity
подтверждены, complete trusted daemon-source→container-capability binding не доказан.
**Production NO_GO; secureOpen=false; additional workspaces disabled.** R2.2/MS-4 не начаты.
R1/R1Q PASS сохраняется только в ранее квалифицированном scope, новый R1 gate не запускался.

INITIAL_HEAD=`1e7ca59727060fef72212cca29ba256265540e9b`, `main`, expected=actual.
FINAL_HEAD — отдельный русский evidence commit, содержащий этот отчёт; exact SHA
приводится в итоговом ответе. Self-SHA не включается в тот же commit.
Production source/schema/dependencies/config не менялись. Разрешены только новые
research/evidence files и documentary запись единственного `docs/ROADMAP.md`.
Три исходных untracked сохраняются; запрещённый audit не читался/искался/хешировался/
изменялся/stage. Push/tag/release отсутствуют.

## Что выполнено и доказано

[Проверяемый design и operator procedure](design.md), [верификатор](bridge.cjs),
[consumer](consumer.cjs), [host runner](run-host.cjs), [C same-FD observation](identity-probe.c),
[read-only openat2 acquisition](observe-fd.c), [protocol tests](protocol-tests.cjs).
Это standalone research, не production adapter/enrollment.

Host hs создаёт ephemeral Ed25519 signing key в памяти; приватный ключ не записывается
и не выводится. Public key только данного test-run доставлен через RO control directory.
Host challenge-response channel — stdin/stdout собственного exact Docker CID через
trusted host Docker CLI. Backend контейнер не получает socket/host privileges/network.
Данный test-root-of-trust создан исследовательским runner, не является production
operator enrollment, защищённым от same-UID writer. Никакого автоматического TOFU
в production не реализовано.

Verifier проверяет signed boot/observer/deployment/enrollment/revision, fresh random
256-bit process epoch и nonce, sequence, active state, exact observed/expected identity,
TTL. Single outstanding challenge; локальный monotonic deadline задаётся при challenge,
не продлевается прибытием token. Отказ сбрасывает admission. Signed revoke fences
verifier; без renew истечение lease закрывает следующий допуск.

### Native runtime

Ubuntu22.04 target, kernel6.8.0-134-generic, x86_64; Docker28.2.2 amd64, builtin seccomp.
Host Node18.20.8, consumer Node20.20.2. Использован только exact cached image
`sha256:c3ff13b395fdf1f251c33ff475318e1c2b8a683e268dcb25142e47d20efba90f`, pull never.
Host static C и host addon собраны native; container addon заново собран native musl
компилятором в отдельном собственном контейнере. Compiler exit0/Werror, OOMfalse.

Контейнеры UID1000:1000, cap-drop ALL, CapEff/CapPrm0, NNP1, Seccomp2, RO rootfs,
network none,128MiB memory/no extra swap,0.25CPU,pids32. Последовательно, без ports/
новых networks/volumes. Compiler RW bind только к fresh собственному control directory;
consumer имеет ровно три RO/rprivate binds control/ext4/XFS. XFS bind recursive disabled.
UID1001 production ownership/enrollment и реальный backend здесь не квалифицированы.

[Raw native result](native-result.json) содержит три consumer lifetimes:

| Сценарий | Факт | Граница |
|---|---|---|
| Create + Ed25519 challenge/lease | accepted, exact disposable marker `BRIDGE_A` прочитан через retained FD/openat2 | test authority, cooperative backend |
| Signed revoke | acceptedBeforeRevoke=true, next admit DENIED | I/O завершился до revoke; active in-kernel cancellation не испытывалась |
| Restart same CID | previous epoch token DENIED; fresh lease accepted; same token replay DENIED | volatile process state, fresh random epoch |
| Recreation new CID | previous epoch token DENIED; fresh lease accepted; real timer expiry DENIED | 3000ms challenge-based awake monotonic lease, не real-time completion bound |
| Ext4 same-FD opaque identity | type1/8bytes handle сохранён через3lifetimes | own directory на mounted ext4, без FS remount/reboot |
| XFS same-FD opaque identity | type129/12bytes handle сохранён через3lifetimes | только read-only существующий XFS root, не writable disposable XFS workspace |
| Numeric namespace / mount IDs | numeric namespace inode и ordinary mount IDs повторились | fresh verifier epochs3разные; числа не lifetime proof |
| Own ext4 directory rename A→B | fresh pathname identity отличается; pinned host FD остаётся A | это directory substitution, НЕ mount/daemon-host mutation |
| Restore B→A | before/after sampled identity равна при промежуточной подмене | наблюдаемая ABA граница sampled protocol |

Контейнер приобретает O_RDONLY root FD через openat2; дочерний C probe получает дубликат
именно этого FD, а не повторно открывает root pathname. Marker открывается относительно
retained directory с BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV. XFS root только
fstat/statfs/name_to_handle_at/statx; содержимое XFS не читалось и не перечислялось.
В V4 сохранены public key и3signed lease envelopes + signed revoke. Offline verifier
независимо проверяет все4Ed25519 signatures и trusted context. Private key не сериализуется.
Это signature/transcript authentication, не independent trusted measurement. В V3
envelopes не сохранялись; прежние ограничения сохранены вместе с его exact sources.

## Проверки и отказавшие попытки

- **32/32 local protocol model PASS**, [результат](local-protocol-tests.json).
- **32/32 native protocol model PASS**, внутри native-result. Это synthetic clock/context:
  valid/absent/malformed/wrong key/tamper, wrong boot/observer/revision/enrollment/
  deployment/epoch/nonce/state/TTL/expected/observation/kind/sequence/version, duplicate
  replay/new challenge/recreation, deadline/delay/expiry/renewal, revoke/channel failure.
- **3/3 native container lifetimes rc0**, live old-epoch/replay/revoke/expiry результаты выше.
- **126/126 offline actual-evidence checks PASS**,
  [verifier](verify-evidence.py), [результат](evidence-verification.json).
  Это integrity/consistency evidence, не complete R2.1C gate.
- Compiler flags Wall/Wextra/Werror; Node syntax checks PASS. Production full suite,
  lint/typecheck/build, PG tests и50GiB не запускались: production code не менялся,
  research не подключён к app. Старые931/932tests не считаются новым прогоном.

Первый отказ сохранён [полностью](failed-attempt/native-result.json): compiler temporary
`./` на RO rootfs. Own container удалён, mount/container invariants равны. Его JS fixture
mtime_ns comparison терял precision выше2^53; это не exact nanosecond equality.
До V2 collector переведён на decimal strings и expected нормализован Python без потерь.
Финальный raw Python comparison с исходным baseline восстановил точную текущую сверку.

[V2 отказ](failed-attempt-v2/native-result.json): build/28modelchecks PASS, consumer
challenge-only и EOF, так как Docker OpenStdin=false; lease success не заявлен.
V3 добавляет interactive stdin без TTY, TEMP только own control; все retries в новых
exclusive RUN/CID names, старые artifacts не перезаписывались.
Каждый execution delta прошёл independent pre-execution review.

V3 успешно прошёл3lifetimes и28modeltests; exact sources/results сохранены
[отдельно](successful-v3/native-result.json). После own final audit найден signer
context overwrite: spread consumer challenge поверх trusted ctx. V4 заменяет его
строгим factory с exact4keys/string64hex nonce+epoch/deployment check, добавляет4
factory tests (1positive +3negative cases) (32total) и retained signed envelopes. Исправление прошёл independent
review, затем новый ограниченный native-run. Cooperative V3 caller лишних полей не
передавал; hostile-input defect не скрыт и в итоговом V4 устранён.

## Почему gate BLOCKED

| Обязательная область | Статус | Что отсутствует |
|---|---|---|
| Подпись/epoch/nonce/replay/expiry | PASS_OBSERVED_PARTIAL | durable authority rollback/revocation state и защищённая key distribution |
| Доверенный daemon-source → container FD | BLOCKED | namespace/lifetime/topology наблюдение trusted observer, а не самосообщение consumer |
| Exact workload instance | PARTIAL | CID/start/PID/startTicks записаны host и signed workload поле; consumer это поле не проверяет, а authenticates fresh process epoch/attach transcript |
| Live daemon-host remount/replacement под rprivate | NOT_RUN / STOP_SCOPE | требует host namespace rights; отдельного согласия нет; реальные mounts не трогались |
| Writable disposable XFS container continuity/remount | BLOCKED_ENVIRONMENT | root entry для isolated ext4/XFS images или dedicated isolated VM отсутствует; read-only root continuity не заменяет это |
| Strong host-source freshness / TOCTOU | BLOCKED | serialize cooperating mount operations + acquisition/fencing; до/после samples допускают ABA |
| In-flight I/O / publication revocation | BLOCKED | cooperative next-admission доказан; in-kernel stop/rollback и metadata publication fencing не реализованы |
| Operator enrollment/revision recovery | DESIGN_ONLY | protected durable store, deployment binding, DR/key rotation процедуры и квалификация |

Host daemon namespace `/proc/1134/ns/mnt` read вернул **EACCES**, а не доказанную
mapping/lifetime continuity. Удерживается только собственный host namespace FD, host
root FDs и consumer root FDs; daemon/container namespace FD pins не получены.
Signed равенство scoped FS+handle и Docker Source string не доказывает актуальный host
pathname или независимо удостоверенный container capability. Inspect metadata и numeric
namespace IDs insufficient. Threat model предполагает trusted hs/operator/root/kernel;
compromised backend/host measurement не аттестованы.

[Docker docs](https://docs.docker.com/engine/storage/bind-mounts/) подтверждают daemon-host
source/default rprivate; здесь live daemon-host remount не наблюдался. Контейнер сам
по себе не узнает невидимые host mount changes. Нужны отдельный trusted host agent
или orchestrator с доказанной supplier/container observation; monitor loss→expiry/offline.

Revocation закрывает следующий cooperative допуск, но операция, уже admitted или
переданная ядру, может завершиться. TTL не hard bound завершения. Linux hrtime исключает
suspend; требуется BOOTTIME или проверенная no-suspend policy для suspend-inclusive
freshness. Authority revocation неизвестен до сообщения/expiry; polling не атомарен.
Предлагаемый lock/drain/fencing protocol и SCM_RIGHTS alternative — design-only,
не экспериментально доказанные production гарантии.

Privileged host adversary, physical/full-FS clone и power-loss durability исключены
из заявленных гарантий. Attestation не доказывает physical uniqueness. Подпись не
заменяет источник доверия, protected revision/current state и реальное наблюдение.

## Сохранность, cleanup, нагрузка

[Initial inventory](initial-inventory.json) точно совпал с R2.1B checkpoint;17fixture
records. [Final read-only inventory](final-inventory.json) и native initial/final
совпадают с original containers/mountinfo/fixtures/boot/mount/user namespaces.
Полный mountinfo SHA256 неизменен:
`0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
26 контейнеров: IDs/images/StartedAt/restart counts/running/health записи равны.
Это выбранные service invariants; latency/FPS/OOM всех чужих процессов и все чужие
файлы не измерялись, zero-impact claim отсутствует.

За четыре прогона создано и удалено9own containers:4compiler и5consumer CIDs,
в успешных V3/V4 один consumer CID перезапущен. Exact label queries всех4RUN в final snapshot пусты;
cleanupErrors[], remainingOwned empty. Ручных mount/umount/loop операций0; Docker
временно создал штатные overlay/bind/container mounts собственных контейнеров.
После cleanup host mountinfo byte-equal. Новых Docker networks/volumes/ports0.
Реальные `/mnt/1TB`, `/mnt/3TB`, `/mnt/data` не mount/umount/format; host propagation
не менялась. Ни root entry, ни password/SSH key запросов не было.

Сохранены source/binaries/public test key/result JSON для воспроизведения, около
4856KiB project artifacts и80KiB allocated tiny ext4 fixture directories по final du.
Private signing key только в завершившемся process; signing service после прогона нет.
Старые protected R2.1B images/loops/fixtures не изменялись. Available RAM на исходном
snapshot4446MiB; V4 resource endpoints приведены в native-result.json. Это endpoints,
не transient peak/attribution; нагрузка ниже ограничена one-container128MiB/0.25CPU.

## Review и следующий предлагаемый checkpoint

[Independent pre-execution review](pre-execution-review.md) проведён отдельным read-only
AI subagent, не автором implementation. Найденные C argument/errno, collision cleanup
и numeric precision defects исправлены. [Final scoped review](independent-review.md)
принимает только BLOCKED/disabled outcome; AI review не human audit и не эксперимент.

Следующий предлагаемый **отдельно разрешаемый R2.1D**: dedicated disposable native AMD64
VM с собственным Docker daemon и private ext4/XFS images. Там qualify trusted host
observer namespace pins, authenticated channel/protected enrollment authority, actual
live daemon-source remount/replacement, writable XFS continuity, orchestrator
serialization/FD handoff и crash/revocation/publication fencing. VM параметры/лимиты,
mount targets, budgets и cleanup plan нужно отдельно утвердить до изменений.

На нынешнем сервере live daemon-host mutation НЕ выполняется: по прямому owner
stop-условию для host namespace нужен отдельный consent. Никакие реальные physical
mount mutations не предлагаются. R2.1C здесь остановлен; R2.2/MS-4 автоматически не
продолжаются. Production NO_GO остаётся.
