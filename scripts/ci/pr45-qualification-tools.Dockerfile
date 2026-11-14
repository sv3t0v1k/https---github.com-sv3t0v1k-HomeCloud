# Disposable Linux root/crash and real-age tests; no host mounts or Docker socket.
FROM homecloud-restore-e2e-runner:local
USER 0:0
RUN apt-get update && apt-get install -y --no-install-recommends age openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/homecloud
COPY --chown=0:0 . /opt/homecloud/
RUN chmod 0755 /opt /opt/homecloud && find /opt/homecloud -type d -exec chmod 0755 {} +
RUN python3 -B scripts/ci/restore-runtime-preflight.py \
    && age --version && command -v age-keygen && openssl version \
    && test -f ops/systemd/homecloud-backup.timer
ENTRYPOINT ["bash"]
