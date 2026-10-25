'use strict';
// Environment pre-flight: detect every tool the build pipeline needs
// (bash, Node, package managers, JDK, Android SDK + platform-tools,
// build-tools, platforms, NDK, CMake) BEFORE the user enters the app.
// Pure Node — usable from the Electron main process and `node out/lib/env-check.js`.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const WIN = process.platform === 'win32';
const PROBE_TIMEOUT = 15000;

// ------------------------------------------------------------------ processes
function probe(cmd: string, args: string[]): string | null {
  const base = { windowsHide: true, timeout: PROBE_TIMEOUT, encoding: 'utf8' as const };
  // npm/yarn/... are .cmd shims on Windows; only absolute .exe paths spawn directly.
  const opts = WIN && !/\.(exe|bat|cmd)$/i.test(cmd) ? { ...base, shell: true } : base;
  let r;
  try {
    r = spawnSync(cmd, args, opts);
  } catch {
    return null;
  }
  if (!r || r.error) return null;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  if (!out) return null;
  return out;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function exists(p: string | null | undefined): boolean {
  return !!p && fs.existsSync(p);
}

/** Numeric compare of dotted version strings ("3.22.1" vs "26.1.10909125"). */
function compareVersionStrings(a: string, b: string): number {
  const pa = String(a).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function firstMatch(text: string | null | undefined, re: RegExp): string | null {
  const m = re.exec(text || '');
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ bash (msys)
function resolveBash(): string {
  const candidates: Array<string | null> = [];
  try {
    const out = spawnSync('where', ['bash'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (out.status === 0) candidates.push(...out.stdout.split(/\r?\n/).filter(Boolean));
  } catch {
    /* `where` may not find it */
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs\\Git\\bin\\bash.exe') : null
  );
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'bash'; // last resort: hope PATH of the spawned env resolves it
}

// --------------------------------------------------------------------- node/pm
function checkNode(): CheckResult {
  const out = probe('node', ['--version']);
  const version = out && firstMatch(out, /^v(\d+\.\d+\.\d+)/m);
  if (!out || !version) {
    return {
      id: 'node', label: 'Node.js', required: true, status: 'missing',
      detail: 'node is not on PATH.',
      hint: 'Install the LTS build from nodejs.org, then reopen Expo Builder.',
    };
  }
  const major = parseInt(version, 10);
  if (major < 18) {
    return {
      id: 'node', label: 'Node.js', required: true, status: 'warn', version,
      detail: `Node ${version} found — current Expo SDKs need Node 18 or newer.`,
      hint: 'Upgrade Node.js to the LTS release from nodejs.org.',
    };
  }
  return { id: 'node', label: 'Node.js', required: true, status: 'ok', version };
}

function checkCmd(id: string, label: string, cmd: string, args: string[], versionRe: RegExp, hint: string): CheckResult {
  const out = probe(cmd, args);
  const version = out && firstMatch(out, versionRe);
  if (!out || !version) {
    return { id, label, required: false, status: 'missing', detail: `${cmd} was not found on PATH.`, hint };
  }
  return { id, label, required: false, status: 'ok', version };
}

// ------------------------------------------------------------------ java / jdk
function findJavaCandidates(): string[] {
  const dirs: string[] = [];
  const javaHome = process.env.JAVA_HOME;
  if (javaHome && fs.existsSync(javaHome)) dirs.push(javaHome);
  try {
    const out = spawnSync('where', ['java'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (out.status === 0) {
      for (const p of out.stdout.split(/\r?\n/).filter(Boolean)) {
        dirs.push(path.dirname(path.resolve(p.trim()))); // .../bin
        dirs.push(path.dirname(path.dirname(path.resolve(p.trim())))); // parent, in case java is a shim copy
      }
    }
  } catch {
    /* ignore */
  }
  const roots = ['C:\\Program Files', 'C:\\Program Files (x86)'];
  const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft'];
  for (const root of roots) {
    for (const vendor of vendors) dirs.push(...listDirs(path.join(root, vendor)));
    dirs.push(path.join(root, 'Android', 'Android Studio', 'jbr'));
  }
  const seen = new Set<string>();
  return dirs.filter((d) => {
    if (!d || seen.has(d.toLowerCase()) || !exists(path.join(d, 'bin', 'java.exe'))) return false;
    seen.add(d.toLowerCase());
    return true;
  });
}

function checkJava(): CheckResult {
  const candidates = findJavaCandidates();
  if (!candidates.length) {
    return {
      id: 'jdk', label: 'Java JDK (17+)', required: true, status: 'missing',
      detail: 'No JDK found — Gradle and keytool both need Java.',
      hint: 'Install a JDK 17+ (adoptium.net) or Android Studio (its bundled JDK is detected automatically).',
    };
  }
  // Android Studio's bundled JBR is the most reliable full JDK; prefer it,
  // then JAVA_HOME / PATH order, then everything else.
  const sorted = [...candidates].sort((a, b) => {
    const score = (d: string) => (/jbr$/i.test(d) ? 2 : d.toLowerCase() === String(process.env.JAVA_HOME || '').toLowerCase() ? 1 : 0);
    return score(b) - score(a);
  });

  let best: { dir: string; version: string; hasKeytool: boolean } | null = null;
  for (const dir of sorted) {
    const java = path.join(dir, 'bin', 'java.exe');
    const out = probe(java, ['-version']);
    const version = out && firstMatch(out, /version "([^"]+)"/);
    if (!version) continue;
    best = { dir, version, hasKeytool: exists(path.join(dir, 'bin', 'keytool.exe')) };
    break;
  }
  if (!best) {
    return {
      id: 'jdk', label: 'Java JDK (17+)', required: true, status: 'missing',
      detail: 'Java was found but `java -version` failed to run.',
      hint: 'Reinstall a JDK 17+ from adoptium.net.',
    };
  }
  const major = parseInt(best.version, 10);
  if (!best.hasKeytool) {
    return {
      id: 'jdk', label: 'Java JDK (17+)', required: true, status: 'warn', version: best.version,
      detail: `${best.version} at ${best.dir} — but keytool.exe is missing, so this looks like a JRE. Signing needs a full JDK.`,
      hint: 'Install a full JDK 17+ (adoptium.net) and set JAVA_HOME.',
    };
  }
  if (major < 17) {
    return {
      id: 'jdk', label: 'Java JDK (17+)', required: true, status: 'warn', version: best.version,
      detail: `${best.version} at ${best.dir} — current Expo/React Native toolchains need JDK 17+.`,
      hint: 'Install a JDK 17+ (adoptium.net) and set JAVA_HOME to it.',
    };
  }
  return { id: 'jdk', label: 'Java JDK (17+)', required: true, status: 'ok', version: best.version, path: best.dir };
}

// --------------------------------------------------------------- android sdk
function findAndroidSdk(): string | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    'C:\\Android\\Sdk',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (
      exists(path.join(c, 'platform-tools')) ||
      exists(path.join(c, 'build-tools')) ||
      exists(path.join(c, 'platforms'))
    ) {
      return c;
    }
  }
  return null;
}

function sdkMissing(id: string, label: string, extra?: string): CheckResult {
  return {
    id, label, required: true, status: 'missing',
    detail: `No Android SDK found${extra ? ` — ${extra}` : ''}.`,
    hint: 'Install Android Studio (developer.android.com/studio) or the command-line tools, then set ANDROID_HOME.',
  };
}

function checkAndroidSdk(sdk: string | null): CheckResult {
  if (!sdk) return { ...sdkMissing('sdk', 'Android SDK'), required: true, path: null };
  return { id: 'sdk', label: 'Android SDK', required: true, status: 'ok', path: sdk, detail: sdk };
}

function checkPlatformTools(sdk: string | null): CheckResult {
  if (!sdk) return sdkMissing('platform-tools', 'SDK platform-tools', 'platform-tools cannot be located');
  const adb = path.join(sdk, 'platform-tools', 'adb.exe');
  if (!exists(adb)) {
    return {
      id: 'platform-tools', label: 'SDK platform-tools', required: true, status: 'missing', path: sdk,
      detail: `${path.join(sdk, 'platform-tools')} was not found.`,
      hint: 'In Android Studio: SDK Manager → SDK Tools → "Android SDK Platform-Tools" (or `sdkmanager "platform-tools"`).',
    };
  }
  // adb prints "Android Debug Bridge version 1.0.41" (protocol) and then
  // "Version 36.0.0-…" — the second line is the platform-tools release and the
  // one comparable against the SDK repository.
  const out = probe(adb, ['--version']);
  const version =
    (out && firstMatch(out, /^\s*Version (\d[\d.]*)/m)) || (out && firstMatch(out, /version ([\d.]+)/));
  return {
    id: 'platform-tools', label: 'SDK platform-tools', required: true, status: version ? 'ok' : 'warn',
    version: version || null, path: adb,
    detail: adb,
  };
}

function checkBuildTools(sdk: string | null): CheckResult {
  if (!sdk) return sdkMissing('build-tools', 'SDK build-tools', 'build-tools cannot be located');
  const roots = listDirs(path.join(sdk, 'build-tools')).sort((a, b) =>
    compareVersionStrings(path.basename(b), path.basename(a))
  );
  for (const dir of roots) {
    const aapt = path.join(dir, 'aapt.exe');
    const zipalign = path.join(dir, 'zipalign.exe');
    const apksigner =
      exists(path.join(dir, 'apksigner.bat')) || exists(path.join(dir, 'apksigner.exe'));
    if (!exists(aapt)) continue;
    const missing = [!apksigner && 'apksigner', !exists(zipalign) && 'zipalign'].filter(Boolean);
    if (missing.length) {
      return {
        id: 'build-tools', label: 'SDK build-tools', required: true, status: 'warn',
        version: path.basename(dir), path: aapt,
        detail: `${path.basename(dir)} at ${dir} — but ${missing.join(' and ')} are missing.`,
        hint: 'Reinstall the build-tools package via the SDK Manager.',
      };
    }
    return { id: 'build-tools', label: 'SDK build-tools', required: true, status: 'ok', version: path.basename(dir), path: aapt };
  }
  return {
    id: 'build-tools', label: 'SDK build-tools', required: true, status: 'missing', path: sdk,
    detail: `${path.join(sdk, 'build-tools')} contains no usable build-tools.`,
    hint: 'In Android Studio: SDK Manager → SDK Tools → "Android SDK Build-Tools" (or `sdkmanager "build-tools;34.0.0"`).',
  };
}

function checkPlatforms(sdk: string | null): CheckResult {
  if (!sdk) return sdkMissing('platforms', 'Android platform', 'platforms cannot be located');
  // Modern platform dirs carry minor versions ("android-37.0", "android-36.1").
  const apis = listDirs(path.join(sdk, 'platforms'))
    .map((d) => ({ dir: d, ver: firstMatch(path.basename(d), /^android-(\d+(?:\.\d+)?)$/) }))
    .filter((p): p is { dir: string; ver: string } => !!p)
    .sort((a, b) => compareVersionStrings(b.ver, a.ver));
  if (!apis.length) {
    return {
      id: 'platforms', label: 'Android platform', required: true, status: 'missing', path: sdk,
      detail: `${path.join(sdk, 'platforms')} is empty.`,
      hint: 'In Android Studio: SDK Manager → SDK Platforms → pick the latest Android platform (Gradle can also fetch it when licenses are accepted).',
    };
  }
  return {
    id: 'platforms', label: 'Android platform', required: true, status: 'ok',
    version: `android-${apis[0].ver}`, path: apis[0].dir,
    detail: `android-${apis[0].ver} (newest of ${apis.length} installed)`,
  };
}

function checkNdk(sdk: string | null): CheckResult {
  if (!sdk) return sdkMissing('ndk', 'Android NDK', 'the NDK cannot be located');
  const dirs = listDirs(path.join(sdk, 'ndk')).sort((a, b) =>
    compareVersionStrings(path.basename(b), path.basename(a))
  );
  const legacy = path.join(sdk, 'ndk-bundle');
  if (exists(legacy)) dirs.push(legacy);
  for (const dir of dirs) {
    if (!exists(path.join(dir, 'source.properties'))) continue;
    return { id: 'ndk', label: 'Android NDK', required: true, status: 'ok', version: path.basename(dir), path: dir };
  }
  return {
    id: 'ndk', label: 'Android NDK', required: true, status: 'missing', path: sdk,
    detail: `${path.join(sdk, 'ndk')} has no NDK installations.`,
    hint: 'In Android Studio: SDK Manager → SDK Tools → "NDK (Side by side)" (or `sdkmanager "ndk;26.1.10909125"`).',
  };
}

function checkCmake(sdk: string | null): CheckResult {
  if (!sdk) return sdkMissing('cmake', 'CMake (SDK)', 'CMake cannot be located');
  const dirs = listDirs(path.join(sdk, 'cmake')).sort((a, b) =>
    compareVersionStrings(path.basename(b), path.basename(a))
  );
  for (const dir of dirs) {
    const cmake = path.join(dir, 'bin', 'cmake.exe');
    if (!exists(cmake)) continue;
    const out = probe(cmake, ['--version']);
    const version = out && firstMatch(out, /cmake version ([\d.]+)/);
    const ninja = exists(path.join(dir, 'bin', 'ninja.exe'));
    if (!ninja) {
      return {
        id: 'cmake', label: 'CMake (SDK)', required: true, status: 'warn', version: version || path.basename(dir), path: cmake,
        detail: `${cmake} — but ninja.exe is missing next to it, so native builds would fail.`,
        hint: 'Reinstall the CMake package via the SDK Manager.',
      };
    }
    return {
      id: 'cmake', label: 'CMake (SDK)', required: true, status: 'ok',
      version: version || path.basename(dir), path: cmake,
    };
  }
  return {
    id: 'cmake', label: 'CMake (SDK)', required: true, status: 'missing', path: sdk,
    detail: `${path.join(sdk, 'cmake')} has no CMake installations.`,
    hint: 'In Android Studio: SDK Manager → SDK Tools → "CMake" (or `sdkmanager "cmake;3.22.1"`).',
  };
}

// ----------------------------------------------------------------------- main
function checkEnvironment({ bashPath }: { bashPath?: string } = {}): EnvCheckResult {
  const bash = bashPath || resolveBash();
  const sdk = findAndroidSdk();

  const checks: CheckResult[] = [
    checkNode(),
    // npm ships with Node; yarn/pnpm/bun are only needed when the project's
    // lockfile matches, so they stay optional.
    checkCmd('npm', 'npm', 'npm', ['--version'], /^([\d.]+)/m, 'npm normally ships with Node.js — reinstall Node from nodejs.org.'),
    checkCmd('yarn', 'Yarn (optional)', 'yarn', ['--version'], /^([\d.]+)/m, 'Only needed for projects with a yarn.lock — npm is used otherwise. Install with `npm i -g yarn`.'),
    checkCmd('pnpm', 'pnpm (optional)', 'pnpm', ['--version'], /^([\d.]+)/m, 'Only needed for projects with a pnpm-lock.yaml. Install with `npm i -g pnpm`.'),
    checkCmd('bun', 'Bun (optional)', 'bun', ['--version'], /^([\d.]+)/m, 'Only needed for projects with a bun.lock. Install from bun.sh.'),
    checkBash(bash),
    checkJava(),
    checkAndroidSdk(sdk),
    checkPlatformTools(sdk),
    checkBuildTools(sdk),
    checkPlatforms(sdk),
    checkNdk(sdk),
    checkCmake(sdk),
  ];

  const requiredFailed = checks.filter((c) => c.required && c.status !== 'ok');
  const optionalMissing = checks.filter((c) => !c.required && c.status !== 'ok');
  return {
    ok: requiredFailed.length === 0,
    os: { platform: process.platform, arch: process.arch, release: os.release() },
    requiredFailed: requiredFailed.map((c) => c.id),
    optionalMissing: optionalMissing.map((c) => c.id),
    sdk,
    bash,
    checks,
  };
}

function checkBash(bashPath: string): CheckResult {
  const out = probe(bashPath, ['--version']);
  const version = out && firstMatch(out, /version (\d+\.\d+[\d.]*)/);
  if (!out || !version) {
    return {
      id: 'bash', label: 'Git Bash', required: true, status: 'missing', path: bashPath,
      detail: 'bash.exe was not found — the build pipeline runs through it.',
      hint: 'Install Git for Windows (git-scm.com), which provides bash.',
    };
  }
  return { id: 'bash', label: 'Git Bash', required: true, status: 'ok', version, path: bashPath };
}

// The individual probes are exported for sdk-updates.ts, which compares the
// installed versions against the latest releases without re-implementing them.
export {
  checkEnvironment,
  resolveBash,
  findAndroidSdk,
  checkNode,
  checkJava,
  checkPlatformTools,
  checkBuildTools,
  checkPlatforms,
  checkNdk,
  checkCmake,
  compareVersionStrings,
};

if (require.main?.filename === __filename) {
  // CLI: node out/lib/env-check.js
  console.log(JSON.stringify(checkEnvironment(), null, 2));
}
