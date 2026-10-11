#!/bin/sh
set -eu
cd /home/hs/homecloud-test
docker compose -p homecloud-test run --rm -T --no-deps persistent 'cc -std=c11 -O2 /probes/syscall-probe.c -o /qualified/container-probe; /qualified/container-probe; cc -std=c11 -O2 -fPIC -shared -Wall -Wextra -Werror -Wno-misleading-indentation -I/usr/local/include/node /app/native/secure-fs.c -o /qualified/secure-fs.node; sha256sum /app/native/secure-fs.node /qualified/secure-fs.node; cmp /app/native/secure-fs.node /qualified/secure-fs.node; node -e "const a=require(\"/qualified/secure-fs.node\"); const c=a.root(\"/qualified\");a.close(c);console.log(\"NATIVE_REBUILT_ADDON_ROOT=PASS\")"; node /probes/artifact-probe.cjs; rm /qualified/container-probe /qualified/secure-fs.node'
docker compose -p homecloud-test run --rm -T --no-deps production-probe
