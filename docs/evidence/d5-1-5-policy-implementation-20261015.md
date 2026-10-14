# D5.1.5 — реализация согласованной security policy

Production NO_GO. COMPLETE не установлен. CVE dispositions/исключений нет.

## Согласованная архитектура

Владелец разрешил реализацию: четыре raw base scans остаются обязательной диагностикой; четыре точных production runtime проходят строгий HIGH/CRITICAL gate; фактические build/CI environments проходят отдельные строгие проверки. Неполные, устаревшие или не связанные с артефактом evidence блокируют gate. Любые CVE dispositions требуют отдельного индивидуального решения владельца.

## Реализованное покрытие

- Runtime: backend, frontend, PostgreSQL, ingress; linux/amd64. Backend/frontend собираются однократно в OCI archive. Scan и smoke используют этот же archive, проверяются manifest/config/rootfs/source/provenance и SHA scan. PostgreSQL/ingress закреплены точными platform digests в production Compose и production-images.lock.json.
- Build: четыре фактических deps/builder stages и закреплённый BuildKit worker. Stage exports должны использовать только закешированные RUN/COPY/ADD исходной runtime сборки; повторно исполненные операции не квалифицируют её окружение. Сохраняются raw progress, metadata и hashes.
- CI: 16 execution producer environments (список в policy-coverage.py), включая реальные установленные apt пакеты, глобальные npm/bundled зависимости и установленные application dependencies в четырёх соответствующих jobs. Rootfs OS inventory сопоставляется с полным установленным dpkg inventory; npm graph/manifests сопоставляются с package paths сканера. Lockfile не заменяет установленное дерево.
- Collector и final gate проверяют JSON evidence; отдельный production/build артефакт они не производят. GitHub runner/control plane не объявляется квалифицированным production образом.
- Raw node/nginx/PostgreSQL/CI Node baseline: findings сохраняются целиком, severity diagnostic. Ошибка сканирования, неверная архитектура, устаревшая DB и несовпадение закреплённого target остаются блокирующими.
- Будущий release потребляет те же OCI archives и qualification текущего run/attempt, без пересборки; до registry writes обязательна отдельная проверка publication environment. Сам release не запускался.

## Границы и сохранение evidence

Все сканы включают unfixed и dev dependencies, не используют ignore files/config или allowlist. Trivy 0.75.0 и checksum-проверка сохранены; vulnerability DB должна быть свежей (не старше 24 часов, NextUpdate не истёк), Java DB проверяется отдельно. Отчёты содержат все severity и package inventory. Qualification сохраняет findings по каждой обязательной группе даже при BLOCKED; исходные JSON/metadata/logs публикуются как CI artifacts. OCI archives сохраняются 7 дней, scan evidence — 14 дней.

Rootfs выполняется только на GitHub Linux amd64 runner. Checkout, его lexical/real paths, temp/cache и Docker stores исключаются до обхода; application scan ограничен backend/frontend. Запрещённый audit-файл не входит в область чтения сканеров. Mac Docker и реальные данные PostgreSQL не затрагивались.

## Проверки до GitHub CI

78 targeted tests PASS: release 19, provenance 9, scan evidence 10, scan policy 7, environment evidence 16, OCI binding 6, aggregate coverage 8, stage cache 3. Shell syntax и actionlint двух workflows PASS. Независимое source security review: ранее обнаруженные gaps закрыты, конкретных оставшихся обходов не найдено; actual CI требуется для интеграционного подтверждения.

## Findings для решения владельца

Предыдущие evidence D5.1.5 сохранены без повторного исследования: PostgreSQL gosu 1.19/Go1.24.6, CVE-2025-68121 — кандидат на индивидуальный not-affected disposition по фактическому бинарному анализу; disposition не принят. Ingress CVE-2026-31789 — кандидат по ELF64; nginx CVE-2026-49975 и остальные HIGH остаются unresolved. Эти выводы не подавляют scanner findings. Новые результаты обязательных artifact/environment scans фиксируются после одного интеграционного запуска CI. До его завершения полное фактическое покрытие не заявляется.
