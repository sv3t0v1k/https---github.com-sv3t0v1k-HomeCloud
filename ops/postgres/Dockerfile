# D5.1.12: рецепт подготовки. Новый результат требует отдельной квалификации.
# Только проверенный минимальный context от prepare.py; без ARG для подмены base.
FROM docker.io/library/postgres:16.15-alpine@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551
COPY --chown=0:0 --chmod=0755 gosu /usr/local/bin/gosu
COPY --chown=0:0 --chmod=0644 zlib.apk /tmp/homecloud-zlib.apk
RUN --network=none printf '%s  %s\n' \
      '3d0088b3cfedd7fa76869768b140db58dd6e52b30343c54000fa9fd92a904085' '/usr/local/bin/gosu' \
      '63aeea03c15a2f9018f81805cfc8aa926bdf5cd68921f22149c2fbb5d0ee9f47' '/tmp/homecloud-zlib.apk' \
      | sha256sum -c - \
    && apk add --no-network /tmp/homecloud-zlib.apk \
    && rm /tmp/homecloud-zlib.apk \
    && awk 'BEGIN { RS=""; FS="\n" } \
      { p=""; v=""; for (i=1;i<=NF;i++) { if ($i ~ /^P:/) p=substr($i,3); if ($i ~ /^V:/) v=substr($i,3) } \
        if (p=="zlib" && v=="1.3.2-r1") found++ } END { exit(found!=1) }' /lib/apk/db/installed
# ENTRYPOINT/CMD/ENV/USER/VOLUME наследуются от закреплённого PostgreSQL.
