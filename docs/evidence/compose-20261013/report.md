# HomeCloud — рабочий Compose Mac/dev и подготовка Linux, 2026-10-13

Результат: основной `docker-compose.yml` реально запущен на существующем тестовом
Mac project `homecloud-preview`. ДБ и storage volumes сохранены; второй стек не создан.
Frontend http://localhost:8080, PostgreSQL/backend/frontend healthy. SSD uploads OFF,
production NOT_READY / NO_GO. COMPLETE не установлен; остановиться после этого этапа.

## Исходное состояние и scope

Репозиторий `/Users/aleksejkozemakin/Desktop/HomeCloud`, exact исходный HEAD
`c2edc270c8e2440363766e8a416d7b75e1313b65`, branch main. Проверены ROADMAP, D1 report,
Compose/Dockerfiles/nginx, bootstrap, migrations и реальные backend env.
Только две посторонние untracked evidence JSON были в scoped status; их содержимое
не читалось, не менялось, не stage'илось. Запрещённый audit path исключён из всех
поисков/status/diff/stage, не читался, не хешировался и не менялся.

Изменены только deployment/runtime wiring, recovery env allowlist, combined Compose release fingerprint и документация.
Backend/frontend business source, migrations, зависимости/lockfiles не менялись.
Нет SSH/mini-PC/physical mount mutations, push/tag/release, prune, down -v, удаления
volumes/БД, destructive migration или остановки unrelated контейнеров.

## Какой файл использовать

- `docker-compose.yml`: Mac, PostgreSQL+backend+frontend, loopback8080; Redis profile OFF.
- `docker-compose.local.yml`: opt-in loopback API3000 для Vite5173, поверх основного.
- `docker-compose.production.yml`: только override основного; SSD PostgreSQL bind,
  HDD `/storage` bind, TLS ingress и exact proxy trust. На mini-PC не запускался.
- `.env.example`: обязательные пустые secret fields, генератор в runbook; не weak defaults.
- [Точные команды и operator contracts](../../docker-compose.md).

Главные исправления: отсутствует fixed external preview volume name/container_name;
project-scoped volumes сохраняют текущие имена при прежнем project. Main/dev больше
не требует TLS/production env. Native addon собирается внутри Linux image. Новый
named-volume directory получает UID1001/.tmp/mode0700 через image copy-up; существующие
volumes автоматически не chown/repair/erase. API entrypoint запускает миграции в
transaction all до сервера, helpers D1 и explicit migration commands обходят startup.
Frontend template использует service DNS backend и только согласованный ingress IP;
prod `!override` действительно заменяет ports, mounts, networks. Bind fallback dirs
не создаются; физический mount/source обязан проверить оператор.

## Реальный Docker smoke

Существующая БД имела22 migrations до1746825160000. После остановки HomeCloud writers
применены additive517–520, до26 migrations; SQL520 admission legacy-only, SSD path не
передавался. Backend marker и storage не переписывались. Старый HomeCloud TLS ingress
штатно остановлен и сохранён; Compose показывает его как stopped orphan. Старые
networks/volumes не удалялись. API/backend port после dev smoke снова не опубликован.

- Build backend/frontend PASS: native build + Nest + TypeScript/Vite в Linux images.
- Main/config, main+local/config, main+prod/config PASS (prod PUBLIC_HOST=homecloud.test
  для проверки, не production deployment). Проверены replacement bind paths/no public
  frontend ports/exact trust variables/SSD omission.
- Main `up --wait`: все3 сервиса healthy; внутренний parsed readiness DB+storage PASS.
- API smoke **22/22 PASS**: собственная registration/login/quota, legacy limits,
  файл3145768bytes четырьмя чанками, точный SHA256 download, Range206 bytes0–127,
  HttpOnly native cookie download; новая незавершённая сессия с одним чанком.
- Штатный `restart backend frontend`: exact file bytes, pending chunk metadata,
  quota/storageUsed, mount source и migration count сохранились. Startup recovery mode
  manual, SSD disabled; это legacy persistence, не SSD recovery qualification.
- Реальный IAB: login → files, готовый файл и hydrated pending session видны;
  browser native download SHA256 совпал. Screenshot `browser-smoke.jpg`.
- Main+local: реальный Vite5173 UI200 и API login через proxy3000 PASS. Собственный
  Vite процесс остановлен, final main config восстановлен.
- Health probe **7/7 PASS**: ready; отказ HTTP503/bad status/bad storage/malformed/
  oversized response; bounded4s deadline. Own scratch container без volumes/network.
- D1 live actual Compose config hash/image ID/mount identity + read-only helper UID1001
  PASS. Не backup/restore data round-trip: destructive recovery не выполнялся.
- Prod frontend nginx template envsubst+`nginx -t` PASS в scratch без volumes; actual
  TLS ingress/bind storage/physical Linux runtime не квалифицированы.
- Все9 unrelated containers сохранили IDs/state/start/restart/mount records после
  канонизации неупорядоченного Mounts. Их не запускали/не останавливали.

Checksum файла: `d3702142bd88fb10a19fa59a2ed60a6cfdd0755f63be0dcd77a097160fb356a7`.
Собственные smoke данные оставлены для проверки: user11 с quota16MiB, file75
`compose-smoke.bin` (~3MiB), pending session с1MiB chunk. Не делали необратимую очистку
без отдельного разрешения; marker/БД/volumes не удалялись. Скачанная собственная копия
лежит в Downloads. Private smoke credentials/старый dotenv сохранены вне Git, mode0600.

## Другие проверки и review

Полный D1 offline набор: исходно **72 PASS / 3 ожидаемых SKIP**, затем после единственного
нового allowlist regression test `test-recovery-config.py` **12/12 PASS** (было11).
Итого проверенных offline assertions73PASS; остальные7 suites не менялись.
Frontend полный набор **278/278 PASS**. Backend lint0errors/15 прежнихwarnings;
frontend lint0errors. Shell syntax/node syntax/diff whitespace PASS.
Backend full suite повторно не запускался: business src byte-identical HEAD;
baseline D1 **956PASS/38FAIL/154SKIP** не объявляется исправленным. Docker runtime smoke
покрывает изменённый startup. Физические disks, 50+GiB/RSS, crash/power loss, actual
TLS/ACME/public DNS и destructive restore не запускались по scope. ShellCheck отсутствует.

Два scoped независимых AI review (compose_audit, runtime_contract), автор root.
Первый review нашёл configurable API port vs fixed Vite target: переменная убрана,
port3000 согласован. Follow-up: **0 unresolved MUST_FIX**. Root сверил diff/фактические
checks. Runtime env allowlist test сохраняет unknown SSD activation key rejection.

Прямые deployment consumers: proxy privacy fixture адаптирован к nginx template/backend
DNS (AST syntax PASS, Docker fixture не запускался); operator preflight fixture теперь
main:production, **13/13 PASS**. Release manifest fingerprint теперь canonical main+prod,
existing shape/schema сохранены; **31/31 PASS**, включая actual read-only Compose merge.
Независимый compose_audit review этого авторства runtime_contract:0 MUST_FIX.
Исторический standalone checksum с новым helper не проходит source-qualified validation,
включая старый source root; metadata/image-only validation формата сохранён. Исторические
release-pair/final-production harnesses архивируют только старый standalone config и
требуют отдельной адаптации/requalification под новую topology/helper; не запускались.
Никакие current immutable production pair/artifacts в этом этапе не выпускались.

## Diagnostics и anti-loop

Первый HTTP smoke: internal-only frontend имел HostConfig binding, но Docker Desktop
не публиковал NetworkSettings port; connection refused. Исправлено отдельным обычным
web bridge того же проекта, после чего реальный smoke PASS. Никакого второго стека.
Первое сравнение unrelated metadata FAIL из-за перестановки Mounts у двух stopped
контейнеров. Сохранили diagnostic; canonical comparator сортирует только mounts по
Destination, не удаляет значения/records, итог PASS.
Automatic approval review один раз ошибочно истолковал запрет конкретного audit file
как запрет всего scripts/tests и отклонил allowlist test+doc copy. После предъявления
точной границы пользовательского запрета тот же разрешённый test file approved;
никакого обхода/изменения запрещённого файла не было. Blocking approval не осталось.

## Пределы подготовки Linux

SSD flag OFF в Compose, все4 SSD mapping vars отсутствуют. 520 без SSD path seals
legacy admission; последующее ON не enroll'ит workspace, нужен отдельный guarded
procedure/migration. DB на SSD и legacy chunks+files на HDD — подготовленная topology,
не проверенный physical SSD→HDD pipeline. Enrollment marker отдельно от startup.
Ceilings RAM: backend4GiB, DB1GiB, frontend256MiB, ingress128MiB, optionalRedis256MiB;
это config bounds, не измеренный8GiB budget/RSS или гарантия больших uploads.
Build npm сообщает прежние dependency vulnerabilities (production install17, включая
1critical); dependencies не изменялись. Production NO_GO сохраняется.
Fresh named-volume full bootstrap не испытывался отдельным вторым стеком: проверен
image directory provisioning и существующий стек. Корректность физической source
identity, SSD admission/recovery/rollout/atomic restore не заявляется.

Raw/sanitized evidence текущего задания:
`/Users/aleksejkozemakin/.codex/.chatgpt-projects/g-p-6aaa72ceff208191895b0fd466f3e892/outputs/compose-20261013`.
Final HEAD/status записываются отдельным closure-state после commits. Следующий этап
не начат; COMPLETE не устанавливать.
