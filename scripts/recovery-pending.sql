-- Shared backup/restore fail-closed gate. The backup contains only legacy
-- storage bytes. SSD workspace/finalization device and inode recovery has no
-- confirmed contract, so pending SSD state cannot be advertised as recoverable.
DO $recovery_pending$
DECLARE
  pending_count bigint;
  has_cleanup boolean;
  has_copy_gate boolean;
  has_copy_journal boolean;
  copy_migration_count bigint := 0;
BEGIN
  IF to_regclass('public.upload_workspaces') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.upload_sessions WHERE status IN (''pending'',''uploading'') AND ("workspaceId" IS NULL OR "workspaceId" <> ''87798389-88af-4ea5-a3e7-8e69a3c7bb01''::uuid)' INTO pending_count;
    IF pending_count <> 0 THEN
      RAISE EXCEPTION 'Unsupported pending SSD/nonlegacy uploads: no confirmed recovery mechanism';
    END IF;
  END IF;
  IF to_regclass('public.ssd_finalization_operations') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ssd_finalization_operations' AND column_name='cleanupState') INTO has_cleanup;
    IF has_cleanup THEN
      EXECUTE 'SELECT count(*) FROM public.ssd_finalization_operations WHERE state <> ''committed'' OR "cleanupState" <> ''cleaned''' INTO pending_count;
    ELSE
      -- Schema 518 has no cleanup checkpoint: even committed rows do not
      -- prove that SSD source cleanup completed. Reject every retained row.
      EXECUTE 'SELECT count(*) FROM public.ssd_finalization_operations' INTO pending_count;
    END IF;
    IF pending_count <> 0 THEN
      RAISE EXCEPTION 'Unsupported pending SSD finalization/cleanup: restored device/inode identity is unproven';
    END IF;
  END IF;

  -- The copy journal is a durable accounting obligation.
  -- An unresolved operation cannot be advertised as safely recoverable.
  has_copy_gate :=
    to_regclass('public.file_copy_admission') IS NOT NULL;

  has_copy_journal :=
    to_regclass('public.file_copy_operations') IS NOT NULL;

  IF to_regclass('public.migrations') IS NOT NULL THEN
    EXECUTE
      'SELECT count(*) FROM public.migrations
       WHERE timestamp = 1792831300000
          OR name = ''FileCopyAdmission1792831300000'''
      INTO copy_migration_count;
  END IF;

  IF has_copy_gate IS DISTINCT FROM has_copy_journal THEN
    RAISE EXCEPTION
      'Incomplete file copy journal schema';
  END IF;

  IF NOT has_copy_gate THEN
    IF copy_migration_count <> 0 THEN
      RAISE EXCEPTION
        'File copy migration exists without journal tables';
    END IF;
  ELSE
    IF copy_migration_count <> 1 THEN
      RAISE EXCEPTION
        'Unqualified file copy journal migration';
    END IF;

    EXECUTE
      'SELECT count(*) FROM public.migrations
       WHERE timestamp = 1792831300000
         AND name = ''FileCopyAdmission1792831300000'''
      INTO copy_migration_count;

    IF copy_migration_count <> 1 THEN
      RAISE EXCEPTION
        'Invalid file copy migration identity';
    END IF;

    EXECUTE
      'SELECT count(*) FROM public.file_copy_admission'
      INTO pending_count;

    IF pending_count <> 1 THEN
      RAISE EXCEPTION
        'Invalid file copy admission singleton';
    END IF;

    EXECUTE
      'SELECT count(*) FROM public.file_copy_admission
       WHERE id IS TRUE'
      INTO pending_count;

    IF pending_count <> 1 THEN
      RAISE EXCEPTION
        'Invalid file copy admission identity';
    END IF;

    EXECUTE
      'SELECT count(*) FROM public.file_copy_operations
       WHERE state IS NULL
          OR state NOT IN (''committed'', ''released'')'
      INTO pending_count;

    IF pending_count <> 0 THEN
      RAISE EXCEPTION
        'Unsupported pending file copy operations';
    END IF;
  END IF;

END
$recovery_pending$;
