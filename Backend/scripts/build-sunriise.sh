#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build sunriise (community MS Money .mny unlocker) as a fat jar and
# drop it at Backend/vendor/sunriise.jar so `docker compose build
# backend` bundles it into the image.
#
# Uses a throwaway maven:3-eclipse-temurin-17 container so your host
# needs nothing but Docker. Set SUNRIISE_REPO to point at a working
# fork if the default is dead.
#
# Usage:
#   Backend/scripts/build-sunriise.sh
#   SUNRIISE_REPO=https://github.com/<fork>/sunriise.git Backend/scripts/build-sunriise.sh

set -euo pipefail

SUNRIISE_REPO="${SUNRIISE_REPO:-https://github.com/clmsoft/sunriise.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$(cd "$SCRIPT_DIR/../vendor" && pwd)"
OUT_JAR="$VENDOR_DIR/sunriise.jar"

echo "Building sunriise from: $SUNRIISE_REPO"
echo "Output jar: $OUT_JAR"
echo

# One-shot Maven container. We mount the vendor directory as the
# output target and cd into a scratch workspace inside the container.
docker run --rm \
  -v "$VENDOR_DIR":/out \
  -w /work \
  maven:3-eclipse-temurin-17 \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -qq -y git >/dev/null
    git clone --depth 1 '$SUNRIISE_REPO' src
    cd src
    # Try the assembly profile first — many forks wire the fat jar
    # under -Passembly. Fall back to plain package.
    mvn -q -DskipTests -Passembly package \\
      || mvn -q -DskipTests package
    # Find whichever fat/shaded jar came out and copy it.
    jar=\$(find . -type f \\( -name '*-jar-with-dependencies.jar' -o -name '*-shaded.jar' \\) | head -n1)
    if [ -z \"\$jar\" ]; then
      echo 'ERROR: no fat jar produced by mvn package. Check the pom for the assembly config.' >&2
      exit 1
    fi
    cp \"\$jar\" /out/sunriise.jar
    echo \"Copied \$jar → /out/sunriise.jar\"
  "

echo
echo "Done. $OUT_JAR ($(du -h "$OUT_JAR" | cut -f1))"
echo "Now rebuild the backend image:"
echo "  docker compose build backend && docker compose up -d backend"
