# Независимый security review после свежего скана — 18.10.2026

Вердикт: PASS для результата квалификации существующего экспериментального OCI в разрешённом scope. Прежний blocker свежего vulnerability scan устранён. Это не принятие остаточных MEDIUM/UNKNOWN, не production approval и не завершение roadmap: Production NO_GO, COMPLETE=false.

Reviewer выполнил только чтение и пересчёт хешей текущих артефактов и явно выбранных существующих references. Trivy, загрузка DB, тесты, CI и Docker не запускались; код и прежние отчёты не изменялись. Запрещённый audit-файл не читался, не искался и не хешировался. Единственное изменение reviewer — этот отчёт.

Все 12 файлов текущего evidence-hashes.json независимо пересчитаны; все SHA-256 совпали. Промежуточный статус evaluation.json до независимого review сохранён без изменения; окончательное заключение дано здесь отдельно.

## Свежесть и исполнение

Представленные execution records согласованно фиксируют одну DB загрузку и один candidate scan: preflight counters=1, db-check scan_attempts=0 до запуска, scan-command attempt=1/retry_allowed=false, binding scan_attempts=1. Загрузка primary `ghcr.io/aquasecurity/trivy-db:2` завершилась rc0 до проверки возраста и до scan. Повторного baseline scan в этих артефактах нет.

Независимо перепроверена полная хронология timestamp и Decimal-разность RFC3339 с nanoseconds. DB UpdatedAt `2026-10-17T18:34:28.174846796Z` — 18 октября 04:34:28 по Владивостоку. Непосредственно перед scan возраст `14398.540595204` секунды, после `14398.922924204` секунды; оба значения находятся в неизменном диапазоне `0 <= age < 86400`. Scan выполнен 18 октября 08:34:26–08:34:27 по Владивостоку; CreatedAt raw report находится внутри этого интервала.

Фактический DB SHA-256 `53ec1bdd7717514174ed808d43464deab895ce6e32924f8224b2a68b0c244125` совпал с db-check до scan, записью после scan и scan binding. Сохранённая metadata соответствует cache metadata. Хеши ранее проверенных official Trivy archive/executable также совпали с текущим preflight.

Raw argv включает vuln scanner, все packages, `--skip-db-update`, `--skip-java-db-update`, `--offline-scan`, `--ignore-unfixed=false`, config и ignorefile `/dev/null`, platform linux/amd64 и exact materialized OCI input. Severity-фильтра или нового ignorefile нет. Rc0 сам по себе не считался прохождением gate: результат независимо пересчитан из raw vulnerabilities.

## Exact binding и результат

Manifest: `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`.

Archive SHA-256: `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.

Config: `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`.

Raw scan SHA-256: `6f83142ccaec95dd1fb13c21d78c8b83ee6656a4a050e9fd41cf6efc3fc0d507`.

Независимо проверены archive hash, выбранный manifest, config, размеры и digest всех layout blobs, их связь с исходным archive, полный состав layout без лишних файлов/symlinks, ArtifactName/ArtifactType, scan ImageID, platform и ordered rootfs DiffIDs. Binding соответствует этим bytes. Все 45 OS packages совпадают с сохранённым candidate inventory; zlib — `1.3.2-r1`.

Пересчитанный результат: **0 CRITICAL / 0 HIGH / 1 MEDIUM / 1 UNKNOWN**, без LOW. В raw scan ровно два findings, оба в неизменном gosu:

| Компонент / CVE | Проверенный результат | Граница решения |
|---|---|---|
| zlib CVE-2026-85091 | Отсутствует при установленном 1.3.2-r1; vendor APK/libz bytes проверены ранее | Исторический CNA High сохранён в references; severity не понижалась ради gate |
| moby/sys/user CVE-2026-61801 | MEDIUM, v0.1.0; scanner FixedVersion 0.4.1 | Finding остаётся; прежний отказ upstream tests не обходился, обновление не принималось |
| x/sys CVE-2026-39824 | UNKNOWN, v0.1.0; scanner FixedVersion 0.44.0 | Finding остаётся; сохранённый Go advisory указывает windows/NewNTUnicodeString. Новая disposition/исключение не принимались |

Исходный historical findings файл независимо сверён с его checkpoint SHA-256 `e04f2d677857caba657724fe7576e7ae975152b52fd17ec53f4d25b96d9a54f4`. Текущие package/CVE пары являются строгим подмножеством прежнего набора: удалён только zlib CVE-2026-85091, новых IDs нет. Это сравнение с retained historical finding list; same-DB paired baseline comparison не выполнялся и не заявляется. Порог текущих 0C/0H, отсутствие zlib CVE и отсутствие новых IDs подтверждены без waiver.

## Повторное использование evidence и итог

Все 10 reference hashes из reused-evidence.json независимо совпали: identity/provenance, functional compatibility, 26 migrations/no-op/compressed restore, layer inventory, apk scripts/package inventory, unsigned SBOM/binding и прежний независимый review. Эти результаты относятся к тому же manifest/archive. Исторические успешные тесты и SBOM не перезапускались; source_commit текущего scan binding обозначен как qualification evidence, а build origin сохранён отдельно в provenance. Подписанная attestation не заявляется.

Подтверждены существующий OCI, прежние функциональные PASS и unsigned SBOM, теперь дополненные свежим scan с пройденными указанными gates. Блокера в этом ограниченном экспериментальном результате не найдено. Остаточные moby/user MEDIUM и x/sys UNKNOWN не закрыты и не приняты как допустимый production risk. Дальнейшее решение владельца — зафиксировать проверенный результат эксперимента в текущем roadmap без установки COMPLETE; Production NO_GO сохраняется.
