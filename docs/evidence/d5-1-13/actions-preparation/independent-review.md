# Независимый review D5.1.13 — GitHub Actions preparation

18.10.2026, Asia/Vladivostok. **PASS только безопасности и честности preflight-подготовки. Исполнение BLOCKED; полный drill не готов.** Production NO_GO; Release BLOCKED; COMPLETE не установлен. Reviewer не автор workflow/harness/отчёта. Этот review не разрешает push, регистрацию workflow, merge, dispatch или runtime.

## Независимо проверенное

Прочитаны новый manual workflow, preflight.py, шесть boundary/regression tests, отчёт подготовки, registration.patch и сохранённые API snapshots github-readonly/origin/permissions-readonly/main-rules-readonly; после завершения автором — remote-download, local-identity, official-metadata и local-checks. Проверен узкий diff единственного docs/ROADMAP.md: добавлен preparation checkpoint без COMPLETE или снятия NO_GO. Сопоставлены используемые prepare.verify_archive, qualification.lock.json, oci-scan-binding/provenance import dependency, runner minimization и существующий actual environment scan/validation. Исходные D5.1.13 report, rollback runbook и image-security-policy проверены ранее в этом review. Production Compose, sources, реальные данные и запрещённый audit-файл не читались и не искались.

Workflow имеет только workflow_dispatch, один ubuntu-24.04 hosted job, timeout25мин, общую concurrency group, contents/actions read, SHA-pinned actions и checkout approved_sha без persisted credentials. Полный source SHA проверяется против actual checkout. Не обнаружены production secret references, release/publish calls, docker build/load/run, mounts, services или privileged containers. Docker обращения context/info/ps/volume/network — read-only и выполняются только после hosted/Linux/amd64 checks. Полную isolation и безопасность runtime они не доказывают; код и отчёт это явно сохраняют.

Artifact проверяется по фиксированным ID/run/build SHA/attempt, not-expired и expires_at, ZIP digest/length и единственному ZIP member. Существующий verifier связывает archive SHA, manifest, config, platform и все referenced layer digests; rebuild fallback отсутствует. Official parser теперь поддерживает как multiarch index с единственным amd64 child, так и уже закреплённый platform manifest; config platform и PG_VERSION проверяются. Первоначальное предположение об обязательном index было исправлено автором после фактического чтения metadata; новый шестой regression test охватывает оба пути. Итоговый snapshot reference_kind=platform-manifest, digest=1a66…4551, config=81bd…7542, Linux/amd64, PG_VERSION16.15; layer bytes и security approval не выдаются за проверенные. Минимизация и actual rootfs/global npm/executed Go tools используют существующие gates без новой scan scope и без exceptions. HIGH/CRITICAL, отсутствующий inventory или stale DB блокируют результат.

Initial status создаётся до checkout, finish/upload используют always(), scan ограничен отдельно от job timeout, runtime не запускается ни при каком исходе. Job намеренно заканчивается failure: BLOCKED_BEFORE_RUNTIME, NOT_RUN, null RPO/RTO. Partial evidence сохраняется best effort; потеря runner/cancel/общий timeout честно исключены из гарантии upload. Uploaded executed-tool binaries исключены, ZIP/OCI не публикуются повторно. Retention evidence1день требует своевременного сохранения результатов владельцем/следующей задачей.

## Матрица и gates

Runtime harness отсутствует и не объявлен готовым. Контракт сохраняет single writer, image identity после каждого switch, rollback текущей cold copy после новых записей, согласованные cold и logical DB+HDD backups/restores, globals с явной bootstrap-role стратегией и остановкой на SQL ошибке. Отдельно перечислены реальные mount/marker/symlink negatives, missing/empty/corrupt/incompatible PGDATA, DB/HDD mismatch и incomplete backup; faults только на copies, originals сохраняются. Gate не эмулируется. App migrations заменять fixture schema нельзя; отчёт сохраняет app-level qualification открытой.

RPO/RTO описаны через подтверждённые DB+file events и monotonic failure-to-full-integrity interval отдельно для каждого пути. Сейчас они NOT_MEASURED. Не приняты Medium/UNKNOWN; provenance/SBOM UNSIGNED, OCI reproducibility UNPROVEN и прежние security/tooling blockers сохранены. До reviewed security qualification обоих runtime images, actual environment/tools PASS и реализации/review настоящего mount fixture контейнерные сценарии запрещены.

## Регистрация, ожидаемые CI и согласие

registration.patch дословно воспроизводит новый workflow и не включает CI/release. Snapshot main не содержит .github; новый workflow ещё не зарегистрирован для workflow_dispatch. Ruleset main требует strict check gate от GitHub Actions app15368, один approving review и last-push approval. Legacy branch-protection endpoint404 не отменяет ruleset. Standalone patch не создаёт настоящий gate и потому НЕ готов к merge; фиктивный зелёный check, skip CI и ослабление ruleset не предлагаются. Путь регистрации и dispatch остаётся BLOCKED, даже после возможной публикации текущей ветки.

Независимо пересчитаны ci.yml matrices:18 jobs и1702 timeout job-мин на один run. Push текущей ветки открытого PR ожидаемо создаёт push+PR synchronize runs. Узкий diff remote cbb74d2..HEAD подтверждает изменение experiments/d5-1-11/qualify.py: дополнительно residual workflow1job/30мин. Итого3auto runs/37jobs/3434timeout job-мин; после разрешённой регистрации один отдельный manual preflight — ещё1job/25мин, общий лимит3459job-мин. Это сумма лимитов, не обещание фактического runtime или bill. Bootstrap branch с одним manual workflow по snapshot имеет0auto runs, но merge заблокирован настоящим required gate. Remote/workflow/ruleset drift требует нового расчёта до публикации.

Public visibility подтверждена сохранённым API snapshot. Billing/account quota и стоимость storage независимо reviewer не проверялись; отчёт правильно не обещает точный total bill и отделяет compute от storage. Ни публикация, ни dispatch здесь не выполнены; владелец должен согласовать конкретный перечень действий отдельно. PR№1 остаётся draft.

## Границы review и оставшиеся препятствия

local-checks.json сохраняет targeted6tests, actionlint1.7.12 и bash-n PASS; reviewer их не повторял и не выдаёт за собственное выполнение. Три source hashes local-checks независимо совпали с текущими workflow/preflight/test bytes. Shellcheck отсутствует и явно отключён. Старые suites, runtime, full app tests, scans/builds и GitHub API запросы reviewer не выполнял. remote-download.json фиксирует одну попытку ZIP download, timeout180сек, partial payload removed, remote NOT_VERIFIED; второй full download не выполнялся. local-identity.json фиксирует только retained local tar SHA392d…c645, manifest83b8…abbe8, confige8f7…a7d2 и14layers, remote_download_verified=false. Reviewer не повторял большой tar verification, remote download или registry requests: независимо проверены соответствие snapshot полям lock и разделение границ, а не транспорт/сам payload. Official metadata является отдельным авторским успешным metadata-only чтением после исправления parser, без замены pin. Workflow на hosted runner обязан заново получить и проверить pinned ZIP; локальный tar не подставляется и не загружается вместо него.

Блокирующих дефектов безопасности preflight-кода в проверенной версии не обнаружено. Оставшиеся препятствия исполнения: регистрация manual workflow при настоящем required gate, незакрытая actual runner/tool квалификация, official security approval, отсутствующий runtime harness/startup fixture и ещё не подтверждённая текущая remote payload integrity. PASS подготовки не закрывает ни одно из них. Единственная запись reviewer — этот файл; Docker/network/Git mutations и внешние действия отсутствуют.

## SHA-256 проверенной версии

| Файл | SHA-256 |
|---|---|
| `.github/workflows/pg-recovery-preflight.yml` | `f5eeb39796015fab5209bcf0a3d20bbba15c83c2196612d9391d877f5073b301` |
| `experiments/d5-1-13/preflight.py` | `7042526e7f8faef1c2bb27dc2e4189e01006320719384d7ac7d96bd6471ff725` |
| `experiments/d5-1-13/test_preflight.py` | `29553c88d9dfd6a7a0fec766ac9e9607a3bf28a7e8109aa7648e0fb9cb0dd1c4` |
| `report.md` | `885984878c4f63c83823afeb93a63ca6bf34b2b09f614f71f909c3be520396e5` |
| `registration.patch` | `2c467b269046b4f83baade3fd1f9f97830ecb36ecc5f9062e80eba27047d9a26` |
| `github-readonly.json` | `45df7e824bbb7a458d4ee79577db77ddc82994c9090b192b7cd2ef21d705ee96` |
| `origin.json` | `d81848f8896c8c731b267e7c2e71fdb0c9acd1651e4208fbcc93cd123a613094` |
| `permissions-readonly.json` | `c67b33898c3707db1e6b4942fb54e49cff5da29f1f7caf8188bd5cd63f6e4c14` |
| `main-rules-readonly.json` | `ede1f66ce4bd3027c4387136e8d0039930ff10c8935ce7046a7113f41cac1918` |
| `remote-download.json` | `9e331f0190fd8553d8d8f16a3acbe962337d3c4de70752ca54562d47a7069497` |
| `local-identity.json` | `9f59d55a616de824cb5a0c7154316afafc38b28b4955f352023cc788ada9cf0e` |
| `official-metadata.json` | `f630d8c564cf6fc8670a3df5c07cd03d6088f80089ec5c6c376316d9da268a7a` |
| `local-checks.json` | `75ac636c0554b133d63ac92f2d9a0be0268f0b69e8fe9b95dd910ddfffc8fea1` |
