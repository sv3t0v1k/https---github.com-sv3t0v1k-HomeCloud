# Финальный независимый narrow review recovery/v2

2026-10-11. **SAFE_TO_MANUAL_RUN_WITH_LIMITATIONS** только для приведённых
exact bytes и ручного root entry владельца. Loop8 ещё allocated, recovery и
v2 qualification ещё не выполнены. **R2.1B_GATE=BLOCKED; R2.1_GATE=BLOCKED**,
secureOpen=false, extras disabled, production NO_GO. R2.2/MS-4 не начинать.

Read-only просмотр source/manual/results; reviewer не выполнял SSH, helper,
recovery, root entry, device ioctl или remote mutation. Собственные проверки
исполняли только AST-extracted functions с mocked OS/command/ioctl. Это отдельный
AI reviewer, не human audit. Historical rejected recovery сохранён отдельно.

## Reviewed artifact hashes

| Artifact | SHA256 |
|---|---|
| recover-owned-loop.py | `6d4dda1208c259c9ad22856dd362496ee8f975630091a03a9eed29e711bfb21c` |
| isolated-helper-v2.py | `5aaab3cd493acc0aba2857aad3202b751c9da75b02df1cb2c936cf20c577ac49` |
| manual-launch-v2.sh | `bb3f9f351b9dbe0b57647592fd693b7edf7bd477efbc389b617b710489c28ca2` |
| manual-run-v2.md | `af177e0bf24fc9d4468048f96508fed46a674b33d3164f053f3187a621039b3b` |
| parser-verification.json | `341d141d09d3d1432ad0a507d0091999b24e3f0795cb4349c30b071b2ec4b995` |
| unbound-verification.json | `e6066f39d7c58cd2244f560e6ce21dfecfbb544eaca22e263cab6a8ebf5da972` |

## Закрытые blockers

Literal BACK-MAJ:MIN comparison заменён строгим whitespace-tolerant numeric pair.
Raw root row теперь journaled до backing guard. Name/inode/device/offset/sizelimit
проверки сохранены; null/malformed или чужой object не принимаются.

Post-detach recovery больше не предполагает пустой JSON array explicit-device
losetup listing. Recovery и v2 делают read-only LOOP_GET_STATUS64 с buffer232,
проверяют device identity, принимают только ENXIO и закрывают собственный FD.
Successful status ioctl означает still bound и вызывает STOP; EPERM/EIO/иной errno
не принимаются за unbound. Lazy detach rc0 отдельно не считается cleanup success.

Primary [Linux6.8 loop.h](https://raw.githubusercontent.com/torvalds/linux/v6.8/include/uapi/linux/loop.h)
подтверждает номер0x4c05 и поля ABI struct loop_info64; nativeAMD64 size232 следует
из этих полей. [Linux6.8 loop.c](https://raw.githubusercontent.com/torvalds/linux/v6.8/drivers/block/loop.c)
возвращает ENXIO для non-bound state, а delayed/autoclear bound association ещё
возвращает status. Kernel observation — текущая bound-state проверка после
успешного detach, не гарантия против последующего allocation другим root process.

Reviewer независимо проверил4 mocked cases ENXIO/EPERM/EIO/bound: только ENXIO
accepted, inspection FD закрывается во всех cases. Ранее независимо10 mocked
parser/backing-identity cases passed; parser sections unchanged. Supplied results
также сообщают10+4PASS в чисто offline scope. Ни одна проверка не обращалась к device.

## Guarded recovery и порядок root execution

Recovery fixed на /dev/loop8 и old image expected regular uid0/nlink1/dev2081/
inode64225325/size67108864. Image открывается pinned O_NOFOLLOW FD. Root+initial
userns+nativeAMD64 обязательны. Current raw root loop metadata должна точно
совпасть с pinned image; hostname/path/marker сами по себе insufficient.

Before detach проверяются old namespace absence и отсутствие loop mount/open
block FD users across /proc. Access denied → STOP, ENOENT/ESRCH gone processes
пропускаются. Raw identity и unused evidence fsync сохраняются до mutation;
association повторно проверяется immediately before detach. Sole mutation только
detach exact matching loop8, без mount/umount/reformat/new loop/global cleanup.
Post-detach kernel status и selected26-container/host-mountinfo invariant обязательны
до возврата recovery success. Old image и evidence не удаляются.

Launcher pinned-FD читает и SHA проверяет **оба** source до первой recovery mutation;
regular owner1000/nlink1/mode0600/size≤65536 checks сохраняются. Абсолютный sudo
/usr/bin/python3 -I, пароль остаётся в owner TTY. Recovery запускается явно из
собственного globals dictionary через recover(); helper ENTRY=parent запускается
лишь после successful guarded recovery. SOURCE передаётся в child/new-process
памяти, hs-writable script не перечитывается. Uploaded launcher bytes также должны
совпасть с reviewed SHA до owner invocation.

## Условия и остающиеся границы

- Trusted quiescent hs/root writers обязательны. Directory type checks и root-owned
  DATA не защищают от rename через hs-writable ancestors; hostile same-UID/root
  writer вне модели. Proc inspection и identity recheck не atomic относительно
  adversarial root/namespace transfer.
- Если loop8 already unbound, reused, metadata недоступна или busy/unknown,
  recovery safe-stops; не менять constants/guards ради успешного прогона. Новый
  helper тогда не запускается. Если detach произошёл, но final invariant/snapshot
  не получен, результат BLOCKED/needs read-only inspection, не повторять launcher.
- Missing tools/kernelABI/filesystem support могут дать безопасный отказ. Это
  не разрешает device formatter, larger images или privileged Docker fallback.
- /proc main-process records не являются формальным доказательством всех скрытых
  kernel refs/namespace handles. Kernel bound-state check дополняет их. Все выводы
  ограничены trusted host/kernel и отсутствием concurrent manipulation.
- SIGKILL, kernel hang, storage failure или timeout могут оставить own allocations;
  journal/raw evidence сохраняют recovery identity при доступном хранилище.
  Parent timeout не гарантирует завершения всех descendants/namespace. Cleanup
  только после current proof ownership и отсутствия использования; broad prune/
  detach-all/force/physical mount changes запрещены.
- V2 fresh exclusive RUN сохраняет прежние namespace≠host, rprivate-before-first-
  FS-mount, pinned regular mkfs, numeric-loop ownership и journal safeguards.
  sequential64MiBext4/384MiBXFS и old64MiB preserved image суммарно учитываются;
  nice10/RLIMIT_AS256MiB/timeouts не hard aggregate host resource guarantee.
- Padding пока подтверждён upstream format, exact first-run root row отсутствует.
  Recovery должна записать actual value; до этого это strong hypothesis. Final
  manual прямо называет её вероятной причиной и правильно требует kernelENXIO,
  а не empty/null losetup JSON для post-detach proof.
- Container recreation/rprivate supplier namespace mapping, trusted attestation
  freshness/replay/anti-rollback, reboot/crash, physical uniqueness и production
  integration остаются UNQUALIFIED независимо от rc0 recovery/helper.

После owner run нужны read-only collection raw recovery/result/journal, independent
invariant/cleanup checks и сравнение старых fixtures. Только actual evidence может
подтвердить отдельные scenario outcomes. Этот static verdict не является gate PASS.
