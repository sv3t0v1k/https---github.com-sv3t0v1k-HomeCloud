# TEST discovery VM 120 — 2026-11-06

**DISCOVERY PASS на VM 120.** Установленная версия J — `76474223ebd7a2fc0dab418a2778dcdd42ab18bc`. Защищённый кандидат K — `8dbcc4088f9545863ed78d31c4446964ba534a93`, [post-merge CI 9/9 PASS](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/actions/runs/42188535212), identity `81eef331d6e09cc92803e0ad762ddc24a21ab540b42b612313fa694ec562b27b`. Отличие J → K — только документация; 22 исходных файла манифеста и 30 миграций совпадают. [Основание: PR #33](https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud/pull/33).

| Проверка | Результат |
|---|---|
| Исходный TEST стенд | Git HEAD J, четыре контейнера healthy, 30 миграций в БД, HTTPS и авторизация PASS, SHA256 двух синтетических файлов совпали. `AUTO_UPDATE=false`, pending и заявка отсутствовали. |
| Предыдущий receipt | `INSTALLED/COMPLETE` с identity J совпал с installed metadata, активным манифестом и работающими image IDs; после проверки архивирован в root-only каталоге, живой статус стал `NO_JOB`. |
| Код и доступ | Installed discovery worker и оба systemd unit побайтово совпали с репозиторием. Fine-grained GitHub token ограничен этим репозиторием и read-доступом к Actions, Contents и обязательным Metadata; он хранится вне Git в root-only файле `0600`. Значение токена не включено в evidence. |
| Разовый discovery 1 | `08:49:43 UTC`, service exit 0; root-owned кандидат K `0640`, source J, CI run `42188535212`, 30 миграций. |
| Разовый discovery 2 | `08:51:31 UTC`, service exit 0; `checkedAt` обновлён, исходный `verifiedAt` и identity сохранены. |
| Административный UI | Установлена J `7647422`, доступна проверенная сборка `test-8dbcc40`; кнопка ручной установки видна, заявка не создавалась. |
| Timer | `enabled/active`; собственные срабатывания `08:52:30` и `08:58:37 UTC` завершились с кодом 0. Второе обновило `checkedAt` до `08:58:40 UTC`, сохранив identity K; следующий запуск назначен на `09:04:37 UTC`. |
| Нет автоустановки | После двух срабатываний timer Git HEAD VM остаётся J, четыре контейнера healthy, нет install request, live job и pending; host installer не запускался повторно. UI показывает K и кнопку ручной установки, статус «Установка не запущена». |

Установщик, backup, restore и rollback здесь не запускались. Production и мини-ПК не изменялись. Отзыв токена без замены остановит обнаружение: перед отзывом требуется ротация на новый токен тех же минимальных прав либо выключение timer.
