'use strict';
// Dependency version watch: for every tool the build pipeline needs, find the
// newest release the toolchain can actually work with (stable channel) and
// compare it against what is installed. Read-only — nothing is ever installed
// or upgraded from here; the first page only reports what is available.
//
// Sources, in order:
//   Android SDK components  dl.google.com repository2-*.xml manifest, parsed
//                           directly (fast); falls back to `sdkmanager --list`
//                           when the manifest URLs move again.
//   Node.js                 nodejs.org/dist/index.json (latest LTS line).
//   JDK                     api.adoptium.net (latest Temurin 21 LTS).
// Pure Node — usable from the Electron main process and as a CLI:
//   node out/lib/sdk-updates.js [--xml repository2-3.xml]

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import {
  findAndroidSdk,
  checkNode,
  checkJava,
  checkPlatformTools,
  checkBuildTools,
  checkPlatforms,
  checkNdk,
  checkCmake,
  compareVersionStrings,
} from './env-check';

const WIN = process.platform === 'win32';

/** The SDK package families shown as upgradeable rows on the deps page. */
const SDK_FAMILIES = ['platform-tools', 'build-tools', 'platforms', 'ndk', 'cmake'] as const;

const MANIFEST_BASE = 'https://dl.google.com/android/repository/';
/** Newest schema first; older manifests keep working for older toolchains. */
const MANIFEST_VERSIONS = [3, 2, 1];
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const ADOPTIUM_21_URL =
  'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk';

const FETCH_TIMEOUT = 15000;
const SDKMANAGER_TIMEOUT = 90000;
const PREVIEW_RE = /-(rc|beta|alpha|canary|preview|dev)\d*$/i;
/** "android-37.2" ok; "android-34-ext10"/"android-CANARY" are side channels. */
const PLATFORM_VER_RE = /^android-(\d+(?:\.\d+)?)$/;

interface SdkPkg {
  family: string;
  version: string;
  preview: boolean;
}

// ------------------------------------------------------------------ https get
function fetchText(url: string, timeoutMs = FETCH_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = (u: string, hops: number): void => {
      if (hops > 3) {
        reject(new Error('too many redirects'));
        return;
      }
      let settled = false;
      const done = (err: Error | null, body?: string) => {
        if (settled) return;
        settled = true;
        if (tim) clearTimeout(tim);
        if (err || body === undefined) reject(err || new Error('empty response'));
        else resolve(body);
      };
      let tim: ReturnType<typeof setTimeout> | undefined;
      tim = setTimeout(() => done(new Error(`timeout: ${u}`)), timeoutMs);
      try {
        const req = https.get(u, { headers: { 'User-Agent': 'expo-builder' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, u).toString(), hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            done(new Error(`HTTP ${res.statusCode}: ${u}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 16 * 1024 * 1024) {
              req.destroy();
              done(new Error('response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
          res.on('error', (e: Error) => done(e));
        });
        req.on('error', (e: Error) => done(e));
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    };
    get(url, 0);
  });
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT): Promise<unknown> {
  return JSON.parse(await fetchText(url, timeoutMs));
}

// -------------------------------------------------------- manifest / sdkmanager
/**
 * Parse dl.google.com's repository2-*.xml. Previews are marked by an -rc/-beta
 * style suffix or a <preview> revision element; channelRef is always
 * "channel-0" in practice, so it cannot be used for filtering.
 */
function parseManifest(xml: string): SdkPkg[] {
  const out: SdkPkg[] = [];
  const re = /<remotePackage path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const p = m[1];
    const body = m[2];
    const semi = p.indexOf(';');
    const family = semi === -1 ? p : p.slice(0, semi);
    if (!(SDK_FAMILIES as readonly string[]).includes(family)) continue;

    let version: string;
    let preview: boolean;
    if (semi === -1) {
      // Unversioned paths (platform-tools) carry their version in <revision>.
      const maj = /<major>(\d+)<\/major>/.exec(body)?.[1] || '0';
      const min = /<minor>(\d+)<\/minor>/.exec(body)?.[1];
      const mic = /<micro>(\d+)<\/micro>/.exec(body)?.[1];
      version = [maj, min, mic].filter(Boolean).join('.');
      preview = /<preview>\d+<\/preview>/.test(body);
    } else {
      version = p.slice(semi + 1);
      preview = PREVIEW_RE.test(version) || /<preview>\d+<\/preview>/.test(body);
    }
    if (family === 'platforms' && !PLATFORM_VER_RE.test(version)) continue;
    out.push({ family, version, preview });
  }
  return out;
}

/** Parse the "Available Packages:" table of `sdkmanager --list`. */
function parseSdkmanagerList(text: string): SdkPkg[] {
  const start = text.indexOf('Available Packages:');
  if (start < 0) return [];
  const out: SdkPkg[] = [];
  const lines = text.slice(start).split(/\r?\n/);
  for (const line of lines.slice(1)) {
    // The next section header ("Available Updates:", …) sits at column 0.
    if (line && !/\s/.test(line[0])) break;
    const row = /^\s{2,}(\S+)\s+\|\s*([^|]+?)\s+\|/.exec(line);
    if (!row) continue;
    const p = row[1];
    const semi = p.indexOf(';');
    const family = semi === -1 ? p : p.slice(0, semi);
    if (!(SDK_FAMILIES as readonly string[]).includes(family)) continue;
    const version = (semi === -1 ? row[2] : p.slice(semi + 1)).trim();
    if (family === 'platforms' && !PLATFORM_VER_RE.test(version)) continue;
    out.push({ family, version, preview: PREVIEW_RE.test(version) });
  }
  return out;
}

function findSdkmanager(sdk: string): string | null {  const cands: string[] = [];
  const clt = path.join(sdk, 'cmdline-tools');
  try {
    // "latest" wins; otherwise the highest numbered versioned dir.
    const dirs = fs
      .readdirSync(clt, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.includes('latest')) cands.push(path.join(clt, 'latest', 'bin'));
    for (const d of dirs.sort((a, b) => compareVersionStrings(b, a))) {
      cands.push(path.join(clt, d, 'bin'));
    }
  } catch {
    /* no cmdline-tools */
  }
  cands.push(path.join(sdk, 'tools', 'bin')); // legacy SDK layout
  for (const dir of cands) {
    const bat = path.join(dir, WIN ? 'sdkmanager.bat' : 'sdkmanager');
    if (fs.existsSync(bat)) return bat;
  }
  return null;
}

/** Run `sdkmanager --list` and return its available packages. */
function runSdkmanagerList(sdk: string): Promise<SdkPkg[]> {
  const bat = findSdkmanager(sdk);
  if (!bat) return Promise.reject(new Error('sdkmanager not found'));
  // sdkmanager needs a JDK; prefer the one env-check would pick.
  const javaDir = checkJava().path || process.env.JAVA_HOME || '';
  return new Promise((resolve, reject) => {
    let settled = false;
    let tim: ReturnType<typeof setTimeout> | undefined;
    const done = (err: Error | null, out?: string) => {
      if (settled) return;
      settled = true;
      if (tim) clearTimeout(tim);
      if (err) reject(err);
      else {
        const pkgs = parseSdkmanagerList(out || '');
        if (pkgs.length) resolve(pkgs);
        else reject(new Error('sdkmanager listed no available packages'));
      }
    };
    tim = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(new Error('sdkmanager timed out'));
    }, SDKMANAGER_TIMEOUT);
    // .bat shims must go through cmd.exe on Windows.
    const child = WIN
      ? spawn('cmd.exe', ['/c', bat, `--sdk_root=${sdk}`, '--list'], {
          windowsHide: true,
          env: { ...process.env, JAVA_HOME: javaDir, ANDROID_HOME: sdk },
        })
      : spawn(bat, [`--sdk_root=${sdk}`, '--list'], {
          windowsHide: true,
          env: { ...process.env, JAVA_HOME: javaDir, ANDROID_HOME: sdk },
        });
    let out = '';
    const feed = (s: string) => { out += s; };
    child.stdout?.setEncoding('utf8').on('data', feed);
    child.stderr?.setEncoding('utf8').on('data', feed);
    child.on('error', (e) => done(e));
    child.on('exit', (code) =>
      code === 0 ? done(null, out) : done(new Error(`sdkmanager exited with ${code}`))
    );
  });
}

/** Latest stable + latest preview release of one SDK family. */
function latestOf(pkgs: SdkPkg[], family: string): { stable: string | null; preview: string | null } {
  const best = (list: SdkPkg[]): string | null =>
    list.reduce<string | null>((acc, p) => {
      const v = p.version.replace(/^android-/, '');
      const a = acc?.replace(/^android-/, '');
      return acc === null || compareVersionStrings(v, a || '') > 0 ? p.version : acc;
    }, null);
  const fam = pkgs.filter((p) => p.family === family);
  return { stable: best(fam.filter((p) => !p.preview)), preview: best(fam.filter((p) => p.preview)) };
}

// ------------------------------------------------------------------ latest feeds
async function latestNodeLts(): Promise<string | null> {
  try {
    const idx = (await fetchJson(NODE_INDEX_URL)) as Array<{ version?: string; lts?: unknown }>;
    const lts = Array.isArray(idx) ? idx.find((e) => e && e.lts && typeof e.version === 'string') : null;
    return lts?.version ? lts.version.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

async function latestJdk21(): Promise<string | null> {
  try {
    const res = (await fetchJson(ADOPTIUM_21_URL)) as Array<{ version?: { semver?: string } }>;
    const semver = Array.isArray(res) ? res[0]?.version?.semver : undefined; // "21.0.12+101.0.LTS"
    if (!semver) return null;
    const [nums] = semver.split('+');
    return nums;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------ main
const DEP_LABELS: Record<string, string> = {
  node: 'Node.js',
  jdk: 'Java JDK (17+)',
  'platform-tools': 'SDK platform-tools',
  'build-tools': 'SDK build-tools',
  platforms: 'Android platform',
  ndk: 'Android NDK',
  cmake: 'CMake (SDK)',
};

function dep(
  id: string,
  current: string | null,
  latest: string | null,
  preview: string | null,
  source: string,
  error: string | null = null
): DepUpdateInfo {
  // Only a *stable* release counts as a suitable upgrade target — that is the
  // channel Expo/React Native release builds are tested against.
  const plain = (v: string) => v.replace(/^android-/, '').replace(/^v/, '');
  const newer = !!(current && latest && compareVersionStrings(plain(current), plain(latest)) < 0);
  return { id, label: DEP_LABELS[id] || id, current, latest, preview, newer, source, error };
}

/** SDK-side discovery: manifest first (fast), sdkmanager as fallback. */
async function resolveSdkLatest(sdk: string | null, opts: { manifestXml?: string }): Promise<{ pkgs: SdkPkg[]; source: string; error: string | null }> {
  if (opts.manifestXml) {
    try {
      return { pkgs: parseManifest(fs.readFileSync(opts.manifestXml, 'utf8')), source: 'local manifest', error: null };
    } catch (e) {
      return { pkgs: [], source: '', error: String(e) };
    }
  }
  for (const v of MANIFEST_VERSIONS) {
    try {
      const pkgs = parseManifest(await fetchText(`${MANIFEST_BASE}repository2-${v}.xml`));
      if (pkgs.length) return { pkgs, source: `dl.google.com · repository2-${v}.xml`, error: null };
    } catch {
      /* try the next manifest version */
    }
  }
  if (sdk) {
    try {
      return { pkgs: await runSdkmanagerList(sdk), source: 'sdkmanager --list', error: null };
    } catch (e) {
      return { pkgs: [], source: '', error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { pkgs: [], source: '', error: 'Android SDK repository unreachable (offline or blocked)' };
}

async function checkDependencyUpdates(opts: { manifestXml?: string } = {}): Promise<UpdatesResult> {
  const sdk = findAndroidSdk();
  const deps: DepUpdateInfo[] = [];

  // Current versions come from the same probes the environment gate uses.
  const cur: Record<string, string | null> = {
    node: checkNode().version || null,
    jdk: checkJava().version || null,
    'platform-tools': checkPlatformTools(sdk).version || null,
    'build-tools': checkBuildTools(sdk).version || null,
    platforms: checkPlatforms(sdk).version || null,
    ndk: checkNdk(sdk).version || null,
    cmake: checkCmake(sdk).version || null,
  };

  // The three source groups are independent — fetch them concurrently so a
  // blocked network costs one timeout, not the sum of all of them.
  const [sdkLatest, nodeLts, jdk21] = await Promise.all([
    resolveSdkLatest(sdk, opts),
    latestNodeLts(),
    latestJdk21(),
  ]);

  for (const family of SDK_FAMILIES) {
    if (sdkLatest.pkgs.length) {
      const { stable, preview } = latestOf(sdkLatest.pkgs, family);
      deps.push(dep(family, cur[family], stable, preview, sdkLatest.source));
    } else {
      deps.push(dep(family, cur[family], null, null, '', sdkLatest.error || 'unknown latest version'));
    }
  }

  // ---- Node.js LTS (Expo needs >= 18; LTS is the recommended line).
  deps.push(
    dep('node', cur.node, nodeLts, null, nodeLts ? 'nodejs.org · LTS' : '', nodeLts ? null : 'nodejs.org unreachable')
  );

  // ---- JDK: Temurin 21 LTS — the newest LTS line Gradle/AGP fully support.
  deps.push(
    dep('jdk', cur.jdk, jdk21, null, jdk21 ? 'adoptium.net · Temurin 21 LTS' : '', jdk21 ? null : 'adoptium.net unreachable')
  );

  return { when: Date.now(), deps };
}

export { checkDependencyUpdates, parseManifest, parseSdkmanagerList, findSdkmanager };

if (require.main?.filename === __filename) {
  // CLI: node out/lib/sdk-updates.js [--xml repository2-3.xml]
  const i = process.argv.indexOf('--xml');
  const manifestXml = i >= 0 ? process.argv[i + 1] : undefined;
  checkDependencyUpdates(manifestXml ? { manifestXml } : {})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(String(e));
      process.exit(1);
    });
}
