#!/bin/sh
set -eu
# Official immutable v0.76.0 release asset digest, independently checked 2026-10-16.
# Install only into a disposable caller-provided directory; never alter host packages.
destination=${1:?Specify disposable installation directory}
reuse_from=${2:-}
mkdir -p "$destination"
if [ -n "$reuse_from" ]; then
  # A previous step in this same job installed and checksum-verified this asset.
  echo "e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7  $reuse_from/trivy.tar.gz" | sha256sum --check
  sh "$(dirname "$0")/verify-trivy-archive.sh" "$reuse_from/trivy.tar.gz" "$reuse_from/trivy" "$destination"
  mkdir -p "$reuse_from/cache"
  ln -s "$reuse_from/cache" "$destination/cache"
  "$destination/trivy" --version
  exit 0
fi
curl --fail --silent --show-error --location \
  https://github.com/aquasecurity/trivy/releases/download/v0.76.0/trivy_0.76.0_Linux-64bit.tar.gz \
  -o "$destination/trivy.tar.gz"
echo "e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7  $destination/trivy.tar.gz" | sha256sum --check
tar -xzf "$destination/trivy.tar.gz" -C "$destination" trivy
"$destination/trivy" --version
