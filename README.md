# Expo Builder

A local Material 3 Expressive desktop app (Electron) that builds and signs **any Expo project** on Windows — a generalization of the original `Mahameh (App)/scripts/build-local.sh` GitLab-CI replica.

![Expo Builder](.smoke/2-config.png)

## Run it

```bash
npm install
npm start
```

Requirements on the machine (same as building by hand) — the app **checks all of them itself** on the first page before anything else:

- **Git for Windows** (bash + MSYS tools) — the build script runs through Git Bash
- **Node** (+ npm; yarn/pnpm/bun optionally, matching the target project)
- **JDK 17+** with `java` + `keytool` (`JAVA_HOME`, PATH, or Android Studio's bundled JDK)
- **Android SDK** (`ANDROID_HOME` / `ANDROID_SDK_ROOT` / `%LOCALAPPDATA%\Android\Sdk`) with **platform-tools**, **build-tools**, an **Android platform**, the **NDK** and **CMake**

## The flow

0. **Setup (environment gate)** — the app opens on a dependency check, not the picker. It probes the machine (read-only, nothing is installed): Node/npm, the optional package managers, Git Bash, the JDK (version + `keytool`), the Android SDK root and inside it platform-tools (`adb`), build-tools (`aapt`/`apksigner`/`zipalign`), the newest platform, the NDK and the SDK's CMake (+ bundled ninja). Each row shows the detected version/path — or what to install and where — with **Continue locked until every required tool is found**; missing optional package managers only turn the row gray. A *Check again* button re-runs everything after you install something, no restart needed.
1. **Project** — pick a folder with the native Windows directory picker. The app validates it is an Expo project (`package.json` with an `expo` dependency + `app.json`/`app.config.js`), then immediately asks you to **name the project** (prefilled with the detected name). Confirming defines the picked folder as a project under that name — this name is what `APP_NAME` uses downstream. Every defined project is remembered in a **"Your projects" list** on this page (localStorage): click an entry to re-validate and reopen it, or remove it with the trash button. Picking a folder that is already listed prefills its saved name. When a project is open, a **Build history** card lists every recorded build of that project (version, format, signing, success/failed status, date, duration, file count) — click an entry to see its **build details**: full settings plus every output file with Save / reveal actions (files no longer on disk are struck through and marked). The saved-projects rows and the project card also show the latest built version, and the trash button on the card clears the history.
2. **Configure**
   - **App version** (`x.y.z`) — **prefilled from `app.json`** (`expo.version`, falling back to `package.json`), re-read every time the project opens; written into `package.json`, `app.json` `expo.version` and `expo.android.versionCode` before the build; the versionCode is auto-derived as `major·10000 + minor·100 + patch` (1.37.18 → 13718) and stays editable
   - **Version warnings** (from the project's build history): typing a version that was **already built** warns that rebuilding replaces that build's output files; typing a version **lower than the last built one** warns that a lower versionCode can block updates. Pressing *Start build* on an already-built version asks for confirmation first — it lists the previous build's files (marking already-deleted ones) and offers *Build without deleting* or *Delete old files & build* (old files go to the **Recycle Bin**, never permanently deleted)
   - **Sign the app** checkbox — when on: key alias, key password, keystore password (password fields with show/hide + a built-in generator with strength meter), and a searchable country picker (249 ISO countries) for the certificate dname
   - **Format** — APK or AAB; for APK pick architectures (arm64-v8a, armeabi-v7a, x86_64, x86 — all selected by default)
   - **Advanced** — redirect heavy Gradle output to `C:\ExpoBuilds\<project>` via NTFS junctions (the F:-drive protection from the original script; on by default)
3. **Build** — every command streams into the console line by line with phase tracking and elapsed time; cancel anytime. On failure the app asks: *"Do you want to run it again in debug mode with stack-trace and more details?"* — the rerun adds `set -x`, gradle `--stacktrace --info`.
4. **Output** — every produced APK/AAB plus `android-key.jks` (the persistent signing key from `android-key/`) with individual Save buttons, **Download ZIP** (outputs + keystore in one archive), and open-folder shortcuts. Finishing a build records it in the project's **build history** (localStorage `ab.builds`, newest first, 50 per project) with its version, settings and output files.

## Signing model (unchanged from the original script)

- The **`android-key/`** folder at the project root holds the persistent keystore (`android-key.jks`). If it exists it is **validated** against the alias/passwords and reused; if not, a 2048-bit RSA / 10000-day key is generated once.
- A working copy is placed at `android/app/<Name>.v<version>.jks` and wired into `android/gradle.properties` (`MYAPP_UPLOAD_*`).
- If a project ships `scripts/verify-signing.sh` (like Mahameh), it runs after an APK build.

## Project layout

```
main.js                  Electron main: IPC, environment gate + build wiring, log streaming, zip, save dialogs
preload.js               contextBridge API
lib/project-info.js      Expo validation + version writing (also a CLI: node lib/project-info.js <dir>)
lib/env-check.js         dependency detection for the setup gate (also a CLI: node lib/env-check.js)
resources/expo-build.sh  generalized build script (env-driven, @@PHASE/@@ARTIFACT markers)
renderer/                UI — hand-rolled Material 3 Expressive dark glass theme
  index.html
  assets/m3.css          design tokens + components (buttons, fields, chips, dialogs…)
  assets/app.css         page layout
  assets/app.js          5-page flow (setup → project → configure → build → output), form logic/validation, console, generator
  assets/countries.js    ISO 3166 country data
```

## Testing

```bash
npm run smoke   # boots the app, walks all pages with mock data, screenshots into .smoke/
node lib/project-info.js "F:/Some Expo Project"   # validate a folder from CLI
node lib/env-check.js                             # run the dependency checks from CLI (JSON)

# full in-app end-to-end against a shimmed fake project (no real gradle needed):
cd .smoke && ./make-fake.sh   # (see shims/ for the yarn/expo/gradlew shims)
E2E_PROJECT="F:/Android Builder/.smoke/fake-project" PATH="$PWD/.smoke/shims:$PATH" npx electron . --e2e
E2E_PROJECT="F:/Android Builder/.smoke/fake-project" E2E_EXPECT_FAIL=1 FAIL_SHIM=1 PATH="$PWD/.smoke/shims:$PATH" npx electron . --e2e

# page-1 naming flow (pick -> name dialog -> project defined -> config form):
npx electron .smoke/verify-naming.js

# every input/combobox: geometry, floating labels, icons, flip-up menu, errors:
npx electron .smoke/verify-inputs.js

# build history: history card, details dialog, app.json version prefill,
# already-built / lower-version warnings, rebuild confirmation, stat/trash IPC:
npx electron .smoke/verify-history.js
```

## Notes

- Passwords never leave the machine: they go into the keytool command and the project's `android/gradle.properties` only (and into the log in debug mode's `set -x` trace — that's inherent to debug output).
- Projects using `app.config.js` instead of `app.json` get the version written to `package.json` only; the UI warns about it.
- `expo prebuild --clean` **regenerates the `android/` folder** on every build — keep custom native changes in Expo config plugins, as usual.
