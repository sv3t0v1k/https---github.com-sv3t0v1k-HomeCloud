# D5.1.13 — независимый review harness и transport

**Вердикт: локальная подготовка принята с ограничениями; блокирующих замечаний по просмотренному snapshot не найдено.** Review охватывает статический код и сохранённые локальные/transport evidence. Целевой unittest suite не запускался повторно. PostgreSQL, Docker, loop/mount и workflow_dispatch не запускались. **Runtime qualification: NOT_RUN.** Этот review не подтверждает фактические RPO/RTO, устойчивость GitHub runner, production пригодность, подпись provenance/SBOM или воспроизводимость OCI.

## Проверенные области

- [.github/workflows/pg-recovery-preflight.yml](../../../../.github/workflows/pg-recovery-preflight.yml), строки 1–112: только manual dispatch, полный SHA и явный boolean для drill; job ограничен ubuntu-24.04/X64 и timeout; `contents:read` + `actions:read`; pinned action SHAs; без production secrets, `continue-on-error`, push/deploy или release permissions. Runtime шаг зависит от успешных предыдущих gates; status/hashes/upload настроены через `always()`.
- [admission.py](../../../../experiments/d5-1-13/admission.py), строки 37–60 и 75–126: официальный image экспортируется из digest-pinned reference через `skopeo --preserve-digests`; существующие strict image/environment validators вызываются повторно; binding связывает archive, scan freshness, manifest/config и rootfs; receipt формируется внутри процесса и привязан к source/run/attempt/job.
- [harness.py](../../../../experiments/d5-1-13/harness.py), строки 110–138, 242–316, 318–463: readiness требует реальный финальный postgres PID1, успешный startup gate, версию/роль сервера и UID; snapshots содержат DB+HDD; restore идёт в новые targets; итоговый PASS выставляется только после полной матрицы и cleanup.
- [runtime_fixture.py](../../../../experiments/d5-1-13/runtime_fixture.py), строки 65–98, 115–165, 222–290 и 307–450: повторный hosted/source/run guard; отдельный приватный root и ext4 loop backing; только recorded immutable images; `--network none`, без ports/privileged/device grants/volumes; проверяются bind identities и отсутствие анонимных volumes; cleanup наблюдает реальный mountinfo и ассоциацию только своего backing file, сохраняет root при недоказанном освобождении и удаляет только подтверждённый exact root.
- [artifact.py](../../../../experiments/d5-1-13/artifact.py), строки 33–65, 76–176 и 179–223: токен используется только к GitHub API; blob URL проверяется и автоматические redirects выключены; resume допускается лишь по strong ETag + If-Match + 206 + точному Content-Range/Length; итоговый ZIP digest и существующий OCI tar verifier обязательны. Ошибки не включают upstream URL/query/текст.
- [recovery_model.py](../../../../experiments/d5-1-13/recovery_model.py), строки 25–112: HDD inventory/check отклоняют ссылки, hardlinks, special files, неожиданные пути/содержимое/владельца/generation и неполные backup компоненты; метрики проверяют последовательность подтверждённых событий и монотонные endpoints.
- Проверены [отчёт подготовки](./report.md), [transport evidence](./artifact-transport.md), [root verification](./root-verification.json) и [local checks](./local-checks.json). Сохранённые evidence показывают локальные тесты/mock boundaries, настоящий remote ZIP digest и tar identity; сами по себе они не квалифицируют runtime.

## Замечания по severity

**Blocker: нет по статическому review.** Обязательные gates не отключены и не заменены пользовательской записью PASS. Medium/UNKNOWN остаются непринятыми; provenance/SBOM остаются UNSIGNED, воспроизводимость OCI — UNPROVEN.

**P2 — runtime timeout и сбор evidence имеют best-effort предел.** Один job ограничен 55 минутами, drill-stage — 8 минутами; workflow `always()` не гарантирует finish/upload при отмене runner, hard timeout или потере VM. Код корректно ограничивает это утверждение и оставляет runtime qualification NOT_RUN до реального исполнения. Для исполнения нужно считать отсутствие итогового evidence возможным исходом, а не успешной очисткой.

**P2 — GitHub Actions пока нельзя запустить этим branch-only изменением.** `workflow_dispatch` требует workflow в default branch. При этом регистрацию через patch, не создающий реальный required `gate`, нельзя считать обходным bootstrap. Сохранённый report правильно оставляет этот внешний prerequisite заблокированным; перед любым будущим внешним действием нужны свежие read-only проверки default branch/rules/CI.

## Итоговая граница

Проверен только код и локальная подготовка текущего snapshot. Успешная передача точного OCI — проверка сохранённого artifact, ZIP digest и неизменённого OCI tar; она не доказывает, что следующий transfer уложится в лимит или что security gates пропустят образ. Фактические переключение, rollback, backup/restore, fail-closed сценарии, cleanup и RPO/RTO остаются **NOT_RUN / NOT_MEASURED**. Production — **NO_GO**, PR остаётся draft, `COMPLETE` не установлен.
