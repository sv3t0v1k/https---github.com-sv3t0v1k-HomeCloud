# UPDATE UX: первый цикл через UI и восстановление на VM120

Дата: 2026-11-08. Исходная установленная TEST-версия: `b72ebc47d81db38bfd4c5f79c2bb7ae5369df6b7`.

PR #40 прошёл Linux CI, затем защищённый `test` получил commit `71ee9673ae3fbb28c54b7dd2a6841a7c3b3c98f7`. Push CI `42427324823` завершился успешно, включая `test-image` для backend/frontend и `test-pair`; опубликован `test-channel-1` с identity `1076ce41bc7b7bde1217275312769d4d31f33bb9d26f4d7db4ccef76922c4a8f`. Host discovery выдал candidate с `sourceGitSha=b72ebc4` и `commit=71ee967`.

В Updates под тестовым администратором были видны установленная `b72ebc4`, проверенная `test-71ee967` и `NO_JOB`. После подтверждения установки UI показал очередь и фазы проверки; на хосте единственная транзакция дошла до `START_SERVICES`. Конкурентный запуск архиватора во время `RUNNING` завершился отказом без удаления `current.json`.

После установки UI показал `71ee967`, отсутствие новой сборки и `NO_JOB`. На хосте `state.json`, `last-status.json` и `installed.json` совпали по commit; `last-status.json` содержит backup `20261108_055655_e1c19cce`. Receipt `INSTALLED/COMPLETE` автоматически перенесён в `status/archive/<identity>.json`. `current.json`, `archiving.json`, `pending.json` и `request.json` отсутствуют; четыре контейнера healthy.

Для crash recovery при остановленных admission и archive timer был воспроизведён долговечный промежуточный checkpoint: `current.json` и архивный receipt ссылались на один inode (`nlink=2`), присутствовал root-owned `archiving.json`. Повторный запуск штатной archive service завершился успешно, удалил оба блокирующих файла и сохранил архивный receipt (`nlink=1`). Службы возвращены в enabled.

После контролируемой перезагрузки VM120 установленная версия и журнал со ссылкой на backup сохранились; admission path, discovery timer и archive timer активны; четыре контейнера healthy, HTTPS 200, блокирующих файлов нет. `AUTO_UPDATE=false` не менялся. Второй UI-цикл и финальный security review выполняются отдельно.
