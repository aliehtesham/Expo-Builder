'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { validateProject, applyVersions } = require('./lib/project-info');
const { checkEnvironment, resolveBash } = require('./lib/env-check');

// When packaged, resources/** is unpacked next to app.asar because bash cannot
// read files inside Electron's virtual asar filesystem.
const RES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : path.join(__dirname, 'resources');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_E2E = process.argv.includes('--e2e');
const E2E_PROJECT = process.env.E2E_PROJECT;
let win = null;
let buildChild = null;

// ------------------------------------------------------------------- build IPC
const ANSI_RE = /\x1b\[[0-9;?=<>!]*[A-Za-z]/g;

function stripAnsi(line) {
  return line.replace(ANSI_RE, '');
}

function send(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('build-event', evt);
}

function emitLine(text, stream) {
  const clean = stripAnsi(text);
  if (!clean.trim()) return;

  if (clean.startsWith('@@PHASE ')) {
    send({ type: 'phase', id: clean.slice(8).trim() });
    return;
  }
  if (clean.startsWith('@@ARTIFACT ')) {
    const rel = clean.slice(11).trim();
    const abs = path.resolve(buildChild.cwdPath, rel);
    let size = null;
    try {
      size = fs.statSync(abs).size;
    } catch { /* moved file should exist; ignore if not */ }
    send({ type: 'artifact', path: abs, size });
    return;
  }
  if (clean.startsWith('@@KEYSTORE ')) {
    const rel = clean.slice(11).trim();
    const abs = path.resolve(buildChild.cwdPath, rel);
    let size = null;
    try {
      size = fs.statSync(abs).size;
    } catch { /* ignore */ }
    send({ type: 'keystore', path: abs, size });
    return;
  }
  if (clean === '@@DONE') {
    send({ type: 'done-marker' });
    return;
  }
  send({ type: 'line', text: clean, stream });
}

function attachStream(src, streamName) {
  let buf = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    buf += chunk;
    // Gradle likes \r-only progress repaints; treat them as line breaks too.
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop();
    for (const p of parts) emitLine(p, streamName);
  });
  src.on('end', () => {
    if (buf) emitLine(buf, streamName);
    buf = '';
  });
}

function killBuildTree() {
  if (!buildChild) return;
  try {
    // bash spawns gradle/java children; taskkill /T takes the whole tree.
    execSync(`taskkill /PID ${buildChild.pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { buildChild.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select your Expo project folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('validate-project', async (_e, dir) => validateProject(dir));

// Pre-flight gate: detect every tool the build pipeline needs. Runs fresh on
// every call (a few `--version` probes) so a newly installed SDK is picked up
// without restarting the app.
ipcMain.handle('check-environment', async () => checkEnvironment({ bashPath: resolveBash() }));

ipcMain.handle('start-build', async (_e, cfg) => {
  if (buildChild) return { ok: false, error: 'A build is already running.' };

  const bashPath = resolveBash();

  // 1. Apply version bumps before anything else.
  let notes = [];
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
    },
  });

  let child;
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

  attachStream(child.stdout, 'out');
  attachStream(child.stderr, 'err');

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
ipcMain.handle('make-zip', async (_e, entries) => {
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

ipcMain.handle('save-file', async (_e, srcPath, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save file',
    defaultPath: path.join(app.getPath('downloads'), suggestedName || path.basename(srcPath)),
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fs.promises.copyFile(srcPath, res.filePath);
  return { ok: true, path: res.filePath };
});

ipcMain.handle('reveal-path', async (_e, p) => {
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('open-path', async (_e, p) => {
  shell.openPath(p);
  return { ok: true };
});

// Build-history support: does an output file still exist (and how big is it now),
// and can we move a previous build's stale files to the Recycle Bin.
ipcMain.handle('stat-path', async (_e, p) => {
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

ipcMain.handle('trash-path', async (_e, p) => {
  try {
    await shell.trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ------------------------------------------------------------------------ app
function createWindow() {
  win = new BrowserWindow({
    // Fixed geometry: no frame, no resize, no maximize/fullscreen.
    width: 1180,
    height: 800,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0d17',
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), IS_SMOKE ? { query: { demo: '1' } } : {});

  if (IS_SMOKE) runSmoke(win);
  if (IS_E2E && E2E_PROJECT) runE2E(win);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killBuildTree();
  app.quit();
});
app.on('before-quit', killBuildTree);

// ------------------------------------------------------------------ smoke test
async function runSmoke(w) {
  const fsPromises = fs.promises;
  await fsPromises.mkdir(path.join(__dirname, '.smoke'), { recursive: true });
  const errors = [];
  w.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(`console: ${message}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => errors.push(`renderer gone: ${details.reason}`));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    await sleep(450); // let animations settle
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.webContents.invalidate();
    await sleep(120); // give the compositor a frame to paint
    const img = await w.webContents.capturePage();
    await fsPromises.writeFile(path.join(__dirname, '.smoke', `${name}.png`), img.toPNG());
  };
  const js = (code) => w.webContents.executeJavaScript(code, true);

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
      if (!checks.find((c) => c[0] === 'countries')?.[1] || checks.find((c) => c[0] === 'countries')[1] < 200)
        errors.push(`countries list too small: ${JSON.stringify(checks)}`);
      if (checks.find((c) => c[0] === 'pages')[1] !== 5) errors.push(`expected 5 pages: ${JSON.stringify(checks)}`);

      // demo navigation through all pages with mock data
      await js(`window.__demo.config()`);
      await shot('2-config');

      // build-history showcase: warnings + rebuild confirmation dialog
      await js(`window.__demo.versionWarning()`);
      await shot('2b-version-warning');
      await js(`window.__demo.rebuildDialog()`);
      await shot('2c-rebuild-dialog');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await js(`window.__demo.resetVersion()`);
      await js(`window.__demo.build()`);
      await sleep(2500);
      await shot('3-build');
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
async function runE2E(w) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const say = (m) => { log.push(m); console.log('E2E ' + m); };
  setTimeout(() => { say('HARD-TIMEOUT'); app.exit(3); }, 120000).unref();

  const js = (code) => w.webContents.executeJavaScript(code, true);
  try {
    await new Promise((resolve) => {
      if (w.webContents.isLoadingMainFrame()) w.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    await sleep(1000);

    // 1. validate
    const valid = await js(`window.builder.validateProject(${JSON.stringify(E2E_PROJECT)})`);
    if (!valid.ok) throw new Error('validate failed: ' + valid.error);
    say('validate ok: ' + valid.info.name + ' ' + valid.info.version);

    // 2. build through real IPC (renderer-side listener records events)
    const res = await js(`new Promise((resolve) => {
      const events = [];
      window.__e2eEvents = events;
      window.builder.onBuildEvent((e) => {
        events.push(e.type + (e.type === 'line' ? ': ' + String(e.text).slice(0, 80)
          : e.type === 'artifact' || e.type === 'keystore' ? ': ' + e.path
          : e.type === 'exit' ? ' code=' + e.code + ' canceled=' + e.canceled : ''));
      });
      window.builder.startBuild({
        projectDir: ${JSON.stringify(E2E_PROJECT)},
        appName: 'Fake App', version: '1.0.2', versionCode: 10002,
        signed: true, keyAlias: 'test.alias', keyPassword: 'testpass123',
        keystorePassword: 'storepass123', countryCode: 'US',
        format: 'apk', archs: ['arm64-v8a'], relocate: false, debug: false,
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
    const exitEvt = res.events.find((e) => e.startsWith('exit'));
    if (process.env.E2E_EXPECT_FAIL === '1') {
      if (exitEvt && /code=0/.test(exitEvt)) throw new Error('expected failure but build succeeded');
    } else if (!exitEvt || !/code=0/.test(exitEvt)) {
      throw new Error('build did not succeed: ' + exitEvt);
    }

    if (process.env.E2E_EXPECT_FAIL !== '1') {
      // 3. UI reached result page with artifacts
      await sleep(1400);
      const ui = await js(`({
        page: document.querySelector('.page.active').id,
        artifacts: [...document.querySelectorAll('.artifact-name')].map((e) => e.textContent),
        phase: document.querySelector('#phase-label').textContent,
      })`);
      say('ui: ' + JSON.stringify(ui));
      if (ui.page !== 'page-result') throw new Error('expected result page, got ' + ui.page);
      if (!ui.artifacts.some((a) => a.includes('Fake_App.v1.0.2.arm64-v8a.apk'))) throw new Error('artifact missing: ' + ui.artifacts);
      if (!ui.artifacts.includes('android-key.jks')) throw new Error('keystore card missing');

      // 4. versions written
      const pkg = JSON.parse(fs.readFileSync(path.join(E2E_PROJECT, 'package.json'), 'utf8'));
      const appJson = JSON.parse(fs.readFileSync(path.join(E2E_PROJECT, 'app.json'), 'utf8'));
      say(`versions: pkg=${pkg.version} app=${appJson.expo.version} code=${appJson.expo.android.versionCode}`);
      if (pkg.version !== '1.0.2' || appJson.expo.version !== '1.0.2' || appJson.expo.android.versionCode !== 10002) {
        throw new Error('version writes incorrect');
      }

      // 4b. build recorded in the per-project history (localStorage ab.builds)
      const hist = await js(`(JSON.parse(localStorage.getItem('ab.builds') || '{}')[${JSON.stringify(String(E2E_PROJECT).toLowerCase())}] || [])`);
      const rec = hist.find((h) => h && h.status === 'success' && h.version === '1.0.2');
      if (!rec) throw new Error('build not recorded in history: ' + JSON.stringify(hist).slice(0, 200));
      if (!rec.artifacts || !rec.artifacts.length || !rec.keystore) throw new Error('history record missing output files');
      say(`history recorded: v${rec.version} files=${rec.artifacts.length + 1} dur=${rec.durationMs}ms`);

      // 5. zip creation (same logic the save handler uses)
      const AdmZipTest = new AdmZip();
      const apkPath = path.join(E2E_PROJECT, 'Fake_App.v1.0.2.arm64-v8a.apk');
      const keyPath = path.join(E2E_PROJECT, 'android-key', 'android-key.jks');
      AdmZipTest.addFile('Fake_App.v1.0.2.arm64-v8a.apk', fs.readFileSync(apkPath));
      AdmZipTest.addFile('android-key.jks', fs.readFileSync(keyPath));
      const zipPath = path.join(app.getPath('temp'), 'expo-builder', 'e2e.zip');
      AdmZipTest.writeZip(zipPath);
      const zipEntries = new AdmZip(zipPath).getEntries().map((e) => e.entryName);
      say('zip entries: ' + zipEntries.join(', ') + ' size=' + fs.statSync(zipPath).size);
      if (zipEntries.length !== 2) throw new Error('zip should contain apk + keystore');

      await sleep(400);
      fs.mkdirSync(path.join(__dirname, '.smoke'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '.smoke', 'e2e-result.png'), (await w.webContents.capturePage()).toPNG());
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
      fs.mkdirSync(path.join(__dirname, '.smoke'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '.smoke', 'e2e-fail.png'), (await w.webContents.capturePage()).toPNG());
    }

    say('PASS');
  } catch (err) {
    say('FAIL ' + err.message);
  }
  app.exit(0);
}
