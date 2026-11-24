#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="$SDK_DIR/build-tools/36.0.0"
ANDROID_JAR="$SDK_DIR/platforms/android-37.0/android.jar"
KEYSTORE="$REPO_ROOT/Banking-4.0-Team-04/android-sdk/team-debug.p12"
BUILD_DIR="$SCRIPT_DIR/build"

if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "Missing android.jar at $ANDROID_JAR" >&2
  exit 1
fi
if [[ ! -f "$KEYSTORE" ]]; then
  echo "Missing signing keystore at $KEYSTORE" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/classes"

"$BUILD_TOOLS/aapt2" compile --dir "$SCRIPT_DIR/res" -o "$BUILD_DIR/res.zip"
"$BUILD_TOOLS/aapt2" link \
  -I "$ANDROID_JAR" \
  --manifest "$SCRIPT_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  --min-sdk-version 29 \
  --target-sdk-version 34 \
  -o "$BUILD_DIR/zenbank-unsigned.apk" \
  "$BUILD_DIR/res.zip"

JAVA_SOURCES="$(find "$SCRIPT_DIR/src" "$BUILD_DIR/gen" -name '*.java')"
javac -source 8 -target 8 -Xlint:-options -bootclasspath "$ANDROID_JAR" -d "$BUILD_DIR/classes" $JAVA_SOURCES

CLASS_FILES="$(find "$BUILD_DIR/classes" -name '*.class')"
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --min-api 29 --output "$BUILD_DIR" $CLASS_FILES

zip -j "$BUILD_DIR/zenbank-unsigned.apk" "$BUILD_DIR/classes.dex"
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD_DIR/zenbank-unsigned.apk" "$BUILD_DIR/zenbank-aligned.apk"

"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-type PKCS12 \
  --ks-key-alias androiddebugkey \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$BUILD_DIR/zenbank-team04.apk" \
  "$BUILD_DIR/zenbank-aligned.apk"

"$BUILD_TOOLS/apksigner" verify --print-certs "$BUILD_DIR/zenbank-team04.apk"
echo "Built signed APK: $BUILD_DIR/zenbank-team04.apk"
