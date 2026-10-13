# D3 — коррекция для существующего Docker-хоста, 2026-10-13

Исходный фактический HEAD: `3228bb99992f029a5b632831ae10972522b02643`.
Коммит кода: `178c814697cbdc63297a772049bab754e2169671`.
Tracked status был чистым. Два посторонних untracked в `docs/evidence/frontend-functional/`
сохранены. Запрещённый audit не читался/не искался/не хешировался/не менялся/не staged.
Предыдущий [D3 report](../d3-preparation-20261013/report.md) — исторический checkpoint.

## Изменения и доказательство отказа

HomeCloud — отдельный Compose project поверх уже установленного Docker Engine.
DB/backend проходят readonly shell gate при КАЖДОМ штатном старте, включая Docker
restart и Compose run helpers, до official initdb/chown или migration/API entrypoint.
Gate сравнивает host UUID alias device metadata (major:minor/source), host exact
mountpoint и собственный container bind (device/root/source/ext4|xfs/rw); затем physical
marker, owner/mode и layout. Проверяет nested mounts, HDD .tmp и external PG WAL/tablespaces.
Marker вне PGDATA/storage, поэтому не мешает fresh initdb и не заменяется D1 data swap.

Если mount отсутствует при существующем underlay каталоге, UUID device и own bind
identity/root не совпадают. Скопированный marker не даёт PASS. Поздний правильный host
mount не исправляет stale bind: gate проверяет именно собственный mount namespace.
Отказ — exit1 ДО вызова writer; нет создания/chown/touch/fallback или ожидания диска.
Docker также отказывает до entrypoint, если missing bind source с create_host_path:false.

Production использует unless-stopped; обязательный HomeCloud systemd unit устранён.
Опциональный unit — лишь boot-order/BindsTo helper; общий docker.service/daemon.json
не менялись. Compose не обеспечивает host mount ordering, поэтому ранний startup
безопасно отказывает; после mount может потребоваться операторский повторный up,
а stale bind требует review maintenance/recreation только собственного writer.

Project/ports/origin/proxy subnets обязательны; fixed container/external network names
не добавлены. PUBLIC_ORIGIN согласует CORS с внешним HTTPS origin. Redis вынесен в
unqualified-production-redis profile и не включается. Main/Mac Compose не менялся.
В recovery_config.py разрешены только3 новых несекретных PUBLIC_* ключа, чтобы D1
читался с теми же Compose port/origin knobs; соответствующий existing regression расширен.
Это необходимая совместимость, не развитие D1.

SSD → DB. HDD → файлы и legacy .tmp. SSD uploads OFF/manual,4 mapping vars отсутствуют.
Временные uploads на SSD отложены до reviewed forward enrollment, который в scope не входит.

## Проверки

- **27/27 startup gate fixtures PASS**: verified backend/DB + literal argv, missing host
  mount при существующем каталоге, late mount/stale bind, cloned marker/root disk,
  UUID/source/bind-root/readonly mismatch, wrong marker/symlink/permissions, .tmp,
  nested file mount, ambiguous valid+valid и valid+invalid FS records, повторный старт,
  PG WAL symlink/external tablespace. Writer-spy вызывается только после PASS.
  Fixtures подменяют metadata/stat/rdev/mountinfo; это admission proof, не реальные mounts.
- **36/36 preflight/config fixtures PASS**, actual Compose merge с отдельным synthetic
  env: отсутствие gate/explicit command, writable gate, privileged writer, preview
  project/external network и прежние UUID/serial/layout/config negatives отвергаются.
- **12/12 D1 recovery-config regressions PASS**, новые PUBLIC_HTTP_PORT/PUBLIC_HTTPS_PORT/
  PUBLIC_ORIGIN сохраняются literal. First candidate run:2 failures из-за отсутствующего
  recovery_storage.py в изолированной копии; добавлена только зависимость fixture, final PASS.
- **Изолированный Docker smoke PASS** в имеющихся postgres:16-alpine и homecloud-backend:dev:
  оба writers × missing config/missing UUID alias × первый старт/прямой docker restart.
  Все8 запусков exit1/STOP; StartedAt изменился после restart, PASS/writer не достигнуты.
  Network none, readonly root, cap-drop ALL, только gate script readonly bind; DB tmpfs,
  для missing UUID synthetic config в own tmpfs (backend scratch root только для создания
  synthetic root-owned config). Ни data bind, ни named/anonymous volume у4 smoke целей.
  Удалены только собственные scratch CID, действующий project не перезапускался.
  Финальная проверка: прежние CID frontend `a0038f42c940`, backend `27ed00f2965b`,
  DB `2eee7cfcd0ce` сохранились, все3 healthy; чужие контейнеры не менялись.
- Shell syntax и используемые BusyBox stat formats проверены внутри обоих Alpine images;
  Python AST и enrollment block syntax PASS; actual-checkout targeted rerun27/36/12 PASS. py_compile не мог писать системный cache;
  AST использован вместо изменения host cache permissions. Git whitespace/diff проверены.

Воспроизведение config/fixture checks, без подключения data/mounts:

```sh
HOMECLOUD_TEST_ROOT="$PWD" PYTHONDONTWRITEBYTECODE=1 python3 deploy/linux/test_preflight.py
PYTHONDONTWRITEBYTECODE=1 python3 deploy/linux/test_startup_gate.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/tests/test-recovery-config.py
sh -n deploy/linux/startup-gate.sh
```

Full backend/frontend suite, application lint/build и image rebuild не повторялись:
business code/Dockerfiles/main Compose не менялись; проверен targeted deployment scope.
Systemd-analyze отсутствует на Mac; optional unit проверен fixture/review, не Linux runtime.

## Независимое review и ограничения

Узкий read-only reviewer независимо воспроизвёл2 P1: потеря awk exit status позволяла
valid+overlay stacked-mount admission; Compose override entrypoint терял image CMD.
Исправлены capture-return-status до split и explicit writer commands; negatives добавлены.
Reviewer повторил exploit: STOP до writer. Final review: неустранённых критических
дефектов нет в разрешённых файлах. Основной исполнитель проверил diff и повторил fixtures.

Root/Docker admin может подменить gate/udev/markers или --entrypoint; это не sandbox и
не криптографическая disk identity. /dev readonly нужен только для metadata; device
cgroup/privileged/devices/capabilities не расширены. Hardened host proc/udev ACL могут
дать STOP. Host serial/capacity/native arch проверяет preflight; per-start gate проверяет
UUID/source/own bind/markers/permissions. Runtime physical loss/hung I/O не fenced.

**Mini-PC не подключали. Реальные native Linux amd64 UUID/udev/proc ACL, FS bind,
mount ordering/reboot/daemon restart/device renumbering, powerloss, target TLS/DNS и D1
round-trip не проверены. Production NOT_READY / NO_GO. COMPLETE не установлен.**
HTTP→HTTPS redirect пока на внешний443: custom host ports требуют подтверждённого routing;
прямой custom HTTPS можно пробовать отдельно, HTTP redirect к custom external port не
квалифицирован. Target hardware/forward SSD enrollment и следующие этапы не начинались.
Остановиться после этой коррекции. [Точные команды/STOP](../../linux-mini-pc.md).
