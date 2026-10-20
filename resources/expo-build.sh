#!/usr/bin/env bash
# Android Builder - generalized local release builder for any Expo project.
# Derived from the Mahameh scripts/build-local.sh GitLab-CI replica.
#
# Invoked by the Electron app (main.js) as:
#   bash expo-build.sh <PROJECT_DIR>
#
# Configuration arrives via environment variables:
#   APP_NAME            display name (artifact names + certificate CN)
#   APP_VERSION         semver (already written to package.json / app.json by the app)
#   SIGNED              1 = generate/reuse keystore & sign, 0 = unsigned build
#   KEY_ALIAS           keystore alias
#   KEY_PASSWORD        key password
#   KEYSTORE_PASSWORD   keystore password
#   KEY_COUNTRY         2-letter country code for the certificate dname
#   FORMAT              apk | aab
#   ARCHS               comma list for -PreactNativeArchitectures (apk splits)
#   RELOCATE            1 = move heavy gradle dirs to RELOCATE_ROOT (default 1)
#   RELOCATE_ROOT       msys path on a big disk, default /c/ExpoBuilds
#   DEBUG               1 = set -x + gradle --stacktrace --info
#   ALLOW_DEBUG_SIGNED  passthrough guard for a project's verify-signing.sh
#   KEYSTORE_BASE64     optional base64 of an existing keystore to reuse
#
# Progress protocol printed to stdout (parsed by main.js, never shown raw):
#   @@PHASE <id>        build phase changed
#   @@ARTIFACT <path>   produced output file (path relative to project root)
#   @@KEYSTORE <path>   persistent keystore that was used/created
#   @@DONE              success
set -euo pipefail

PROJECT_DIR="${1:?missing PROJECT_DIR argument}"
cd "$PROJECT_DIR"

if [ "${DEBUG:-0}" = "1" ]; then set -x; fi

APP_NAME="${APP_NAME:?APP_NAME required}"
APP_VERSION="${APP_VERSION:?APP_VERSION required}"
FORMAT="${FORMAT:-apk}"
ARCHS="${ARCHS:-arm64-v8a,armeabi-v7a,x86,x86_64}"
SIGNED="${SIGNED:-1}"
RELOCATE="${RELOCATE:-1}"
RELOCATE_ROOT="${RELOCATE_ROOT:-/c/ExpoBuilds}"
ALLOW_DEBUG_SIGNED="${ALLOW_DEBUG_SIGNED:-0}"

# Strip characters that are unsafe in Windows filenames / gradle property values.
SAFE_NAME=$(printf '%s' "$APP_NAME" | tr -d '/\\:*?"<>|' | tr ' ' '_')

export NODE_OPTIONS="--max-old-space-size=4096"
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
export GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dkotlin.compiler.execution.strategy=in-process"

say()   { printf '%s\n' "$*"; }
phase() { printf '@@PHASE %s\n' "$1"; }
artifact() { printf '@@ARTIFACT %s\n' "$1"; }

# ------------------------------------------------------------------ dependencies
phase dependencies
if [ -f yarn.lock ]; then
  PM=yarn;   PM_INSTALL="yarn install"
elif [ -f pnpm-lock.yaml ]; then
  PM=pnpm;   PM_INSTALL="pnpm install"
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  PM=bun;    PM_INSTALL="bun install"
else
  PM=npm;    PM_INSTALL="npm install"
fi
say "Detected package manager: $PM"
$PM_INSTALL

# Use the project-local expo CLI (a globally installed legacy expo-cli would
# otherwise shadow it and crash).
case "$PM" in
  yarn) EXPO_CMD="yarn expo" ;;
  pnpm) EXPO_CMD="pnpm exec expo" ;;
  bun)  EXPO_CMD="bunx expo" ;;
  npm)  EXPO_CMD="npx --no-install expo" ;;
esac

# ----------------------------------------------------------------------- prebuild
phase prebuild
say "Generating native android project (expo prebuild --platform android --clean)..."
$EXPO_CMD prebuild --platform android --clean

# Windows MAX_PATH workaround: cap CMake object file path length, otherwise
# ninja fails with "Filename longer than 260 characters" on codegen C++ targets.
# prebuild regenerates build.gradle, so this patch is re-applied every time.
if grep -q 'targetSdkVersion rootProject.ext.targetSdkVersion' android/app/build.gradle 2>/dev/null; then
  sed -i 's|targetSdkVersion rootProject.ext.targetSdkVersion|targetSdkVersion rootProject.ext.targetSdkVersion\n        externalNativeBuild {\n            cmake {\n                arguments "-DCMAKE_OBJECT_PATH_MAX=240"\n            }\n        }|' android/app/build.gradle
  say "Patched android/app/build.gradle (CMAKE_OBJECT_PATH_MAX=240)."
else
  say "targetSdkVersion pattern not found - skipping MAX_PATH patch (fine for projects without native C++)."
fi

# ----------------------------------------------------------------------- prepare
# prebuild --clean wipes the android folder, deleting any junctions that
# redirect heavy build output to another (bigger) disk. Re-establish them so
# Gradle keeps writing there instead of filling the project drive.
is_junction() {
  powershell -NoProfile -Command "(Get-Item -LiteralPath '$(cygpath -w "$1")' -Force -ErrorAction SilentlyContinue).LinkType" 2>/dev/null
}

ensure_junction() {
  local link="$1" target="$2" linktype
  linktype=$(is_junction "$link")
  if [ -d "$link" ] && [ -z "$linktype" ]; then
    say "Relocating $link to $target (drive protection)..."
    rm -rf "$target"
    mv "$link" "$target"
  fi
  [ -d "$target" ] || mkdir -p "$target"
  if [ ! -d "$link" ]; then
    cmd //c mklink //J "$(cygpath -w "$link")" "$(cygpath -w "$target")" > /dev/null
  fi
}

if [ "$RELOCATE" = "1" ]; then
  phase prepare
  PROJ_ID=$(node -p "require('./package.json').name" | tr -d '/\\:*?"<>| ')
  say "Redirecting heavy Gradle output to $RELOCATE_ROOT/$PROJ_ID ..."
  ensure_junction "android/build"     "$RELOCATE_ROOT/$PROJ_ID/android--build"
  ensure_junction "android/.gradle"   "$RELOCATE_ROOT/$PROJ_ID/android--.gradle"
  ensure_junction "android/app/build" "$RELOCATE_ROOT/$PROJ_ID/android--app--build"
  ensure_junction "android/app/.cxx"  "$RELOCATE_ROOT/$PROJ_ID/android--app--.cxx"
fi

# --------------------------------------------------------------------- keystore
JKS_PATH="android/app/${SAFE_NAME}.v${APP_VERSION}.jks"
KEY_DIR="android-key"
KEY_ALIAS="${KEY_ALIAS:-}"
KEY_PASSWORD="${KEY_PASSWORD:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
DNAME="CN=${APP_NAME}, O=App, C=${KEY_COUNTRY:-US}"

validate_keystore() {
  keytool -list -keystore "$1" -alias "$SAFE_ALIAS" -storepass "$SAFE_STORE_PASS" -keypass "$SAFE_KEY_PASS" > /dev/null 2>&1
}

generate_keystore() {
  keytool -genkeypair -v -keystore "$1" -alias "$SAFE_ALIAS" -keypass "$SAFE_KEY_PASS" -storepass "$SAFE_STORE_PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 -deststoretype JKS -dname "$DNAME"
}

SIGNED_FROM=""
KEYSTORE_REPORT=""
if [ "$SIGNED" = "1" ]; then
  phase keystore
  SAFE_ALIAS="$KEY_ALIAS"
  SAFE_KEY_PASS="$KEY_PASSWORD"
  SAFE_STORE_PASS="$KEYSTORE_PASSWORD"

  if [ -n "${KEYSTORE_BASE64:-}" ]; then
    say "Found KEYSTORE_BASE64. Decoding to $JKS_PATH..."
    echo "$KEYSTORE_BASE64" | tr -d '\n\r ' | base64 -d > "$JKS_PATH"
    if validate_keystore "$JKS_PATH"; then
      say "Keystore from KEYSTORE_BASE64 is VALID. Proceeding..."
      SIGNED_FROM="$JKS_PATH (from KEYSTORE_BASE64)"
    else
      say "Keystore from KEYSTORE_BASE64 is INVALID! Removing it and generating a new one..."
      rm -f "$JKS_PATH"
      generate_keystore "$JKS_PATH"
      SIGNED_FROM="$JKS_PATH (regenerated)"
    fi
    KEYSTORE_REPORT="$JKS_PATH"
  else
    # Persistent signing key: the 'android-key/' folder at the project root.
    # If it contains a .jks file it is reused for every build (commit it so the
    # key is never lost); otherwise a new one is generated there once.
    mkdir -p "$KEY_DIR"
    keyfile=$(ls "$KEY_DIR"/*.jks 2>/dev/null | sort | head -n 1 || true)
    if [ -n "$keyfile" ]; then
      keycount=$(ls "$KEY_DIR"/*.jks 2>/dev/null | wc -l)
      if [ "$keycount" -gt 1 ]; then
        say "WARNING: Multiple .jks files in '$KEY_DIR/' - using '$keyfile'. Remove the extras to avoid ambiguity."
      fi
      say "Using keystore '$keyfile'..."
      cp "$keyfile" "$JKS_PATH"
      if validate_keystore "$JKS_PATH"; then
        say "Keystore is VALID and matches the credentials. Proceeding..."
      else
        say "Keystore '$keyfile' is INVALID for alias '$SAFE_ALIAS' with the configured passwords. Build aborted."
        say "  The file was NOT modified. Options:"
        say "    - pass matching key alias / passwords in the form, or"
        say "    - delete the file from '$KEY_DIR/' and rebuild to generate a fresh key."
        exit 1
      fi
      SIGNED_FROM="$keyfile"
      KEYSTORE_REPORT="$keyfile"
    else
      say "No .jks found in '$KEY_DIR/'. Generating a NEW one at '$KEY_DIR/android-key.jks'..."
      say "  Keep / commit this file so the signing key is never lost."
      generate_keystore "$KEY_DIR/android-key.jks"
      cp "$KEY_DIR/android-key.jks" "$JKS_PATH"
      SIGNED_FROM="$KEY_DIR/android-key.jks (newly generated)"
      KEYSTORE_REPORT="$KEY_DIR/android-key.jks"
    fi
  fi
  printf '@@KEYSTORE %s\n' "$KEYSTORE_REPORT"
fi

# ---------------------------------------------------------------- gradle config
# The prebuild template writes expo.useLegacyPackaging=false; drop it so the
# override below is unambiguous. NOTE: this sed must run BEFORE the append
# group below - an in-place rewrite inside a redirected group orphans the
# group's remaining output on Windows (sed -i replaces the file inode).
sed -i '/^expo\.useLegacyPackaging/d' android/gradle.properties
{
  echo ""
  echo "react.extraNodeOptions=--max-old-space-size=4096"
  echo "expo.useLegacyPackaging=true"
  if [ "$SIGNED" = "1" ]; then
    echo "MYAPP_UPLOAD_STORE_FILE=${SAFE_NAME}.v${APP_VERSION}.jks"
    echo "MYAPP_UPLOAD_STORE_PASSWORD=$KEYSTORE_PASSWORD"
    echo "MYAPP_UPLOAD_KEY_ALIAS=$KEY_ALIAS"
    echo "MYAPP_UPLOAD_KEY_PASSWORD=$KEY_PASSWORD"
  fi
} >> android/gradle.properties

# ----------------------------------------------------------------------- gradle
phase gradle
cd android
chmod +x gradlew

TASK="assembleRelease"
[ "$FORMAT" = "aab" ] && TASK="bundleRelease"

GRADLE_FLAGS="--no-daemon --console=plain -PreactNativeArchitectures=$ARCHS -x lint -x lintVitalRelease -x test"
if [ "${DEBUG:-0}" = "1" ]; then
  GRADLE_FLAGS="$GRADLE_FLAGS --stacktrace --info"
fi

say "Running: ./gradlew $TASK $GRADLE_FLAGS"
./gradlew $TASK $GRADLE_FLAGS
cd ..

# ---------------------------------------------------------------------- collect
phase collect
shopt -s nullglob
MADE=()
if [ "$FORMAT" = "aab" ]; then
  OUT_DIR="android/app/build/outputs/bundle/release"
  for f in "$OUT_DIR"/*.aab; do
    dest="${SAFE_NAME}.v${APP_VERSION}.aab"
    mv "$f" "$dest"
    artifact "$dest"
    MADE+=("$dest")
  done
else
  OUT_DIR="android/app/build/outputs/apk/release"
  for f in "$OUT_DIR"/*.apk; do
    b=$(basename "$f")
    abi=""
    case "$b" in
      *arm64-v8a*)   abi="arm64-v8a" ;;
      *armeabi-v7a*) abi="armeabi-v7a" ;;
      *x86_64*)      abi="x86_64" ;;
      *x86*)         abi="x86" ;;
    esac
    dest="${SAFE_NAME}.v${APP_VERSION}${abi:+.$abi}.apk"
    mv "$f" "$dest"
    artifact "$dest"
    MADE+=("$dest")
  done
fi

if [ "${#MADE[@]}" -eq 0 ]; then
  say "ERROR: no output files were produced in $OUT_DIR."
  exit 1
fi

# Optional project-provided signature guard: some projects (e.g. Mahameh) keep
# a scripts/verify-signing.sh that rejects debug-signed APKs.
if [ "$SIGNED" = "1" ] && [ "$FORMAT" = "apk" ] && [ -f "scripts/verify-signing.sh" ]; then
  phase verify
  if [ "$ALLOW_DEBUG_SIGNED" = "1" ]; then
    say "ALLOW_DEBUG_SIGNED=1 - skipping the debug-signature guard."
  else
    say "Verifying APK signature with scripts/verify-signing.sh..."
    bash scripts/verify-signing.sh "${MADE[0]}"
  fi
fi

for f in "${MADE[@]}"; do
  say "Built: $f"
done
if [ -n "$SIGNED_FROM" ]; then
  say "Signing key: $SIGNED_FROM (persistent in '$KEY_DIR/' - safe to commit)"
fi

phase done
printf '@@DONE\n'
