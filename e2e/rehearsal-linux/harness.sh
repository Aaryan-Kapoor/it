#!/bin/sh
# Copies only the harness's in-container scripts into staged folders, leaving their builds alone.
#   sh e2e/rehearsal-linux/harness.sh <folder> [<folder> ...]
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
for out in "$@"; do
  [ -f "$out/BUILD.json" ] || { echo "$out is not a staged folder" >&2; exit 1; }
  cp "$root"/e2e/rehearsal-linux/inside/*.mjs "$root"/e2e/rehearsal-linux/inside/*.sh "$root"/e2e/rehearsal-linux/inside/*.py "$out/harness/"
  chmod -R a+rX "$out/harness"
done
