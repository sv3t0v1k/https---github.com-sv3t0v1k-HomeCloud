# Independent scoped review — MS-3B-R1

2026-10-11, Asia/Vladivostok. Reviewer: отдельный read-only agent
`/root/independent_review`, не автор production implementation или tests.
**REVIEW_STATUS=COMPLETED_WITH_LIMITATIONS.** Safety restriction не возникла;
отказ не обходился, PR CI diagnostics tool не объявлялся security review.

Reviewer прочитал native addon/build, TypeScript boundary, реальные upload integration
modules и финальный diff, actual adversarial/recovery harnesses и logs, full suite и
lint/build summaries. Tests он независимо не перезапускал; основной исполнитель
проверил его findings по source/diff и фактическим результатам.

| Finding | Resolution |
|---|---|
| P1 ingress→stage inode authority заменялась reopened FD | Исходный ingress/stage FD удерживается через fsync/publication; canonical path сравнивается именно с ним |
| P1 retry size/hash/sync через разные opens | Один retained chunk FD, identity check до metadata adoption |
| P2 bounded read | expected-byte callback hashing; finalizer chunk stream end limit |
| P2 Multer resolver lifecycle | useClass factory с onModuleDestroy; actual Nest DI teardown без FD leak |
| P2 constructor acquisition failure cleanup | initial directory open входит в try/finally; native capability закрывается на failure |

Финальный независимый verdict: открытых P1/P2 findings в заявленной path-resolution
модели не найдено. Actual Multer failclosed/outside0,2000adapter attempts/ancestor swaps,
EXDEV without copy, symlink cleanup, fd lifecycle и two-process UploadsService+PG SIGKILL
recovery подтверждены прочитанными harness/logs. Full69/931 с9PG suites, lint0errors
и typecheck/build — evidence основного исполнителя, не отдельный reviewer rerun.

В LinuxKit arm64 process был SIGKILL после публикации+directory fsync до metadata insert;
новый service сохранил inode/bytes, повторил retry дважды, accounting и quota без inflation.
Это устраняет прежнюю оговорку «только standalone adapter crash», но не power loss.

Amd64 logs и source подтверждают ENOSYS propagation до ingress mkdir/upload bytes.
Успешный amd64 image export не доказывает amd64 operational support; точная причина
ENOSYS отдельно не установлена. Native Linux amd64 host, power loss, durable enrollment,
finalizer output и arbitrary same-UID sabotage вне qualification. Trusted ancestors нужны.

**Scoped implementation review завершён, full R1 PASS/production approval не выданы.**
R1_GATE=BLOCKED, production NOT_READY/NO_GO, R2 не разрешён. Решение владельца сохранить
implementation/evidence с отложенным host qualification соответствует этому verdict.
