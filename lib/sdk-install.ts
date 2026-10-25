'use strict';
// Update-action side of the deps page: download & install newer dependency
// releases on demand.
//   SDK components  through the SDK's own sdkmanager (side-by-side install,
//                   licenses auto-accepted by feeding "y" to stdin)
//   Node / JDK      the official Windows MSI is downloaded to Downloads and
//                   opened — those touch system locations, so the user finishes
//                   the wizard themselves
// Pure Node — used by the Electron main process.

import { spawn, execSync, ChildProcess } from 'child_process';
import { ClientRequest } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { checkJava } from './env-check';
import { findSdkmanager } from './sdk-updates';

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
let activeReq: ClientRequest | null = null;
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
      tim = setTimeout(() => done(new Error('download timed out')), 10 * 60 * 1000);
      const req = https.get(u, { headers: { 'User-Agent': 'expo-builder' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(new URL(res.headers.location, u).toString(), hops + 1);
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
