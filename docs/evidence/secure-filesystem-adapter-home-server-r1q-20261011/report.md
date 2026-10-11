# HomeCloud MS-3B-R1Q — preflight домашнего сервера

> Продолжение 2026-10-11: **текущий R1Q_GATE=PASS / R1_GATE=PASS в исходном R1 scope**. Native Linux AMD64 квалификация завершена на домашнем сервере; [актуальный отчёт](../secure-filesystem-adapter-home-server-native-r1q-20261011/report.md). Нижеследующий BLOCKED статус относится к исторической попытке. Production NO_GO, secureOpen=false; R2/MS-4 не начаты.

Дата: 2026-10-11, Asia/Vladivostok. **R1Q_GATE=BLOCKED / BLOCKED_STORAGE_PERMISSION; R1_GATE=BLOCKED.**
Квалификация не запускалась. Production NOT_READY / NO_GO; R2/MS-4 не начаты.

| Поле | Результат |
|---|---|
| INITIAL_HEAD | Expected=actual `1f1fc8ecb23adfd19bceb18f7e1010d1a343d8ab`; исходный tracked diff пуст; три известных untracked |
| SSH_ACCESS | PASS: `hs@192.168.3.44`, BatchMode=yes, NumberOfPasswordPrompts=0, StrictHostKeyChecking=yes. Первая попытка заблокирована локальной песочницей; разрешённая повторная попытка успешна. Секреты не запрашивались и не выводились |
| SERVER_BASELINE | Ubuntu22.04.5; kernel6.8.0-134-generic; native IntelN100 x86_64,4CPU; Docker28.2.2 linux/amd64, Compose5.1.0; default context unix:///var/run/docker.sock; overlay2; builtin seccomp+AppArmor+cgroupns. Работают26контейнеров, не27 |
| SAFE_PATHS | `/home/hs/homecloud-test` и `/mnt/1TB/homecloud-test` отсутствуют, dangling symlink также не обнаружен. `/home/hs` принадлежит1000:1000,0755 и writable. `/mnt/1TB` принадлежитroot:root,0755; hs не может создать каталог; `sudo -n true` отказал. **Preflight STOP** до любых изменений |
| MOUNT_IDENTITY | storage: `/mnt/1TB` → `/dev/sdc1`,ext4,rw,relatime,stripe=8191; Available989676662784bytes (~921.71GiB). `/home/hs` → `/dev/mapper/ubuntu--vg-ubuntu--lv`,ext4,rw; Available185333948416bytes (~172.61GiB). sda SSD238.5GiB; sdc USB HDD3.6TiB с двумя разделами; mount не менялся |
| CPU_MEMORY_SWAP | RAM8059514880bytes (~7.51GiB), available5092888576 (~4.74GiB); swap2074083328/4294963200 (~1.93/4GiB). load0.09/0.16/0.18. vmstat: две секундные выборки si=so=0; историческая первая строка9/14KiB/s не текущая нагрузка. Это короткий snapshot, не доказательство долгосрочной стабильности |
| PORTS | Read-only `ss -lnt` выполнен. Среди занятых:22,53,80,81,443,1880,2222,3000,5056,6881,7878,8080,8085,8090,8096,8123,8181,8989,8971,9099,9443; также динамический loopback44853. Порт для HomeCloud не выбран/не забронирован; конфликты проверять повторно перед запуском |
| ISOLATION | Существующих containers/networks/volumes с Compose label `homecloud-test` не найдено. Новый project/network/PG/volumes/ports не создавались. Будущий запуск только с явным `-p homecloud-test`, non-root app, builtin seccomp, без docker.sock/privileged/host network; frontend/Redis добавлять только при необходимости квалификации |
| DEPLOY_STATUS | NOT_STARTED: preflight остановлен на отсутствии прав на storage. Исходники/образы не переданы; Compose не создан; build/pull/run не выполнялись |
| OPENAT2_NATIVE_AMD64 | HOST_ARCH_CONFIRMED / SYSCALL_UNQUALIFIED. Номер kernel и builtin seccomp не доказывают openat2 внутри контейнера; syscall/addon/ELF проверки не запускались |
| ATTACK_RESULTS | NOT_RUN: production Multer, chunk lifecycle, symlink5→0, ancestor swaps, traversal, cleanup,2000attempts,EXDEV,restart/SIGKILL/recovery. Старые ARM64/Rosetta evidence не считаются native AMD64 PASS |
| REGRESSION_TESTS | Targeted/full backend/9PG suites/lint/typecheck/build/runtime smoke NOT_RUN: stop до развёртывания. Production код не изменён; нет основания нагружать сервер для заблокированного gate. Проверка скрипта владельца: см. validation ниже |
| REVIEW | Независимый scoped review отчёта и owner-script: отдельный `independent-review.md`. Не заменяет отсутствующую qualification |
| DATA_INTEGRITY | Canonical stack/storage/DB не подключались и не изменялись. Свежая проверка11table/FS hashes и21/21bindings не выполнялась; прошлое `../secure-filesystem-adapter-native-amd64-r1q-20261011/data-integrity.json` подтверждает прежний checkpoint (5files/37021bytes/21bindings), а не новый прогон. Production source/config, secureOpen=false и extra workspace activation не менялись |
| UNTRACKED_INTEGRITY | Два разрешённых JSON до/после проверяются SHA256: closure-checkpoint `1b579e8f3f25462c45bd3ac1fbfabd2987a4165e2a971cb65ca46af8130518ff`; closure-controls `26e0b0f92a23e0be631427752552c680d8372de726ec86a13c5c28582c33b9d4`. Третий запрещённый audit не открывался/хешировался/изменялся/staged/committed; известен только из git status; исключён из поисков/diff |
| R1Q_GATE / R1_GATE | BLOCKED_STORAGE_PERMISSION / BLOCKED. Native host найден, прежний blocker «нет доступной среды» для этой попытки снят; qualification ещё не выполнена, operational PASS отсутствует |
| RESOURCE_IMPACT | Только read-only inventory: docker stats один snapshot, vmstat3строки, metadata и SSH. Дополнительных workload контейнеров0. Не измерен transient peak inventory. Ограничить будущие проверки последовательным выполнением/одним CPU, backend~1GiB и PG~512MiB; перед каждым этапом повторить available RAM и si/so |
| SERVER_CHANGES | **NONE** со стороны этой задачи. Docker daemon/context/networks/firewall/порты/mount/разделы/существующие контейнеры/volumes не менялись. `sudo -n true` — единственная непривилегированно неуспешная проверка sudo; owner-script на сервере НЕ запускался |
| COMMITS / FINAL_HEAD / GIT_STATUS | Только русский documentation checkpoint этой попытки; exact SHA сообщается в итоговом ответе, не самоссылкой в commit. После commit ожидаются tracked clean и ровно3исходных untracked |
| NEXT_ACTION | Владелец создаёт один пустой каталог безопасным скриптом ниже; затем сообщает выполнение. Повторить preflight целиком; не запускать Compose автоматически. После успешной квалификации остановиться, R2 требует отдельного решения |

## Точный следующий шаг владельца

На Mac передать только проверенный скрипт во временный уникальный файл и выполнить его **в собственной сессии на сервере**. Пароль sudo при необходимости вводится владельцем локально, не отправляется в чат и не передаётся агенту.

```sh
cd /Users/aleksejkozemakin/Desktop/HomeCloud
remote_script=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes hs@192.168.3.44 'umask 077; mktemp /tmp/homecloud-r1q-owner.XXXXXX.py') &&
scp -o BatchMode=yes -o StrictHostKeyChecking=yes /Users/aleksejkozemakin/Desktop/HomeCloud/docs/evidence/secure-filesystem-adapter-home-server-r1q-20261011/owner-prepare-storage.py "hs@192.168.3.44:$remote_script" &&
printf 'На сервере выполнить: sudo python3 %s\n' "$remote_script"
```

Команда создаёт новый временный файл скрипта; это **предлагаемый владельцу шаг**, не уже выполненное изменение. Цепочка && не выдаёт команду запуска после ошибки SSH/SCP. Скрипт проверяет UID/GID, mount source/ext4, device identity и root ownership родителя. Открывает ancestors через dirfd/O_NOFOLLOW, делает exclusive mkdir одного каталога, fchown/fchmod только нового FD, fsync. При существующем файле/каталоге/ссылке — отказ без перезаписи. Не рекурсивный chown, не chmod mount root; child storage/workspace ещё не создаются. При ошибке после mkdir не удаляет ничего автоматически: сообщить владельцу точное состояние и перепроверить. Device identity относится к текущему /dev/sdc1, а не постоянному UUID; concurrent root mount replacement не входит в модель защиты.

В server terminal после запуска:

```sh
stat -c '%n|%F|%u:%g|%a' /mnt/1TB/homecloud-test
find /mnt/1TB/homecloud-test -mindepth 1 -maxdepth 1 -printf '%f\n'
test -w /mnt/1TB/homecloud-test && printf 'STORAGE_TEST_ROOT_WRITABLE=yes\n'
```

Ожидается directory1000:1000,700; пустой find; WRITABLE=yes. Каталог проекта создаст агент после повторного PASS preflight. Одно только создание каталога не закрывает R1Q.

## Validation

Синтаксис PASS; шесть изолированных локальных fixtures PASS: создание единственного каталога, отказ при существующем каталоге без overwrite, существующей ссылке, ссылке ancestor, изменённом mount и неверном UID. Реальные mkdir/O_NOFOLLOW/fchmod/fsync выполнялись только в локальном disposable temp; UID/mount/root metadata и fchown mocked. [Лог](owner-script-validation.txt). Эти проверки не являются server/production qualification. Проверенные права изоляции и metadata контейнеров сохранены в [server-baseline.txt](server-baseline.txt); это повторный read-only snapshot после остановки, не замена первоначальных цифр RAM.
