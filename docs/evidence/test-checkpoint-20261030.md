# HomeCloud — принятый test checkpoint, 30.10.2026

Этот документ фиксирует границы уже выполненной проверки. Сырые серверные логи,
резервные копии, пользовательские файлы и секреты не включены в Git. Доказательства
оператора и QA сохранены вне репозитория. Публичные GitHub-источники и локальные
контрольные суммы отделены от результатов, сообщённых оператором в этой задаче;
последние нельзя независимо воспроизвести по одному этому PR.

| Факт | Проверяемый источник и граница |
|---|---|
| Удалённый `main` — `52ddb5dac277a11ec783b4ca9bdeb89e992c4487` | [GitHub commit](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/commit/52ddb5dac277a11ec783b4ca9bdeb89e992c4487). |
| Backend — `0387feda2496adc3c0e97d2653c7de6bc055a9d7`, image ID `sha256:dd3bfa830e1e1e2dfc340498e3749bbc055c98192986ac0f265fff1433cac1ce` | Read-only `docker inspect` работающего test backend 30.10; revision label совпал с установленными metadata. Код исправления DI — [PR №7](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/7). |
| Frontend — `52ddb5dac277a11ec783b4ca9bdeb89e992c4487`, image ID `sha256:80930d8d6b2b089c73a5a7950222119e9a07fb664d7fe31636b86dbbf41455a8` | Read-only `docker inspect` работающего test frontend 30.10; revision label и installed metadata совпали. Исправление UI — [PR №8](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/8). |
| Backup/isolated restore, 30 миграций, health 4/4 — PASS | Результаты ручного test deploy и изолированного восстановления предоставлены оператором в задаче 27–29.10; финальный протокол не является частью этого PR. Дополнительно 30 имён миграций сверены по read-only installed metadata, все четыре healthy контейнера — по `docker inspect` 30.10. Исправления backup/restore — [PR №5](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/5), [PR №6](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/6). Отдельная production recovery qualification этим не доказана. |
| Safari Browser Acceptance и визуальная приёмка — PASS в проверенном test объёме | Протокол Browser Acceptance в задаче HomeCloud и четыре снимка ниже. Не заявляется Safari 50 ГиБ или production acceptance. |
| QA-данные перемещены в корзину; активных QA-ссылок — 0 | Проверка всех QA-объектов и корзины через HomeCloud 30.10; сохранённый локальный `outputs/homecloud-browser-qa-0387fed-SBz45v/cleanup-report-20261030.md`, SHA-256 `f60b22eb998404c8765278df345c6478cbcdc2bc8492697c0b8e2b803adb84d1`. Безвозвратное удаление не выполнялось. |
| Опубликованный совместимый beta-релиз канала `test` не подтверждён | [GitHub releases](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/releases) на 30.10 содержат только старый `v0.9.0-local.1`; он не является кандидатом Updates v1. Установка обновлений не реализована. |

## Снимки визуальной приёмки

Файлы ниже сохранены в локальном каталоге проекта `outputs/homecloud-visual-qa-52ddb5d/`,
но не добавлены в Git. Контрольные суммы позволяют оператору проверить именно
использованные снимки.

| Файл | SHA-256 |
|---|---|
| `list-download.jpg` | `62be875d3bc6f83ab9ffb84a82803670c458a9818e00976cfaf33a49abab0f0b` |
| `tile-download.jpg` | `0e75d0fcbc976c46e15ca84da0a2cb1d5c2ff881b8742148e56e2a32ff40b2e3` |
| `narrow-list-download.jpg` | `5d5aa707b1551c60554dd8aeb9f92c2c61ebda5791617f58da2d1af92ef91934` |
| `narrow-tile-download.jpg` | `61f6f4cc87a94cd483bf1265613faaccb029454bc7adee923464e83d68820fc2` |

Production остаётся `NO_GO`; Multi-Storage — `DEFERRED`. Этот checkpoint не
присваивает `COMPLETE` D5.1, D5.2, Public Folder Sharing v1.0 целиком или
какому-либо production gate.
