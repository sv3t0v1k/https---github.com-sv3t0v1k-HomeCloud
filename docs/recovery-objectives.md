# Независимое offsite recovery и recovery objectives

Ненумерованная remediation, 2026-10-02 Asia/Vladivostok. Overall Production Readiness **NOT_READY / NO_GO**. Evidence и измерения: [qualification](./evidence/offsite-recovery/qualification.json). Локальные Docker volumes одного daemon проверяют логическую и операционную независимость, но не физическую потерю компьютера/диска/daemon.

## Контракт production offsite

Оператор предоставляет target в другом failure domain относительно application host и primary storage, документирует размещение, транспортную аутентификацию/TLS, external credentials, ёмкость и доступ с replacement host. Передача только `backup.age` и несекретного manifest (generation/time/size/SHA256). Integrity verification обязательна до decrypt, authenticated age decrypt и archive validation — до mutation. SHA256 не доказывает authenticity при замене ciphertext и manifest вместе: нужна независимая inventory/ACL и доверенная custody.

Потеря или удаление source staging/volumes не должны удалять offsite restore points. Retention контролируется отдельным target administrator; source writer не должен иметь возможность удалить все сохранённые поколения. Существующий writable filesystem coordinator выполняет remote retention и сам по себе НЕ обеспечивает эту гарантию. Нужны отдельно удерживаемые target-side копии/ACL и независимый digest inventory; если выбранный provider поддерживает immutable/object-lock retention, оператор квалифицирует его конфигурацию и emergency recovery. Возможности provider здесь не предполагаются. Read-only escrow drill защищает копию от source application namespace, но Docker/root administrator остаётся доверенной границей.

## Custody recovery identity

Production policy требует минимум две независимые защищённые копии каждой действующей private age identity, минимум одну вне primary host/failure domain. Это технический контракт, фактические custodian/locations не назначены. Named recovery owner хранит inventory version → public recipient → поколения. Private directory0700, identity0600, offline encrypted storage либо защищённый vault, emergency access без исходного host. Writer и scheduler получают public recipients, не private identity. Не помещать key bytes в Git, chat, logs, manifests, env или image.

Rotation: создать новую identity вне source; сделать две custodial copies; проверить новый encrypted restore; затем переключить public recipients. Старые identities сохранять до истечения всех соответствующих backup, включая target-managed retention. Rotation не отзывает доступ к уже украденным ciphertext+key. Потеря всех копий identity означает НЕВОССТАНОВИМОСТЬ соответствующих backup; обхода шифрования нет. Emergency access журналирует actor/time/reason/key-version/result, без key bytes, с одобрением назначенного owner. Проверять доступ при rotation и регулярном drill.

## Аварийное восстановление без chat context

1. Объявить incident и записать UTC timestamp; закрыть ingress/writers. Получить независимый offsite inventory и выбрать последнее verified поколение; записать его snapshot timestamp и completion timestamp.
2. Подготовить новый host/Compose project, PostgreSQL/storage volumes, trusted recovery tools/images и external recovery.env согласно [backup productionization](./backup-productionization.md). Original host не требуется; config/credentials и release images должны быть доступны независимо.
3. Custodian выдаёт нужную identity по аварийной процедуре в private temporary directory. Получить ciphertext только из независимого target, проверить digest по независимому inventory. Смонтировать target read-only для recovery; local staging находится на replacement encrypted filesystem.
4. Из чистого окружения выполнить `env -i PATH="$PATH" HOME="$HOME" HOMECLOUD_ENV_FILE=/secure/recovery.env bash /opt/homecloud/scripts/restore-offsite.sh GENERATION --validate-only`. После PASS выполнить ту же команду с `--yes` вместо `--validate-only`, при maintenance barrier.
5. Выполнить documented migrations/reconciliation, запустить backend; readiness200 недостаточно: проверить rows/ownership/shares/trash/quota и file bytes/SHA256. Записать readiness и verification timestamps; только после acceptance открыть traffic.
6. Удалить temporary key material по filesystem policy (unlink не secure erase), закрыть emergency access и сохранить безопасные evidence. Missing/wrong key или corrupt artifact — остановка до mutation. Target недоступен — incident/escalation, не выдавать local-only backup за offsite success.

## Recovery budgets

Исторические RPO24h/RTO30min остаются предложениями, не approved SLA. Daily02:00 schedule имеет nominal cadence24h, freshness threshold26h и hourly check; missed jobs/replication failures увеличивают gap без верхней гарантии. RPO = incident time − consistency snapshot time последнего доступного verified backup. Age от completion отдельно отражает freshness, но может занижать data-loss window на backup duration. Не заявлять sub-cadence RPO по быстрому backup.

Измерения monotonic clock: backup completion, external escrow replication, selection/copy, decrypt/validation, DB restore, storage restore, startup/readiness и end-to-end verification. Component timings могут быть inclusive/nested: не суммировать их как независимые. Full-volume transfer/decrypt peak disk и maintenance window квалифицируются на launch dataset.

Candidate budget: для точно измеренного dataset RTO взять округлённое вверх до минуты значение max(две observed end-to-end duration) ×3 плюс 10min на operator access/preparation; это proposal **OWNER_APPROVAL_REQUIRED**, не production guarantee. Candidate RPO для daily cadence — 24h + measured backup/replication window при исправном расписании; владелец должен либо принять этот риск, либо изменить cadence. Alert26h не гарантирует RPO24h. Ни одно число не экстраполируется на production volume.

## Минимальные внешние inputs

- Фактический remote target/placement/failure-domain evidence, authenticated transport/mount, external credential locations, target-side delete/retention separation, independent inventory и capacity.
- Named recovery owner, две независимые custody locations, emergency approval/access/audit sequence; credentials/keys передаются вне chat/Git.
- Replacement host/config/image access, launch DB/storage size и write rate, maintenance window, утверждённые RPO/RTO/cadence/freshness/escalation и full-volume drill.

До этих inputs REAL_EXTERNAL_OFFSITE и REAL_CUSTODIAN_PROCESS **NOT_QUALIFIED**, OWNER_APPROVED_RECOVERY_BUDGETS **NOT_AVAILABLE**. Этот блок не закрывает Linux/DNS/CA, registry provider, alert recipient, E2E и final operator acceptance.

### Итог квалификации локальной механики

| Статус | Результат |
|---|---|
| OFFSITE_FAILURE_DOMAIN_MECHANICS | PASS — distinct escrow volume, source containers/volumes/scratch удалены |
| REAL_EXTERNAL_OFFSITE | NOT_QUALIFIED — same host/daemon |
| RECOVERY_KEY_CUSTODY_MECHANICS | PASS — две copies, A удалена, recovery через B; source без private identity |
| REAL_CUSTODIAN_PROCESS | NOT_QUALIFIED |
| MEASURED_RPO_RTO_BASELINE | PASS — два прогона 128 MiB |
| OWNER_APPROVED_RECOVERY_BUDGETS | NOT_AVAILABLE |
| INDEPENDENT_OFFSITE_RECOVERY_DRILL | PASS |
| INDEPENDENT_REVIEW | APPROVE в declared logical scope |
| PRODUCTION_BLOCKER_OFFSITE_RECOVERY | PARTIALLY_RESOLVED |

Backup4.935/5.098s; escrow replication3.371/3.428s; incident→artifact selected5.690/5.804s; validation0.776/0.771s; authenticated decrypt destructive restore0.143/0.144s; DB restore0.517/0.515s; storage1.316/1.334s; app start+migrations17.325/17.267s; incident→readiness30.681/30.840s; incident→verification31.384/31.543s. Component intervals nested/inclusive, не складывать с totals. В raw evidence restore/validation aggregate mislabeled `legacy_backup`: это inclusive legacy restore child, не повторный backup.

Dataset134217728 bytes:8 файлов по16MiB,2 users,2 folders,1 share,1 trash,1 completed upload; snapshots rows и8 SHA256 совпали. Assert quota проверяет user1, snapshot equality сохраняет accounting обоих users. Prebuilt backend image и подготовленные tools/config используются; provisioning/download images, real custodian access и network recovery не измерены. Нет production-volume гарантии.

Observed snapshot RPO age8.376/8.597s при incident сразу после backup; completion freshness0.056s. Это выбранная точка drill, НЕ sub-cadence RPO. Daily cadence24h и stale26h сохраняются proposed. Candidate RTO12min для этого dataset (ceil(31.543×3/60)min +10min), candidate RPO24h + measured~8.6s pipeline при успешных jobs; **OWNER_APPROVAL_REQUIRED**, owner-approved SLA отсутствует.

Wrong/missing key/corruption: empty DB schema и actual storage sentinel SHA unchanged после каждого failed restore. Offsite unavailable: coordinator nonzero, failed JSON, без ложного success; scheduler delivery mechanics отдельно квалифицированы22 tests с1 intentional skip, production recipient не квалифицирован. All identities lost — документированная unrecoverable ситуация, recovery path не выдуман.

Evidence содержит executed assertion results и file SHA256 inventory. Source/target raw row snapshots и gate transcripts не сохранены после disposable cleanup; независимый reviewer проверил harness и qualification, архивного повторного сравнения rows нет. Это ограничение evidence, не утверждение о сохранённых raw transcripts. Production34 focused и external-config11 PASS; legacy backup safety PASS и restore validation PASS/1 integration SKIP внутри source fixture; scheduler22 tests PASS/1 SKIP. App source не менялся; full backend/frontend suites не запускались.

### Единицы baseline: исправление интерпретации

Raw `rto_verified_seconds` =31.383936416 и31.543150250 **секунды** (JSON decimal point), то есть примерно31,4–31,5 секунды, не31 384–31 543 секунды и не8,7 часа. Raw readiness30.680818291/30.840005 seconds. Candidate12min =ceil(max verified seconds×3/60)+10min согласуется с измерением, но не approved SLA: prepared128MiB local dataset, prebuilt images/tools/config; provisioning, network и human access исключены. Предыдущая интерпретация в чате о8,7h ошибочна; evidence не меняется.
