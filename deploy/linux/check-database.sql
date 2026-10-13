-- Только чтение, выполнять после штатной миграции при остановленных writers.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT name,timestamp FROM migrations WHERE timestamp>=1746825170000 ORDER BY timestamp;
SELECT pg_get_functiondef('guard_upload_session_binding()'::regprocedure);
SELECT id,"machineKey","mountKey",type FROM upload_workspaces ORDER BY "machineKey";
SELECT "workspaceId",status,count(*) FROM upload_sessions GROUP BY 1,2 ORDER BY 1,2;
SELECT s."workspaceId",o.state,o."cleanupState",count(*)
FROM ssd_finalization_operations o JOIN upload_sessions s ON s.id=o."sessionId"
GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT count(*) AS pending_operations FROM ssd_finalization_operations
WHERE state <> 'committed' OR "cleanupState" <> 'cleaned';
SHOW fsync;
SHOW full_page_writes;
SHOW synchronous_commit;
COMMIT;
