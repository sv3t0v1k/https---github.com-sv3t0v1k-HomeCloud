# Независимый scoped security review R2.1B preflight

2026-10-11, Asia/Vladivostok. Отдельный AI reviewer; не human audit и не новый
эксперимент. **Verdict: ACCEPT только R2.1B_GATE=BLOCKED / R2.1_GATE=BLOCKED.**
Критичных findings, требующих изменения остановленного результата, нет.
Production NO_GO, secureOpen=false, additional workspaces disabled сохраняются.

## Scope и процедура

Прочитаны локальные R2.1B report/reproduce, preflight.py, collect.py,
verify-evidence.py, baseline.json, final.json, evidence-verification.json.
Из repo только docs/ROADMAP.md и предыдущие R2.1 report/reproduce.
SSH, mounts, Docker operations и qualification tests reviewer не выполнял.
Repo не изменён, запрещённый audit не читался/не искался/не хешировался.
Предоставленный verifier не запускался: проверки raw JSON пересчитаны своим
локальным кодом, без перезаписи evidence. Внешние kernel/Docker ссылки не
проверялись заново; вывод о доступности ext4/XFS mount на точном distro kernel
не является новым экспериментальным результатом этого review.

## Независимо подтверждённые данные

- Baseline 08:47:14 UTC / final 08:47:35 UTC: ровно 26 уникальных container IDs,
  7 полей каждой записи, все running=true. Полные selected records равны:
  ID/name/image/StartedAt/RestartCount/running/health.
- Mountinfo строки равны побайтно после извлечения из JSON; оба SHA независимо
  пересчитаны: `0ce1352a652824556154eb0069dc69170bb18430af1e8b2636cbd17ff0632429`.
- Boot ID, self userns и self mntns равны. PID1 mntns readlink errno13 в обоих
  snapshots; равенство self и PID1 не доказано и report его не заявляет.
- 17 fixture entries равны целиком: 8 directory metadata records и 9 regular
  file records с SHA256. Равны paths, owner/group/mode, dev/inode, size, mtime
  и сохранённые content hashes. Atime/ctime, xattrs и весь чужой data tree не
  покрываются этой сверкой; report явно ограничивает invariant.
- sudo -n true rc1/password required; sudo -n -l показывает password-gated ALL
  и узкие NOPASSWD ipset/birdc. Подмена этих исключений не использовалась.
- User/mount unshare rc0: userns4026533239/mntns4026533240 против self
  userns4026531837/mntns4026531841. UID map ровно 0→1000, count1.
  Child capabilities не доказывают initial-userns полномочия.
- Plain unshare --mount rc1/EPERM. В выбранном preflight отсутствует безопасный
  initial-userns privilege entry; это не доказательство отсутствия всех
  возможных административных методов на сервере.
- findmnt сообщает shared у настоящих ext4/XFS mounts. --propagation unchanged
  не является qualification private propagation. Ни make-rprivate, ни mkfs,
  losetup, mount/umount, server-file creation или container mutation в прочитанном
  preflight/collector source нет. Child namespace завершает короткий процесс.

Сохранённый evidence-verification.json корректно называет свой PASS только
consistency check. Независимый reviewer не перечитывал .stderr files вне
выделенного scope, поэтому его last stderr-empty assertion отдельно не удостоверяет.

Snapshots доказывают равенство наблюдавшихся состояний, не отсутствие любого
кратковременного изменения между ними. Они не транзакционны; latency и transient
resource minima не измерены. Отсутствие созданных ресурсов следует также из
прочитанного исполнявшегося preflight source, а не из mountinfo equality отдельно.
Первый сохранённый baseline не предшествует всем ознакомительным SSH чтениям;
report честно указывает эту границу.

## Остановка и граница привилегий

Остановка до привилегированных действий соответствует owner stop-condition.
Доказано существование отдельной child mount namespace; **полная требуемая
изоляция ещё не доказана**. Сам mount namespace не изолирует loop allocations
или writes через унаследованные реальные mounts. Нельзя продолжить из значения
CapEff child userns, Docker-group membership или generic sudo ALL.
Попытки privileged Docker, host mount manipulation и обход NOPASSWD не нужны.
Все ext4/XFS remount/recycling/stacked/live/attestation строки R2.1B NOT_RUN;
исторические R2.1 PASS не повышают текущий gate.

## Attestation/rprivate: приемлемая гипотеза, ещё не qualification

Report правильно разделяет operator enrollment и boot/namespace/mount-instance
runtime observation, scope opaque handles внутри доверенной FS и необходимость
внешнего trusted expected. Равенство handles не доказывает physical uniqueness,
freshness, текущий host pathname или FS provenance. Clone и privileged host/kernel
adversary явно исключены, same-UID writable enrollment не допускается.

Container recreation может менять container mount instance; host remount требует
operator-controlled повторной аттестации. rprivate container view может удерживать
старый mount: она не удостоверяет continuity host source. Private helper mount
не становится автоматически source для обычного Docker daemon. Изолированная VM
может исследовать этот механизм на собственном Docker; её результат потребуется
связать с actual deployment profile отдельной qualification.

Nonce/signature и наблюдение boot/namespace/instance сами по себе ещё не закрывают
TOCTOU между attestation и I/O. Будущий helper/monitor должен доказать acquisition
и использование того же FD, актуальность trusted revision, live mutation behavior
и fail-closed прекращение I/O/cleanup при утрате continuity. Report не заявляет,
что эти acceptance criteria уже исполнены.

## Минимальный owner action и будущие ограничения

Допустимый запрос: выбрать disposable native AMD64 VM с root либо разрешить
разовый ручной запуск конкретного предварительно проверенного ограниченного
helper, включая только его собственные host-global loop allocations. Пароль,
blanket sudo, privileged production containers и writable physical XFS root
не требуются. Одобрение helper в общем виде не заменяет review конкретных bytes.

Перед будущим запуском нужны executable helper и его scoped review, новый
baseline, parent/child namespace proof, rprivate verification до первого mount,
exclusive regular image identity и protected ancestors, pinned backing-file proof,
точная allowlist собственных loops/paths, bounded resources и cleanup evidence.
Нельзя сделать mkfs/loop setup первой проверкой изоляции. Физический XFS каталог
можно не запрашивать при disposable XFS images; матрица остаётся исследовательской.
Существующее согласие не расширяется этим review.

## Привязка review к evidence

SHA256 прочитанных raw snapshots:

- baseline.json: `5a6bdd3c1b666b0e07ed51543c17660e1f63bc0c11ee0567ea6868ef45984631`
- final.json: `e7a6bf2e7b366a8e0a24dec2e1a36a49b089a58e42d524262c07b20a4b731ee0`
- preflight.py: `be10639ccb55ef778906ceb45d0cf935a4b609225d82af4a08c456623d59e29a`
- collect.py: `20f574a9a2a62265ec09089cde0fee3ec2ef4924fa8a9a55f3213446abd46a5b`

Итоговый Git HEAD/status/allowlist reviewer не проверял: это отдельная обязанность
основного агента перед документальным commit. Без нового evidence **PASS запрещён**.
