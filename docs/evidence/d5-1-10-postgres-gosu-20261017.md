# D5.1.10 — эксперимент PostgreSQL/gosu

17.10.2026, Asia/Vladivostok. **Эксперимент PASS; Release BLOCKED / Production NO_GO.**
Исходный HEAD `1c7d2424140fa3a8dfc49295edb56c9a471e9857`, квалифицированный harness
`c9882aee68e0d027df8b326080f66b5e8e35416f`, PR №1 draft. COMPLETE не установлен.

## Точная идентичность

| Артефакт | Значение |
|---|---|
| База PostgreSQL16.15-alpine/linux-amd64 | `sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551` |
| Эксперимент `homecloud-d5110:experimental`, manifest | `sha256:fd2e86b5b1a2d9381d6e6018feacda382e6b669dda0a519dbc4744aa46980f95` |
| Config | `sha256:901736d0c387e32c7ddcdabf8491015a710bf99600688229a7b6435ea9aa9415` |
| Архив, SHA256 | `2cffc90fb5c5f3309c3c1e2e708de8267dabab60dc49f164f418f3e1e0581961` |
| gosu1.19 upstream commit | `6456aaa0f3c854d199d0f037f068eb97515b7513` |
| Go1.26.9 official archive, SHA256 | `42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d` |
| Новый gosu, SHA256 | `3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085` |

Единственный новый слой заменяет `/usr/local/bin/gosu`; исходные11 слоёв и runtime
Config/entrypoint сохранены. Исходники и зависимости gosu не менялись; две сборки
с раздельными путями/module/compiler caches совпали. Проверены clean VCS metadata,
статический ELF64 amd64, root:root0755 и запуск PostgreSQL как PID1 UID/GID70.
Воспроизводимость доказана для бинарника на одном runner, не всего OCI.
[Официальные security fixes Go](https://go.dev/doc/devel/release#go1.26.9).

## Результат

| Один exact image, raw findings | Critical | High | Medium | Low | UNKNOWN |
|---|---:|---:|---:|---:|---:|
| Официальный |1|24|31|3|2|
| Эксперимент |0|0|2|0|1|

Trivy0.76.0, одна свежая DB SHA256
`bf1f1b29d76cae9ff085d418cb4bfdb3906b6069f837abdef06558b8102dd1db`,
skip-db-update и hash-контроль после каждого scan, без ignore/disposition.
**58 findings устранено,0новых**; OS target нормализован только для сравнения путей архивов.
Critical CVE-2025-68121 отсутствует в новом raw scan. Остались zlib/CVE-2026-85091(M),
moby/sys/user/CVE-2026-61801(M), x/sys/CVE-2026-39824(UNKNOWN), без принятия риска.

**154/154 tests,12 PostgreSQL suites,0skip/0fail** на exact image;
**26 migrations**, повторный запуск без pending migrations; SQL dump/restore всей
мигрированной fixture-схемы и marker; clean shutdown/restart; official→candidate→official
на одном disposable PGDATA. PostgreSQL16.15/data format16 сохранены.

Источник доказательств: [source build](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38981422399),
[образ](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38981697774/artifacts/12080738832),
[парные scans и154tests](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38982205796),
[итоговые migrations/runtime и консолидированные evidence](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/38982612278).
Успешные build/scans/suites переиспользованы с проверкой hashes, exact image bindings
и неизменного backend tree. CycloneDX SBOM обоих образов, raw reports и provenance сохранены.
Baseline tar wrapper при повторном экспорте отличается от scan-bound archive;
manifest/config/rootfs совпадают. Candidate archive совпадает побайтово.

Независимый reviewer подтвердил34 evidence hashes, все image blobs и raw результаты:
**APPROVE только экспериментальной квалификации**. Локальные полный отчёт, review,
provenance, checkpoint и копия OCI находятся в mirror проекта:
`outputs/d5-1-10-20261017/`. На каждую конкретную проблему была максимум одна корректировка;
отказы и точные границы reuse перечислены в полном отчёте. Обычные push/PR CI отменялись;
их результаты не используются как квалификация этого этапа.

## Границы и решение владельца

Старый hash-bound disposition не перенесён; expiry2026-11-15T00:00Z сохранён.
Официальный production image по-прежнему содержит исходные1C/24H. Production Compose,
image locks, policy/gates, работающий Mac Docker, mini-PC и реальные данные не затрагивались.
Новых исключений, публикации GHCR, merge/tag/release/deploy нет. Прежние blockers
Gitleaks/Compose/esbuild/BuildKit и mandatory CI rootfs сохраняются.

Backup/restore относится к synthetic DB, не реальным файловым данным и полной recovery
процедуре. Provenance неподписана; сопровождение производного образа отдельно не квалифицировано.
GitHub artifacts хранятся30дней; локальная копия сохранена. Resume workflow закреплён на
конкретные artifacts; после expiry новая квалификация требует fresh build без resume env.

**Одно предлагаемое решение:** разрешить отдельную экспериментальную квалификацию
следующего производного образа с x/sys≥0.44.0, moby/sys/user≥0.4.1 и zlib≥1.3.2-r1,
сохранив PostgreSQL16.15, без внедрения текущего образа и без CVE-исключений.
**Production NO_GO.**
