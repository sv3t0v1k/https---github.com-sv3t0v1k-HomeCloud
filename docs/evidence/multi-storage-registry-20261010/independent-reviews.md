# Независимые проверки MS-2

Reviewers работали узкими read-only ролями. Запретный audit-файл не читали; собственных
изменений или Docker mutations не выполняли. Primary executor сверил выводы с кодом,
реальными Linux тестами и runtime, не принимал verdict как самостоятельное доказательство.

| Роль | Итог | Граница |
|---|---|---|
| filesystem security / TOCTOU | ACCEPT WITH LIMITATIONS | Static confinement/guard integrations/marker FD anchor; только trusted legacy, check→open race сохраняется |
| Linux + Docker mount identity | ACCEPT | Exact mount/marker/process pin/FD lifetime; не physical disk attestation и не NFS/Desktop qualification |
| legacy consumer compatibility | ACCEPT | Pair+bridge, Health/Multer/temp/cleanup guards, no new user roots; full/runtime подтверждает primary |

Объединённый review→remediation устранил прямые path bypass, ingress mkdir/write и Health
probe bypass, marker FIFO blocking, read capability classification, probe cleanup errors,
metadata keys/quota symlink traversal, nested mounts и `.tmp` cleanup outside namespace.
Minor constructor cleanup замечание исправлено: failed constructor закрывает registry FD.

Тесты независимо от review выявили shared `/tmp` fixture, не соответствующую trusted
profile, и Linux immediate marker inode reuse. Private test root исправлен. Первичная
stat-only гипотеза и её timestamp усиление были опровергнуты real Linux тестом; reviewers
прямо отозвали более сильный промежуточный вывод. Принят другой механизм: удержание
исходного read-only marker FD до shutdown, с проверенным close/reuse refusal. После него
финальный полный Linux/PostgreSQL suite PASS, отдельный canonical runtime PASS.

Нерешённых material findings в разрешённом MS-2 scope нет. Безопасный user descriptor
adapter, hostile ancestor/mount races, physical host binding и remote FS qualification
не выполнены; new/untrusted user locations запрещены, production NO_GO.
