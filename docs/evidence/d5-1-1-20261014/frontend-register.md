# frontend: полный реестр исходных npm audit записей

Дата: 2026-10-14. Baseline e0c5e00655067b052d2e105e6a27e939eb22eeff.

Запись пакета включает inherited/meta findings; количество записей не равно числу независимых GHSA. Все исходные пути и цепочки находятся в [audit-register.json](./audit-register.json). Путь удалённого пакета может отсутствовать; версия на прежнем пути сама по себе не доказывает исправление — результат определяется свежим audit.

| Пакет | До → после на исходных путях | Severity до → после | Прямые GHSA / inherited из | Первый путь зависимостей |
|---|---|---|---|---|
| `@vitest/mocker` | 3.2.7 → 4.1.11 | moderate → нет | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | `vitest → @vitest/mocker` |
| `brace-expansion` | 5.0.9 → 5.0.12; 1.1.18 → 1.1.21 | high → нет | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | `typescript-eslint → @typescript-eslint/typescript-estree → @typescript-eslint/typescript-estree/minimatch → @typescript-eslint/typescript-estree/brace-expansion` |
| `braces` | 3.0.3 → удалён/перемещён | high → нет | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `tailwindcss → chokidar → braces` |
| `chokidar` | 3.6.0 → удалён/перемещён | high → нет | meta: braces | `tailwindcss → chokidar` |
| `fast-glob` | 3.3.3 → удалён/перемещён | high → нет | meta: micromatch | `tailwindcss → fast-glob` |
| `micromatch` | 4.0.8 → удалён/перемещён | high → нет | meta: braces | `tailwindcss → micromatch` |
| `postcss-nested` | 6.2.0 → удалён/перемещён | moderate → нет | meta: postcss-selector-parser | `tailwindcss → postcss-nested` |
| `postcss-selector-parser` | 6.1.4 → удалён/перемещён | moderate → нет | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | `tailwindcss → postcss-selector-parser` |
| `source-map-js` | 1.2.1 → 1.2.2 | high → нет | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | `postcss → source-map-js` |
| `tailwindcss` | 3.4.19 → удалён/перемещён | high → нет | meta: chokidar, fast-glob, micromatch, postcss-nested, postcss-selector-parser | `tailwindcss` |
| `tinypool` | 1.1.1 → удалён/перемещён | critical → нет | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | `vitest → tinypool` |
| `vitest` | 3.2.7 → 4.1.11 | critical → нет | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | `vitest` |
