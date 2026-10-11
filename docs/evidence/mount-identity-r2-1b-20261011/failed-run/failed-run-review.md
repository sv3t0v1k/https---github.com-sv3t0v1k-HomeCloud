# Независимый review первого ручного R2.1B запуска

2026-10-11. **ACCEPT только BLOCKED с незавершённым own-loop cleanup.**
Предыдущий static review пропустил несовместимость сравнения CLI device string
с padded output. Это дефект helper; qualification persistent identity ещё не
началась. Production NO_GO, secureOpen=false, extras disabled сохраняются.

Scope: локальные root-run-result.json, root-run-journal.ndjson и предыдущий
isolated-helper.py. Собственная offline сверка raw records; SSH, root execution,
изменения серверных ресурсов и repeat experiments reviewer не выполнял.
Для проверки гипотезы причины read-only просмотрен primary util-linux source.

## Независимо пересчитанное evidence

Exact executed helper SHA:
`8d900ee95acbe009028f78b00dd1c19693ae48a16a5e52291391ab589c531426`.
child_rc1; traceback указывает сначала loop backing device mismatch, затем
повторный такой же отказ cleanup и cleanup incomplete; preserve resources and STOP.

Initial и final содержат ровно 26 уникальных семипольных container records,
все running=true. Selected records, полный mountinfo, boot ID и self mount/user
namespaces равны. Независимый SHA mountinfo:
`0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
Это observed before/after invariant, не полная проверка данных/latency и не
доказательство отсутствия любого transient события.

Journal отдельно прочитан и разобран: records совпадают с result.records,
raw bytes совпадают с result.journal_raw. Новая child mntns4026533239 отличается
от host4026531841, userns4026531837 сохранена. Child private mountinfo83rows:
нет shared/master/propagate_from. Loop8 FS mount в этом private snapshot отсутствует.

Подтверждены fresh image `/mnt/1TB/homecloud-test/r2-1b-20261011-01a12a22/ext4.img`,
dev2081/inode64225325, size67108864, uid0/regular; mkfs.ext4 на pinned procFD rc0;
proposed loop `/dev/loop8`. По traceback и helper control flow loop setup вернулся
успешно и name/backing-inode check прошли перед device-string mismatch. **Первый
FS mount call не достигнут**, поэтому ext4 object-identity/stack/remount/recycle
испытания NOT_RUN, XFS allocation и испытания NOT_RUN.

Cleanup intentionally не detach при mismatch. remaining_mounts=[] соответствует
ещё не начатому FS mounting, **не означает удаление loop association**. Journal
даёт recoverable image identity и proposed loop, но для текущего detach нужен
свежий root-owned observation: raw root row не сохранён. Read-only non-root null
BACK-INO/BACK-MAJ:MIN не является ни mismatch доказательством, ни detach разрешением.

Raw SHA256:

- root-run-result.json:
  `65585e47b1d24352a6a510a1f9d0eb8de9640e93cea2f992aafb1353b6e5b4d1`;
- root-run-journal.ndjson:
  `90c5229d1a6bfbb1e535595edd0706ad1adf8c3616e80fba98bb1819080d0662`.

## Причина: сильная гипотеза, exact host root row ещё отсутствует

Helper сравнивает BACK-MAJ:MIN буквально с unpadded `major:minor`. В primary
[util-linux v2.37.2 losetup.c](https://raw.githubusercontent.com/util-linux/util-linux/v2.37.2/sys-utils/losetup.c)
COL_BACK_MAJMIN создаёт строку форматом `%8u:%-3u`, при этом колонка JSON string.
Для8:33 это допускает leading/trailing padding, несовместимый с exact string
comparison. Это конкретная подтверждённая source причина возможного false mismatch;
без actual host root row нельзя окончательно исключить настоящий mismatch/иной
format. Снимать проверку или принять null вместо identity запрещено.

Исправление: сохранять raw loop row **до** assertions; строго parse полный
whitespace-tolerant decimal pair major/minor и сравнивать числовой tuple. Null,
malformed, missing fields → STOP. Name, backing inode, offset0, sizelimit0 и current
loop block-device identity по-прежнему обязательны. На Linux dev2081 соответствует
8:33; Mac os.major/os.minor используют другую dev_t encoding и не годятся для
декодирования сохранённого Linux st_dev. Нормализация должна выполняться на Linux
из actual fstat либо Linux-specific decoder для offline evidence.

## Минимальные требования single owner root recovery

Отдельный reviewed owner launcher с pinned-source SHA, без автоматического root
SSH агента. Recovery fixed только image выше и /dev/loop8; без mkfs/mount/umount,
allocation новых loops, prune, detach-all или changes чужих ресурсов.

До detach: O_NOFOLLOW pinned image FD и fstat regular uid0/nlink1/ожидаемые
size/dev/inode; actual root loop row с normalized major/minor8:33, inode64225325,
name/devnode, offset0/sizelimit0. Backing pathname/label отдельно недостаточны.
При несоответствии/недоступности не трогать loop. При already unbound подтверждённом
состоянии безопасный no-op, а не повторное использование номера как ownership.

Доказать завершение helper/formatter/mount descendants и отсутствие live child
namespace/FD/mount пользователей этого loop. Self host mountinfo alone не исключает
mount в другой namespace. Captured old child mntns4026533239 полезен для поиска,
но отсутствие только этого ID не заменяет current loop-use checks. Trusted quiescent
hs/root writers остаются premise; повторный current identity check перед detach
обязателен. Linux detach может быть lazy при busy: rc0 не доказывает освобождение.
После закрытия собственных inspection FDs подтвердить отсутствие association,
сохранить before/after loop rows, image stat и host/container invariants.
При unknown/busy state STOP; не force cleanup. Старые image/evidence сохранить.

## Требования fresh retry

Сначала подтвердить own-loop cleanup. Новый RUN, project и DATA exclusive;
старые не удалять ради обхода collision. Исправленные helper/owner launcher проходят
новый narrow review и SHA проверку before exec. Meaningful offline regression должен
проверить фактический padded pair, null/malformed отказ и другой major/minor mismatch.
Перед allocation raw root metadata parsing можно проверить на own recovered resource
без дополнительных мутаций; не считать non-root null пригодным evidence.

Сохранить прежние namespace proof/rprivate-before-first-mount, pinned regular mkfs,
loop backing checks, bounded resources, fsync journal и STOP-on-error. Добавить
raw row journaling до проверки, чтобы следующий отказ не терял диагноз. После
normal/lazy detach подтверждать association removal, иначе cleanup UNQUALIFIED.
Новый общий preserved-image footprint учитывает старые64MiB плюс retry budgets;
не расширять согласованные budgets автоматически.

Ни successful recovery, ни retry helper rc0 не квалифицируют Docker recreation,
rprivate supplier mapping, trusted host attestation/replay protection, reboot,
physical uniqueness или production integration. Оба gates остаются BLOCKED до
реальных доказательств критичных сценариев; R2.2/MS-4 не начинать.
