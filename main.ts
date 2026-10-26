'use strict';
import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import AdmZip from 'adm-zip';
import { validateProject, applyVersions } from './lib/project-info';
import { checkEnvironment, resolveBash, findAndroidSdk } from './lib/env-check';
import { checkDependencyUpdates, findSdkmanager } from './lib/sdk-updates';
import { runSdkUpdate, downloadFile, cancelActiveInstall } from './lib/sdk-install';

// When packaged, resources/** is unpacked next to app.asar because bash cannot
// read files inside Electron's virtual asar filesystem.
const RES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : path.join(__dirname, '..', 'resources');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_E2E = process.argv.includes('--e2e');
const E2E_PROJECT = process.env.E2E_PROJECT;
const WIN = process.platform === 'win32';
let win: BrowserWindow | null = null;

interface BuildChild extends ChildProcess {
  cwdPath?: string;
  __canceled?: boolean;
}
let buildChild: BuildChild | null = null;

// ------------------------------------------------------------------- build IPC
const ANSI_RE = /\x1b\[[0-9;?=<>!]*[A-Za-z]/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

function send(evt: BuildEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('build-event', evt);
}

function emitLine(text: string, stream: 'out' | 'err'): void {
  if (!buildChild) return;
  const clean = stripAnsi(text);
  if (!clean.trim()) return;

  if (clean.startsWith('@@PHASE ')) {
    send({ type: 'phase', id: clean.slice(8).trim() });
    return;
  }
  if (clean.startsWith('@@ARTIFACT ')) {
    const rel = clean.slice(11).trim();
    const abs = path.resolve(buildChild.cwdPath || '', rel);
    let size: number | null = null;
    try {
      size = fs.statSync(abs).size;
    } catch { /* moved file should exist; ignore if not */ }
    send({ type: 'artifact', path: abs, size });
    return;
  }
  if (clean.startsWith('@@KEYSTORE ')) {
    const rel = clean.slice(11).trim();
    const abs = path.resolve(buildChild.cwdPath || '', rel);
    let size: number | null = null;
    try {
      size = fs.statSync(abs).size;
    } catch { /* ignore */ }
    send({ type: 'keystore', path: abs, size });
    return;
  }
  if (clean.startsWith('@@KEYFAIL ')) {
    // Keystore validation failed (wrong passwords/alias) — the renderer asks
    // whether to archive the old key and build with a fresh one.
    const abs = path.resolve(buildChild.cwdPath || '', clean.slice(10).trim());
    send({ type: 'keyfail', path: abs });
    return;
  }
  if (clean === '@@DONE') {
    send({ type: 'done-marker' });
    return;
  }
  send({ type: 'line', text: clean, stream });
}

function attachStream(src: NodeJS.ReadableStream, streamName: 'out' | 'err'): void {
  let buf = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    buf += chunk;
    // Gradle likes \r-only progress repaints; treat them as line breaks too.
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop() || '';
    for (const p of parts) emitLine(p, streamName);
  });
  src.on('end', () => {
    if (buf) emitLine(buf, streamName);
    buf = '';
  });
}

function killBuildTree(): void {
  if (!buildChild) return;
  try {
    // bash spawns gradle/java children; taskkill /T takes the whole tree.
    execSync(`taskkill /PID ${buildChild.pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { buildChild.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Select your Expo project folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('validate-project', async (_e: IpcMainInvokeEvent, dir: string) => validateProject(dir));

// Pre-flight gate: detect every tool the build pipeline needs. Runs fresh on
// every call (a few `--version` probes) so a newly installed SDK is picked up
// without restarting the app.
ipcMain.handle('check-environment', async () => checkEnvironment({ bashPath: resolveBash() }));

// Latest-release watch for the deps page (read-only). The probes hit Google's
// SDK manifest plus nodejs.org/adoptium.net, so the result is cached for 10
// minutes — repeated re-checks stay instant.
let updatesCache: { ts: number; value: Promise<UpdatesResult> } | null = null;
ipcMain.handle('check-updates', async (_e: IpcMainInvokeEvent, force?: boolean): Promise<UpdatesResult> => {
  if (!force && updatesCache && Date.now() - updatesCache.ts < 10 * 60 * 1000) return updatesCache.value;
  const value = checkDependencyUpdates();
  updatesCache = { ts: Date.now(), value };
  value.catch(() => {
    updatesCache = null; // failed run: don't serve the rejection from cache
  });
  return value;
});

// ─────────────────────── dependency update action ──────────────────────────
// The install half of the newer-version watch: SDK components go through the
// SDK's own sdkmanager (side-by-side), Node/JDK download their official MSI
// into Downloads and open it. Progress streams to the renderer on a dedicated
// channel so it never mixes with build events.

const INSTALLABLE_IDS = ['platform-tools', 'build-tools', 'platforms', 'ndk', 'cmake', 'node', 'jdk'];
const NODE_MSI_URL = (v: string) => `https://nodejs.org/dist/v${v}/node-v${v}-x64.msi`;
const JDK_MSI_URL = 'https://api.adoptium.net/v3/installer/latest/21/windows/x64/jdk/hotspot/normal/eclipse?project=jdk';

let installRunning = false;
let installCanceled = false;

function sendUpdate(evt: UpdateEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('update-event', evt);
}

ipcMain.handle('install-update', async (_e: IpcMainInvokeEvent, id: string, version: string): Promise<InstallStartResult> => {
  if (installRunning) return { ok: false, error: 'An update is already running.' };
  if (buildChild) return { ok: false, error: 'A build is running — install the update after it finishes.' };
  if (!INSTALLABLE_IDS.includes(id)) return { ok: false, error: 'Unknown dependency.' };
  // Accepts tool versions ("4.1.2", "24.22.0") and platform tags ("android-37.2").
  if (!/^[A-Za-z0-9][\w.+-]*$/.test(version)) return { ok: false, error: 'Invalid version string.' };
  if (id === 'node' || id === 'jdk') {
    if (!WIN) return { ok: false, error: 'Installer download is only supported on Windows.' };
    installRunning = true;
    installCanceled = false;
    void (async () => {
      try {
        sendUpdate({ type: 'phase', id: 'download' });
        const url = id === 'node' ? NODE_MSI_URL(version.replace(/^v/, '')) : JDK_MSI_URL;
        const dest = path.join(
          app.getPath('downloads'),
          id === 'node' ? `node-v${version.replace(/^v/, '')}-x64.msi` : 'temurin-jdk-21-latest-x64.msi'
        );
        await downloadFile(url, dest, {
          onPhase: (pid) => sendUpdate({ type: 'phase', id: pid }),
          onProgress: (percent, text) => sendUpdate({ type: 'progress', percent, text }),
          onLine: (text, stream) => sendUpdate({ type: 'line', text, stream }),
        });
        if (installCanceled) return;
        sendUpdate({ type: 'progress', percent: 100, text: 'Installer downloaded' });
        const child = spawn('msiexec.exe', ['/i', dest], { detached: true, stdio: 'ignore' });
        child.unref();
        sendUpdate({ type: 'installer-launched', path: dest });
        sendUpdate({ type: 'exit', code: 0, canceled: false });
      } catch (err) {
        sendUpdate({ type: 'line', text: String(err), stream: 'err' });
        sendUpdate({ type: 'exit', code: 1, canceled: installCanceled });
      } finally {
        installRunning = false;
      }
    })();
    return { ok: true, kind: 'installer' };
  }

  const sdk = findAndroidSdk();
  if (!sdk) return { ok: false, error: 'No Android SDK found.' };
  if (!findSdkmanager(sdk)) {
    return { ok: false, error: 'sdkmanager was not found — install the Android SDK command-line tools via Android Studio first.' };
  }

  installRunning = true;
  installCanceled = false;
  void runSdkUpdate(sdk, `${id};${version}`, {
    onPhase: (pid) => sendUpdate({ type: 'phase', id: pid }),
    onProgress: (percent, text) => sendUpdate({ type: 'progress', percent, text }),
    onLine: (text, stream) => sendUpdate({ type: 'line', text, stream }),
  })
    .then((code) => sendUpdate({ type: 'exit', code, canceled: installCanceled }))
    .catch((err) => {
      sendUpdate({ type: 'line', text: String(err), stream: 'err' });
      sendUpdate({ type: 'exit', code: 1, canceled: installCanceled });
    })
    .finally(() => {
      installRunning = false;
    });
  return { ok: true, kind: 'sdk' };
});

ipcMain.handle('cancel-install', async () => {
  if (!installRunning) return { ok: false };
  installCanceled = true;
  cancelActiveInstall();
  return { ok: true };
});

// ─────────────────────────── signing-password vault ─────────────────────────
// The key alias and key/keystore passwords are stored encrypted per project
// with Chromium's safeStorage (DPAPI on Windows: only the current Windows user
// can decrypt). Reading them back asks for a Windows Hello consent prompt
// (fingerprint / PIN / face) via the UserConsentVerifier WinRT API; when Hello
// is not set up on the machine the entry still decrypts — DPAPI user isolation
// remains — and the renderer is told so it can say so.

interface VaultEntry {
  v: number;
  ts: number;
  alias?: string;
  keypass?: string;
  storepass?: string;
}
type VaultFile = Record<string, VaultEntry>;

const vaultFields = ['alias', 'keypass', 'storepass'] as const;
type VaultFieldName = (typeof vaultFields)[number];

const vaultFile = () => path.join(app.getPath('userData'), 'password-vault.json');
const vaultKeyOf = (dir: string) => String(dir || '').trim().toLowerCase();

function readVault(): VaultFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(vaultFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeVault(all: VaultFile): void {
  fs.mkdirSync(path.dirname(vaultFile()), { recursive: true });
  fs.writeFileSync(vaultFile(), JSON.stringify(all, null, 2));
}

type HelloResult = 'verified' | 'denied' | 'unavailable';

// The consent prompt lives in a PowerShell child; kept around so the
// renderer's Cancel button can dismiss a pending prompt.
let helloChild: ChildProcess | null = null;

function verifyWindowsHello(message: string): Promise<HelloResult> {
  return new Promise((resolve) => {
    // Headless test modes must never pop the OS consent dialog.
    if (IS_SMOKE || IS_E2E || process.env.AB_NO_HELLO === '1' || process.platform !== 'win32') {
      resolve('unavailable');
      return;
    }
    const script = path.join(RES_DIR, 'verify-hello.ps1');
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, message], {
        windowsHide: true,
      });
    } catch {
      resolve('unavailable');
      return;
    }
    // Tell the renderer the OS prompt is going up so it can freeze + blur
    // the whole app behind its unlock overlay until this resolves.
    if (win && !win.isDestroyed()) win.webContents.send('vault-auth', 'prompt');
    helloChild = child;
    // The consent dialog can sit on screen for a while — cap at 2 minutes.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve('denied');
    }, 120000);
    // Exit codes come from resources/verify-hello.ps1.
    child.on('exit', (code) => {
      clearTimeout(timer);
      helloChild = null;
      resolve(code === 0 ? 'verified' : code === 2 ? 'unavailable' : 'denied');
    });
    child.on('error', () => {
      clearTimeout(timer);
      helloChild = null;
      resolve('unavailable');
    });
  });
}

// Cancel button on the unlock overlay: kill the pending consent prompt; its
// exit handler settles the in-flight vault-load as a denial.
ipcMain.handle('vault-cancel-hello', () => {
  if (!helloChild) return { ok: false };
  try { helloChild.kill(); } catch { /* already gone */ }
  return { ok: true };
});

ipcMain.handle('vault-save', (_e: IpcMainInvokeEvent, projectDir: string, secrets: VaultSecrets) => {
  if (!projectDir) return { ok: false, error: 'No project.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Encryption is not available on this system.' };
  const patch: Partial<VaultEntry> = {};
  for (const field of vaultFields) {
    const val = secrets?.[field];
    if (typeof val === 'string' && val) patch[field] = safeStorage.encryptString(val).toString('base64');
  }
  if (!patch.alias && !patch.keypass && !patch.storepass) return { ok: false, error: 'Nothing to save.' };
  const all = readVault();
  const key = vaultKeyOf(projectDir);
  all[key] = { ...(all[key] || { v: 1, ts: 0 }), ...patch, v: 1, ts: Date.now() };
  writeVault(all);
  return { ok: true };
});

ipcMain.handle('vault-status', (_e: IpcMainInvokeEvent, projectDir: string) => {
  const entry = readVault()[vaultKeyOf(projectDir)];
  return { has: !!(entry && (entry.alias || entry.keypass || entry.storepass)) };
});

ipcMain.handle('vault-load', async (_e: IpcMainInvokeEvent, projectDir: string): Promise<VaultLoadResult> => {
  const entry = readVault()[vaultKeyOf(projectDir)];
  if (!entry || (!entry.alias && !entry.keypass && !entry.storepass)) return { ok: false, reason: 'empty' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'no-encryption' };

  const auth = await verifyWindowsHello('Expo Builder — unlock the saved signing credentials');
  if (auth === 'denied') return { ok: false, reason: 'denied' };

  const secrets: VaultSecrets = {};
  for (const field of vaultFields) {
    const blob = entry[field];
    if (!blob) continue;
    try {
      secrets[field] = safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }
  return { ok: true, auth, secrets };
});

ipcMain.handle('vault-forget', (_e: IpcMainInvokeEvent, projectDir: string) => {
  const all = readVault();
  delete all[vaultKeyOf(projectDir)];
  writeVault(all);
  return { ok: true };
});

ipcMain.handle('start-build', async (_e: IpcMainInvokeEvent, cfg: BuildConfig) => {
  if (buildChild) return { ok: false, error: 'A build is already running.' };
  if (installRunning) return { ok: false, error: 'A dependency update is installing — start the build after it finishes.' };

  const bashPath = resolveBash();

  // 1. Apply version bumps before anything else.
  let notes: string[] = [];
  try {
    const res = applyVersions(cfg.projectDir, { version: cfg.version, versionCode: cfg.versionCode });
    notes = res.notes;
  } catch (err) {
    return { ok: false, error: `Failed to write versions: ${err.message}` };
  }

  const scriptPath = path.join(RES_DIR, 'expo-build.sh');
  const env = {
    ...process.env,
    APP_NAME: cfg.appName,
    APP_VERSION: cfg.version,
    SIGNED: cfg.signed ? '1' : '0',
    KEY_ALIAS: cfg.keyAlias || '',
    KEY_PASSWORD: cfg.keyPassword || '',
    KEYSTORE_PASSWORD: cfg.keystorePassword || '',
    KEY_COUNTRY: cfg.countryCode || 'US',
    FORMAT: cfg.format,
    ARCHS: (cfg.archs && cfg.archs.length) ? cfg.archs.join(',') : 'arm64-v8a,armeabi-v7a,x86,x86_64',
    RELOCATE: cfg.relocate ? '1' : '0',
    RELOCATE_ROOT: '/c/ExpoBuilds',
    TARGET_SDK: cfg.targetSdk ? String(cfg.targetSdk) : '',
    DEBUG: cfg.debug ? '1' : '0',
  };

  send({
    type: 'meta',
    notes,
    bash: bashPath,
    debug: !!cfg.debug,
    // Sent so the renderer can record the build in the project's history even
    // when the build was started over raw IPC (e2e) instead of its own form.
    cfg: {
      projectDir: cfg.projectDir,
      appName: cfg.appName,
      version: cfg.version,
      versionCode: cfg.versionCode,
      format: cfg.format,
      archs: cfg.archs || [],
      signed: !!cfg.signed,
      debug: !!cfg.debug,
      targetSdk: cfg.targetSdk,
    },
  });

  let child: ChildProcess;
  try {
    child = spawn(bashPath, [scriptPath, cfg.projectDir.replace(/\\/g, '/')], {
      cwd: cfg.projectDir,
      env,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: `Failed to start bash: ${err.message}` };
  }

  buildChild = child;
  buildChild.cwdPath = cfg.projectDir;

  child.on('error', (err) => {
    send({ type: 'error', message: `Failed to run build script: ${err.message}` });
    buildChild = null;
    send({ type: 'exit', code: 1, canceled: false });
  });

  if (child.stdout && child.stderr) {
    attachStream(child.stdout, 'out');
    attachStream(child.stderr, 'err');
  }

  child.on('exit', (code) => {
    const canceled = buildChild && buildChild.__canceled;
    buildChild = null;
    send({ type: 'exit', code: code == null ? 1 : code, canceled: !!canceled });
  });

  return { ok: true };
});

ipcMain.handle('cancel-build', async () => {
  if (!buildChild) return { ok: false };
  buildChild.__canceled = true;
  killBuildTree();
  return { ok: true };
});

// ------------------------------------------------------------------ files/zip
ipcMain.handle('make-zip', async (_e: IpcMainInvokeEvent, entries: ZipEntry[]) => {
  // entries: [{ path, name }]
  const zip = new AdmZip();
  let total = 0;
  for (const entry of entries) {
    const buf = fs.readFileSync(entry.path);
    total += buf.length;
    zip.addFile(entry.name, buf);
  }
  const dir = path.join(app.getPath('temp'), 'expo-builder');
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `build-${Date.now()}.zip`);
  zip.writeZip(zipPath);
  return { ok: true, path: zipPath, size: fs.statSync(zipPath).size, uncompressed: total };
});

ipcMain.handle('save-file', async (_e: IpcMainInvokeEvent, srcPath: string, suggestedName: string) => {
  const res = await dialog.showSaveDialog(win!, {
    title: 'Save file',
    defaultPath: path.join(app.getPath('downloads'), suggestedName || path.basename(srcPath)),
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fs.promises.copyFile(srcPath, res.filePath);
  return { ok: true, path: res.filePath };
});

ipcMain.handle('reveal-path', async (_e: IpcMainInvokeEvent, p: string) => {
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('open-path', async (_e: IpcMainInvokeEvent, p: string) => {
  shell.openPath(p);
  return { ok: true };
});

// Build-history support: does an output file still exist (and how big is it now),
// and can we move a previous build's stale files to the Recycle Bin.
ipcMain.handle('stat-path', async (_e: IpcMainInvokeEvent, p: string) => {
  try {
    const s = fs.statSync(p);
    return { exists: true, size: s.size, mtime: s.mtimeMs };
  } catch {
    return { exists: false };
  }
});

// Custom window controls (the window is frameless; the renderer draws its own
// minimize/close buttons in the top bar).
ipcMain.handle('window-minimize', () => {
  if (win && !win.isDestroyed()) win.minimize();
  return { ok: true };
});

ipcMain.handle('window-close', () => {
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

ipcMain.handle('trash-path', async (_e: IpcMainInvokeEvent, p: string) => {
  try {
    await shell.trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Keystore reset (asking-mode dialog): archive the project's old signing key
// as android-key-old[-N] so the next build generates a fresh one. Nothing is
// deleted — the old .jks stays on disk under the new name.
ipcMain.handle('rename-keystore', (_e: IpcMainInvokeEvent, projectDir: string): KeyResetResult => {
  const src = path.join(projectDir, 'android-key');
  if (!fs.existsSync(src)) return { ok: false, error: 'No android-key folder was found in the project.' };
  let dest = path.join(projectDir, 'android-key-old');
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(projectDir, `android-key-old-${n}`);
  try {
    fs.renameSync(src, dest);
    return { ok: true, from: src, to: dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ------------------------------------------------------------------------ app
function createWindow(): void {
  win = new BrowserWindow({
    // Fixed geometry: no frame, no resize, no maximize/fullscreen.
    width: 1180,
    height: 800,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Transparent OS surface: the page paints its own rounded window shape
    // (--window-radius in the stylesheets), so Windows' own corner rounding
    // stays off and the frame background must be fully transparent.
    transparent: true,
    roundedCorners: false,
    backgroundColor: '#00000000',
    title: 'Expo Builder',
    // Branded window/taskbar icon instead of the stock Electron logo.
    icon: path.join(RES_DIR, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  // With a transparent surface an unpainted window is invisible — show only
  // once the first (rounded) frame exists.
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), IS_SMOKE ? { query: { demo: '1' } } : {});

  if (IS_SMOKE) runSmoke(win);
  if (IS_E2E && E2E_PROJECT) runE2E(win);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killBuildTree();
  cancelActiveInstall();
  app.quit();
});
app.on('before-quit', () => {
  killBuildTree();
  cancelActiveInstall();
});

// ------------------------------------------------------------------ smoke test
async function runSmoke(w: BrowserWindow): Promise<void> {
  const fsPromises = fs.promises;
  await fsPromises.mkdir(path.join(__dirname, '..', '.smoke'), { recursive: true });
  const errors: string[] = [];
  w.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(`console: ${message}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => {
    await sleep(450); // let animations settle
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.webContents.invalidate();
    await sleep(120); // give the compositor a frame to paint
    const img = await w.webContents.capturePage();
    await fsPromises.writeFile(path.join(__dirname, '..', '.smoke', `${name}.png`), img.toPNG());
  };
  const js = (code: string) => w.webContents.executeJavaScript(code, true);

  w.webContents.once('did-finish-load', async () => {
    try {
      await sleep(600);

      // environment gate (page 0): all-ok + missing variants
      await js(`window.__demo.envCheck()`);
      await shot('0-deps');
      await js(`window.__demo.envMissing()`);
      await shot('0b-deps-missing');
      const envRows = await js(`document.querySelectorAll('#env-list .env-row').length`);
      const envDisabled = await js(`document.querySelector('#btn-env-continue').disabled`);
      await js(`window.__demo.envCheck()`);
      const envEnabled = await js(`!document.querySelector('#btn-env-continue').disabled`);
      if (envRows < 10) errors.push(`env rows too few: ${envRows}`);
      if (!envDisabled) errors.push('Continue should be disabled while required tools are missing');
      if (!envEnabled) errors.push('Continue should enable once all required tools pass');

      // newer-release detection (page 0): chips + read-only details dialog
      const chips = await js(`document.querySelectorAll('#env-list .ver-chip').length`);
      if (chips < 4) errors.push(`version chips too few: ${chips}`);
      const updatesStatus = await js(`document.querySelector('#env-updates-status').textContent`);
      if (!/newer stable release/.test(String(updatesStatus))) errors.push(`updates status wrong: ${updatesStatus}`);
      // Open an SDK-family dialog (CMake) — Node/JDK rows show install
      // instructions instead of an sdkmanager command.
      await js(`[...document.querySelectorAll('#env-list .env-row')]
        .find((r) => r.querySelector('.env-label')?.textContent.startsWith('CMake'))
        .querySelector('.ver-chip').click()`);
      await shot('0c-deps-version');
      const dlgVisible = await js(`!document.querySelector('#dlg-version').classList.contains('hidden')`);
      const dlgCmd = await js(`document.querySelector('#dlg-version-cmd').textContent`);
      if (!dlgVisible) errors.push('version dialog did not open');
      if (!/sdkmanager "cmake;/.test(String(dlgCmd))) errors.push(`version dialog command wrong: ${dlgCmd}`);
      // "Update now" flow: progress mode → finished state (demo-shimmed)
      const updateBtn = await js(`!document.querySelector('#btn-install-update').classList.contains('hidden')`);
      if (!updateBtn) errors.push('Update now button missing');
      await js(`window.__demo.updateDialog()`);
      await shot('0d-deps-update-progress');
      const progVisible = await js(`!document.querySelector('#dlg-version-progress').classList.contains('hidden')`);
      const barW = await js(`document.querySelector('#dlg-version-bar').style.width`);
      if (!progVisible) errors.push('progress block missing');
      if (barW !== '62%') errors.push(`progress bar wrong: ${barW}`);
      await js(`window.__demo.updateDialogDone()`);
      await shot('0e-deps-update-done');
      const doneTxt = await js(`document.querySelector('#dlg-version-phase').textContent`);
      if (!/Installed/.test(String(doneTxt))) errors.push(`finish text wrong: ${doneTxt}`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);
      // installer-kind dialog (JDK) must fit the window too
      await js(`window.__demo.updateDialog('jdk')`);
      await shot('0f-deps-update-installer');
      const dlgFits = await js(`(() => { const d = document.querySelector('#dlg-version'); return d.scrollHeight <= d.clientHeight + 2; })()`);
      if (!dlgFits) errors.push('installer dialog overflows its scroll area');
      await js(`window.__demo.updateDialogDone()`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);

      await js(`window.__demo.projects()`);
      await shot('1-select');

      // build-history card + details dialog (mock data)
      await js(`window.__demo.history()`);
      await shot('1b-history');
      await js(`window.__demo.historyDetail()`);
      await shot('1c-history-detail');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);

      const checks = await js(`(() => {
        const out = [];
        out.push(['countries', window.COUNTRIES ? window.COUNTRIES.length : -1]);
        out.push(['pages', document.querySelectorAll('.page').length]);
        out.push(['fields', !document.querySelector('#field-appname') && !!document.querySelector('#field-version') && !!document.querySelector('#dlg-name')]);
        return out;
      })()`);
      const countriesCount = checks.find((c: unknown[]) => c[0] === 'countries')?.[1];
      if (!countriesCount || countriesCount < 200) errors.push(`countries list too small: ${JSON.stringify(checks)}`);
      if (checks.find((c: unknown[]) => c[0] === 'pages')[1] !== 5) errors.push(`expected 5 pages: ${JSON.stringify(checks)}`);

      // demo navigation through all pages with mock data
      await js(`window.__demo.config()`);
      await shot('2-config');

      // build-history showcase: warnings + rebuild confirmation dialog
      await js(`window.__demo.versionWarning()`);
      await shot('2b-version-warning');
      await js(`window.__demo.rebuildDialog()`);
      await shot('2c-rebuild-dialog');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);

      // Windows Hello unlock overlay: app frozen + blurred while the OS
      // prompt is up, then fading away with the values landing in place.
      await js(`window.__demo.vaultAuth()`);
      await shot('2d-vault-auth');
      const vaultShown = await js(`!document.querySelector('#vault-auth').classList.contains('hidden') && document.querySelector('#vault-auth').classList.contains('show')`);
      if (!vaultShown) errors.push('vault auth overlay did not show');
      const vaultFrozen = await js(`document.querySelector('#main').inert === true`);
      if (!vaultFrozen) errors.push('app should be frozen (inert) during vault auth');
      await js(`window.__demo.vaultAuthDone(true)`);
      // Capture the fill moment on the signing card itself: the glow animation
      // runs 1.5s, the shot settles at ~570ms — still mid-flash.
      await js(`document.querySelector('#signing-card').scrollIntoView({ block: 'center' })`);
      await shot('2e-vault-filled');
      await sleep(400);
      const vaultGone = await js(`document.querySelector('#vault-auth').classList.contains('hidden') && document.querySelector('#main').inert === false`);
      if (!vaultGone) errors.push('vault auth overlay did not fade away / unfreeze');
      const vaultGlow = await js(`document.querySelectorAll('.field.vault-filled').length`);
      if (vaultGlow < 2) errors.push('autofilled password fields should highlight');
      const vaultPass = await js(`document.querySelector('#field-keypass').value.length > 0 && document.querySelector('#field-storepass').value.length > 0`);
      if (!vaultPass) errors.push('autofilled password values missing');

      await js(`window.__demo.resetVersion()`);
      await js(`window.__demo.build()`);
      await sleep(2500);
      await shot('3-build');
      // Stopped build: the Back-to-projects button must appear and navigate back.
      const backHiddenRunning = await js(`document.querySelector('#btn-back-projects').classList.contains('hidden')`);
      if (!backHiddenRunning) errors.push('Back-to-projects button visible while the build is still running');
      await js(`window.__demo.buildStopped()`);
      await shot('3b-build-stopped');
      const backVisible = await js(`!document.querySelector('#btn-back-projects').classList.contains('hidden')`);
      if (!backVisible) errors.push('Back-to-projects button missing after the build stopped');
      await js(`document.querySelector('#btn-back-projects').click()`);
      await sleep(200);
      const backPage = await js(`document.querySelector('.page.active').id`);
      if (backPage !== 'page-select') errors.push(`Back-to-projects landed on ${backPage}, expected page-select`);

      // Keystore-reset dialog: asking mode before archiving the old key.
      await js(`window.__demo.keyResetDialog()`);
      await shot('3c-keyreset');
      const krVisible = await js(`!document.querySelector('#dlg-keyreset').classList.contains('hidden')`);
      if (!krVisible) errors.push('keyreset dialog did not open');
      const krPath = await js(`document.querySelector('#keyreset-old-path').textContent`);
      if (!/android-key\.jks$/.test(String(krPath))) errors.push(`keyreset old path wrong: ${krPath}`);
      const krBtn = await js(`document.querySelector('#btn-keyreset-confirm').textContent.trim()`);
      if (!/Archive old key & build/.test(String(krBtn))) errors.push(`keyreset confirm button wrong: ${krBtn}`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);
      const krClosed = await js(`document.querySelector('#dlg-keyreset').classList.contains('hidden')`);
      if (!krClosed) errors.push('keyreset dialog did not close on Escape');

      await js(`window.__demo.result()`);
      await shot('4-result');
      await js(`window.__demo.generator()`);
      await shot('5-generator');

      console.log('SMOKE_RESULT ' + JSON.stringify({ ok: errors.length === 0, errors }));
    } catch (err) {
      console.log('SMOKE_RESULT ' + JSON.stringify({ ok: false, errors: [String(err)] }));
    }
    app.exit(errors.length === 0 ? 0 : 1);
  });
}

// -------------------------------------------------------------------- e2e test
// Drives the REAL app over the real IPC surface against E2E_PROJECT
// (a throwaway Expo-shaped folder exercised through shimmed yarn/expo/gradle).
async function runE2E(w: BrowserWindow): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log: string[] = [];
  const say = (m: string) => { log.push(m); console.log('E2E ' + m); };
  setTimeout(() => { say('HARD-TIMEOUT'); app.exit(3); }, 120000).unref();

  const js = (code: string) => w.webContents.executeJavaScript(code, true);
  try {
    await new Promise<void>((resolve) => {
      if (w.webContents.isLoadingMainFrame()) w.webContents.once('did-finish-load', () => resolve());
      else resolve();
    });
    await sleep(1000);

    // 1. validate
    const valid = await js(`window.builder.validateProject(${JSON.stringify(E2E_PROJECT)})`);
    if (!valid.ok) throw new Error('validate failed: ' + valid.error);
    say('validate ok: ' + valid.info.name + ' ' + valid.info.version);

    // 2. build through real IPC (renderer-side listener records events)
    // E2E_KEYFAIL=1 runs with passwords that don't match the fake project's
    // keystore: the build must abort at the keystore phase and the renderer
    // must offer the archive-and-rebuild dialog.
    const keyFail = process.env.E2E_KEYFAIL === '1';
    const res = await js(`new Promise((resolve) => {
      const events = [];
      window.__e2eEvents = events;
      window.builder.onBuildEvent((e) => {
        events.push(e.type + (e.type === 'line' ? ': ' + String(e.text).slice(0, 80)
          : e.type === 'artifact' || e.type === 'keystore' ? ': ' + e.path
          : e.type === 'keyfail' ? ': ' + e.path
          : e.type === 'exit' ? ' code=' + e.code + ' canceled=' + e.canceled : ''));
      });
      window.builder.startBuild({
        projectDir: ${JSON.stringify(E2E_PROJECT)},
        appName: 'Fake App', version: '1.0.2', versionCode: 10002,
        signed: true, keyAlias: 'test.alias', keyPassword: ${keyFail ? "'wrongpass123'" : "'testpass123'"},
        keystorePassword: ${keyFail ? "'wrongstore123'" : "'storepass123'"}, countryCode: 'US',
        format: 'apk', archs: ['arm64-v8a'], relocate: false, debug: false,
        targetSdk: 33,
      }).then((r) => { if (!r.ok) { resolve({ fail: r.error }); return; }
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (events.some((e) => e.startsWith('exit')) || Date.now() - t0 > 80000) {
            clearInterval(poll); resolve({ started: true, events });
          }
        }, 400);
      });
    })`);
    if (res.fail) throw new Error('startBuild failed: ' + res.fail);
    say('events:\n  ' + res.events.join('\n  '));
    const exitEvt = res.events.find((e: string) => e.startsWith('exit'));
    if (process.env.E2E_EXPECT_FAIL === '1' || keyFail) {
      if (exitEvt && /code=0/.test(exitEvt)) throw new Error('expected failure but build succeeded');
    } else if (!exitEvt || !/code=0/.test(exitEvt)) {
      throw new Error('build did not succeed: ' + exitEvt);
    }

    if (keyFail) {
      // 3b. keystore mismatch: the archive-and-rebuild dialog, not the generic one
      await sleep(900);
      const kf = await js(`({
        keyresetVisible: !document.querySelector('#dlg-keyreset').classList.contains('hidden'),
        debugHidden: document.querySelector('#dlg-debug').classList.contains('hidden'),
        body: document.querySelector('#dlg-keyreset-text').textContent,
        oldPath: document.querySelector('#keyreset-old-path').textContent,
        confirmBtn: document.querySelector('#btn-keyreset-confirm').textContent.trim(),
      })`);
      say('keyfail-path: ' + JSON.stringify(kf));
      if (!kf.keyresetVisible) throw new Error('keystore-reset dialog did not appear');
      if (!kf.debugHidden) throw new Error('generic fail dialog should not appear on a keystore mismatch');
      if (!/android-key\\+android-key\.jks/.test(kf.oldPath) && !/android-key\/android-key\.jks/.test(kf.oldPath)) {
        throw new Error('old key path wrong: ' + kf.oldPath);
      }
      fs.mkdirSync(path.join(__dirname, '..', '.smoke'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', '.smoke', 'e2e-keyfail.png'), (await w.webContents.capturePage()).toPNG());
      // Cancel keeps everything untouched: dialog closes, folder stays.
      await js(`document.querySelector('#btn-keyreset-cancel').click()`);
      await sleep(300);
      const closed = await js(`document.querySelector('#dlg-keyreset').classList.contains('hidden')`);
      if (!closed) throw new Error('keyreset dialog did not close on Cancel');
      if (!fs.existsSync(path.join(E2E_PROJECT!, 'android-key', 'android-key.jks'))) {
        throw new Error('Cancel must leave the old keystore untouched');
      }
      say('keyfail-path: PASS (dialog shown, Cancel keeps the old key)');
    } else if (process.env.E2E_EXPECT_FAIL !== '1') {
      // 3. UI reached result page with artifacts
      await sleep(1400);
      const ui = await js(`({
        page: document.querySelector('.page.active').id,
        artifacts: [...document.querySelectorAll('.artifact-name')].map((e) => e.textContent),
        phase: document.querySelector('#phase-label').textContent,
      })`);
      say('ui: ' + JSON.stringify(ui));
      if (ui.page !== 'page-result') throw new Error('expected result page, got ' + ui.page);
      if (!ui.artifacts.some((a: string) => a.includes('Fake_App.v1.0.2.arm64-v8a.apk'))) throw new Error('artifact missing: ' + ui.artifacts);
      if (!ui.artifacts.includes('android-key.jks')) throw new Error('keystore card missing');

      // 4. versions written
      const pkg = JSON.parse(fs.readFileSync(path.join(E2E_PROJECT!, 'package.json'), 'utf8'));
      const appJson = JSON.parse(fs.readFileSync(path.join(E2E_PROJECT!, 'app.json'), 'utf8'));
      say(`versions: pkg=${pkg.version} app=${appJson.expo.version} code=${appJson.expo.android.versionCode}`);
      if (pkg.version !== '1.0.2' || appJson.expo.version !== '1.0.2' || appJson.expo.android.versionCode !== 10002) {
        throw new Error('version writes incorrect');
      }

      // 4b. targetSdk pin reached the generated gradle.properties
      const gp = fs.readFileSync(path.join(E2E_PROJECT!, 'android', 'gradle.properties'), 'utf8');
      if (!/^targetSdkVersion=33$/m.test(gp)) throw new Error('targetSdkVersion not pinned in gradle.properties');
      say('targetSdk pin written: targetSdkVersion=33');

      // 4b. build recorded in the per-project history (localStorage ab.builds)
      const hist = await js(`(JSON.parse(localStorage.getItem('ab.builds') || '{}')[${JSON.stringify(String(E2E_PROJECT).toLowerCase())}] || [])`);
      const rec = hist.find((h: { status: string; version: string }) => h && h.status === 'success' && h.version === '1.0.2');
      if (!rec) throw new Error('build not recorded in history: ' + JSON.stringify(hist).slice(0, 200));
      if (!rec.artifacts || !rec.artifacts.length || !rec.keystore) throw new Error('history record missing output files');
      say(`history recorded: v${rec.version} files=${rec.artifacts.length + 1} dur=${rec.durationMs}ms`);

      // 5. zip creation (same logic the save handler uses)
      const AdmZipTest = new AdmZip();
      const apkPath = path.join(E2E_PROJECT!, 'Fake_App.v1.0.2.arm64-v8a.apk');
      const keyPath = path.join(E2E_PROJECT!, 'android-key', 'android-key.jks');
      AdmZipTest.addFile('Fake_App.v1.0.2.arm64-v8a.apk', fs.readFileSync(apkPath));
      AdmZipTest.addFile('android-key.jks', fs.readFileSync(keyPath));
      const zipPath = path.join(app.getPath('temp'), 'expo-builder', 'e2e.zip');
      AdmZipTest.writeZip(zipPath);
      const zipEntries = new AdmZip(zipPath).getEntries().map((e) => e.entryName);
      say('zip entries: ' + zipEntries.join(', ') + ' size=' + fs.statSync(zipPath).size);
      if (zipEntries.length !== 2) throw new Error('zip should contain apk + keystore');

      await sleep(400);
      fs.mkdirSync(path.join(__dirname, '..', '.smoke'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', '.smoke', 'e2e-result.png'), (await w.webContents.capturePage()).toPNG());
    } else {
      // 6. failure path: the failed build must have opened the debug-retry dialog
      await sleep(900);
      const fail = await js(`({
        exit: ${JSON.stringify(exitEvt)},
        dialogVisible: !document.querySelector('#dlg-debug').classList.contains('hidden'),
        dialogText: document.querySelector('#dlg-debug-text').textContent,
        debugBtn: document.querySelector('#btn-fail-debug').textContent.trim(),
        phaseLabel: document.querySelector('#phase-label').textContent,
        page: document.querySelector('.page.active').id,
      })`);
      say('fail-path: ' + JSON.stringify(fail));
      if (!fail.dialogVisible) throw new Error('fail dialog did not appear');
      if (!/debug mode/.test(fail.dialogText)) throw new Error('dialog text wrong: ' + fail.dialogText);
      fs.mkdirSync(path.join(__dirname, '..', '.smoke'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '..', '.smoke', 'e2e-fail.png'), (await w.webContents.capturePage()).toPNG());
    }

    say('PASS');
  } catch (err) {
    say('FAIL ' + err.message);
  }
  app.exit(0);
}
