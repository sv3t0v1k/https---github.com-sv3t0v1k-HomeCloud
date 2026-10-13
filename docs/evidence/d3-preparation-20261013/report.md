# D3 — подготовка Linux mini-PC, 2026-10-13

Исходный фактический HEAD: `69959de7528bba954f6a9ef3f283ab1ac96544fd`, совпал с ориентиром.
До изменений tracked status чистый; три прежних посторонних untracked сохранены.
Проверены ROADMAP, Docker runbook, Compose evidence, production override, env template,
520, storage/recovery contracts. Запрещённый audit файл не читался/не искался/не
хешировался/не менялся/не staged. Исторические отчёты не переписаны.

## Подтверждённые исправления

- Production inherited unless-stopped мог обходить ручную проверку mounts после boot/
  daemon restart. Override теперь restart=no; systemd связывает запуск с exact mount
  units, перед стартом читает UUID/serial/config/permissions/capacity/architecture.
- Существование source directory не доказывает физический mount. Preflight отвергает
  missing exact mount, другой UUID/serial/FS/диск, nested mounts (включая PG WAL),
  external pg_wal/tablespaces, symlinks и недостаточную capacity/inodes.
- Image nextjs реально UID1001/GID65533; production user и host ownership явно
  согласованы с D1 restore id-g-nextjs. Backend Dockerfile/Mac runtime не изменены.
- Runbook D1 дополнен exact BACKEND_IMAGE, GENERATION, внешним config, capacity,
  maintenance и возвращением helper-started контейнеров под systemd gate.
- 520 фиксирует guard roots на первом up. Forward enrollment для already-applied
  legacy-only отсутствует: отдельный reviewed forward path, без up/down/rollback520.
  SSD OFF/manual, mapping absent; pending journals/перенос identity требуют STOP.

Файлы: docker-compose.production.yml, .env.example, docs/docker-compose.md,
docs/linux-mini-pc.md, deploy/linux/{preflight.py,test_preflight.py,
host-disks.example.json,homecloud.service,check-database.sql}, этот report и ROADMAP.

## Проверки на Mac

- Actual main Compose config PASS; secret presence проверена только boolean, значения
  не выводились/не сохранялись. SSD=false/manual, 4 mapping keys отсутствуют.
- Actual main+candidate production merge через Docker Compose v5.1.3 и отдельный
  synthetic env PASS. Текущий Mac env для Linux отвергнут по незаполненному PUBLIC_HOST;
  его не изменяли. Linux требует отдельный external runtime.env.
- **30/30 D3 fixtures PASS**: actual merge, restart bypass, ON/empty mapping, source
  fallback, wrong bind, published Mac port, UID/GID, image tag/registry port, RAM ceiling,
  missing mount с существующим каталогом, UUID/serial, readonly/NFS, capacity/inodes,
  LVM/symlink, nested PG WAL/file mounts, ownership/mode, external WAL/tablespace,
  default PG layout и согласованность env-i/ExecStopPost/mount dependencies.
- **12/12 D1 recovery-config regressions PASS**, explicit allowlist test file.
- Native read probe из operator runbook реально PASS в own scratch current Linux
  ARM64 image с user1001:65533, network none, read-only, cap-dropALL, **без data mounts**.
  Это подтверждает команду и image ownership, не target amd64/physical/native write.
- Python AST syntax PASS. Первый fixture run выявил numeric-string mem_limit в Compose
  JSON и canonical macOS temp alias; исправлены parser и fixture. Отдельный py_compile
  не смог создать системный cache за sandbox; AST validation заменяет эту проверку.
- Host preflight на Mac ожидаемо STOP до Docker API/host действий: не native Linux amd64.
- Diff whitespace PASS; main/local Compose, backend Dockerfile и migration520 byte-equal
  исходным. Mac running services DB/backend/frontend остались healthy; сервисы не
  останавливали/пересоздавали, volumes/data не меняли. Own scratch только id/native,
  автоматически удалены; pull/build/prune/reset/backup/restore не выполнялись.

Воспроизведение (из checkout на Mac, synthetic inputs, без Docker API):

```sh
HOMECLOUD_TEST_ROOT="$PWD" PYTHONDONTWRITEBYTECODE=1 python3 deploy/linux/test_preflight.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/tests/test-recovery-config.py
git diff --check
```

Полный backend/frontend suite, lint/build images повторно не запускались: business
source/Dockerfile/main Compose не изменены, safety change покрыт D3/config fixtures.
Исторический backend full baseline956PASS/38FAIL/154SKIP не выдаётся за новый PASS.
Systemd-analyze verify не доступен на macOS; unit проверен fixture и независимым code
review, реальная systemd/mount qualification только на target.

## Независимое review и границы

Два узких read-only reviewer (migration/storage и D1 compatibility), основной автор root.
Выявленные MUST_FIX исправлены: native root /app→image /storage, nested PG mounts,
D1-compatible GID, обязательный offsite GENERATION, единое env-i systemd authority,
возврат helper-started stack под unit. Оба follow-up review: **0 unresolved MUST_FIX**.
Root проверил diff, реальные конфигурации и fixtures; отчёт review не заменяет тесты.

Host preflight не обеспечивает cryptographic identity или race-free daemon mount
pinning, mount substitution исключается операторским контрактом. BindsTo не доказывает
fencing active-but-failed I/O. One-shot unit не health supervisor; stop при unhealthy.
Минимумы RAM/capacity — floors, не гарантия peak/large uploads. D1 не гарантирует
атомарный DB+files rollback, SSD workspace/.tmp archive или перенос pending binding.

**Mini-PC не подключали, hardware deploy не выполняли. SSD OFF. Production
NOT_READY / NO_GO. COMPLETE не установлен.** Аппаратные действия, preflight/deploy
команды, evening sequence и стоп-критерии: [инструкция оператора](../../linux-mini-pc.md).
Остановиться после D3 подготовки; forward SSD migration/activation и другие этапы
не реализовывать в этой задаче.
