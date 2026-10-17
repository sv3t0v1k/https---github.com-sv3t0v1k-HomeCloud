# backend: полный реестр исходных npm audit записей

Дата: 2026-10-14. Baseline e0c5e00655067b052d2e105e6a27e939eb22eeff.

Запись пакета включает inherited/meta findings; количество записей не равно числу независимых GHSA. Все исходные пути и цепочки находятся в [audit-register.json](./audit-register.json). Путь удалённого пакета может отсутствовать; версия на прежнем пути сама по себе не доказывает исправление — результат определяется свежим audit.

| Пакет | До → после на исходных путях | Severity до → после | Прямые GHSA / inherited из | Первый путь зависимостей |
|---|---|---|---|---|
| `@angular-devkit/core` | 17.3.11 → 19.2.23 | high → нет | meta: ajv, chokidar, picomatch | `<backend> → @nestjs/cli → @angular-devkit/core` |
| `@angular-devkit/schematics` | 17.3.11 → 19.2.23 | moderate → нет | meta: @angular-devkit/core | `<backend> → @nestjs/cli → @angular-devkit/schematics` |
| `@angular-devkit/schematics-cli` | 17.3.11 → 19.2.23 | moderate → нет | meta: @angular-devkit/core, @angular-devkit/schematics, inquirer | `<backend> → @nestjs/cli → @angular-devkit/schematics-cli` |
| `@istanbuljs/load-nyc-config` | 1.1.0 → 1.1.0 | moderate → moderate | meta: js-yaml | `<backend> → jest → @jest/core → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config` |
| `@jest/core` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/reporters, @jest/transform, jest-config, jest-resolve-dependencies, jest-runner, jest-runtime, jest-snapshot | `<backend> → jest → @jest/core` |
| `@jest/expect` | 30.5.1 → 30.5.1 | moderate → moderate | meta: jest-snapshot | `<backend> → jest → @jest/core → jest-runtime → @jest/globals → @jest/expect` |
| `@jest/globals` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/expect | `<backend> → jest → @jest/core → jest-runtime → @jest/globals` |
| `@jest/reporters` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/transform | `<backend> → jest → @jest/core → @jest/reporters` |
| `@jest/transform` | 30.5.1 → 30.5.1 | moderate → moderate | meta: babel-plugin-istanbul | `<backend> → jest → @jest/core → @jest/transform` |
| `@nestjs/cli` | 10.4.9 → 11.0.18 | high → нет | meta: @angular-devkit/core, @angular-devkit/schematics, @angular-devkit/schematics-cli, @nestjs/schematics, chokidar, fork-ts-checker-webpack-plugin, glob, inquirer, webpack | `<backend> → @nestjs/cli` |
| `@nestjs/common` | 10.4.22 → 10.4.22 | moderate → moderate | meta: file-type | `<backend> → @nestjs/common` |
| `@nestjs/config` | 3.3.0 → 3.3.0 | moderate → нет | meta: lodash | `<backend> → @nestjs/config` |
| `@nestjs/core` | 10.4.22 → 10.4.22 | moderate → moderate | [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) | `<backend> → @nestjs/core` |
| `@nestjs/platform-express` | 10.4.22 → 10.4.22 | high → moderate | meta: @nestjs/core, body-parser, multer | `<backend> → @nestjs/platform-express` |
| `@nestjs/platform-socket.io` | 10.4.22 → 10.4.22 | moderate → moderate | meta: @nestjs/websockets | `<backend> → @nestjs/platform-socket.io` |
| `@nestjs/schematics` | 10.2.3 → 11.1.0 | moderate → нет | meta: @angular-devkit/core, @angular-devkit/schematics | `<backend> → @nestjs/cli → @nestjs/schematics` |
| `@nestjs/terminus` | 10.3.0 → 10.3.0 | moderate → moderate | meta: @nestjs/core, @nestjs/typeorm | `<backend> → @nestjs/terminus` |
| `@nestjs/testing` | 10.4.22 → 10.4.22 | moderate → moderate | meta: @nestjs/core, @nestjs/platform-express | `<backend> → @nestjs/testing` |
| `@nestjs/typeorm` | 10.0.2 → 10.0.2 | moderate → moderate | meta: @nestjs/core, uuid | `<backend> → @nestjs/typeorm` |
| `@nestjs/websockets` | 10.4.22 → 10.4.22 | moderate → moderate | meta: @nestjs/core, @nestjs/platform-socket.io | `<backend> → @nestjs/websockets` |
| `ajv` | 8.12.0 → 8.18.0 | moderate → нет | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | `<backend> → @nestjs/cli → @angular-devkit/core → @angular-devkit/core/ajv` |
| `argparse` | 1.0.10 → 1.0.10 | moderate → moderate | meta: sprintf-js | `<backend> → jest → @jest/core → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config → @istanbuljs/load-nyc-config/js-yaml → @istanbuljs/load-nyc-config/argparse` |
| `babel-jest` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/transform, babel-plugin-istanbul | `<backend> → jest → @jest/core → jest-config → babel-jest` |
| `babel-plugin-istanbul` | 8.0.0 → 8.0.0 | moderate → moderate | meta: @istanbuljs/load-nyc-config | `<backend> → jest → @jest/core → @jest/transform → babel-plugin-istanbul` |
| `body-parser` | 1.20.4 → 1.20.8 | low → нет | [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) | `<backend> → @nestjs/platform-express → body-parser` |
| `brace-expansion` | 1.1.18 → 1.1.21; 1.1.18 → 1.1.21; 5.0.9 → 5.0.12; 1.1.18 → 1.1.21; 1.1.18 → 1.1.21; 2.1.4 → 2.1.7; 2.1.4 → удалён/перемещён | high → нет | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | `<backend> → eslint → @eslint/config-array → @eslint/config-array/minimatch → @eslint/config-array/brace-expansion` |
| `braces` | 3.0.3 → удалён/перемещён | high → нет | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `<backend> → @nestjs/cli → chokidar → braces` |
| `chokidar` | 3.6.0 → 4.0.3 | high → нет | meta: braces | `<backend> → @nestjs/cli → chokidar` |
| `external-editor` | 3.1.0 → удалён/перемещён | low → нет | meta: tmp | `<backend> → @nestjs/cli → inquirer → external-editor` |
| `fast-uri` | 3.1.7 → 3.1.8 | moderate → нет | [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) | `<backend> → @nestjs/cli → @angular-devkit/core → ajv-formats → ajv-formats/ajv → fast-uri` |
| `file-type` | 20.4.1 → 20.4.1; 19.6.0 → 19.6.0 | moderate → moderate | [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473), [GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v) | `<backend> → @nestjs/common → @nestjs/common/file-type` |
| `fork-ts-checker-webpack-plugin` | 9.0.2 → 9.1.0 | high → нет | meta: chokidar | `<backend> → @nestjs/cli → fork-ts-checker-webpack-plugin` |
| `glob` | 10.4.5 → 10.5.0 | high → нет | [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2) | `<backend> → @nestjs/cli → glob` |
| `handlebars` | 4.7.9 → 4.7.10 | critical → нет | [GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7), [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj), [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f) | `<backend> → ts-jest → handlebars` |
| `inquirer` | 9.2.15 → удалён/перемещён; 8.2.6 → удалён/перемещён | low → нет | meta: external-editor | `<backend> → @nestjs/cli → @angular-devkit/schematics-cli → @angular-devkit/schematics-cli/inquirer` |
| `jest` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/core, jest-cli | `<backend> → jest` |
| `jest-circus` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/expect, jest-runtime, jest-snapshot | `<backend> → jest → @jest/core → jest-config → jest-circus` |
| `jest-cli` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/core, jest-config | `<backend> → jest → jest-cli` |
| `jest-config` | 30.5.1 → 30.5.1 | moderate → moderate | meta: babel-jest, jest-circus, jest-runner | `<backend> → jest → @jest/core → jest-config` |
| `jest-resolve-dependencies` | 30.5.1 → 30.5.1 | moderate → moderate | meta: jest-snapshot | `<backend> → jest → @jest/core → jest-resolve-dependencies` |
| `jest-runner` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/transform, jest-runtime | `<backend> → jest → @jest/core → jest-runner` |
| `jest-runtime` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/globals, @jest/transform, jest-snapshot | `<backend> → jest → @jest/core → jest-runtime` |
| `jest-snapshot` | 30.5.1 → 30.5.1 | moderate → moderate | meta: @jest/transform | `<backend> → jest → @jest/core → jest-snapshot` |
| `js-yaml` | 3.15.2 → 3.15.2 | moderate → moderate | meta: argparse | `<backend> → jest → @jest/core → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config → @istanbuljs/load-nyc-config/js-yaml` |
| `lodash` | 4.17.21 → 4.18.1 | high → нет | [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc), [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh), [GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) | `<backend> → @nestjs/config → lodash` |
| `multer` | 2.0.2 → удалён/перемещён; 1.4.5-lts.2 → 2.4.0 | high → нет | [GHSA-xf7r-hgr6-v32p](https://github.com/advisories/GHSA-xf7r-hgr6-v32p), [GHSA-v52c-386h-88mc](https://github.com/advisories/GHSA-v52c-386h-88mc), [GHSA-5528-5vmv-3xc2](https://github.com/advisories/GHSA-5528-5vmv-3xc2), [GHSA-72gw-mp4g-v24j](https://github.com/advisories/GHSA-72gw-mp4g-v24j), [GHSA-3p4h-7m6x-2hcm](https://github.com/advisories/GHSA-3p4h-7m6x-2hcm), [GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm), [GHSA-qvfw-j98x-7q72](https://github.com/advisories/GHSA-qvfw-j98x-7q72), [GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4) | `<backend> → @nestjs/platform-express → @nestjs/platform-express/multer` |
| `picomatch` | 4.0.1 → 4.0.4 | high → нет | [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p), [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) | `<backend> → @nestjs/cli → @angular-devkit/core → picomatch` |
| `proxy-addr` | 2.0.7 → 2.0.8 | critical → нет | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) | `<backend> → @nestjs/platform-express → express → proxy-addr` |
| `qs` | 6.14.2 → 6.16.0 | moderate → нет | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | `<backend> → @nestjs/platform-express → body-parser → qs` |
| `sharp` | 0.33.5 → 0.35.5 | high → нет | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | `<backend> → sharp` |
| `sprintf-js` | 1.0.3 → 1.0.3 | moderate → moderate | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | `<backend> → jest → @jest/core → @jest/transform → babel-plugin-istanbul → @istanbuljs/load-nyc-config → @istanbuljs/load-nyc-config/js-yaml → @istanbuljs/load-nyc-config/argparse → sprintf-js` |
| `tmp` | 0.0.33 → удалён/перемещён | high → нет | [GHSA-52f5-9888-hmc6](https://github.com/advisories/GHSA-52f5-9888-hmc6), [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) | `<backend> → @nestjs/cli → inquirer → external-editor → tmp` |
| `ts-jest` | 29.4.12 → 29.4.12 | moderate → moderate | meta: @jest/transform, babel-jest, jest | `<backend> → ts-jest` |
| `uuid` | 9.0.1 → 9.0.1 | moderate → moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `<backend> → @nestjs/typeorm → @nestjs/typeorm/uuid` |
| `webpack` | 5.97.1 → 5.105.4 | low → нет | [GHSA-8fgc-7cc6-rx7x](https://github.com/advisories/GHSA-8fgc-7cc6-rx7x), [GHSA-38r7-794h-5758](https://github.com/advisories/GHSA-38r7-794h-5758) | `<backend> → @nestjs/cli → webpack` |
