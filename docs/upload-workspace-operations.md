# Upload Workspace — операторский контракт MS-3A

Только legacy `/storage/.tmp`. Production **NOT_READY / NO_GO**. Второй диск, MS-3B,
policy/admin/UI/cross-FS finalizer не реализованы.

## Идентичность и привязка

`upload_workspaces`: UUID `87798389-88af-4ea5-a3e7-8e69a3c7bb01`, machineKey
`legacy-upload-workspace`, approved mountKey `legacy-storage`, type `local_filesystem`.
Корень задаёт операторский binding существующего STORAGE_PATH, а не DB/API path.
Новых env keys нет. Deployment по-прежнему содержит один `/storage` mount.

`upload_sessions.workspaceId` NOT NULL, FK RESTRICT, index; workspace identity и
session `(workspaceId, uploadId, tempPath)` immutable DB triggers. Для legacy bridge
`tempPath` обязан точно равняться `<approved root>/.tmp/<uploadId>`; uploadId — UUID.
Новый UUID либо неизвестный DB mountKey не включает filesystem и не вызывает fallback.
Новые writers явно задают FK; старый writer на новой схеме отказывает.

Admission, status/list/reconcile, chunks/hydration, finalize/retry, cancel, expiry и
recovery/cleanup проверяют session workspace. JWT/rate admission предшествуют session
binding, который проверяется **до** Multer записи ingress. Orphan classifier сначала
проверяет все известные bindings, затем сохраняет active directories; terminal leftovers
может очистить. При недоступном/подменённом workspace bytes/accounting не модифицируются.

## Filesystem и границы

Legacy workspace должен быть provisioned до production startup, directory без symlink,
с корректным ownership/permissions. Отсутствующий `.tmp` в production не пересоздаётся.
Development fixtures могут создавать свой fresh root/.tmp; это не production self-heal.
Процесс удерживает `.tmp` directory FD и сверяет dev/ino, MS-2 проверяет root/mount/marker
и отсутствие nested mounts. После наблюдаемой потери identity отказ sticky до restart.
DB record type/machineKey/mountKey должны совпадать с allowlist.

Ingress — `<workspace>/multipart-ingress`, chunks — `<workspace>/<uploadId>/<index>`.
Adoption использует rename ingress→session temporary→canonical chunk, fsync file и
session directory до DB commit. Проверяется одна FS; `EXDEV` прерывает операцию. Copy
fallback не добавлен. Ingress не переносится на отдельный диск. Existing assembly finalizer
читает chunks и создаёт final File по legacy протоколу; SSD→HDD finalizer не появился.

Это trusted exclusive-directory профиль: pathname checks не устраняют check→open race,
`secureOpen=false`; защита openat2 не заявляется. `.tmp` physical identity не аттестуется
между restart, root marker clone/restart и Docker VM не доказывают физический диск хоста.
Multer factory держит один directory FD до завершения процесса; это bounded anchor.

## Migration и восстановление

Migration `UploadWorkspaceBinding1746825160000`: fenced writer/ingress, TypeORM transaction,
ACCESS EXCLUSIVE sessions/chunks, readonly FS preflight, exact paths и UUID, отсутствие
symlinks/чужой FS. Missing session directory допускается для terminal/crashed sessions;
missing workspace root прекращает migration. Все старые поля, counters/accounting,
confirmed chunks/JSON, IDs, expiry, reservations сохраняются; bytes не перемещаются.
Down отказывает: нужен coherent pre-checkpoint backup и совместимый binary.

Перед canonical: verified DB/storage backup, isolated DB restore/migration, invariants и
old/new-schema dump restore. Exact restore gate принимает прежние 7/8/9/10 generations
и только legitimate 11-table generation с upload_workspaces; unknown/missing/view отказ.

Обычный backup по-прежнему исключает `.tmp`; он не обещает восстановление активных
upload bytes. Для этого checkpoint при fenced writer сделан отдельный private `.tmp`
snapshot с проверенным SHA/tree. Canonical имел 21 session и 0 upload_chunks, активные
chunk fixtures отдельно доказаны exact migration/PostgreSQL lifecycle tests. Это checkpoint
safety supplement, не новая backup policy. Restore на fresh volume требует explicit
provisioning approved `.tmp` до migration/startup; существующий restore сохраняет `.tmp`.
Destructive full-stack DR/power-loss сценарии не заявлены.

[Evidence и команды](evidence/upload-workspace-20261010/report.md).
