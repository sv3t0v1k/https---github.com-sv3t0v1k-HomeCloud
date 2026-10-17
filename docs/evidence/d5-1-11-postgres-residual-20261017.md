# D5.1.11 — узкая квалификация остаточных PostgreSQL findings

17.10.2026, Asia/Vladivostok. Исходный HEAD `e940226c437a3aa9b3bd7a2d145d3329dcc2057a`.
Production NO_GO; Release BLOCKED. Это отдельный эксперимент, без изменения production.
Raw evidence находятся в локальном mirror `outputs/d5-1-11-20261017/`, не объявляются
опубликованными файлами GitHub. Точный локальный HEAD и remote PR HEAD — в checkpoint.json.

## Исходные доказательства и точная идентификация

Использован D5.1.10 candidate manifest
`sha256:fd2e86b5b1a2d9381d6e6018feacda382e6b669dda0a519dbc4744aa46980f95`,
archive SHA256 `2cffc90fb5c5f3309c3c1e2e708de8267dabab60dc49f164f418f3e1e0581961`.
Raw scan SHA256 `f1cba39185a85f6297f16d5929024bd5c19f83f648ac77ecdae952b6351964b8`
и binary SHA256 `3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085`
повторно сверены локально. Все три записи сохранены в `outputs/d5-1-11-20261017/initial-findings.json`.
Trivy 0.76.0, Alpine 3.24.2; исходная DB SHA256
`bf1f1b29d76cae9ff085d418cb4bfdb3906b6069f837abdef06558b8102dd1db`.
Это историческая квалификация конкретного образа, не новый скан.

| ID | Компонент/target | Installed → fixed | Raw severity/source | Применимость |
|---|---|---|---|---|
| CVE-2026-85091 | zlib, Alpine OS | 1.3.2-r0 → 1.3.2-r1 | MEDIUM / Alpine Secdb; vendor severity ubuntu=2 | Библиотека присутствует; достижимость специфического пути gzwrite/gzprintf из PostgreSQL не установлена. Не объявлена неприменимой. |
| CVE-2026-61801 / GHSA-mjcv-p78q-w5fw | github.com/moby/sys/user, usr/local/bin/gosu | v0.1.0 → v0.4.1 | MEDIUM / GHSA, CVSS3.1 5.5 | gosu вызывает GetExecUserPath для /etc/passwd и /etc/group; эксплуатация зависит от контроля account files. Runtime данные и их mounts не исследовались. |
| CVE-2026-39824 / GO-2026-5024 | golang.org/x/sys, usr/local/bin/gosu | v0.1.0 → v0.44.0 | UNKNOWN / govulndb | Advisory явно ограничен windows.NewNTUnicodeString и GOOS=windows. Linux/amd64 бинарник и gosu source используют unix. Windows package в Linux build не входит. |

### zlib: исправление и расхождение severity

[Alpine Secdb](https://secdb.alpinelinux.org/v3.24/main.json) и
[APKBUILD ветки 3.24-stable](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD)
подтверждают fix 1.3.2-r1; snapshot и checksums сохранены в `upstream/`.
Минимальный vendor patch меняет только обработку ошибочного nonblocking gzwrite:
сбрасывает avail_in и возвращает next_in во внутренний буфер. APK той же ветки/архитектуры,
SHA256 `63aeea03c15a2f9018f81805cfc8aa926bdf5cd68921f22149c2fbb5d0ee9f47`;
штатная проверка подписи apk обязательна, allow-untrusted не используется.

**Существенное ограничение прежнего 0C/0H:**
[первичный CNA advisory](https://www.vulncheck.com/advisories/zlib-1.3.1.2-through-1.3.2-heap-buffer-overflow-via-gz-vacate)
оценивает эту же CVE как HIGH, CVSS v4=8.3 / v3.1=7.4.
Raw Trivy MEDIUM сохранён без переписывания; он не доказывает отсутствие High по другим источникам.
Первичная CVE JSON с обеими оценками сохранена в `upstream/cve-zlib.json`.

### moby/user: исправление требует адресной совместимости

[Upstream GHSA](https://github.com/moby/sys/security/advisories/GHSA-mjcv-p78q-w5fw)
подтверждает affected <=0.4.0, fix v0.4.1, DoS при недоверенных account files.
[Fix](https://github.com/moby/sys/commit/85a71bbe1faa36c552a960e6a5f3d0cfb632fbbe)
добавляет предел чтения файла 10MiB, проверку regular file и предел group line 1MiB.
Поэтому обновление требует тестов parser и фактического gosu UID/GID/groups/HOME.
Версия v0.4.1 требует Go1.18 и x/sys v0.1.0; расширять зависимости до x/sys0.44 ради счётчика не требуется.
**Обновление отклонено на первой попытке:** run `39015161422`, workflow/source HEAD `9951d5e2d616c6c4f313b8966e4d67464610cc8e`.
`go test -count=1 github.com/moby/sys/user` завершился FAIL:
`TestParseGroupFileCapsReads` — below-cap fixture даёт лишнюю NUL-группу GID0,
а at/past10MiB fixtures упираются в `bufio.Scanner: token too long` при лимите строки1MiB.
Raw stdout/stderr, dependency patch с суммами модуля и Linux dependency list сохранены в `attempt-1/`.
Это может быть дефектом upstream fixture, а не runtime regression; в этом scope различие не разрешено.
Не менялись upstream tests/fixtures, не добавлялись skip и не выполнялась повторная попытка того же подхода.
Без требуемого подтверждения безопасности moby/user оставлен v0.1.0; finding открыт.
До отказа новый бинарник/образ не были собраны. Последующий образ меняет только zlib,
сохраняя gosu1.19/Go1.26.9 и exact SHA D5.1.10; никакого переноса disposition нет.

### UNKNOWN: причина и решение

[Официальный Go advisory JSON](https://vuln.go.dev/ID/GO-2026-5024.json)
содержит windows-only imports/goos/symbol и fixed0.44.0, но не severity/CVSS.
В сохранённой Trivy-записи также нет CVSS, SeveritySource или VendorSeverity.
По [правилам Trivy](https://trivy.dev/docs/latest/scanner/vulnerability/#severity-selection)
UNKNOWN означает отсутствие пригодной оценки тяжести. Это не отсутствие исправления.
Пакетный module match охватывает x/sys целиком; он не устанавливает достижимость Windows-функции.
Решение: x/sys0.1.0 оставить, raw UNKNOWN сохранить; это аналитическая квалификация применимости,
не CVE-исключение, VEX suppression или новая hash-bound disposition.

## Границы целевой квалификации

После отказа moby новый hosted-only qualifier сохраняет прежний gosu побайтово:
его SHA проверяется в предыдущем и новом образе; пересборки бинарника нет.
Проверяются permissions и named/numeric UID/GID/groups/HOME.
Проверяются exact предыдущий OCI, новый manifest/config/rootfs/binary и allowlist новых layer entries.
Сканы предыдущего и нового образа выполняются одной свежей DB без ignore/config/disposition,
с inventory и SBOM. Новые findings или C/H не принимаются автоматически.
Runtime: fresh init, previous→new PGDATA, PostgreSQL16.15/PID1 UID70, compressed pg_dump/restore
1000 синтетических строк, clean shutdown, restart и new→previous PGDATA.
Локальная статическая сверка старой и vendor r1 libz подтверждает одинаковый SONAME
`libz.so.1` и все111 exported defined dynamic-symbol names (`zlib-static-abi.json`);
это ограниченная проверка интерфейса, не доказательство полной ABI/runtime безопасности.
154/154 tests и 26 migrations D5.1.10 не запускаются qualifier повторно и не выдаются за проверки нового образа:
backend/migrations и gosu неизменны, новая проверка адресована zlib и границам образа.
Возврат к официальному образу доказан ранее только для D5.1.10; новый тест возвращает к D5.1.10.

## Поддержание собственного образа до любого решения о внедрении

1. Назначить владельца образа, еженедельную проверку advisory/версий и внеплановую при security release PostgreSQL/gosu/Go/Alpine. Critical/High блокируют продвижение до квалификации/отдельного решения; новых исключений этот процесс не создаёт.
2. Закреплять platform manifest digest базы, source commits, toolchain/module/APK checksums и официальные подписи. Хранить locks и patches в Git; собирать на одноразовом runner без production secrets. Удерживать локальный OCI дольше 30-дневных Actions artifacts.
3. На каждую сборку сохранять SBOM, provenance с источниками/patches/build parameters, binary/archive/manifest/config hashes и fresh scan DB metadata. Перед публикацией отдельно внедрить подписанную attestation; сегодняшние JSON evidence неподписаны.
4. Подтверждать бинарную воспроизводимость независимыми caches; отдельно квалифицировать воспроизводимость всего OCI (timestamps/layers/package sources), которой текущий эксперимент не доказывает.
5. Проверять account parser, entrypoint/init, PostgreSQL major/data format, extensions и compressed backup/restore. Полные app tests/migrations повторять при затронутых изменениях или перед решением о внедрении; результаты привязывать к exact digest.
6. Сохранять предыдущий проверенный OCI и backup; репетировать возврат на disposable PGDATA. Перед любым будущим production переключением отдельно проверить полноценное восстановление БД и файлов/расширений, определить окно и критерии возврата. Это не разрешение deployment.

## Ранее отменённые CI

Read-only API подтвердил: `38983088302` и `38983084953` — `completed/cancelled`,
updated_at соответственно `2026-10-16T23:50:47Z` и `23:50:49Z`.
Никаких cancel/force-cancel/rerun в этом этапе над ними не выполнялось.
Snapshot — `cancelled-ci-readonly.json`. Обычные CI, автоматически создаваемые push,
не являются evidence этой узкой квалификации и не подменяют прежние release blockers.
Отдельно владелец явно разрешил отменить только новые обычные CI `39015161242` и `39015163447`
от отклонённого HEAD9951d5e. По одному cancel и force-cancel на каждый, без третьей попытки;
согласование и состояние — `owner-authorized-ci-cancel.json`; поздний API snapshot подтвердил completed/cancelled обоих.

## Итог: квалификация нового образа не завершена

**INCOMPLETE, не PASS.** Подтверждены точные ID/версии/источники и применимость остатка.
Сборка zlib-only и package/binary/config checks прошли; новый образ пока не квалифицирован.
Продолжение run39016144800 ожидает runner. Scan/smoke/init/backup-restore нового образа
ещё не выполнены и не подменены историческими154/26. Независимый review пока только
preflight/сужение scope, финального APPROVE образу нет.

**Конкретное решение владельцу:** разрешить отменить оставшиеся обычные автозапуски
39015752147,39015755250,39016144784,39016147540, чтобы предоставить runner уже подготовленной
проверке exact OCI; не менять образ и не запускать новые сборки. Предыдущие два новых CI
от9951d5e отменялись только после явного согласия. Запрос на следующие четыре открыт;
отсутствие ответа не трактуется как разрешение. API показал13 выполняющихся jobs
mandatory environment qualification у39015752147. Исчерпание runner capacity — гипотеза,
назначенные runner ID и точная причина очереди этим snapshot не подтверждены.


Первая zlib-only попытка `39015313560` (HEAD65cad36) выполнила offline signed upgrade r0→r1,
но harness ожидал строку версии от `apk info -v`, получив описание пакета. До сканов/runtime не дошло.
Сохранён raw `attempt-2/commands.json`; один корректирующий commit заменил display-команду
на точную installed DB P/V inventory с проверкой неизменности всех прочих пакетов.
Preflight independent security review этой корректировки APPROVE.
Второй zlib-only run `39015752148` (build HEADd3770c4) подтвердил inventory45packages,
неизменность gosu/config/rootfs prefix и сохранил новый exact OCI, но остановился на
неучтённом в harness пути `lib/apk/db/scripts.tar.gz` (ожидался scripts.tar).
Это штатный путь уже в исходном Alpine; следующая единственная коррекция этой отдельной
проблемы разрешает только .tar.gz и сравнивает полный набор внутренних member names,
types/link targets/mode/UID/GID/file bytes до/после. При отличии — FAIL.
Дальнейшая квалификация использует exact сохранённый OCI run39015752148 без пересборки:
archive SHA392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645,
manifest83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8,
confige8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2.
Qualifier запишет build HEAD отдельно от qualification HEAD в reused-image.json; этот raw ещё не получен, run ожидает runner. Прежний FAIL не выдан за PASS.
Новый OCI artifact [12095095760](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/39015752148/artifacts/12095095760)
доступен в GitHub с30-дневным retention. Полная локальная копия не получена после двух
сетевых попыток; `image/artifact.zip.partial` не является OCI или доказательством integrity.
`image/download-status.json` фиксирует ограничение, третья загрузка не выполняется.
Возможный итоговый review ограничен raw hosted execution evidence, без независимой
локальной перепроверки нового OCI bytes. Перед истечением retention нужна сохраняемая копия.
Лимит — до двух попыток на каждую отдельную проблему, а не произвольные повторные сборки.
Production NO_GO сохраняется. Gates/production Compose/policy/dispositions не менялись.
