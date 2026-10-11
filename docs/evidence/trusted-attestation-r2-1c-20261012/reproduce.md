# Проверка и воспроизведение R2.1C

Без SSH/изменений среды:

```sh
node protocol-tests.cjs
python3 verify-evidence.py
```

Ожидается32modelchecks и126offline consistency checks PASS, оба gates BLOCKED.
Exact native executed source hashes — executed-source-manifest.json; первые отказы
и их sources/manifests сохранены отдельно. manifest.json покрывает финальные artifacts.

`execute.py` выполняет reviewed exact run-host.cjs в памяти через BatchMode SSH,
с strict host key checking; passwords/keys не вводятся/не выводятся. Remote output
сохраняется локально. Из текущих retained paths повторный запуск намеренно откажет
exclusive mkdir; не удалять старые evidence ради rerun и не отключать baseline guards.

Для нового отдельно разрешённого disposable rerun необходимо выбрать fresh RUN/CID
names, прочитать текущий ROADMAP/AGENTS и прошлое evidence, заново собрать точный
read-only baseline (26records/mountinfo/17fixtures), independently review source delta,
обновить exact reviewed SHA/manifest и run only reviewed bundle. Команды root/mount/
nsenter/loops не нужны для данного prototype и не должны добавляться.

Особый scope XFS: существующий /mnt/data binds readonly, recursive disabled; только
metadata root observation. Никаких directory list/user file bytes/writes. Для writable
XFS image и live daemon-host remount данный runner не пригоден: STOP и отдельная
isolated VM/owner-authorized процедура. Не ослаблять container profile ради PASS.

Измерения protocol model используют synthetic context/clock; native lifetimes проверяют
реальный transport и expiry awake runtime. Production full suite/build не являются
условием для исследовательского кода вне app path и в этом checkpoint не запускались.
