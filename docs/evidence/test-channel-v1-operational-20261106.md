# TEST Channel v1 — operational checkpoint, 2026-11-06

**Operational E2E PASS на VM 120; Production RELEASE — NO_GO.** Защищённый `test` и установленный TEST Git HEAD: `76474223ebd7a2fc0dab418a2778dcdd42ab18bc` (J). [Post-merge CI J](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/42182725230): 9/9 PASS.

| Сценарий | Подтверждённый результат |
|---|---|
| TEST apply и backup | Штатный apply с проверенным манифестом, созданием backup и проверками образов пройден; восстановление проверено отдельно. |
| Restore | Полное штатное восстановление тестовой записи БД и файла завершилось с кодом 0; данные и SHA256 совпали. [Исправление health gate: PR #23](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/23). |
| Version rollback | Реальный переход B → A через штатный rollback, проверка image IDs, журнала и защиты от повторного отката; это не тест отказа. [Кандидат B: PR #24](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/24). |
| UI TEST install | Администратор запустил I `20a82df` → J `7647422` кнопкой «Установить»; UI показал этапы и итог, host worker завершился с кодом 0, durable status `INSTALLED`, нет pending. Реальные backend/frontend image IDs совпали с манифестом J. [UI/worker: PR #25](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/25), [host discovery: PR #27](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/27), [исправления: PR #29](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/29), [PR #31](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/31), [кандидат J: PR #32](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/32). |
| После установки | 4/4 контейнера healthy, 30 применённых миграций в БД, HTTPS 200 и вход администратора успешны; два тестовых файла доступны и имеют ожидаемые SHA256. |

Временный GitHub-токен удалён с VM после E2E. Discovery timer выключен; `AUTO_UPDATE=false`. Разовая проверка обнаружения при UI E2E не означает, что периодическое обнаружение введено в эксплуатацию. Следующий шаг — отдельный ввод read-only token и таймера по [плану](../updates-test-discovery.md); никакой автоматической установки по публикации сборки нет.
