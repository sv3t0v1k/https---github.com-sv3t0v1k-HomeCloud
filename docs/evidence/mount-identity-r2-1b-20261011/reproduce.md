# Воспроизведение остановленного preflight

Offline, не обращается к серверу:

```sh
python3 verify-evidence.py
```

Фактически локально выполнено `python3 collect.py baseline`, затем
`python3 collect.py final`. Каждый запуск SSH передавал содержимое preflight.py
через shell-quoted `python3 -c`, без создания server files. Коллектор использует
exclusive локальные output names; не перезаписывать raw evidence.
Эта процедура только читает metadata/content прежних собственных fixtures,
docker selected records и /proc; создаёт краткую user/mount namespace без mount syscall.
Повторный запуск потребует новых локальных filenames и свежей актуальной авторизации.

Привилегированный helper подготовлен после дополнительного owner решения о manual
root entry/собственных loop allocations, но не выполнен. Запуск только по точной
SHA-проверяющей команде в manual-run.md после независимого helper review.
Не запускать отдельные mkfs/losetup/mount команды по этому документу.
