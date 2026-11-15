#!/bin/sh
# Puts the build under test and the harness's in-container scripts into one folder, which every
# rehearsal container mounts read-only at /build.
#   sh e2e/rehearsal-linux/stage.sh <folder>
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$1
mkdir -p "$out/bin" "$out/harness"
for f in it-linux-x64 it-linux-arm64 install.sh SHA256SUMS LICENSE.md THIRD_PARTY_NOTICES.md latest.json; do
  cp "$root/packages/cli/dist/bin/$f" "$out/bin/$f"
done
cp "$root"/e2e/rehearsal-linux/inside/*.mjs "$root"/e2e/rehearsal-linux/inside/*.sh "$out/harness/"
ln -sfn /opt/person/node_modules "$out/harness/node_modules"
# The build's commit is the newest that changed anything but this harness
commit=$(git -C "$root" log -1 --format=%H -- . ":(exclude)e2e/rehearsal-linux")
harness=$(git -C "$root" rev-parse HEAD)
version=$(sed 's/.*"version":"\([^"]*\)".*/\1/' "$root/packages/cli/dist/bin/latest.json")
printf '{"commit":"%s","harness":"%s","version":"%s","staged":"%s"}\n' "$commit" "$harness" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/BUILD.json"
chmod -R a+rX "$out"
cat "$out/BUILD.json"
