# D5.1.11 — итог единственного дополнительного fresh Trivy scan

18.10.2026, Asia/Vladivostok.

**PASS для квалификации существующего экспериментального OCI в согласованном scope. Production NO_GO; Release BLOCKED; COMPLETE не установлен.** Независимый post-scan security review — PASS в том же ограниченном scope. Остаточные findings не приняты как допустимый риск; новых исключений или диспозиций нет.

## Точный объект и выполнение

- Manifest: `sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`.
- Config: `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`.
- Archive SHA256: `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
- Raw scan SHA256: `6f83142ccaec95dd1fb13c21d78c8b83ee6656a4a050e9fd41cf6efc3fc0d507`.
- Trivy 0.76.0, сохранённый ранее проверенный инструмент; одна загрузка основной DB, ровно один candidate vulnerability scan, returncode 0.
- Просканирован существующий OCI layout через `--input`, linux/amd64, без Docker. Archive, manifest, config, все layout blobs и ordered rootfs привязаны к raw report существующим verifier.

## Freshness до скана

Primary DB: `ghcr.io/aquasecurity/trivy-db:2`.
UpdatedAt `2026-10-17T18:34:28.174846796Z` — **18 октября 04:34:28 Владивосток**.
Scan выполнен 18 октября **08:34:26–08:34:27 Владивосток**.

Возраст непосредственно до scan: `14398.540595204` seconds; после: `14398.922924204` seconds, около 4 часов. Неизменное условие `0 <= age < 86400` выполнено до запуска и после завершения. Наносекундный RFC3339 timestamp разобран с Decimal без потери точности; локальная коррекция разбора metadata не требовала повторной загрузки DB или скана.

DB SHA256 до/после: `53ec1bdd7717514174ed808d43464deab895ce6e32924f8224b2a68b0c244125`. DB не менялась. Скан использовал `--skip-db-update --skip-java-db-update --offline-scan`, config и ignorefile `/dev/null`, все packages, все severity, `--ignore-unfixed=false`. Новых фильтров/waivers нет. Успех определялся по raw findings и bindings, не только по rc0.

## CVE результат

**0 CRITICAL / 0 HIGH / 1 MEDIUM / 0 LOW / 1 UNKNOWN.**

| Компонент / CVE | Результат |
|---|---|
| zlib / CVE-2026-85091 | В fresh Trivy отсутствует. Installed `1.3.2-r1`; все 45 OS packages совпали с сохранённым candidate inventory. Прежние vendor APK/libz proof и CNA High остаются в evidence, severity не понижалась. |
| moby/sys/user / CVE-2026-61801 | MEDIUM, `v0.1.0`, scanner fix `0.4.1`. Finding открыт; прежний отказ upstream tests не обходился. |
| x/sys / CVE-2026-39824 | UNKNOWN, `v0.1.0`, scanner fix `0.44.0`. Сохранённый advisory Windows-only; raw finding сохранён, новой disposition/исключения нет. |

По сравнению с сохранённым историческим набором 2M/1 UNKNOWN отсутствует только zlib CVE; новых package/CVE пар нет. Baseline повторно не сканировался: сравнение с историческим evidence не выдаётся за новую пару сканов на одной DB.

## Использованные evidence и независимый review

Существующие evidence относятся к тому же exact manifest/archive. Их hashes подтверждены: functional compatibility; 26 migrations + no-op + compressed schema/marker restore; layer allowlist и apk scripts; package inventory; unsigned SBOM/binding; build provenance и прошлый review. Успешные тесты, миграции, smoke, backup/restore и SBOM не повторялись. Signed attestation не создавалась; прежняя unsigned provenance не объявляется подписанной.

`independent-review.md` независимо подтвердил freshness chronology, DB/tool/archive/raw scan hashes, exact input binding, 45 packages, текущие CVEs, 12 current evidence hashes и 10 reused reference hashes. Вердикт — **PASS экспериментальной квалификации**, без принятия остаточных MEDIUM/UNKNOWN и без production approval.

## Состояние и ограничения

HEAD `8e8a356e93620f3e0c88904aea74d14c90292b1e` не изменён; рабочее дерево в разрешённом scope чистое. Исходники, security gates, policy/dispositions и docs/ROADMAP.md не менялись. Новых CI, image builds, push, merge, tag/release/publish/deploy нет. Mac Docker, mini-PC, production Compose и реальные данные не затронуты. Запрещённый audit-файл не читался, не искался, не хешировался и не staged; посторонние untracked сохранены.

Итог: прежний blocker отсутствия свежего scan снят для этого OCI и данного DB snapshot. Существующая экспериментальная квалификация дополнена fresh scan и независимым review. Production NO_GO и общий Release BLOCKED сохраняются; COMPLETE не устанавливается. Дальнейшие действия требуют отдельного согласования владельца.
