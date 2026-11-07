# UPDATE UX: переход TEST-стенда на проверенный host-контур

Дата: 2026-11-08. Стенд: VM120. RELEASE и `AUTO_UPDATE=false` не менялись.

До перехода были сверены защищённый `test` HEAD `b72ebc47d81db38bfd4c5f79c2bb7ae5369df6b7`, успешный push CI `42425342417`, опубликованный TEST-манифест `9a20f7e6a0d6e9a2dc86af41469d5e178c8881315c160578d81553033514f1bb` и текущий установленный checkpoint `7a8eda92bef3be34b9905b8a6adc3a28448bc999`. Независимый read-only review разового финализатора устранил два случая исполнения checkout-кода до сверки его хэшей.

На время перехода были остановлены admission path и discovery timer, проверено отсутствие активных задач, `request.json` и `pending.json`. Действующие host anchors и unit-файлы сохранены в root-only резервной копии. Новый root-owned архиватор подтвердил прежний `INSTALLED/COMPLETE` по `installed.json`, `last-status.json`, `state.json` и живым контейнерам, после чего перенёс `current.json` в архив по identity.

Единственный checkout стенда переведён на защищённый commit `b72ebc4`; новые anchors и unit-файлы установлены с проверкой SHA256, владельца и режима. Штатный `test-dry-run` дал `INSTALL`, проверка manifest/source прошла. Разовый `test-apply` завершился `INSTALLED: exact TEST pair and public HTTPS smoke passed`, создал backup и очистил `pending.json`. Проверенный финализатор опубликовал `installed.json` для `b72ebc4`; повторный dry-run дал `SKIP: exact TEST source already installed`.

После сверки state, last-status, installed metadata, backup и отсутствия блокирующих файлов admission, discovery и archive timer снова включены. Первое обновление через UI и повторный цикл проверяются отдельно; этот документ не считается доказательством их прохождения.
