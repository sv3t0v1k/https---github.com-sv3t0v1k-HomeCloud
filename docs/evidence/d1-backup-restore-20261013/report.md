# HomeCloud — D1 Backup & Restore Hardening, 2026-10-13

**D1 gate PASS. Project production NOT_READY / NO_GO, SSD activation OFF.**
COMPLETE не установлен; работа остановлена после D1. D2/D3 не начаты.

## HEAD и исходное состояние

Репозиторий: `/Users/aleksejkozemakin/Desktop/HomeCloud`.
Исходный exact HEAD: `5279d25a2c0c798f546e346a95d89c2f4c99ef4f`.
Implementation/test HEAD: `e8fd3681d357ae094b194d1ade011270e5346fb8`.
Коммиты: `c760a06` — actual mount/backup/reconcile; `e8fd368` — restore/preflight/fencing/tests.
Оба сообщения по-русски. Final documentation HEAD/status фиксируются после
последнего commit в итоговом отчёте текущей задачи: hash собственного commit
невозможно включить в его содержимое.

Первичный status с исключением запрещённого audit path: только два чужих untracked:
`docs/evidence/frontend-functional/closure-checkpoint.json` и `closure-controls.json`.
Они не читались, не хешировались, не изменялись и не добавлялись в Git.
Запрещённый `scripts/tests/PHASE-5.3.1-TEST-AUDIT.md` исключён из чтения,
содержательных searches, hashes, diff и stage; его состояние отдельно не проверялось.
Никаких clean/reset/prune, push, tag, release, mini-PC/SSH операций не выполнялось.

## Изменения и пределы

- Actual existing backend CID + Compose project/service/oneoff/config-hash + image
  ID + declared/actual mount type/source/name/driver; explicit external name и bind.
  STORAGE_VOLUME — assertion фактического имени, не альтернативная цель. Host-path/
  project-prefix fallback удалены. Helpers не создают volumes и читают архив/estimate/
  reconciliation RO, без сети/pull; backend сохраняется через stop.
- Перед DROP/switch: integrity/mode checks, реальный SQL replay в private tmpfs PG,
  known exact BASE TABLE sets 7/8/9/10/11/13, actual migration replay в том же
  network-none namespace, required current fields и migration520. Current13 и
  historical518/519 проверены. Sparse paths/sizes используются только в own tmpfs;
  это не копия payload и не проверка полного SQL type/constraint parity.
- Pending SSD/nonlegacy sessions, незавершённая finalization/cleanup запрещены в
  source/target и backup publication. 518 без cleanup proof запрещает любой journal.
  Современный committed+cleaned journal — retained metadata; device/inode replay
  после восстановления не обещается. SSD workspace/.tmp bytes не архивируются.
- Target pending guard до stop и после fencing; hashes повторяются после confirmation
  под lock. При destructive failure — no recovery up, stop backend/frontend,
  token-scoped migration oneoff cleanup. Readiness HTTP200/parsed ready/database+storage
  ok, total deadline5s/body8192B. Existing staging/swap сохранены и блокируют retry.
- Compose deployment/backend source/migrations/dependencies/frontend не изменены.
  Build-only config без explicit image, missing/stale backend, unsupported remote-only
  bind, image mismatch/extra VOLUME и unavailable guard отказывают fail-closed.

## Baseline comparison и порядок проверок

Сначала добавлены assertions и воспроизведены дефекты исходного HEAD в замороженной
копии только разрешённых scripts. После этого внесены fixes и выполнены disposable
checks. Baseline fixtures не обращались к preview; реальный опасный сценарий старого
restore воспроизведён только на own project/DB/storage.

| Regression | Exact baseline | Candidate |
|---|---|---|
| External name / bind-as-volume / unrelated override | 3 assertion FAIL | PASS |
| Current13 rejection / unknown-schema writer restart | 2 assertion FAIL | PASS |
| HTTP error/incorrect body + missing deadline | 4 assertion FAIL | PASS |
| Actual current13 restore | DB заменена, storage старый, writers запущены после error | exact rows+bytes, success |

Команды baseline (exit1 ожидаем):
```bash
python3 scripts/tests/test-recovery-storage.py --baseline --baseline-root ../d1-baseline
python3 scripts/tests/test-restore-schema.py --baseline-root ../d1-baseline
python3 scripts/tests/test-restore-health.py --baseline-root ../d1-baseline
```
`d1-baseline` — frozen allowed scripts исходного `5279d25`; для воспроизведения вне
этой задачи извлекать individual разрешённые scripts из указанного commit.
[Mount log](mount-baseline.log), [schema log](schema-baseline.log), [health log](health-baseline.log).
Все 25 ранее существовавших offline instances (schema11/config11/cleanup1/metadata2)
сохранили PASS. Metadata fixture адаптирован к verified snapshot API, assertions
фильтрации registry metadata не ослаблены. Новых baseline failures не скрывали.

## Окончательный offline набор

| Команда | Результат | Пропуски |
|---|---|---|
| `python3 scripts/tests/test-recovery-storage.py` | 22 PASS | 3 SKIP |
| `python3 scripts/tests/test-restore-schema.py` | 13 PASS | 0 SKIP |
| `python3 scripts/tests/test-restore-preflight.py` | 13 PASS | 0 SKIP |
| `python3 scripts/tests/test-restore-health.py` | 8 PASS | 0 SKIP |
| `python3 scripts/tests/test-restore-storage.py` | 2 PASS | 0 SKIP |
| `python3 scripts/tests/test-restore-cleanup.py` | 1 PASS | 0 SKIP |
| `python3 scripts/tests/test-recovery-config.py` | 11 PASS | 0 SKIP |
| `python3 scripts/tests/storage-registry-metadata.test.py` | 2 PASS | 0 SKIP |

**72 PASS; 3 SKIP — только explicit baseline-only cases.**
[Полные команды, exit codes и outputs](offline-suite.json).
Bash syntax и Python AST PASS. ShellCheck не установлен; проверка им не выполнялась.

## Реальные isolated gates

```bash
python3 scripts/tests/test-d1-runtime.py --image hc-d1-runtime:5279d25 \
  --postgres-image postgres:16-alpine --baseline-root ABS/d1-baseline \
  --evidence ABS/runtime-final-source.json
python3 scripts/tests/test-d1-historical.py --image hc-d1-runtime:5279d25 \
  --postgres-image postgres:16-alpine --baseline-root ABS/d1-baseline \
  --evidence ABS/historical.json
```

**Current gate12/12 PASS**: external name и bind round-trip current13; invalid SQL
с пересчитанными hashes до target mutation; pending SSD backup/source/target rejection;
five injected failures import/storage/migration/reconcile/health с остановленными
backend/frontend; actual baseline destructive13 rejection + writer restart.

**Historical gate9/9 PASS**: actual populated migrations до512/513/514/515/517/518/519
→ restore/migrate current13 + migration520, exact name/bytes; current13 missing size
column с пересчитанными hashes отвергнут до target mutation; `/data/storage` round-trip.
Fixtures используют readiness/writer-start sentinel, а не full Nest application runtime.
Реальны PostgreSQL, текущие compiled migrations и backup/restore/reconcile CLI.
[Current raw evidence](runtime-final-source.json), [historical raw evidence](historical.json),
[gate summary](gate-summary.json), [проверенная копия исходников](repository-source-verification.json).

Полные raw stdout/stderr и Docker traces сохранены в каталоге текущей задачи
`/Users/aleksejkozemakin/.codex/.chatgpt-projects/g-p-6aaa72ceff208191895b0fd466f3e892/d1-work/docs/evidence/d1-backup-restore-20261013`; versioned evidence оставляет compact snapshots/summaries.
Absolute log paths внутри JSON указывают на эти сохранённые originals.

## Изоляция и cleanup

12 random own fixtures в окончательных gates: 3 current + 9 historical/additional.
Только fresh labeled external volumes или canonical own `/private/tmp` bind;
DB target tmpfs; no ports, own internal network. Scratch containers без target mounts,
network none/localhost namespace, read-only rootfs,512MiB/1CPU/128PID/1GiB PGDATA.
Scope guard проверяет каждую delegated recovery Docker operation до выполнения.
Cleanup — explicit ID/name+label/token, без blanket prune и обнаружения чужих targets.

Canonical before/after records **13 existing containers / 76 volumes / 10 networks**
совпали после обоих final gates; включены status/running/StartedAt/FinishedAt/RestartCount,
mount и network fields без Env. Порядок unordered Mounts/aliases канонизируется,
значения/количество records сохраняются. Все own fixture cleanup PASS, residues0.
Preview/live DB/data не подключались, contents volumes не читались и не хешировались;
существующие Docker объекты только inspect для metadata evidence. Shared daemon resource
usage не означает zero-impact физическую гарантию. Recovery source SHA256 фиксировались
только для шести разрешённых файлов и совпали до/после final gate и после copy в repo.

## Неудачные попытки и anti-loop

- Первый runtime diagnostic: root изменил Bash script во время его чтения;7 проверок
  успели PASS, reset после storage получил mixed-version command error. Не gate.
  Own cleanup PASS, initial selected snapshots equal. Затем source freeze и новые gates.
- Первый historical diagnostic: private tmpfs mode1777 отвергнут migration515;
  добавлен chmod0700 в own scratch. Fixture uid приведён к repository uid1001.
  Initial raw isolation comparator показал перестановку Mounts, без изменения значений;
  raw mismatch сохранён, final comparator канонизирует unordered arrays. Не gate.
- Initial offline metadata API fixture mismatch исправлен только адаптацией input/mock;
  post-fix2PASS. Owned-cleanup unit сначала наблюдал stdout, который cleanup подавляет;
  исправлен observer stderr, production logic не менялась из-за этой ошибки.
- Backend sandbox listen denial: затем один authorized local run. После завершения
  assertions own Jest оставил open handles, завершён SIGTERM. Нет утверждения full PASS.
- 4 migration-preflight failures промежуточного candidate до followup сохранены как
  diagnostic, не выдаются за comparison с exact original HEAD.

[Первый runtime diagnostic](runtime-attempt1.json),
[первый historical diagnostic](historical-attempt1.json),
[offline first run](offline-suite-first.json). Ошибки не скрывались; повтор выполнялся
после конкретного изменения/диагноза. После зелёных gates broad повторов нет.

## Backend, lint и build

`npm test -- --runInBand --json --outputFile=...`: exact baseline backend source
на macOS — **956 PASS / 38 FAIL / 154 SKIP,1148 total**;4 failed suites/12 skipped suites.
[Список каждого failed instance и границы сравнения](backend-summary.json).
Backend src byte-equal исходному HEAD, D1 не исправляет эти failures. Candidate backend
suite не дублировался: code unchanged. Исторический Linux1148PASS из roadmap не выдаётся
за результат этого запуска. Full deployment/DR/offsite/browser suites не запускались:
они требуют иных images/fixtures, часть старых synthetic valid dumps не содержит
структуры для нового real migration preflight; нельзя использовать preview как test target.
Encrypted wrapper focused test не запускался: age/age-keygen отсутствуют, wrapper unchanged.

`npm run lint`:0 errors/15 прежних warnings. `npm run build`:PASS (TypeScript/Nest);
compile output использован в отдельном local fixture image, deployment image не изменён.
[Lint](backend-lint.log), [build](backend-build.log).
[Independent critical review](independent-review.md): unresolved MUST_FIX0; reviewer
не автор, Docker не вызывал. Root отдельно проверил diff, assertions и isolation evidence.

## Остаточные риски и следующий gate

Полный DB+files rollback отсутствует; multi-entry rename не атомарен при crash.
SIGKILL/daemon/external auto-start/сторонние writers и реальный сигнал во время attach
не квалифицированы. Требуются maintenance write barrier, отсутствие concurrent
source/remount/backup substitutions и ручной разбор retained swap/stage. Client bind
inode не доказывает daemon inode, check→mount TOCTOU остаётся. Preflight resource limits
могут отказать большой БД; per-object payload checksum/полное schema parity/50+GiB RSS,
physical SSD/HDD, reboot/power loss и target enrollment здесь не проверены.
Pending SSD и legacy temporary upload resume не обещаются. Nonempty pending journal
predicates reviewed; отдельной actual SQL state matrix journal в D1 не было.

**Решение: принять локальный D1 script/test checkpoint; production NO_GO сохраняется.**
Следующий предлагаемый gate — отдельно разрешённый D2 isolation Compose review/fixtures.
Он не начат. D3/mini-PC/SSD activation остаются отдельными gates. После D1 остановиться.
