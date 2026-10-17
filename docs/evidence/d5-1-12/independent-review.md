# Независимый security/operability review D5.1.12

18.10.2026, Владивосток. **PASS только для подготовки интеграции. Интеграция BLOCKED;
Production NO_GO; Release BLOCKED; COMPLETE не установлен.** Reviewer не автор
рецепта, verifier, Compose checker или rollback runbook. Блокирующих дефектов в
разрешённом preparation scope не найдено. Этот PASS не квалифицирует новую сборку,
не принимает остаточные CVE и не разрешает работу с production.

## Независимо проверенное

Прочитаны фактические `ops/postgres/{Dockerfile,.dockerignore,prepare.py,
check_compose.py,test_prepare.py,qualification.lock.json,README.md}`, rollback,
выбранные retained/derived evidence, diff единственного roadmap и существующие
Compose/startup-gate/production lock. Для проверки offline verifier прочитаны
`oci-scan-binding.py` и необходимая реализация `Archive`/digest в `provenance.py`.

Выполнены только:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ops/postgres/test_prepare.py
PYTHONDONTWRITEBYTECODE=1 python3 ops/postgres/prepare.py evidence
PYTHONDONTWRITEBYTECODE=1 python3 ops/postgres/prepare.py verify-archive ../outputs/d5-1-11-resume-20261017/candidate.oci.tar
```

Результат: **8/8 новых synthetic tests PASS**, SHA-256 всех **25 retained evidence
совпали**; exact archive, platform manifest, config и **14 referenced layer digests**
сверены без распаковки/запуска. У verifier нет автоматического scan/build/deploy.
Негативные тесты проверяют подмену bytes, symlink/overwrite, изменение при копировании,
traversal/tamper и несовпадение manifest/config/platform. Реальные четыре файла
подготовленного context прочитаны только для SHA-256: их hashes совпали с
`context-result.json` и pins; modes 0644/0644/0755/0644 и mtime 1792224036 совпали.
Ни gosu, ни APK не исполнялись. Полноту состава нового каталога подтверждает
synthetic test; reviewer не выполнял широкого перечисления файлов.

Подтверждён exact manifest
`sha256:83b8b00eca9cb7e77dc6c6bbb3fd4bef197853afa0c2cd104991d7a9673abbe8`,
config `sha256:e8f72c13539571329d433e4d0ea475dc42a6407b36f9332cfe3fd790fe81a7d2`,
archive SHA-256 `392dfe5ab7ce5fdfd77b4c32884ab8700a72124d783fd20b244cba6135d5c645`.
SBOM `24004d905b756af5d3ac15c7eb4df482a284b2c02298e0185866e7f63d4f8f47`
сохранён с hash-verified binding к тому же image. Исторический scan и его независимый
review переиспользованы; новый scan/DB download не выполнялись. Указанные 0C/0H/1M/
1 UNKNOWN и возраст DB около4ч относятся к моменту прежнего scan, а не к текущему
моменту. Build origin отделён от qualification commit. Provenance/SBOM **UNSIGNED**;
хеши не подменяют trust chain или подпись builder.

## Рецепт, контекст и границы квалификации

Base закреплён exact official digest, platform фиксируется протоколом сборки.
Gosu SHA-256 `3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085`
и APK SHA-256 `63aeea03c15a2f9018f81805cfc8aa926bdf5cd68921f22149c2fbb5d0ee9f47`
совпадают между lock, Dockerfile и локальным context. `.dockerignore` ограничивает
вход четырьмя файлами. Подготовка требует новый каталог, проверяет source/copy bytes,
отказывает при symlinks и не читает `.env`. Dockerfile не задаёт плавающий ARG для
base, не отключает APK signature checks, использует local APK/no-network и проверяет
установленную версию zlib. Штатные entrypoint/CMD/ENV/USER/VOLUME наследуются от base.
Статический разбор не обнаружил дефекта, препятствующего отложенной сборке; фактическая
сборка и установка APK этим review **не проверялись**.

Рецепт создаёт **новый candidate**: история слоёв отличается от существующего OCI.
Нет обещания совпадения старого digest или наследования миграций/scan/restore PASS.
Прежняя hash-bound gosu disposition не переносится; Medium и UNKNOWN остаются
открытыми и непринятыми. Новый binary hash требует нового решения даже при том же
названии/версии. BuildKit candidate остаётся BLOCKED существующим gate. Протокол
требует отдельного разрешения, изолированного Linux/amd64 runner, pin/review builder,
двух независимых сборок и сравнения manifest/config/DiffIDs/layers/inventory.
**Воспроизводимость всего OCI UNPROVEN**: context determinism и SOURCE_DATE_EPOCH
не доказывают её. Возможные apk.log/exporter различия указаны без обхода allowlist.

## Compose и recovery

Сохранённый `compose-contract.json` честно обозначен `PASS_STATIC_CONTRACT_ONLY`:
checker сверяет выбранные db поля YAML и exact OCI metadata; не реализует полный
Compose merge/interpolation. Reviewer вручную проверил существующие db mounts,
entrypoint/command, healthcheck/env, отсутствие published DB port и startup-gate
цепочку. Четыре input hashes snapshot совпали с фактическими файлами. В inspected
production override остаётся pinned official; новый Dockerfile/lock к нему не
подключён. Статический результат не доказывает runtime исполнение mount/marker gate,
UID/GID по работающему процессу или успешный возврат exact candidate↔official.
Эти границы прямо сохранены в README/runbook/report.

Rollback учитывает различие Mac named volume и production SSD bind, write freeze,
всех writers, clean shutdown и полную cold copy, logical dumps/globals с остановкой
на ошибке, отдельный restore target, DB+HDD consistency и сохранение originals.
Возврат с текущим PGDATA допускается лишь после проверки его копии на exact official;
recovery из старой точки отдельно требует решения о потере новых записей. Нет
`down -v`, prune, запуска initdb поверх original или обхода marker/mount admission.
Backend не запускается автоматически из-за migrations. Исторические previous↔candidate
тесты не выданы за прямой exact↔official drill. Official rollback pin с прежними 1C/24H
не назван security-approved. **Production recovery UNQUALIFIED**, RPO/RTO не обещаны.

## Проверенные SHA-256 preparation files

| Файл | SHA-256 |
|---|---|
| `ops/postgres/Dockerfile` | `808a88be496295434ed3e11caa9f26dc6ae2f5af76a94752606da857536df81f` |
| `ops/postgres/.dockerignore` | `ecd65c9b7bc31701bbac3c234b46e94ab569695f7f5ba5d4d11c6752c2ff19bf` |
| `ops/postgres/prepare.py` | `aa1eec4a96e25aa379e19bf52271edf6de086c858549ede90e7f487f5f1bc939` |
| `ops/postgres/check_compose.py` | `823e0c0bb13d06f4c02ef05348560d776b30b54eace1004a316158ea18ab64c7` |
| `ops/postgres/test_prepare.py` | `7286e9ffcc9aeffff87ec00f51915eb138bd62f52c6de80d6c9ae4182686e28a` |
| `ops/postgres/qualification.lock.json` | `3ffba611aa8aa40055b656a51c4b29181cad7afbee4ac3415fa4348624be1b18` |
| `ops/postgres/README.md` | `0ba863d149ab38d40ff58b793bdc9aff9ff6b42b8f15d6cbc26fda2789c9e5ce` |
| `docs/postgres-image-rollback.md` | `5b1a4f5dd52fb0b30a975e677fece57196c126b8b0bbe2ad86c16ffe344105c3` |
| `compose-contract.json` | `519b633b0689bee9621b941463503057814c1636febd86284af24ee5060ec311` |
| `materials-binding.json` | `4aabe167ebc7b0f2852bce7272fc223c8770f31a87945aa4336dcf2801d93a76` |
| `context-result.json` | `aba749d520fc6c783039b0cdf67032be56696e0b26449c32eec5dee2910ad9d9` |

Compose snapshot inputs независимо совпали: base `07e5028c1d30c75a5798a1c8a15f805b075c03d1a53bd392418e322474279404`,
production `5b92b5b86e1bb68acc213e74f02f278be02f340f2538649c0882bd56115130f2`,
startup gate `a0bec0d0d1338dbab7ba21c388cc3e9683ca28ed380349b08f67f18f5c3dd1d6`,
production lock `60f43ddd5d395c5bdc2bb6ad5f8d28ba498a7dd0fad9fbf960bfb210f64be54b`.

## Открытые условия и допустимое решение

Подготовительный пакет пригоден к рассмотрению владельцем. До интеграции остаются:
непринятые Medium/UNKNOWN; unsigned trust; новый build/reproducibility, если выбран
новый рецепт; долговечный архив материалов/OCI до artifact expiry; ответственные
и maintenance; full Compose CLI и exact production-gate/direct official rollback/
DB+storage recovery drill с RPO/RTO; прежние Gitleaks, Compose, esbuild, BuildKit и
mandatory CI rootfs blockers. Они не закрыты этим review и не объявлены waived.

Решение владельцу: принять preparation package, затем отдельно решить вопрос об
isolated synthetic drill exact OCI↔pinned official на gate-compliant инструментах.
Не разрешены production Compose diff/deploy/publish или production GO. PR draft и
NO_GO сохраняются; roadmap COMPLETE не установлен.

Reviewer не обращался к сети, Docker, mini-PC или реальным данным; не запускал CI,
build, scan, прежние успешные функциональные suites; Git mutations не выполнял.
Запрещённый audit-файл не читался/не искался/не хешировался/не изменялся. Единственная
запись reviewer — этот отчёт; сохранность истории/untracked и финальный Git diff
контролирует основной исполнитель в своей разрешённой области.
