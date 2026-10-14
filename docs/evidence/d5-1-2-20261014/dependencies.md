# D5.1.2 — зависимости и достижимость

Source baseline: `79f8e4b`; этот отчёт описывает локальный dependency candidate, фактический final commit/CI указываются в основном отчёте. Production остаётся `NO_GO`, COMPLETE не установлен.

## Фактический результат

| Tree | До | После | High / critical после | Уникальные GHSA после |
|---|---:|---:|---:|---:|
| Backend full | 30 moderate | 25 moderate | 0 / 0 | 2 |
| Backend production | 9 moderate | 4 moderate | 0 / 0 | 1 |

Это npm audit records с inherited findings, а не число CVE. [Raw full](./backend-audit-after.json), [raw production](./backend-production-audit-after.json), [машинный реестр всех 30 исходных records](./dependency-triage.json). npm audit exit1 ожидаем при moderate; JSON metadata проверены, registry error отсутствует. Gate не менялся; finding не маскируется overrides/ignore.

## Адресные исправления

1. `file-type19.6.0` и nested `20.4.1` заменены единственным exact `21.3.2`; scoped `@nestjs/common.file-type=$file-type`. [ASF advisory](https://github.com/advisories/GHSA-5v7r-6r5c-r473) исправлена с21.3.1; [ZIP advisory](https://github.com/advisories/GHSA-j47w-4g3g-c36v) требует21.3.2. Выбран минимальный общий patched релиз; более новый major22 без необходимости не вводился. [Upstream ASF fix](https://github.com/sindresorhus/file-type/commit/319abf871b50ba2fa221b4a7050059f1ae096f4f), [ZIP fix](https://github.com/sindresorhus/file-type/commit/a155cd7).
2. Вызовы `uploads.service.ts` и `ssd-mime.ts` используют существующий native ESM bridge из CommonJS. Оба передают пользовательские первые4100bytes;55B ASF payload действительно помещается. Размер/try-catch не считались защитой. Framework Nest10 FileTypeValidator сам использует native dynamic import; его entrypoint проверен отдельно, хотя app source validator не использует.
3. Nested `uuid9.0.1` удалён через exact `@nestjs/typeorm11.0.3`, опубликованный adapter явно допускает `@nestjs/core/common^10 || ^11`, TypeORM0.3. Runtime framework остаётся10.4.22. Adapter перешёл с uuid.v4 на crypto.randomUUID; UUID generation проверена под Node24. `@nestjs/terminus11.1.1` — необходимое companion изменение optional peer adapter11;10.3.0 допускал только9/10. Terminus runtime import в приложении отсутствует,11.1.1 явно поддерживает Nest10 и adapter11. [TypeORM release](https://github.com/nestjs/typeorm/releases/tag/11.0.3), [Terminus release](https://github.com/nestjs/terminus/releases/tag/11.1.1), [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Direct/typeorm uuid остаётся patched11.1.1.
4. `npm ls file-type @nestjs/typeorm @nestjs/terminus uuid --all` exit0; broken peers отсутствуют. npm install первоначально предупредил optional Terminus10 peer; companion update устранил конфликт, force/legacy-peer-deps не применялись. npm10 package-lock-only оставлял stale nested file-type20 после добавления override; после двух повторов подход сменён: изолированный scratch resolver, удалены только две stale affected lock entries и registry разрешил tree заново; clean `npm ci --ignore-scripts` подтвердил корректность lock. Unrelated packages/version updates отсутствуют, удалён только orphan dependency graph двух изменённых chains.

## Остаточные риски и предложенные исключения

**Решения пока не утверждены владельцем.** Роль HomeCloud maintainer предложена для принятия/контроля, без выдуманного назначения или согласия. Deadline —2026-11-13, с досрочным пересмотром при изменении условий/появлении patch. Исключения в code/audit/CI не введены. При отсутствии принятого решения эти остаточные риски остаются входом release decision.

- [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75): Nest10 SSE serializer допускает CR/LF в message.id/type; установлен vulnerable code. В `backend/src` отсутствуют `@Sse`, `SseStream`, `.sse()` и соответствующий user-controlled id/type sink. Это evidence ограниченной текущей достижимости, не исправление. Patch только Nest>=11.1.18 требует согласованной framework migration. Предложение: временно принять конкретную SSE advisory при запрете новых SSE consumers до fix; reviewer проверяет отсутствие route, будущий SSE автоматически отменяет исключение. Все четыре production records наследуют эту единственную GHSA.
- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): sprintf<=1.1.3, опубликованного patch нет. Уязвимый formatter может выбросить RangeError при attacker-controlled precision. Chain только dev; актуальный load-nyc-config1.1.0 продолжает использовать js-yaml3/argparse1. js-yaml library import не требует CLI/argparse; реальная загрузка YAML config через parent не загрузила argparse/sprintf ([probe](./residual-reachability-node24.log)). Это не доказательство безопасности всех возможных dev CLI consumers. Production `npm ci --omit=dev` chain не содержит. Предложение: конкретный dev-only риск, репозиторий/CI config считать trusted code, просматривать PR tooling changes, отслеживать upstream patch. Scope не расширен parser-major override или заменой Jest, gate не ослаблен.

## Проверки и ограничения

- Node24.21.0 darwin/arm64: четыре targeted suites,163/163 PASS ([log](./dependency-targeted-node24.log)): legacy uploads, SSD uploads, health, sharing.
- `nest build` под Node24 PASS; compiled CommonJS loader реально загрузил ESM file-type. Regression helper ([log](./file-type-node24.log)) запускает disposable child с внешним10s timeout, поэтому event-loop hang не подвешивает harness. PNG и ASF header recognition; zero-size ASF55B отвергается как undefined; Nest validator acceptance/rejection, malformed ASF reject. ZIP fixture<4100B имеет2MiB uncompressed XML и understated size1, office marker расположен после1MiB; small control с тем же marker распознаётся docx, oversized fixture возвращает zip. Это проверяет fixed fallback, не production нагрузочный benchmark.
- Существующие dependency runtime regressions7/7 под Node24 PASS ([log](./dependency-runtime-node24.log)): multipart boundaries/crafted fields/abort cleanup, Sharp JPEG/PNG, CIDR parsing.
- Первый Node20 native test attempt был ограничен sandbox: health HTTP fixture listenEPERM,8fail/131pass; после разрешённого локального listen и Node24 targeted163PASS. Первые ASF expectation ошибки исправлены после чтения установленного patched parser:21.3.2 malformed input отвергает, тогда как upstream original21.3.1 regression ожидала genericASF. Эти неудачи не считаются PASS; vulnerable ASF baseline не запускался.
- macOS targeted/build не заменяют Linux/PostgreSQL полный suite, amd64/musl/native addon/image tests или real final PR CI. Их результаты и независимое review в основном отчёте.

## Реестр всех 30 исходных records

Node path в таблице — точный lock install path. Полный via graph, reachability, решение, deadline и owner для каждой строки в JSON. Removed inherited record не означает исправление других advisories его parent; например TypeORM/Terminus больше не помечены npm, но установленный Nest core SSE остаётся открытым.

| Пакет | Исходная версия | Lock path | Группа / решение | После | Deadline / owner |
|---|---|---|---|---|---|
| `@istanbuljs/load-nyc-config` | 1.1.0 | `node_modules/@istanbuljs/load-nyc-config` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@jest/core` | 30.5.1 | `node_modules/@jest/core` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@jest/expect` | 30.5.1 | `node_modules/@jest/expect` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@jest/globals` | 30.5.1 | `node_modules/@jest/globals` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@jest/reporters` | 30.5.1 | `node_modules/@jest/reporters` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@jest/transform` | 30.5.1 | `node_modules/@jest/transform` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@nestjs/common` | 10.4.22 | `node_modules/@nestjs/common` | file-type: patched/chain removed | removed audit record | 14.10 / исполнитель |
| `@nestjs/core` | 10.4.22 | `node_modules/@nestjs/core` | Nest SSE: ACCEPTANCE_PENDING | moderate (prod) | 13.11 / maintainer pending |
| `@nestjs/platform-express` | 10.4.22 | `node_modules/@nestjs/platform-express` | Nest SSE: ACCEPTANCE_PENDING | moderate (prod) | 13.11 / maintainer pending |
| `@nestjs/platform-socket.io` | 10.4.22 | `node_modules/@nestjs/platform-socket.io` | Nest SSE: ACCEPTANCE_PENDING | moderate (prod) | 13.11 / maintainer pending |
| `@nestjs/terminus` | 10.3.0 | `node_modules/@nestjs/terminus` | uuid: patched/chain removed | removed audit record | 14.10 / исполнитель |
| `@nestjs/testing` | 10.4.22 | `node_modules/@nestjs/testing` | Nest SSE: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `@nestjs/typeorm` | 10.0.2 | `node_modules/@nestjs/typeorm` | uuid: patched/chain removed | removed audit record | 14.10 / исполнитель |
| `@nestjs/websockets` | 10.4.22 | `node_modules/@nestjs/websockets` | Nest SSE: ACCEPTANCE_PENDING | moderate (prod) | 13.11 / maintainer pending |
| `argparse` | 1.0.10 | `node_modules/@istanbuljs/load-nyc-config/node_modules/argparse` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `babel-jest` | 30.5.1 | `node_modules/babel-jest` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `babel-plugin-istanbul` | 8.0.0 | `node_modules/babel-plugin-istanbul` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `file-type` | 19.6.0, 20.4.1 | `node_modules/@nestjs/common/node_modules/file-type`<br>`node_modules/file-type` | file-type: patched/chain removed | removed audit record | 14.10 / исполнитель |
| `jest` | 30.5.1 | `node_modules/jest` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-circus` | 30.5.1 | `node_modules/jest-circus` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-cli` | 30.5.1 | `node_modules/jest-cli` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-config` | 30.5.1 | `node_modules/jest-config` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-resolve-dependencies` | 30.5.1 | `node_modules/jest-resolve-dependencies` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-runner` | 30.5.1 | `node_modules/jest-runner` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-runtime` | 30.5.1 | `node_modules/jest-runtime` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `jest-snapshot` | 30.5.1 | `node_modules/jest-snapshot` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `js-yaml` | 3.15.2 | `node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `sprintf-js` | 1.0.3 | `node_modules/sprintf-js` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `ts-jest` | 29.4.12 | `node_modules/ts-jest` | sprintf-js: ACCEPTANCE_PENDING | moderate (dev) | 13.11 / maintainer pending |
| `uuid` | 9.0.1 | `node_modules/@nestjs/typeorm/node_modules/uuid` | uuid: patched/chain removed | removed audit record | 14.10 / исполнитель |
