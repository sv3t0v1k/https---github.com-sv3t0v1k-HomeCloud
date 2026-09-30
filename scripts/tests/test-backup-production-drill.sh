#!/usr/bin/env bash
# Real disposable PostgreSQL/storage restore drill. Never reads the repository .env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DR_ROOT="$(mktemp -d /private/tmp/homecloud-backup-dr.XXXXXX)"
KEY_ROOT="$(mktemp -d /private/tmp/homecloud-backup-key.XXXXXX)"
PROJECT="homecloud-backup-dr-$(date +%s)-$$"
IMAGE="${DR_IMAGE:-homecloud-backup-dr:checkpoint}"
export COMPOSE_PROJECT_NAME="$PROJECT"
export BACKEND_IMAGE="$IMAGE"
umask 077
export DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export JWT_REFRESH_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export REDIS_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export BACKUP_DIR="$DR_ROOT/backups" STORAGE_VOLUME="${PROJECT}_storage_data"
cleanup() {
 local result=$?
 (cd "$DR_ROOT" && docker compose logs --no-color backend) > "$DR_ROOT/final-backend.log" 2>&1 || true
 rm -rf "$KEY_ROOT"
 rm -f "$DR_ROOT/.env" "$DR_ROOT/keygen.log"
 rm -rf "$DR_ROOT/backups" "$DR_ROOT/offsite" "$DR_ROOT/staging"
 if ! (cd "$DR_ROOT" && docker compose down -v --remove-orphans) > "$DR_ROOT/cleanup.log" 2>&1; then
  printf 'DISPOSABLE_CLEANUP: FAIL\n' >&2; exit 1
 fi
 local containers volumes
 containers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT") || exit 1
 volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT") || exit 1
 if [ -n "$containers$volumes" ]; then printf 'DISPOSABLE_CLEANUP: FAIL\n' >&2; exit 1; fi
 printf 'DISPOSABLE_CLEANUP: PASS\n'
 rm -rf "$KEY_ROOT"
 rm -f "$DR_ROOT/.env" "$DR_ROOT/keygen.log"
 rm -rf "$DR_ROOT/backups" "$DR_ROOT/offsite" "$DR_ROOT/staging"
 exit "$result"
}
trap cleanup EXIT
mkdir -p "$DR_ROOT/scripts"
export BACKUP_PRODUCTION_DIR="$DR_ROOT/backups" BACKUP_OFFSITE_DIR="$DR_ROOT/offsite"
mkdir -m 700 "$BACKUP_OFFSITE_DIR"
export BACKUP_OFFSITE_CONFIRMED=1 BACKUP_WRITE_BARRIER_CONFIRMED=1
export BACKUP_AGE_RECIPIENTS_FILE="$KEY_ROOT/recipients.txt" BACKUP_AGE_IDENTITY_FILE="$KEY_ROOT/identity.txt"
age-keygen -o "$BACKUP_AGE_IDENTITY_FILE" 2> "$DR_ROOT/keygen.log"
age-keygen -y "$BACKUP_AGE_IDENTITY_FILE" > "$BACKUP_AGE_RECIPIENTS_FILE"
chmod 600 "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_AGE_RECIPIENTS_FILE"
printf "DB_NAME=homecloud\nDB_USER=homecloud\nDB_PASSWORD=%s\n" "$DB_PASSWORD" > "$DR_ROOT/.env"
cp "$ROOT/scripts/backup.sh" "$ROOT/scripts/restore.sh" "$ROOT/scripts/reconcile.py" "$DR_ROOT/scripts/"
cp "$ROOT/scripts/backup-production.sh" "$ROOT/scripts/restore-offsite.sh" "$ROOT/scripts/backup-production.py" "$DR_ROOT/scripts/"
# Only non-secret manifest is copied; no synced or deployment configuration.
cp "$ROOT/backend/package.json" "$DR_ROOT/package.json"
if [ -z "${DR_IMAGE:-}" ]; then docker build -t "$IMAGE" "$ROOT/backend" > "$DR_ROOT/build.log" 2>&1; fi
cat > "$DR_ROOT/compose.yml" <<'DR_EOF'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: homecloud
      POSTGRES_USER: homecloud
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/postgresql/data
  backend:
    image: ${BACKEND_IMAGE}
    environment:
      NODE_ENV: production
      FRONTEND_URL: https://dr.example.invalid
      PORT: 3000
      DB_PASSWORD: ${DB_PASSWORD}
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      DATABASE_URL: postgres://homecloud:${DB_PASSWORD}@db:5432/homecloud
      JWT_SECRET: ${JWT_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      STORAGE_PATH: /storage
    volumes:
      - storage_data:/storage
volumes:
  db_data:
  storage_data:

DR_EOF
cat > "$DR_ROOT/fixtures.sql" <<'DR_EOF'
INSERT INTO users(id,email,password,name,"storageQuota","storageUsed") VALUES(1,'dr@example.invalid','fixture-not-login','DR',1048576,28);
INSERT INTO folders(id,name,"parentId","userId") VALUES(1,'root',NULL,1),(2,'nested',1,1);
INSERT INTO files(id,name,"isFolder","folderId","parentId","userId") VALUES(1,'root',true,1,NULL,1),(2,'nested',true,2,1,1);
INSERT INTO files(id,name,"storagePath",size,"mimeType","parentId","userId") VALUES(3,'alpha.txt','1/alpha.txt',14,'text/plain',2,1),(4,'beta.txt','1/beta.txt',14,'text/plain',2,1);
UPDATE files SET "isDeleted"=true,"deletedAt"=NOW() WHERE id=4;
UPDATE files SET "isDeleted"=false,"deletedAt"=NULL WHERE id=4;
INSERT INTO share_links(token,"fileId","userId","maxDownloads") VALUES('dr-fixture-token',3,1,5);
INSERT INTO upload_sessions("uploadId",filename,"totalSize","uploadedSize","chunkSize","totalChunks","uploadedChunks","tempPath","parentId",status,"userId") VALUES('dr-completed-upload','alpha.txt',14,14,14,1,'[0]','.tmp/dr-completed-upload',2,'completed',1);

DR_EOF
cat > "$DR_ROOT/snapshot.sql" <<'DR_EOF'
SELECT 'users',row_to_json(t) FROM (SELECT * FROM users ORDER BY id)t;
SELECT 'folders',row_to_json(t) FROM (SELECT * FROM folders ORDER BY id)t;
SELECT 'files',row_to_json(t) FROM (SELECT * FROM files ORDER BY id)t;
SELECT 'shares',row_to_json(t) FROM (SELECT * FROM share_links ORDER BY id)t;
SELECT 'uploads',row_to_json(t) FROM (SELECT * FROM upload_sessions ORDER BY id)t;
SELECT 'upload-consistency',bool_and("totalSize"="uploadedSize") FROM upload_sessions WHERE status='completed';
SELECT 'quota',"storageUsed"=(SELECT SUM(size) FROM files WHERE "userId"=1 AND NOT "isFolder") FROM users WHERE id=1;

DR_EOF
cat > "$DR_ROOT/mutate.sql" <<'DR_EOF'
UPDATE users SET name='after-backup' WHERE id=1;

DR_EOF
cd "$DR_ROOT"
docker compose up -d db
for attempt in $(seq 1 30); do docker compose exec -T db pg_isready -U homecloud -d homecloud >/dev/null 2>&1 && break; sleep 1; done
docker compose run --rm backend npm run migration:run > migrations.log 2>&1
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud < fixtures.sql > fixtures.log
docker run --rm --user root -v "$STORAGE_VOLUME:/storage" "$IMAGE" sh -c 'mkdir -p /storage/1 /storage/.tmp; printf "alpha-bytes!!\n" > /storage/1/alpha.txt; printf "beta--bytes!!\n" > /storage/1/beta.txt; chown -R 1001:1001 /storage'
snapshot() {
 docker compose exec -T db psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud -tA < snapshot.sql > "$1.rows"
 python3 - "$1.rows" <<'ASSERT_EOF'
import sys
rows = open(sys.argv[1]).read().splitlines()
assert "quota|t" in rows, "quota consistency failed"
assert "upload-consistency|t" in rows, "completed upload consistency failed"
ASSERT_EOF
 docker run --rm -v "$STORAGE_VOLUME:/storage" "$IMAGE" sh -c 'cd /storage; find . -type f -not -path "./.tmp/*" -exec sha256sum {} \;' | sort > "$1.bytes"
}
snapshot before
bash scripts/backup-production.sh > backup.log 2>&1
GENERATION="$(find "$BACKUP_OFFSITE_DIR" -type d -name 'hc_*' -maxdepth 1 | head -n 1)"
[ -n "$GENERATION" ]
GENERATION="${GENERATION##*/}"
# Delete the entire local encrypted copy: recovery must fetch the offsite set.
rm -rf "$BACKUP_PRODUCTION_DIR"
printf 'LOCAL_ENCRYPTED_COPY_REMOVED: PASS\n' > authority.log
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U homecloud -d homecloud < mutate.sql > mutation.log
docker run --rm --user root -v "$STORAGE_VOLUME:/storage" "$IMAGE" sh -c 'printf "mutated\n" > /storage/1/alpha.txt; printf "orphan\n" > /storage/1/post-backup.txt'
bash scripts/restore-offsite.sh "$GENERATION" --yes > restore.log 2>&1
snapshot after
diff -u before.rows after.rows
diff -u before.bytes after.bytes
docker compose exec -T backend node -e 'require("http").get("http://localhost:3000/api/v1/health/ready",{headers:{"X-Request-Id":"fs-dr-restored"}},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{console.log(b);process.exit(r.statusCode===200?0:1)});}).on("error",()=>process.exit(1))' > readiness.json
docker compose logs --no-color > runtime.log 2>&1
python3 - "$DR_ROOT" "$BACKUP_AGE_IDENTITY_FILE" <<'EVIDENCE_EOF'
import os, sys, json, pathlib
root=pathlib.Path(sys.argv[1])
secrets=[os.environ[k] for k in ('DB_PASSWORD','JWT_SECRET','JWT_REFRESH_SECRET','REDIS_PASSWORD')]
secrets.extend(line for line in pathlib.Path(sys.argv[2]).read_text().splitlines() if line.startswith('AGE-SECRET-KEY-'))
for log in root.glob('*.log'):
    if log.name == 'keygen.log': continue
    data=log.read_text(errors='replace')
    assert not any(secret in data for secret in secrets), 'secret found in drill logs'
rows=(root/'after.rows').read_text().splitlines()
result={'verdict':'PASS','source':'encrypted offsite artifact after deletion of local encrypted copy','transport_scope':'same-host isolated filesystem fixture; physical offsite placement remains operator responsibility','row_counts':{name:sum(line.startswith(name+'|') for line in rows) for name in ('users','folders','files','shares','uploads')},'quota_consistent':'quota|t' in rows,'completed_upload_consistent':'upload-consistency|t' in rows,'db_snapshot_identical':(root/'before.rows').read_bytes()==(root/'after.rows').read_bytes(),'file_sha256_identical':(root/'before.bytes').read_bytes()==(root/'after.bytes').read_bytes(),'readiness_http_status':200,'secret_leakage_scan':'PASS'}
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
EVIDENCE_EOF
printf 'TRANSPORT_SCOPE: isolated filesystem target; same-host fixture, no physical offsite disaster claim\n' > scope.txt
printf 'ENCRYPTED_OFFSITE_RESTORE_DRILL: PASS\nEvidence: %s\n' "$DR_ROOT"
