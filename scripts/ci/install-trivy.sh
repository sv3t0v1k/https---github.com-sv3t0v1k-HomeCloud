#!/bin/sh
set -eu
# Official immutable v0.76.0 release asset digest, independently checked 2026-10-16.
# Install only into a disposable caller-provided directory; never alter host packages.
destination=${1:?Specify disposable installation directory}
mkdir -p "$destination"
curl --fail --silent --show-error --location \
  https://github.com/aquasecurity/trivy/releases/download/v0.76.0/trivy_0.76.0_Linux-64bit.tar.gz \
  -o "$destination/trivy.tar.gz"
echo "e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7  $destination/trivy.tar.gz" | sha256sum --check
tar -xzf "$destination/trivy.tar.gz" -C "$destination" trivy
"$destination/trivy" --version
