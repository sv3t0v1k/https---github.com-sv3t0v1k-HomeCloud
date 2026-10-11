# MS-3B-R1Q — native Linux AMD64 квалификация домашнего сервера

2026-10-11, Asia/Vladivostok. **R1Q_GATE=PASS; R1_GATE=PASS в утверждённом descriptor-safe R1 scope.**
Production **NOT_READY / NO_GO**, `secureOpen=false`, additional workspace activation disabled.
R2/MS-4 не начаты. Квалификационный стенд остановлен, его контейнеры, сети и PG volume удалены.

Этот результат закрывает прежние blockers среды и storage permissions. Он не означает
production deployment или решение durable root enrollment/R2. [Implementation/design](../secure-filesystem-adapter-implementation-r1-20261011/report.md)
сохраняет исходную модель угроз и границы R1. Исторические BLOCKED отчёты описывают предыдущие попытки.

| Поле | Проверенный результат |
|---|---|
| INITIAL_HEAD | Начало продолжения: expected=actual `37190a8d3e77cc80314790df71d74e0ac121e143`, main. Исходный checkpoint первоначального запроса `1f1fc8ecb23adfd19bceb18f7e1010d1a343d8ab` сохранён в истории. Tracked clean до этой работы, три исходных untracked |
| SSH_ACCESS | PASS: реальный BatchMode доступ `hs@192.168.3.44`, NumberOfPasswordPrompts=0, StrictHostKeyChecking=yes. Интерактивные пароли и переданные в чате секреты не использовались |
| SERVER_BASELINE | Ubuntu22.04.5; kernel6.8.0-134-generic; Intel N100 native x86_64,4CPU; Docker28.2.2 linux/amd64, Compose5.1.0; default local context, overlay2, builtin seccomp/AppArmor. Фактически26 исходных контейнеров |
| SAFE_PATHS | Владелец подготовил `/mnt/1TB/homecloud-test`, hs:hs/0700. До развёртывания проверены отсутствие symlink/чужих данных и exclusive write/fsync/unlink probe. Созданы только собственные `/home/hs/homecloud-test`/0700 и disposable `workspace/{host-probe,persistent,adversarial,recovery,http}`/0700 с marker. Storage mount `/mnt/1TB` → `/dev/sdc1`,ext4,rw; проект на SSD ext4 `/dev/mapper/ubuntu--vg-ubuntu--lv`. Mount identity после прогона та же |
| ISOLATION | Явный `-p homecloud-test`; own internal network/PG volume, опубликованных портов0. Последовательные non-root backend workloads1000:1000, production runner probe1001:1001, PG user70:70. Backend1GiB/1CPU/no extra swap, PG512MiB/0.5CPU; ALL capabilities dropped, no-new-privileges, backend read-only rootfs. Ordinary builtin seccomp, без privileged/root app/docker.sock/host network. Redis/frontend не нужны для этого qualification scope |
| DEPLOY_STATUS | QUALIFICATION_COMPLETED / STAND_STOPPED. Только изолированный тестовый stand, без production app deployment, reverse proxy/DNS/public access/auto-start. Own PG container, volume и обе созданные сети удалены; собственные образы, конфигурация, исходники, логи и небольшие fixtures оставлены для воспроизведения |
| OPENAT2_NATIVE_AMD64 | PASS: raw/libc syscall437 с полным resolve flags внутри обычного Docker seccomp; errno0, invalid size EINVAL22, invalid pointer EFAULT14. ELF64 machine62, Node20.20.2/NAPI9, native x86_64 kernel, no emulation self maps. Delivered addon и заново собранный внутри native server addon byte-identical; оба открывают root успешно, production UID1001 тоже PASS |
| ATTACK_RESULTS | PASS: известная 5-byte symlink attack после production resolver теперь FAIL_CLOSED/ELOOP, outside0;2000 concurrent descriptor attempts,621 success/1379 explicit refusal,516143 ancestor swaps,outside0. Persistent ext4 traversal/leaf/ancestor/root substitution/hardlink/nonregular/cleanup tests10/10. Actual nested Docker tmpfs EXDEV/source retained/no copy fallback; SIGKILL restart, UploadsService+PG recovery и100FD cycles/leaks0 PASS |
| REGRESSION_TESTS | Targeted10suites/194tests; persistent1/10; corrected memory unit1/14; final full69suites/932tests,0skips, включая9 реальных PostgreSQL suites: PASS. Lint0errors/15existing warnings; src typecheck, backend build и compiled file-type runtime PASS. Первый full68/69,930/931 сохранён: единственный environment-dependent memory test исправлен, production collector не менялся |
| REVIEW | Independent scoped review конфигурации, HTTP fixture, test-only correction и финальных evidence: COMPLETED_WITH_LIMITATIONS; см. [review](independent-review.md). Review не заменяет эмпирические проверки и не утверждает production readiness |
| DATA_INTEGRITY | Fresh canonical before/after: hashes11tables + полный file/directory inventory равны;21/21bindings;5user files/37021bytes,0disposable schemas. Canonical4container IDs/images/start times/restarts/health unchanged. Server26container IDs/images/start times/restarts/running unchanged; foreign volumes не монтировались. [Сводка](data-integrity.json) |
| R1Q_GATE / R1_GATE | PASS / PASS в исходной модели угроз R1. Native AMD64 blocker снят; никакого изменения fail-closed/syscall flags/production rollout. R2 durable enrollment, physical mount substitution, power loss, finalizer publication и arbitrary same-UID sabotage остаются вне квалификации |
| RESOURCE_IMPACT | Минимальная наблюдавшаяся available RAM4.157GiB; OOM0, resource-stop0. Начало: available5086683136bytes, swap2070937600/4294963200; конец: available5333073920, swap2277244928. Swap вырос на206307328bytes (~196.75MiB); attribution на общей машине не установлен. Последняя короткая vmstat выборка si0/4KiB/s,so0. Не измерены transient peaks, latency домашних сервисов, Frigate FPS или длительная стабильность |
| SERVER_CHANGES | Созданы только два согласованных test paths, own Docker image cache tags, disposable PG/volume/networks и one-off containers. После stop workloads/networks/PG volume отсутствуют. Проект~2.4MiB, storage fixtures~212KiB. Daemon, общие сети, firewall, existing ports/containers/volumes, разделы и mount configuration не изменялись; глобальный prune не выполнялся |
| COMMITS | `c0fd1ef34e0ab8a8ba47cea286c203ad952fa2d7` — «Сделать проверку cgroup в тесте независимой от окружения»; отдельный русский evidence/documentation commit содержит этот отчёт. Push/Git tag/release отсутствуют |
| FINAL_HEAD / GIT_STATUS | FINAL_HEAD — evidence commit, содержащий этот файл; exact SHA сообщается в итоговом ответе (самоссылка SHA в содержимом commit невозможна). После него tracked clean и ровно3 исходных untracked; два разрешённых JSON SHA unchanged. Запрещённый audit не читался, не хешировался, не менялся, не staged/committed и исключён из поисков |
| NEXT_ACTION | Остановиться после R1Q. Для следующего этапа требуется отдельное решение владельца; R2/MS-4 автоматически не запускать. Production NO_GO сохраняется |

## Нативность и происхождение артефактов

[Native probes](native-container-probes-final.txt) проверяют реальные raw/libc `openat2`,
а не только version/architecture labels. В контейнере `Cap* = 0`, `NoNewPrivs=1`,
`Seccomp=2`, filter1; daemon сообщает `seccomp,profile=builtin`. `SYS_openat2=437`,
`open_how` size24/offsets0,8,16; полные resolve flags работают. Host probe также успешен,
но host `Seccomp=0` сам по себе не заменяет container proof.

Native server compiler собрал `secure-fs.node` из экспортированного неизменённого production
C source. SHA256 нового и доставленного addon:
`bdadb25e4dab704ce19235564baaf27deacb821c25f0ec166d76d68c9d82ff09`.
`cmp` успешен, freshly rebuilt addon открыт/использован на server. Production runner
из штатного `backend/Dockerfile` работает UID1001; test builder UID1000.

Полная Docker image build на сервере не завершилась: DNS daemon не разрешает
`registry-1.docker.io` через `[::1]:53`, отказ до build container. [Оригинальная ошибка](native-tests-build.txt).
Daemon/DNS не менялись. Стандартные backend builder/runner images собраны на Mac через
`--platform linux/amd64` (build под эмуляцией), PG — отдельный собственный tag;
затем offline image save/load. Runtime квалификация и fresh addon rebuild выполнены
нативно на Intel N100. Это доказательство native runtime/addon, а не wholly native
production image build или supply-chain аттестация; базовые image tags mutable.

| Image | Server ID | Inspect size, bytes |
|---|---|---|
| `homecloud-r1q-tests:37190a8-20261011` | `c3ff13b395fdf1f251c33ff475318e1c2b8a683e268dcb25142e47d20efba90f` |667944955|
| `homecloud-r1q-production:37190a8-20261011` | `8694a91c8306b7f43e6d5d93f693973ddb5d302010dee477d0e6fc7f83cb4e52` |240388304|
| `homecloud-r1q-postgres:16-amd64-20261011` | `7c35e1ccdcdb00a84f2b374a0ec98373c1ab493c35acf521bfb7bc2abe765b01` |294282098|

Все `linux/amd64`. Sizes не суммируются в точный physical disk footprint из-за общих слоёв.
[Build logs](mac-amd64-tests-build.txt), [runner build](mac-amd64-production-build.txt),
[PG build](mac-amd64-pg-build.txt), [offline load](offline-image-load.txt),
[source check](source-check.txt), [manifest208files](source-manifest.json).
В архив попадали только tracked backend files с исключением env/keys/secrets, без `.git`,
пользовательских данных и запрещённого audit. Bundle и binaries в evidence commit не входят.

## Upload, adversarial и regression evidence

[Adversarial fixture](adversarial.cjs) повторно использует ранее проверенный R1 harness;
delta только UID1001→1000 и описание среды ext4/native AMD64. Он вызывает **реальный
compiled production StorageEngine/resolver** с управляемой symlink подменой сразу после
guard. Историческое before5 находится в [R1 before](../secure-filesystem-adapter-implementation-r1-20261011/attack-before.json),
а не является новым native AMD64 прогоном прежнего небезопасного кода. Текущий after0 —
[actual result](adversarial.txt).2000 — descriptor operations при concurrent ancestor swaps,
не2000 HTTP requests. Настоящий EXDEV получен между двумя отдельными disposable Docker tmpfs;
это не SSD→HDD migration или изменение host mounts. Очистка не следует outside symlink;
100capability cycles не оставили FD leaks.

[Persistent FS tests](persistent.txt) запущены с `TMPDIR=/qualified` на разрешённом ext4
и проверяют traversal, ancestor/leaf symlinks (включая ссылки внутрь root), acquisition
substitution, hardlinks/nonregular leaves, cleanup, publication without overwrite,
fsync/enumeration и закрытую capability. Ни race, ни destructive fixtures не запускались
на mount roots или пользовательских каталогах.

[HTTP fixture](http-lifecycle.cjs) использует исходный Nest production Multer `useClass`
factory/options и реальный multipart HTTP на loopback внутри контейнера, затем compiled
UploadsService: ingress→chunk→retry→finalize и отдельный cancel. [Результат](http.txt):
3success requests,5точных bytes, quota5, idempotent retry, ingress/temp/PG cleanup.
Multer/DI capabilities закрыты; PASS печатается после cleanup. Authentication/controller
pipeline этим fixture не упражнялся; success HTTP и storage-engine adversarial evidence
не объявляются полным adversarial authenticated HTTP test.

[Recovery](recovery.cjs) использует два процесса и реальный UploadsService+PG с собственной
schema/ext4 fixture. Child pause внутри syncDirectory задаёт точную точку после chunk
publication+directory fsync, до metadata commit; SIGKILL, rollback, retained original
inode/bytes, fresh service retry twice, uploadedCount1,size4,quota4: [PASS](recovery.txt).
Отдельный adapter restart проверяет retained fsync bytes с новой capability.
Это process-crash qualification; power loss/device flush/remount/R2 enrollment **UNQUALIFIED**.

Первый [full log](full.txt) показывает68/69suites и930/931tests: bounded cgroup-v2 правильно
обнаружен production collector, но unit test ожидал host без cgroup. Resource cap не снимался,
collector не менялся. [Test-only diff](test-fix.diff) задаёт deterministic fs inputs и добавляет
явную cgroup-v2 проверку limit/current/headroom. [Targeted14/14](memory-targeted.txt),
затем [final full69/932](full-final.txt) PASS,0skips,9PG suites. [Validation](validation.txt):
lint0errors/15existing warnings, `tsc --noEmit` для src, Nest build, compiled CommonJS
file-type ESM load. Изменённый bench test проверен Jest/ts-jest, production TS build scope — src.

[Targeted194tests](targeted.txt), [machine-readable summary](verification-summary.json)
и индивидуальные `*-resources.json` сохраняют exit codes, runtime constraints и samples.
Все финальные stages exit0; исходный full exit1 оставлен. Ни ARM64/Rosetta, ни skipped
PG tests не засчитаны как этот native AMD64 PASS. Frontend/end-to-end UI/50GiB/throughput
и auth deployment smoke вне данной квалификации и не запускались.

## Безопасность стенда, воздействие и остановка

[Compose](compose.yaml) содержит profiles для backend workloads: они запускаются явно,
по одному через [bounded runner](run-stage.py). Безопасность не зависит от общей
6.5GiB суммы лимитов всех объявленных services. PG имеет только internal own network,
trust auth исключительно для disposable isolated DB, без реальных credentials; порт5432
на host не опубликован. `/storage` и canonical roots в workloads отсутствуют.

Runner проверяет project marker/label, сохраняет samples каждые~4секунды, останавливает
только свой CID при available RAM<2GiB или duration>900секунд, затем удаляет только свой
one-off container. Наблюдавшийся минимум4.157GiB не является доказанным transient peak.
Workload cap1CPU; короткие tests21.33секунды для2000attempts. Full stages по~259секунд;
validation96.17секунды. Недоступных ресурсов и OOM не было. Server build остановился
на DNS; дальнейшие build workloads перенесены на Mac.

[Server before](server-before.txt), [pre-cleanup](server-pre-cleanup.txt),
[after](server-after.txt) и [cleanup](stop-owned-stand.txt) подтверждают исходные26IDs/images/start
and restart counters unchanged и отсутствие own containers/networks/PG volume после stop.
Первая cleanup ownership check остановилась до изменений из-за short/full network ID mismatch;
[лог](stop-owned-stand-initial.txt). Проверка исправлена на full IDs, guards сохранены.
Первый container syscall probe не смог выполнить файл с noexec `/tmp`;
[лог](native-container-probes.txt). Probe перенесён только в own disposable ext4 fixture;
seccomp, capabilities и noexec policy не ослаблялись. Финальный probe PASS.

Оставлены только свои project/source/config/probe/log files, markers,212KiB disposable
fixtures и3own image cache tags. Нет запущенного backend/PG, auto-start, публичных портов,
новых canonical workspaces, migration/disks formatting, daemon/firewall/DNS/mount edits,
push/Git tag/release, R2 или MS-4. Существующие26services продолжают работать.
Latency/FPS/длительная стабильность домашних сервисов не измерены; increase swap196.75MiB
не скрывается и не приписывается однозначно тесту на общей машине.

## Сохранность и независимая проверка

[Canonical before](canonical-before.json) и [after](canonical-after.json) содержат hashes/counts,
не rows/имена пользовательских файлов/credentials. Все11tables, full file and directory
inventory, bindings digest совпадают. Canonical4containers health/IDs/images/start/restarts
также совпадают. [Data integrity](data-integrity.json) включает SHA256 двух разрешённых
исходных untracked JSON. Запрещённый audit виден только как filename в Git status;
его bytes/metadata contents не читались и не хешировались, изменения не выполнялись.
208backend source hashes проверены локально и на server; единственный delta — reviewed
memory test. Production C/TS/config/dependencies/migrations неизменны.

[Independent review](independent-review.md) охватывает stand/test/evidence delta.
Отдельная попытка делегировать расширенный HTTP fixture была недоступна из-за tool safety
rejection, не выдала artifact и не дала основания менять production защиту. Выполнены
разрешённый success HTTP fixture и существующий R1 adversarial harness; их scope указан
выше. Все фактические результаты повторно проверены основным исполнителем.

Для воспроизведения нужны permission/preflight PASS, marker-owned пустые disposable
каталоги, own PG и локальные проверенные image IDs. Не запускать harness на canonical
roots, не делать blanket cleanup и не запускать все profiles одновременно. Текущие
fixtures и сохранённые stage logs намеренно предотвращают случайный повтор на старых
данных: нужен отдельный подготовленный disposable run, а не удаление произвольных roots.

**Остановка после квалификации. R1 PASS не разрешает R2/MS-4 или production rollout.**

Логи в Git нормализованы: ANSI удалён, literal NUL показан как `\0`, trailing spaces/CR убраны. [Hash manifest](captured-artifact-hashes.json) сохраняет SHA256 исходного захвата и committed текста; raw captures оставлены в локальном qualification artifact directory. Это преобразование отображения, не изменение результатов.
