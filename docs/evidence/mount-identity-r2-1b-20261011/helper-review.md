# Независимый review неисполненного privileged helper

## Повторный review после исправлений — актуальный verdict

2026-10-11. **SAFE_TO_MANUAL_RUN_WITH_LIMITATIONS** для exact helper SHA256
`8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426`
и окончательного прочитанного manual-run.md SHA256
`01df288ca9878a10302499a19756844247714a001a0cd2ee7466ada4dde1ced2`.
Прежний manual digest c0debe…6920 относится к intermediate версии.
Helper не исполнен; AST разобран, runtime mount/loop safety ещё должна быть
проверена самим helper. Historical BLOCKED ниже относится к предыдущим bytes.
Статический verdict не снимает R2.1B_GATE/R2.1_GATE=BLOCKED и не разрешает
автоматический root запуск агентом.

Прежний blocking finding закрыт: image dev/inode и proposed loop теперь пишутся
в fsync journal до explicit-loop setup. Candidate занятый другим процессом не
заменяется; cleanup проверяет current backing identity перед detach. Parent
заранее создаёт result с baseline/source SHA, сохраняет raw stdout/stderr,
timeout/parse/other errors, journal и best-effort final snapshot. Ошибка final
snapshot или child rc запрещает completion. Mount tracking проверяет mountinfo
count в finally, и normal umount разрешён лишь для точного own-loop source.
Неопределённый timeout не выдаётся за полный cleanup PASS.

Дополнительно закрыты замечания о ambient child environment dispatch, actual
ro/rw mount flags и marker file identity. ENTRY/HOST_NS передаются в verified
in-memory code; parent environment не может выбрать child route. Проверяются
ro/rw flags, оба directory handle comparisons, distinct marker file handles и
marker preservation после clean remount. Python -I и in-memory SOURCE сохраняются.

Ограничения актуального разрешения:

- Trusted quiescent hs/root writers обязательны, как явно написано в manual-run.md.
  Path mutations остаются через hs-writable ancestors; это не защита от hostile
  same-UID/root process. Проверка ancestors не заявляется такой защитой.
- Loop allocations глобальны. EBUSY, identity mismatch, signal или timeout дают
  STOP/owner recovery; чужой loop не detach. Journal fsync сохраняет image identity,
  но OS/storage failure может мешать записи; отсутствие identity запрещает cleanup.
- Outer timeout убивает непосредственный subprocess, а не гарантированно всех
  descendants. Прежде чем owner detach exact matching loop, нужно доказать завершение
  namespace/всех mount или formatter descendants и отсутствие использования loop.
  Busy cleanup не форсировать. Child PID+starttime в namespace journal улучшили бы
  recovery; нынешний namespace ID также позволяет owner inspect оставшиеся процессы.
- Прямые subprocess bounded20/30s, child alarm150s, parent timeout240s и
  RLIMIT_AS256MiB не дают hard aggregate CPU/memory/latency guarantee для host.
  nice10 — приоритет. Размеры остаются fixed64/384MiB, без автоматического расширения.
- Точные mkfs/losetup support/версии и успешность FD-path formatting ещё не испытаны.
  Missing tool/unsupported budget должен остановить запуск; probe не переносится
  на physical devices и не получает дополнительные права автоматически.
- SIGKILL, kernel hang и внезапное завершение всей машины не дают гарантированного
  автоматического cleanup. Images/journal сохраняются; broad cleanup запрещён.
- Container recreation на disposable private FS, Docker supplier/rprivate continuity,
  host attestation freshness/rollback, reboot/crash и physical uniqueness остаются
  UNQUALIFIED. Успешный manual helper только добавит частичные experimental evidence.

Нельзя принимать новый helper SHA без повторного review изменённых sections.

## Финальная проверка launcher и source-only uploader

Также read-only проверены, без исполнения:

- manual-launch.sh SHA256
  `3c1954013386be053e22e04a7a4b5486582c5e69b13cb7f03cd5633d74e6a44a`;
- upload-helper.py SHA256
  `347e63f6190d3078f2427c5beb13bbc6071eea9bf6f727388457734c7877ac94`.

**SAFE_TO_MANUAL_RUN_WITH_LIMITATIONS сохраняется** для launcher с этим SHA и
helper с SHA8d900e…1426. Embedded Python и uploader разобраны AST без выполнения.
Root entry остаётся ручным действием владельца; source-only upload может быть
выполнен отдельно без root, поскольку он не вызывает helper/launcher.
Final manual-run.md дополнительно проверен: owner ssh -t сохраняет локальный
TTY для sudo и запускает только reviewed launcher; это не агентский root entry.
Ограничение descendants/namespace exit перед orphan-loop detach теперь явно
включено в руководство. Команда исполняется только после confirmed source upload
и read-only сверки actual uploaded reviewed hashes.

Launcher вызывает абсолютный sudo /usr/bin/python3 -I, получает пароль через
обычный локальный sudo TTY prompt, не сохраняет его. O_NOFOLLOW open и fstat
проверяют regular leaf uid1000/nlink1/mode0600/size≤65536. Читается тот же FD,
ограничение size перепроверяется по read length, SHA exact bytes проверяется до
decode/compile/exec. SOURCE и ENTRY=parent задаются в памяти; подмена pathname
после open не меняет исполняемые bytes. Путь через trusted hs ancestors остаётся
заявленной предпосылкой. Сам launcher должен совпадать с reviewed SHA перед
ручным выполнением: helper checksum не удостоверяет произвольный изменённый launcher.

Uploader передаёт только два fixed filenames, проверяет exact helper SHA,
uid1000, 26-container count и текущий ожидаемый mountinfo SHA перед записью.
Parent chain не symlink, approved parent hs0700, новый project создаётся exclusive;
оба файла O_EXCL/O_NOFOLLOW0600, fsync. Docker операции только ps/inspect;
mountinfo читается. Final selected records/hash сравниваются с before. Нет mkfs,
loop allocation, mount/umount, helper exec или удаления прежних ресурсов.
Успех сохраняется в exclusive локальный helper-upload.json.

Ограничения uploader: interrupted upload может оставить частичный собственный
project; повтор не должен обходить collision удалением evidence. Capture before/
after не atomic и не является сервисной проверкой health/latency. Launcher checksum
не проверяется самим uploader against fixed constant; перед root запуском owner
сверяет uploaded launcher с reviewed SHA отдельно. Trusted quiescent writers и
последующая агентская read-only сверка uploaded bytes обязательны для передачи
именно reviewed artifact. Это не дополнительное разрешение на root execution.

## Historical initial review — предыдущая версия

2026-10-11. Отдельный AI reviewer, статическая проверка только isolated-helper.py
с контекстом предыдущего preflight. **Verdict: BLOCKED до исправления failure
evidence/uncertain allocation tracking.** Это не отзыв отдельного разрешения
владельца на manual root entry и только собственные disposable loop devices.
SSH, privileged execution, Docker mutation и эксперименты reviewer не выполнял.
AST source разобран локально без исполнения helper.

Прочитанный SHA256: `542c0317f86bb6e926437d33a9d3ac1089e1ebaec3e2f9e2097b4395f097bd5c`.
Любые последующие edits требуют повторной сверки/review; это historical finding.

## Blocking finding: неопределённая allocation теряет recoverable evidence

Строки151,135–141,287–302. После успешного kernel loop allocation сигнал/timeout
может возникнуть до присваивания `loop`. Тогда finally видит loop=None и может
сохранить cleanup errors=[] несмотря на оставшуюся global loop association.
После успешного mount такой же разрыв существует до mounts.append(path).
Mount namespace exit ограничивает lifetime mounts, но не изолирует global loops.

При outer TimeoutExpired, ошибке final snapshot или невалидном JSON parent
сохраняет только generic BLOCKED message. Он теряет исходный baseline, raw
stdout/stderr, partial records и уже наблюдавшиеся image dev/inode. На SIGKILL
child вообще не напечатает RECORDS: они находятся только в памяти до finally.
Получается собственный global ресурс без надёжного evidence для owner cleanup.
Это нарушает требование безопасной остановки и точной отчётности cleanup.

Нужно до allocation надёжно сохранить identity fresh image и progress, например
в fsync journal через заранее открытый evidence FD, передаваемый child. Parent
должен всегда сохранять initial snapshot, source SHA, raw stdout/stderr (включая
TimeoutExpired output), exception и отдельно best-effort final snapshot. Unknown
allocation/mount completion должно давать UNCERTAIN/OWNER_CLEANUP_REQUIRED,
никогда cleanup-complete по пустому Python list. Recoverable read-only inspection
может искать association только exact свежего image dev/inode; detach допустим
лишь после повторного identity proof и отсутствия живых пользователей namespace.
Не добавлять broad detach/umount/prune.

## Существенная граница pathname confinement

Строки52–60,124–157,247–251,276–283. ancestors проверяет тип и отсутствие symlink
на момент чтения, но не защищает от rename через hs-owned writable parent.
Новая DATA root-owned0700 не мешает владельцу DATA.parent переименовать DATA и
подставить другую directory/symlink. Root Path.mkdir/write_bytes и mount targets
вновь разрешают абсолютные paths. O_NOFOLLOW у image защищает только leaf;
openat2 от / защищает наблюдение, а не остальные mutations.

При trusted quiescent operator-controlled hs writers такой adversary исключён,
но это должно быть явной предпосылкой ручного запуска. Скрипт не обеспечивает
protected ancestor chain или confinement against same-UID concurrent writer.
Для сильного confinement нужны pinned directory descriptors и операции относительно
них, либо стабильный private anchor без повторного разрешения hs-writable ancestor.
Нельзя утверждать, что нынешний ancestors сам доказывает эту защиту. Physical
namespace isolation отдельно не защищает writes через унаследованные mounts.

## Прочие замечания

- Parent child-mode выбирается из R21B_CHILD environment. Нормальный parent
  устанавливает actual host namespace, поэтому обычный flow правилен. Лучше
  убрать ambient-environment child entry и передавать verified dispatch in-memory
  либо сверять actual parent namespace через /proc, чтобы ошибочная root launch
  с заранее установленными R21B_* не могла пропустить parent isolation proof.
- Remount rw→ro→rw currently проверяет identity при ro, но не сохраняет actual
  flags и не asserts возвращённый rw handle. Добавить mountinfo/statvfs readonly
  observations и equality после rw, прежде чем заявлять этот scenario PASS.
- Marker copy проверяет directory handles; marker handles отдельно не измеряются.
  Не выдавать это за полное выполнение directory+marker acceptance matrix.
- nice10 — приоритет, не hard CPU≤25% limit. RLIMIT_AS256MiB, sparse images64/384MiB,
  sequential execution и bounded500/15s recycle полезны, но host-wide latency и
  aggregate descendant memory ими не доказаны.
- Проверить доступность/версии mkfs/losetup и минимальный supported XFS image budget
  до allocation. Не изменять size budget автоматически при mkfs.xfs failure.

## Подтверждённые сильные стороны source

Нормальный flow требует root и initial userns, создаёт mount namespace без userns,
проверяет child≠captured host до первого mount. Первый mount только make-rprivate
в child; затем проверка отсутствия shared/master/propagate_from во всём tree.
DATA mapping должен быть exact /mnt/1TB ext4. Никаких mount операций в parent,
physical device formatter или Docker mutation в source нет.

Formatter получает только inherited FD свежего O_EXCL/O_NOFOLLOW regular image,
с проверкой owner0/nlink1. Loop path ограничен /dev/loopN; перед detach проверяются
backing dev/inode/offset/sizelimit. Отсутствие equality запрещает detach. SOURCE
передаётся in-memory и python -I не перечитывает hs-writable script в child/new
process; manual launcher source не входит в этот review.

Retained FD vs fresh pathname, same-object stack, nested NO_XDEV и clean
unmount/remount различаются; pins закрываются до clean unmount. Fsync scoped to
собственной FS, global sync отсутствует. Вариант без фактического inode reuse
называет recycle UNQUALIFIED. Container recreation/rprivate supplier mapping,
trusted attestation и reboot остаются BLOCKED независимо от успеха helper.

После исправления blocking finding и явной фиксации pathname trust premise
возможен повторный verdict SAFE_TO_MANUAL_RUN_WITH_LIMITATIONS. Исполнение
helper из этого review не разрешается и не производится автоматически.
