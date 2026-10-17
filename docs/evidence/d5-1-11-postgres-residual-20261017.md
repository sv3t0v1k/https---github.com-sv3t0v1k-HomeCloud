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
повторно сверены локально. Все три записи сохранены в `initial-findings.json`.
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

## Фактический результат целевой квалификации

**INCOMPLETE. Новый OCI не принят; scan/runtime PASS отсутствует.**
[Последний run39016144800 FAILURE](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/39016144800),
qualification HEAD `85ec55e70a374209706bf5ffeeb09b9920fdcdcb`.
Raw `resume-final/`: все11 hashes из evidence-hashes.json сверены локально.

- Только zlib обновлён 1.3.2-r0→1.3.2-r1; все прочие44 package versions сохранены.
- Gosu exact SHA3d0088… сохранён old/new; бинарник не пересобирался. Runtime Config/entrypoint/CMD/env сохранены; old rootfs prefix сохранён.
- Подписанный vendor APK, offline install и image build прошли в run39015752148, build HEAD `d3770c4e49c9d45572f7c0dc70daf3021d8055bd`.
- Последний run возобновил exact тот же archive/manifest/config, без пересборки; source build HEAD и qualification HEAD записаны в `resume-final/reused-image.json`.
- Все10 внутренних apk package scripts имеют одинаковые names/type/link targets/mode/UID/GID/file bytes. Подтверждено `resume-final/apk-scripts-comparison.json`.
- Локальная статическая сверка старой и vendor r1 libz: SONAME `libz.so.1`, все111 exported defined dynamic-symbol names сохранены (`zlib-static-abi.json`). Это ограниченная проверка интерфейса, не полная ABI/runtime qualification.
- Следующий слой содержит `var/log/apk.log`, не включённый в строгий allowlist. Это второй отказ одной проверки допустимых filesystem mutations; третьей попытки нет. Наличие обычного служебного лога не доказывает опасность пакета, но не даёт права объявить непройденную проверку успешной.
- **До fresh scans/SBOM, smoke/init/PID1/restart, PGDATA return и compressed backup/restore выполнение не дошло.** Их результатов нет. Raw scan D5.1.10 не переносится на новый digest; новый count0C/0H/1M/1U не заявляется.
- Qualifier не повторял154 tests/26 migrations. Они относятся только к прежнему D5.1.10, backend/migrations неизменны. Возврат к официальному образу не объявлен доказанным для нового OCI.

Новый experimental manifest:
`sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`.
Config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`;
archive SHA256 `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
[Сохранённый GitHub artifact12095095760](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/39015752148/artifacts/12095095760),
30-дневный retention. Его bytes проверялись hosted helper при resume. Полная локальная копия
не получена после двух сетевых попыток; `image/artifact.zip.partial` не является OCI или proof.
Третья загрузка не выполнялась; `image/download-status.json` фиксирует ограничение.
Независимый review ограничен raw execution evidence, без локальной независимой проверки нового OCI bytes.

| Проблема | Попытки и граница |
|---|---|
| Moby/user update | 39015161422: upstream tests FAIL; одна попытка, update отклонён без обхода. |
| apk version display | 39015313560: info -v вернул описание; одна коррекция на installed DB, 39015752148 version/inventory PASS. |
| Filesystem mutation allowlist | 39015752148: scripts.tar.gz отсутствовал; одна коррекция с equality всех inner scripts, 39016144800: var/log/apk.log отсутствовал → остановка, без третьей попытки. |
| Local OCI download | Две сетевые попытки; нет полного локального OCI, remote artifact сохранён. |
| Разрешённые новые CI cancel | По одному cancel и force-cancel на каждый из двух явно разрешённых IDs, без третьей попытки. |

## Поддержание собственного образа до любого решения о внедрении

1. Назначить владельца образа, еженедельную проверку advisory/версий и внеплановую при security release PostgreSQL/gosu/Go/Alpine. Critical/High блокируют продвижение до квалификации/отдельного решения; новых исключений этот процесс не создаёт.
2. Закреплять platform manifest digest базы, source commits, toolchain/module/APK checksums и официальные подписи. Хранить locks и patches в Git; собирать на одноразовом runner без production secrets. Удерживать локальный OCI дольше 30-дневных Actions artifacts.
3. На каждую сборку сохранять SBOM, provenance с источниками/patches/build parameters, binary/archive/manifest/config hashes и fresh scan DB metadata. Перед публикацией отдельно внедрить подписанную attestation; сегодняшние JSON evidence неподписаны.
4. Подтверждать бинарную воспроизводимость независимыми caches; отдельно квалифицировать воспроизводимость всего OCI (timestamps/layers/package sources), которой текущий эксперимент не доказывает.
5. Проверять account parser, entrypoint/init, PostgreSQL major/data format, extensions и compressed backup/restore. Полные app tests/migrations повторять при затронутых изменениях или перед решением о внедрении; результаты привязывать к exact digest.
6. Сохранять предыдущий проверенный OCI и backup; репетировать возврат на disposable PGDATA. Перед любым будущим production переключением отдельно проверить полноценное восстановление БД и файлов/расширений, определить окно и критерии возврата. Это не разрешение deployment.

## Ранее отменённые CI и побочные автозапуски

Read-only API подтвердил исходные `38983088302` и `38983084953` — `completed/cancelled`,
updated_at соответственно `2026-10-16T23:50:47Z` и `23:50:49Z`.
Cancel/force-cancel/rerun над ними в этом этапе не выполнялись (`cancelled-ci-readonly.json`).

Владелец отдельно разрешил отменить новые обычные CI `39015161242` и `39015163447`
от отклонённого HEAD9951d5e. После одного cancel и одного force-cancel на каждый
поздний API snapshot подтвердил completed/cancelled обоих (`owner-authorized-ci-cancel.json`).
Обычные автозапуски не являются evidence этой узкой квалификации и не закрывают release blockers.

Запрос на дополнительные четыре обычных CI `39015752147,39015755250,39016144784,39016147540`
был отозван после самостоятельного назначения runner квалификации; отмены не выполнялись.
API показывал13 выполняющихся jobs, но исчерпание runner capacity оставалось гипотезой.
Эта очередь больше не является блокером: последний experiment run завершился FAILURE.

## Итог и одно решение владельцу

**Остановлено в установленном лимите: INCOMPLETE; Release BLOCKED / Production NO_GO.**
Квалификация исходных2M/1UNKNOWN документирована; ни один finding не принят и не подавлен.
Доступный vendor fix zlib не равен прошедшему квалификацию HomeCloud image.
Moby/user update не доказан безопасным в этом scope; x/sys Windows-only не требует обновления
ради нуля счётчика. Остаточный риск не изменён в production.

**Рекомендация владельцу:** текущий новый OCI не внедрять; если продолжение нужно,
отдельно разрешить новую ограниченную квалификацию уже сохранённого exact OCI с полным
учётом служебных изменений apk, fresh scans/SBOM и runtime checks, без пересборки и исключений.
В текущем эксперименте лимит проверки filesystem mutations исчерпан; новых попыток нет.
Это предложение будущего решения, не объявление следующего этапа запущенным.

Независимый review одобряет остановку/отчёт INCOMPLETE и ограничения evidence;
итогового APPROVE новому image нет. Подписанная attestation, image reproducibility,
локальная независимая проверка OCI и полноценное восстановление реальных данных не доказаны.
Production Compose/gates/policy/dispositions не менялись. GHCR/merge/tag/release/deploy,
Mac Docker/mini-PC/реальные данные не затронуты. Запрещённый audit file не читался,
не искался, не хешировался и не staged; посторонние untracked сохранены.
