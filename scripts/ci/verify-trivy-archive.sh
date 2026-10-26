#!/bin/sh
# Confirm that the binary used earlier in this job is the one in the pinned archive.
set -eu
archive=${1:?Specify verified archive}
used_binary=${2:?Specify previously used binary}
destination=${3:?Specify destination directory}
test -f "$archive" && test -x "$used_binary"
mkdir -p "$destination"
test ! -e "$destination/trivy"
tar -xzf "$archive" -C "$destination" trivy
test -f "$destination/trivy" && test -x "$destination/trivy"
cmp "$used_binary" "$destination/trivy"
