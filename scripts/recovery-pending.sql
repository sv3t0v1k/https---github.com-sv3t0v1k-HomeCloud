-- Shared backup/restore fail-closed gate. The backup contains only legacy
-- storage bytes. SSD workspace/finalization device and inode recovery has no
-- confirmed contract, so pending SSD state cannot be advertised as recoverable.
DO $recovery_pending$
DECLARE
  pending_count bigint;
  has_cleanup boolean;
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
END
$recovery_pending$;
