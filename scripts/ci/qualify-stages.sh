#!/bin/sh
set -eu
scanner=${1:?scanner}
component=${2:?backend or frontend}
source=${3:?source commit}
output=${4:?output directory}
case "$component" in backend|frontend) ;; *) exit 1 ;; esac
mkdir -p "$output"
node_image=$(python3 -c 'import json; print(json.load(open("scripts/ci/images.lock.json"))["node"])')
nginx_image=$(python3 -c 'import json; print(json.load(open("scripts/ci/images.lock.json"))["nginx"])')
status=0
for stage in deps builder; do
  role="$component-$stage"
  archive="$RUNNER_TEMP/$role.oci.tar"
  if docker buildx build --progress=rawjson --platform linux/amd64 --target "$stage" \
      --build-arg "NODE_IMAGE=$node_image" --build-arg "NGINX_IMAGE=$nginx_image" \
      --label "org.opencontainers.image.revision=$source" --label "io.homecloud.role=$role" \
      --provenance=false --output "type=oci,dest=$archive" \
      --metadata-file "$output/$role.build.json" "./$component" 2> "$output/$role.progress.jsonl"; then
    python3 scripts/ci/stage-cache-proof.py "$output/$role.progress.jsonl" "$role" "$source" "$output/$role.cache.json" "$output/$role.build.json" || status=1
    sh scripts/ci/scan-image.sh "$scanner" archive "$archive" "$output/$role.scan.json" || status=1
    python3 scripts/ci/oci-scan-binding.py --archive "$archive" --report "$output/$role.scan.json" \
      --role "$role" --source "$source" --output "$output/$role.binding.json" || status=1
  else
    status=1
  fi
done
exit "$status"
