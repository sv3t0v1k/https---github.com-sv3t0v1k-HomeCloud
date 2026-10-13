# Независимый критичный review D1

Reviewer: отдельный subagent critical_review, не автор изменений. Review выполнялся
по разрешённым исходникам и scoped tests в d1-work; Docker daemon не вызывался.

Итог: unresolved MUST_FIX = 0. Условие: зелёные actual disposable runtime gates.

Подтверждённые находки, исправленные автором/root:
- health false success HTTP error/body с ok; добавлены HTTP200, parsed readiness,
  deadline5s, socket timeout и body cap8192B;
- image extra VOLUME/pull; pinned local image ID/config/CID и reject implicit volumes;
- custom STORAGE_PATH в reconciliation; выбранный SQL root с quoting;
- сохранение retained restore swap/staging, отказ автоматического удаления;
- early target pending guard и recheck после fencing;
- scoped owned migration oneoff cleanup, scratch helper cleanup;
- исправлены ошибочные имена digest переменных промежуточной интеграции;
- scratch mode1777 несовместим с migration515: chmod0700 только private tmpfs.

Независимые проверки: первичный scope58PASS/3baseline-onlySKIP; после delta45PASS/
3SKIP (только затронутые проверки); последний chmod delta preflight13PASS/bash-nPASS.
Это наборы с пересечением, складывать их нельзя. Docker interactions в offline
fixtures mocked; review не является независимым runtime/isolation attestation.

Остаточные границы: TOCTOU bind/archive требует maintenance barrier; sparse stage
проверяет metadata/migrations, не payload/полный schema parity; полного rollback нет;
реальный signal во время foreground Compose не квалифицирован offline review.

Root отдельно обязан проверить фактические diff, runtime assertions, cleanup и
before/after canonical Docker snapshots. COMPLETE не устанавливается.
