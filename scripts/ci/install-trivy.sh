#!/bin/sh
set -eu
# Official immutable v0.75.0 release asset digest, independently checked 2026-10-14.
# Install only into a disposable caller-provided directory; never alter host packages.
destination=${1:?Specify disposable installation directory}
mkdir -p "$destination"
curl --fail --silent --show-error --location \
  https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz \
  -o "$destination/trivy.tar.gz"
echo "c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f  $destination/trivy.tar.gz" | sha256sum --check
tar -xzf "$destination/trivy.tar.gz" -C "$destination" trivy
"$destination/trivy" --version
