# Независимый narrow security review MS-3B-R2.1

2026-10-11. Отдельный read-only subagent, не автор probes. Основание: repository AGENTS.md
требует независимый review critical/security работы и узкие subagent roles.
Server operations, правки и чтение запрещённого audit reviewer не выполнял.
Это AI review, не внешний human audit.

## Итог reviewer

**ACCEPT только R2.1_GATE=BLOCKED, activation disabled, production NO_GO.**
Оснований разрешать R2.2 нет.

Независимо проверены актуальная ROADMAP/архитектура и adapter/registry/workspace sources,
Linux6.8/Moby28.2.2 primary sources, probe/runner source, 52 основных raw records,
O_RDONLY supplemental raw records, draft report и offline verifier.
Source SHA совпал, stderr пуст. Reviewer повторил offline verifier на версии с
34 checks PASS; это отдельный результат от BLOCKED gate.

O_RDONLY host/container handles ext4 directory и XFS root непосредственно сверены
с original O_PATH records: одинаковые при UID1000, CapEff/CapBnd0, NoNewPrivs1, Seccomp2.
Прежний пробел O_RDONLY capability снят; production ownership/enrollment admission не
проверен. UID1001 остаётся raw metadata-only observation на object owner1000.

Подтверждены process/container restart equality, ext4 replacement/copy mismatch,
фактический inode64225321 reuse с handle
`2900d4034613eb97→2900d40361d59f5e`, rename equality, сохранение handle при in-place
mutation и nested same-object bind. До recycle прежний probe завершился и закрыл FD.
Один reuse не доказывает отсутствие generation collisions.
NO_XDEV crossing возвращает EXDEV18; overlay EOPNOTSUPP95 явно проверяется offline.
Production denial enforcement это не доказывает.

Независимо пересчитаны equality 26 исходных container records и полного основного
host mountinfo. Восемь primary container inspect records и два supplemental records
имеют OOMKilled=false; всего10 disposable container objects, один запускался дважды.
Resource snapshots не доказывают transient minimum, host-wide OOM0 или zero-impact.

Reviewer выявил ошибку draft: marker31 byte, не29; hash004c6e… совпадает с raw record.
Также потребовал явно ограничить O_RDONLY matrix UID1000. Автор исправил оба пункта
до документационного checkpoint. Других существенных неточных claims reviewer не выявил.

## Оставшиеся ограничения

- Real FS remount/reboot, physical replacement/reconnect, stacked/live mount mutation
  не выполнялись.
- XFS workspace replacement/recycle/writable lifecycle не проверен. Root handle
  ino128/generation0 особенно непригоден как самостоятельная FS provenance.
- Trusted host→container attestation, operator revision/revocation lifecycle и external
  enrollment остаются design-only; app recovery не интегрирован.
- Fixtures без fsync: process/container restart не доказывает power-loss durability.
- File handle идентифицирует object within FS; full block clone, arbitrary same-UID writer,
  host root/kernel adversary не закрыты.

Рекомендация: сохранить BLOCKED; отдельно разрешённая дальнейшая R2.1 qualification,
без stat/marker fallback, open_by_handle_at и автоматического принятия новой identity.
Expected external tuple сравнивается с тем же trusted FD, который станет I/O capability,
плюс отдельная trusted FS/host binding и live mount-context проверка.

## Дополнение автора после review

Финальный read-only [integrity snapshot](final-integrity.json) после O_RDONLY follow-up
подтвердил26 прежних containers, full host mountinfo equality и own label0. Этот snapshot
добавлен в verifier отдельной35-й проверкой; final author result35 PASS. Не выдаётся
за дополнительный independently rerun reviewer test. Общий R2.1 gate остаётся BLOCKED.
