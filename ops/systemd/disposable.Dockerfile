# Test environment only, never production application deployment.
FROM debian:bookworm-slim
RUN apt-get -o Acquire::Retries=2 update && apt-get -o Acquire::Retries=2 install -y --no-install-recommends ca-certificates && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=2 update && apt-get -o Acquire::Retries=2 install -y --no-install-recommends systemd python3 openssl age bash && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
