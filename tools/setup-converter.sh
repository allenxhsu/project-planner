#!/bin/sh
# Fetch what tools/mpp2xml.sh needs to read Microsoft Project files: the MPXJ
# library (LGPL, https://mpxj.org) and a Temurin Java 21 runtime (GPLv2+CE),
# into tools/mpxj and tools/jre. About 180 MB; neither is kept in git.
#
#   tools/setup-converter.sh            # macOS arm64 (this Mac)
#   ARCH=x64 tools/setup-converter.sh   # Intel
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
MPXJ="${MPXJ_VERSION:-16.7.0}"
ARCH="${ARCH:-aarch64}"
cd "$HERE"
if [ ! -x jre/Contents/Home/bin/java ]; then
  echo "Fetching Temurin JRE 21 ($ARCH)…"
  curl -fL -o jre.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/mac/$ARCH/jre/hotspot/normal/eclipse"
  rm -rf jre && mkdir jre && tar -xzf jre.tar.gz -C jre --strip-components=1 && rm jre.tar.gz
fi
if [ ! -f mpxj/mpxj.jar ]; then
  echo "Fetching MPXJ $MPXJ…"
  curl -fL -o mpxj.zip "https://github.com/joniles/mpxj/releases/download/v$MPXJ/mpxj-$MPXJ.zip"
  rm -rf mpxj-tmp && unzip -q mpxj.zip -d mpxj-tmp
  mkdir -p mpxj/lib
  cp mpxj-tmp/mpxj/mpxj.jar mpxj/ && cp mpxj-tmp/mpxj/LICENSE mpxj/
  cp mpxj-tmp/mpxj/lib/*.jar mpxj/lib/
  rm -f mpxj/lib/junit-* mpxj/lib/opentest4j-* mpxj/lib/apiguardian-* mpxj/lib/jgoodies-*
  rm -rf mpxj-tmp mpxj.zip
fi
echo "Converter ready:"; ./mpp2xml.sh 2>&1 | head -1 || true
