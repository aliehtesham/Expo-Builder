#!/usr/bin/env bash
# Rebuilds the throwaway "fake Expo project" + yarn shim used by the E2E test
# (npm-run smoke uses mock data only; --e2e drives a real build with these).
#   usage: bash .smoke/make-fake.sh
set -euo pipefail
cd "$(dirname "$0")"
rm -rf fake-project shims
mkdir -p fake-project/scripts shims

cat > shims/yarn <<'EOF'
#!/usr/bin/env bash
echo "yarn shim args: $*"
if [ "$1" = "install" ]; then
  echo "success Saved lockfile."
  exit 0
fi
if [ "$1" = "expo" ]; then
  echo "Running expo prebuild --platform android --clean"
  P="${PWD}"
  mkdir -p "$P/android/app/build/outputs/apk/release" "$P/android/app/src"
  printf 'expo.useLegacyPackaging=false\n' > "$P/android/gradle.properties"
  cat > "$P/android/app/build.gradle" <<'GRADLE'
android {
    compileSdkVersion rootProject.ext.compileSdkVersion
    targetSdkVersion rootProject.ext.targetSdkVersion
}
GRADLE
  cat > "$P/android/gradlew" <<'GW'
#!/usr/bin/env bash
echo "Gradle shim"
echo "> Task :app:preBuild"
echo "> Task :app:bundleReleaseJsAndAssets"
for a in $(echo "$ARCHS" | tr ',' ' '); do
  echo "app-$a-release.apk built" > "app/build/outputs/apk/release/app-$a-release.apk"
done
if [ "${FAIL_SHIM:-0}" = "1" ]; then
  echo "> Task :app:packageRelease FAILED"
  echo "FAILURE: Build failed with an exception."
  exit 1
fi
echo "BUILD SUCCESSFUL in 3s"
GW
  chmod +x "$P/android/gradlew"
  echo "Android project generated."
  exit 0
fi
exit 1
EOF
chmod +x shims/yarn
cp shims/yarn shims/npm && sed -i 's/yarn shim/npm shim/' shims/npm && chmod +x shims/npm

cat > fake-project/package.json <<'EOF'
{
  "name": "fake-expo-app",
  "version": "1.0.0",
  "dependencies": { "expo": "~52.0.0" }
}
EOF
cat > fake-project/app.json <<'EOF'
{
  "expo": {
    "name": "Fake App",
    "slug": "fakeapp",
    "version": "1.0.0",
    "android": { "package": "com.example.fake", "versionCode": 10000 }
  }
}
EOF
touch fake-project/yarn.lock

echo "fake project + shims ready in .smoke/"
