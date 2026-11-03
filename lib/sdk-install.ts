'use strict';
// Install-action side of the deps page: download & install dependency releases
// on demand — both newer versions of detected tools and tools that are missing
// entirely.
//   SDK updates     through the SDK's own sdkmanager (side-by-side install,
//                   licenses auto-accepted by feeding "y" to stdin)
//   SDK missing     straight from the Android SDK repository manifest of the
//                   selected download source (Google by default, mirrors
//                   available): the package zip is downloaded, SHA-1-verified
//                   and extracted into the SDK folder — no sdkmanager and no
//                   JDK needed, so a fresh machine can bootstrap a complete SDK
//   Node / JDK / Git the official installer is downloaded to Downloads and
//                   opened — those touch system locations, so the user
//                   finishes the wizard themselves
// Pure Node — used by the Electron main process.

import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { httpGet } from './net';
import { checkJava, checkPlatformTools, checkBuildTools, checkPlatforms, checkNdk, checkCmake, compareVersionStrings } from './env-check';
import { findSdkmanager, fetchManifestFrom, manifestPackages, parseManifest, ManifestSource } from './sdk-updates';

const WIN = process.platform === 'win32';

export interface InstallHandlers {
  onPhase(id: 'license' | 'download' | 'install'): void;
  onProgress(percent: number | null, text: string): void;
  onLine(text: string, stream: 'out' | 'err'): void;
}

// One install at a time. These handles let cancel-install reach whatever is
// running right now: a sdkmanager process tree, an in-flight download request
// (killed + partial file removed), or both.
let activeChild: ChildProcess | null = null;
let activeReq: { destroy(): void } | null = null;
let activeFile: string | null = null;

export function cancelActiveInstall(): void {
  if (activeChild) {
    try {
      execSync(`taskkill /PID ${activeChild.pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
    } catch {
      try { activeChild.kill(); } catch { /* already gone */ }
    }
  }
  if (activeReq) {
    try { activeReq.destroy(); } catch { /* already gone */ }
  }
  if (activeFile) {
    try { fs.unlinkSync(activeFile); } catch { /* never created */ }
  }
  activeChild = null;
  activeReq = null;
  activeFile = null;
}

/** Run sdkmanager with the given args, feeding "y" so licenses auto-accept. */
function runSdkmanager(sdk: string, args: string[], h: InstallHandlers, feedYes: boolean): Promise<number> {
  const bat = findSdkmanager(sdk);
  if (!bat) return Promise.reject(new Error('sdkmanager was not found — install the Android SDK command-line tools first'));
  const javaDir = checkJava().path || process.env.JAVA_HOME || '';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // .bat shims must go through cmd.exe on Windows.
      child = WIN
        ? spawn('cmd.exe', ['/c', bat, `--sdk_root=${sdk}`, ...args], {
            windowsHide: true,
            env: { ...process.env, JAVA_HOME: javaDir, ANDROID_HOME: sdk },
          })
        : spawn(bat, [`--sdk_root=${sdk}`, ...args], {
            windowsHide: true,
            env: { ...process.env, JAVA_HOME: javaDir, ANDROID_HOME: sdk },
          });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    activeChild = child;
    let yes = 0;
    const timer = feedYes
      ? setInterval(() => {
          if (yes++ > 120) {
            try { child.stdin?.end(); } catch { /* closed */ }
            return;
          }
          try { child.stdin?.write('y\n'); } catch { /* stdin closed */ }
        }, 400)
      : null;
    const finish = (code: number) => {
      if (timer) clearInterval(timer);
      activeChild = null;
      resolve(code);
    };
    // sdkmanager repaints progress with \r; normalize so each repaint is a line.
    let buf = '';
    const feed = (s: string, stream: 'out' | 'err') => {
      buf += s.replace(/\r/g, '\n');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.trim()) continue;
        h.onLine(ln, stream);
        // Progress repaints look like "[=====  ] 25% Loading repository…" —
        // the percent sits mid-line, followed by the phase text.
        const pct = /(\d{1,3})%/.exec(ln);
        if (pct) {
          h.onProgress(parseInt(pct[1], 10), ln.replace(/\[[= ]*\]\s*/, '').replace(/\d{1,3}%\s*/, '').trim());
        }
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (d: string) => feed(d, 'out'));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => feed(d, 'err'));
    child.on('error', (e) => {
      if (timer) clearInterval(timer);
      activeChild = null;
      reject(e);
    });
    child.on('exit', (code) => finish(code == null ? 1 : code));
  });
}

/** Accept licenses if needed, then install one SDK package. Resolves to the exit code. */
export async function runSdkUpdate(sdk: string, pkgPath: string, h: InstallHandlers): Promise<number> {
  if (!fs.existsSync(path.join(sdk, 'licenses', 'android-sdk-license'))) {
    h.onPhase('license');
    h.onProgress(null, 'Accepting SDK licenses…');
    const licCode = await runSdkmanager(sdk, ['--licenses'], h, true);
    if (licCode !== 0) return licCode;
  }
  h.onPhase('install');
  h.onProgress(0, 'Downloading & installing…');
  return runSdkmanager(sdk, [pkgPath], h, true);
}

/** Stream a file to disk with percent progress; resolves to the written path. */
export function downloadFile(url: string, dest: string, h: InstallHandlers): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = (u: string, hops: number): void => {
      if (hops > 5) {
        reject(new Error('too many redirects'));
        return;
      }
      let settled = false;
      let tim: ReturnType<typeof setTimeout> | undefined;
      const done = (err: Error | null) => {
        if (settled) return;
        settled = true;
        if (tim) clearTimeout(tim);
        activeReq = null;
        activeFile = null;
        if (err) reject(err);
        else resolve(dest);
      };
      // Generous: the NDK alone is a ~1 GB download on a slow line.
      tim = setTimeout(() => done(new Error('download timed out')), 30 * 60 * 1000);
      const req = httpGet(u, { 'User-Agent': 'expo-builder' }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(new URL(String(res.headers.location), u).toString(), hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          done(new Error(`HTTP ${res.statusCode} while downloading`));
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        activeReq = req;
        activeFile = dest;
        const out = fs.createWriteStream(dest);
        res.on('data', (c: Buffer) => {
          got += c.length;
          const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
          h.onProgress(total ? Math.round((got / total) * 100) : null, `${mb(got)}${total ? ` of ${mb(total)}` : ''}`);
        });
        res.pipe(out);
        out.on('finish', () => done(null));
        out.on('error', (e) => done(e));
        res.on('error', (e) => done(e));
      });
      req.on('error', (e) => done(e));
    };
    get(url, 0);
  });
}

// ───────────────────── direct installs from Google's manifest ───────────────
// Used when there is no working sdkmanager yet (missing components on a machine
// without a JDK, or a full SDK bootstrap): the manifest names a zip per package
// with its size and SHA-1; download, verify, extract into the SDK folder.

/** One downloadable archive of a manifest package. */
interface PkgArchive {
  url: string;
  size: number;
  sha1: string;
  hostOs: string | null;
}

function hostOsTag(): { os: string; zipPrefix: string } {
  if (process.platform === 'darwin') return { os: 'macosx', zipPrefix: 'mac' };
  if (process.platform === 'linux') return { os: 'linux', zipPrefix: 'linux' };
  return { os: 'windows', zipPrefix: 'win' };
}

/** The <archive> children of one remotePackage body. */
function parseArchives(body: string): PkgArchive[] {
  const out: PkgArchive[] = [];
  const re = /<archive>([\s\S]*?)<\/archive>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const a = m[1];
    const url = /<url>([^<]+)<\/url>/.exec(a)?.[1];
    if (!url) continue;
    out.push({
      url,
      size: parseInt(/<size>(\d+)<\/size>/.exec(a)?.[1] || '0', 10),
      sha1: (/<checksum>([0-9a-fA-F]{40})<\/checksum>/.exec(a)?.[1] || '').toLowerCase(),
      hostOs: /<host-os>([^<]+)<\/host-os>/.exec(a)?.[1] || null,
    });
  }
  return out;
}

function archiveForPlatform(archives: PkgArchive[]): PkgArchive | null {
  const { os } = hostOsTag();
  return archives.find((a) => a.hostOs === os) || archives.find((a) => !a.hostOs) || null;
}

/** The archive of one package path ("build-tools;36.1.0", "platform-tools"). */
function findArchive(xml: string, pkgPath: string): PkgArchive | null {
  const block = manifestPackages(xml).find((p) => p.path === pkgPath);
  return block ? archiveForPlatform(parseArchives(block.body)) : null;
}

/**
 * The command-line tools zip: the rolling "_latest" artifact of the newest
 * listed cmdline-tools build for this platform.
 */
export function findCmdlineToolsArchive(xml: string): PkgArchive | null {
  const { os, zipPrefix } = hostOsTag();
  let best: PkgArchive | null = null;
  let bestBuild = -1;
  for (const pkg of manifestPackages(xml)) {
    if (!pkg.path.startsWith('cmdline-tools;')) continue;
    for (const arch of parseArchives(pkg.body)) {
      if (arch.hostOs && arch.hostOs !== os) continue;
      const m = new RegExp(`^commandlinetools-${zipPrefix}-(\\d+)_latest\\.zip$`).exec(arch.url);
      if (!m) continue;
      const build = parseInt(m[1], 10);
      if (build > bestBuild) {
        bestBuild = build;
        best = arch;
      }
    }
  }
  return best;
}

/** Where a package path installs to inside the SDK ("ndk;29.x" → ndk/29.x). */
function targetDirOf(sdk: string, pkgPath: string): string {
  const semi = pkgPath.indexOf(';');
  if (semi === -1) return path.join(sdk, pkgPath); // "platform-tools"
  const family = pkgPath.slice(0, semi);
  const version = pkgPath.slice(semi + 1);
  if (family === 'cmdline-tools') return path.join(sdk, 'cmdline-tools', version || 'latest');
  return path.join(sdk, family, version);
}

function sha1Of(file: string): string {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/**
 * Extract a package zip into `target`: zips carry one top folder whose name
 * varies (android-14, android-ndk-r29, cmdline-tools, …) — the package path is
 * authoritative, so contents land in `target` whatever the folder is called.
 */
function extractZipInto(zipFile: string, target: string): void {
  const work = path.join(path.dirname(zipFile), `extract-${path.basename(zipFile, '.zip')}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    new AdmZip(zipFile).extractAllTo(work, true);
    const top = fs.readdirSync(work).filter((n) => !n.startsWith('.'));
    const src =
      top.length === 1 && fs.statSync(path.join(work, top[0])).isDirectory()
        ? path.join(work, top[0])
        : work;
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      const from = path.join(src, child);
      const to = path.join(target, child);
      fs.rmSync(to, { recursive: true, force: true });
      try {
        fs.renameSync(from, to);
      } catch {
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Host label for log lines ("dl.google.com", "mirrors.cloud.tencent.com", …). */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** Download + verify + extract one package zip into the SDK folder. The base
 *  is always the one that served the manifest — mirrors are only consistent
 *  with their own copy of the repository. */
async function downloadExtract(arch: PkgArchive, target: string, label: string, h: InstallHandlers, base: string): Promise<void> {
  const url = /^https?:\/\//.test(arch.url) ? arch.url : base + arch.url;
  const staging = path.join(os.tmpdir(), 'expo-builder-install');
  fs.mkdirSync(staging, { recursive: true });
  const dest = path.join(staging, `${label.replace(/[^\w.]+/g, '_')}.zip`);
  try {
    h.onPhase('download');
    const mb = arch.size ? ` (${(arch.size / 1048576).toFixed(0)} MB)` : '';
    h.onLine(`Downloading ${label}${mb} from ${hostOf(base)}…`, 'out');
    await downloadFile(url, dest, h);
    h.onProgress(null, `Verifying ${label}…`);
    if (arch.sha1 && sha1Of(dest) !== arch.sha1) {
      throw new Error(`Checksum mismatch for ${label} — the download is corrupt and was deleted.`);
    }
    h.onPhase('install');
    h.onProgress(null, `Extracting ${label}…`);
    extractZipInto(dest, target);
    h.onLine(`✓ Installed ${label} → ${target}`, 'out');
  } finally {
    try { fs.unlinkSync(dest); } catch { /* already gone */ }
  }
}

/** Install one SDK package straight from the repository manifest. `base` is
 *  the base URL the manifest came from (mirror-aware). */
export async function installPackageDirect(sdk: string, xml: string, pkgPath: string, h: InstallHandlers, base: string): Promise<void> {
  const arch = findArchive(xml, pkgPath);
  if (!arch) throw new Error(`No downloadable archive for "${pkgPath}" was found in the repository manifest.`);
  await downloadExtract(arch, targetDirOf(sdk, pkgPath), pkgPath.replace(';', ' '), h, base);
}

/** Install the command-line tools if `sdkmanager` is still missing. */
export async function ensureCmdlineTools(sdk: string, h: InstallHandlers, manifest?: ManifestSource): Promise<void> {
  if (findSdkmanager(sdk)) return;
  const m = manifest || (await fetchManifestFrom());
  const arch = findCmdlineToolsArchive(m.xml);
  if (!arch) throw new Error('The command-line tools package was not found in the Android SDK repository manifest.');
  await downloadExtract(arch, path.join(sdk, 'cmdline-tools', 'latest'), 'cmdline-tools latest', h, m.base);
  if (!findSdkmanager(sdk)) {
    throw new Error('The command-line tools were installed but sdkmanager was still not found.');
  }
}

/** Which SDK families a full bootstrap installs, most important first. */
const BOOT_ORDER = ['platform-tools', 'build-tools', 'platforms', 'cmake', 'ndk'] as const;

function familyStatus(sdk: string, family: string): string {
  switch (family) {
    case 'platform-tools': return checkPlatformTools(sdk).status;
    case 'build-tools': return checkBuildTools(sdk).status;
    case 'platforms': return checkPlatforms(sdk).status;
    case 'ndk': return checkNdk(sdk).status;
    case 'cmake': return checkCmake(sdk).status;
    default: return 'missing';
  }
}

/** Latest stable version of one family from the parsed manifest. */
export function latestStableOf(pkgs: ReturnType<typeof parseManifest>, family: string): string | null {
  const plain = (v: string) => v.replace(/^android-/, '');
  let best: string | null = null;
  for (const p of pkgs) {
    if (p.family !== family || p.preview) continue;
    if (best === null || compareVersionStrings(plain(p.version), plain(best)) > 0) best = p.version;
  }
  return best;
}

/**
 * Bootstrap a complete SDK into `sdk`: command-line tools first, then every
 * required component that is still missing (small packages before the ~1 GB
 * NDK, so a failed run keeps as much as possible). `canceled()` is polled
 * between packages; on cancel the function returns with the partial SDK in
 * place and the caller reports the cancelation.
 */
export async function installSdkAt(sdk: string, h: InstallHandlers, canceled: () => boolean): Promise<void> {
  h.onProgress(null, 'Reading the Android SDK repository…');
  const m = await fetchManifestFrom();
  await ensureCmdlineTools(sdk, h, m);
  const pkgs = parseManifest(m.xml);
  for (const family of BOOT_ORDER) {
    if (canceled()) return;
    if (familyStatus(sdk, family) === 'ok') {
      h.onLine(`${family} is already present — skipping.`, 'out');
      continue;
    }
    const version = latestStableOf(pkgs, family);
    if (!version) {
      h.onLine(`No stable ${family} release was found in the repository — skipping.`, 'err');
      continue;
    }
    const pkgPath = family === 'platform-tools' ? 'platform-tools' : `${family};${version}`;
    await installPackageDirect(sdk, m.xml, pkgPath, h, m.base);
  }
}
