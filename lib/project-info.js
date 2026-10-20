'use strict';
// Pure Node helpers for validating an Expo project and applying version bumps.
// Usable both from the Electron main process and from plain node CLI tests.

const fs = require('fs');
const path = require('path');

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return { pm: 'yarn', lockfile: 'yarn.lock' };
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return { pm: 'pnpm', lockfile: 'pnpm-lock.yaml' };
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb')))
    return { pm: 'bun', lockfile: 'bun.lock' };
  return { pm: 'npm', lockfile: 'package-lock.json' };
}

function findAppConfig(dir) {
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/**
 * Validate that `dir` is an Expo project and collect the info the UI pre-fills
 * from. Returns { ok: true, info } or { ok: false, error }.
 */
function validateProject(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'The selected path is not a directory.' };
    }
  } catch {
    return { ok: false, error: 'The selected path does not exist.' };
  }

  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, error: 'No package.json found — this folder is not an Expo project.' };
  }

  let pkg;
  try {
    pkg = readJson(pkgPath);
  } catch {
    return { ok: false, error: 'package.json could not be parsed (invalid JSON).' };
  }

  const expoRange = (pkg.dependencies && pkg.dependencies.expo) || (pkg.devDependencies && pkg.devDependencies.expo);
  if (!expoRange) {
    return {
      ok: false,
      error: "The 'expo' package was not found in package.json dependencies — this is not an Expo project.",
    };
  }

  const appJsonPath = path.join(dir, 'app.json');
  const appConfigName = findAppConfig(dir);
  let expoCfg = null;
  let appJsonParsed = false;

  if (fs.existsSync(appJsonPath)) {
    try {
      expoCfg = readJson(appJsonPath).expo || null;
      appJsonParsed = true;
    } catch {
      return { ok: false, error: 'app.json could not be parsed (invalid JSON).' };
    }
  }
  if (!expoCfg && !appConfigName) {
    return {
      ok: false,
      error: 'Neither app.json nor app.config.js was found — this is not an Expo project.',
    };
  }

  const { pm, lockfile } = detectPackageManager(dir);
  const version = (expoCfg && expoCfg.version) || pkg.version || '1.0.0';
  const computedCode = computeVersionCode(version);

  return {
    ok: true,
    info: {
      dir,
      name: (expoCfg && expoCfg.name) || pkg.name || 'App',
      slug: (expoCfg && expoCfg.slug) || pkg.name || 'app',
      version,
      versionCode: (expoCfg && expoCfg.android && expoCfg.android.versionCode) || computedCode,
      androidPackage: (expoCfg && expoCfg.android && expoCfg.android.package) || '',
      expoRange,
      pm,
      lockfile,
      appConfigName,
      hasAndroidDir: fs.existsSync(path.join(dir, 'android')),
      hasPersistentKey: fs.existsSync(path.join(dir, 'android-key')),
      appJsonWritable: appJsonParsed,
    },
  };
}

/** Mahameh-style scheme: 1.37.18 -> 13718 (major*10000 + minor*100 + patch). */
function computeVersionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return 1;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/**
 * Write `version` into package.json and `version`/`versionCode` into app.json.
 * app.json is plain JSON in Expo projects; if the project uses app.config.js
 * instead, the app.json write is skipped and a note is returned (the config
 * file must be updated by hand or already handles versions).
 */
function applyVersions(dir, { version, versionCode }) {
  const notes = [];
  const applied = { packageJson: false, appJson: false };

  const pkgPath = path.join(dir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  applied.packageJson = true;

  const appJsonPath = path.join(dir, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const app = readJson(appJsonPath);
    if (app.expo) {
      app.expo.version = version;
      if (versionCode && app.expo.android) {
        app.expo.android.versionCode = Number(versionCode);
      } else if (versionCode) {
        app.expo.android = { ...(app.expo.android || {}), versionCode: Number(versionCode) };
      }
      fs.writeFileSync(appJsonPath, JSON.stringify(app, null, 2) + '\n');
      applied.appJson = true;
    }
  } else {
    const appConfigName = findAppConfig(dir);
    if (appConfigName) {
      notes.push(
        `${appConfigName} detected — app.json not found. Version/versionCode were only applied to package.json;` +
          ` make sure ${appConfigName} reads the version from package.json or update it manually.`
      );
    }
  }

  return { applied, notes };
}

module.exports = { validateProject, applyVersions, computeVersionCode, detectPackageManager };

if (require.main === module) {
  // CLI: node lib/project-info.js <dir>
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node lib/project-info.js <projectDir>');
    process.exit(2);
  }
  console.log(JSON.stringify(validateProject(target), null, 2));
}
