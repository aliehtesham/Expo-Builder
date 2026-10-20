// Verifies the per-project build-version history in the REAL app:
//   - history card on the project page (renders when the project opens)
//   - build details dialog (files + settings, missing-file detection)
//   - version field prefilled from app.json
//   - live warnings: already-built version / lower-than-last-build version
//   - rebuild confirmation dialog (old-file list, cancel keeps you on the form)
//   - stat-path / trash-path IPC, clear-history button
// Requires the REAL main.js IPC surface; runs with an isolated userData dir so
// it never touches the real saved projects or build history.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAKE = 'F:/Android Builder/.smoke/fake-project';
const out = [];
const say = (m) => { out.push(m); console.log('VERIFY ' + m); };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
setTimeout(() => { console.log('VERIFY HARD-TIMEOUT'); app.exit(3); }, 90000).unref();

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-history-'));
app.setPath('userData', tmpUserData);
require('../main.js');

const D = 86400000;
const now = Date.now();
const tmpFiles = [
  path.join(tmpUserData, 'Fake_App.v1.0.2.arm64-v8a.apk'),
  path.join(tmpUserData, 'Fake_App.v1.0.2.armeabi-v7a.apk'),
];
const KEY = FAKE.toLowerCase();
const seedBuilds = {
  [KEY]: [
    { id: 'b2', ts: now - 2 * 3600000, durationMs: 252000, status: 'failed', appName: 'Fake App',
      version: '1.0.3', versionCode: 10003, format: 'apk', archs: ['arm64-v8a'], signed: true, debug: false,
      artifacts: [], keystore: null },
    { id: 'b1', ts: now - 2 * D, durationMs: 432000, status: 'success', appName: 'Fake App',
      version: '1.0.2', versionCode: 10002, format: 'apk', archs: ['arm64-v8a', 'armeabi-v7a'], signed: true, debug: false,
      artifacts: [{ path: tmpFiles[0], size: 12345678 }, { path: tmpFiles[1], size: 9876543 }],
      keystore: { path: path.join(tmpUserData, 'no-such-key.jks'), size: 2070 } },
  ],
};
const seedProjects = [{ dir: FAKE, name: 'Fake App', ts: now }];

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(tmpFiles[0], 'apk-bytes-a');
    fs.writeFileSync(tmpFiles[1], 'apk-bytes-b');
    const appJson = JSON.parse(fs.readFileSync(path.join(FAKE, 'app.json'), 'utf8'));
    const appJsonVersion = appJson.expo.version; // version field must default to this

    let w = null;
    for (let i = 0; i < 40 && !w; i++) {
      await new Promise((r) => setTimeout(r, 250));
      w = BrowserWindow.getAllWindows()[0] || null;
    }
    if (!w) throw new Error('main.js window never appeared');
    await new Promise((r) => setTimeout(r, 900));
    const js = (code) => w.webContents.executeJavaScript(code, true);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name) => {
      if (w.isMinimized()) w.restore();
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(process.cwd(), '.smoke', `verify-history-${name}.png`), img.toPNG());
    };

    // 1. Seed the saved list + build history, reload so page 1 renders them.
    await js(
      `localStorage.setItem('ab.builds', ${JSON.stringify(JSON.stringify(seedBuilds))});` +
      `localStorage.setItem('ab.projects', ${JSON.stringify(JSON.stringify(seedProjects))}); true`
    );
    await new Promise((resolve) => {
      w.webContents.once('did-finish-load', () => setTimeout(resolve, 700));
      w.webContents.reload();
    });

    // The app reopens on the environment gate — pass it like a user would.
    for (let i = 0; i < 60; i++) {
      const ready = await js(`!document.querySelector('#btn-env-continue').disabled`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await js(`document.querySelector('#btn-env-continue').click()`);
    await new Promise((r) => setTimeout(r, 300));

    const listHint = await js(`[...document.querySelectorAll('.project-row-text small')].map((e) => e.textContent)`);
    say('list hints: ' + JSON.stringify(listHint));
    ok(/2 builds · latest v1\.0\.3/.test(listHint[1] || ''), 'project row missing build hint');

    // 2. Open the project -> project card + history card with 2 rows.
    await js(`document.querySelector('.project-row-main').click()`);
    await sleep(900);
    const opened = await js(`({
      card: !document.querySelector('#project-card').classList.contains('hidden'),
      history: !document.querySelector('#history-card').classList.contains('hidden'),
      count: document.querySelector('#history-count').textContent,
      rows: [...document.querySelectorAll('.history-row .history-version')].map((e) => e.textContent),
      lastBuildMeta: [...document.querySelectorAll('#project-meta dt')].map((e) => e.textContent),
    })`);
    say('opened: ' + JSON.stringify(opened));
    ok(opened.card && opened.history, 'history card not shown with the project');
    ok(opened.count === '2 builds', 'history count wrong: ' + opened.count);
    ok(JSON.stringify(opened.rows) === JSON.stringify(['v1.0.3', 'v1.0.2']), 'history rows wrong: ' + JSON.stringify(opened.rows));
    ok(opened.lastBuildMeta.includes('Last build'), 'project meta missing Last build row');
    await shot('1-project-history');

    // 3. Details dialog: failed build first (no files), then success build.
    await js(`document.querySelectorAll('.history-row')[0].click()`);
    await sleep(400);
    let dlg = await js(`({
      visible: !document.querySelector('#dlg-history').classList.contains('hidden'),
      title: document.querySelector('#dlg-history-title').textContent,
      sub: document.querySelector('#dlg-history-sub').textContent,
      dts: [...document.querySelectorAll('#history-meta dt')].map((e) => e.textContent),
      filesNote: document.querySelector('#history-files').textContent,
    })`);
    say('failed-build dialog: ' + JSON.stringify(dlg));
    ok(dlg.visible && dlg.title === 'Fake App v1.0.3', 'failed-build dialog wrong: ' + dlg.title);
    ok(/did not finish/.test(dlg.filesNote), 'failed build should have no files');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(250);

    await js(`document.querySelectorAll('.history-row')[1].click()`);
    await sleep(900); // give the async existence checks time to run
    dlg = await js(`({
      visible: !document.querySelector('#dlg-history').classList.contains('hidden'),
      title: document.querySelector('#dlg-history-title').textContent,
      dds: [...document.querySelectorAll('#history-meta dd')].map((e) => e.textContent),
      fileRows: [...document.querySelectorAll('#history-files .artifact')].length,
      missing: [...document.querySelectorAll('#history-files .artifact.missing .artifact-name')].map((e) => e.textContent),
    })`);
    say('success-build dialog: ' + JSON.stringify(dlg));
    ok(dlg.visible && dlg.title === 'Fake App v1.0.2', 'success dialog wrong: ' + dlg.title);
    ok(dlg.fileRows === 3, 'expected 3 file rows (2 apk + keystore), got ' + dlg.fileRows);
    ok(dlg.missing.length === 1 && /no-such-key/.test(dlg.missing[0]), 'missing-file detection wrong: ' + JSON.stringify(dlg.missing));
    await shot('2-history-detail');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(250);

    // 4. stat-path / trash-path IPC on real temp files.
    const st = await js(`window.builder.statPath(${JSON.stringify(tmpFiles[0])})`);
    ok(st && st.exists && st.size === 11, 'statPath wrong: ' + JSON.stringify(st));
    const stGone = await js(`window.builder.statPath(${JSON.stringify(path.join(tmpUserData, 'never-existed.bin'))})`);
    ok(stGone && stGone.exists === false, 'statPath should report missing: ' + JSON.stringify(stGone));
    const tr = await js(`window.builder.trashPath(${JSON.stringify(tmpFiles[1])})`);
    ok(tr && tr.ok, 'trashPath failed: ' + JSON.stringify(tr));
    ok(!fs.existsSync(tmpFiles[1]), 'file still on disk after trashPath');
    say('ipc: stat ok, trash ok (recycle bin)');

    // 5. Configure page: version defaults from app.json + live warnings.
    await js(`document.querySelector('#btn-continue').click()`);
    await sleep(400);
    const prefill = await js(`document.querySelector('#field-version').value`);
    ok(prefill === appJsonVersion, `version field should default to app.json (${appJsonVersion}), got ${prefill}`);

    const setVersion = (v) => js(`(() => {
      const i = document.querySelector('#field-version');
      i.value = ${JSON.stringify(v)};
      i.dispatchEvent(new Event('input'));
      return true;
    })()`);
    const warnState = () => js(`({
      visible: !document.querySelector('#version-warn').classList.contains('hidden'),
      text: document.querySelector('#version-warn-list').textContent,
    })`);

    let wst = await warnState(); // app.json version (1.0.2) was built before
    say('warn@prefill: ' + JSON.stringify(wst));
    ok(wst.visible && /already built/.test(wst.text), 'already-built warning missing at prefill');

    await setVersion('1.0.1');
    wst = await warnState();
    say('warn@1.0.1: ' + JSON.stringify(wst));
    ok(wst.visible && /lower than the last built version v1\.0\.2/.test(wst.text), 'lower-version warning missing');
    ok(!/already built/.test(wst.text), '1.0.1 was never built — already-built warning should be absent');

    await setVersion('9.9.9');
    wst = await warnState();
    ok(!wst.visible, 'no warnings expected for a fresh higher version');
    say('warnings ok');
    await setVersion('1.0.1');
    await shot('3-version-warning');

    // 6. Submit with an already-built version -> rebuild confirmation dialog.
    await setVersion('1.0.2');
    await js(`(() => {
      document.querySelector('#field-alias').value = 'fake.release';
      document.querySelector('#field-keypass').value = 'testpass123';
      document.querySelector('#field-storepass').value = 'storepass123';
      document.querySelector('#btn-build').click();
      return true;
    })()`);
    await sleep(900); // dialog opens after async stat-path checks
    const reb = await js(`({
      visible: !document.querySelector('#dlg-rebuild').classList.contains('hidden'),
      title: document.querySelector('#dlg-rebuild-title').textContent,
      text: document.querySelector('#dlg-rebuild-text').textContent,
      files: [...document.querySelectorAll('#rebuild-file, .rebuild-file')].map((e) => e.textContent),
      deleteBtn: !document.querySelector('#btn-rebuild-delete').classList.contains('hidden'),
    })`);
    say('rebuild dialog: ' + JSON.stringify(reb));
    ok(reb.visible && reb.title === 'Rebuild v1.0.2?', 'rebuild dialog wrong: ' + reb.title);
    ok(/replaces the previous build's output files/.test(reb.text), 'rebuild dialog text wrong');
    ok(reb.files.length === 2, 'expected 2 old files listed, got ' + reb.files.length);
    ok(reb.files.some((f) => /already gone/.test(f)), 'trashed file should be listed as already gone');
    ok(reb.deleteBtn, 'delete button hidden while one old file still exists');
    await shot('4-rebuild-dialog');

    // Cancel must NOT start a build (we'd hit real gradle here).
    await js(`document.querySelector('#btn-rebuild-cancel').click()`);
    await sleep(400);
    const after = await js(`({
      gone: document.querySelector('#dlg-rebuild').classList.contains('hidden'),
      page: document.querySelector('.page.active').id,
      scrim: document.querySelector('#scrim').classList.contains('hidden'),
    })`);
    say('after cancel: ' + JSON.stringify(after));
    ok(after.gone && after.scrim && after.page === 'page-config', 'cancel should close the dialog and stay on the form');

    // 7. Clear history from the project page.
    await js(`document.querySelector('#btn-back-select').click()`);
    await sleep(300);
    await js(`document.querySelector('#history-clear').click()`);
    await sleep(300);
    const cleared = await js(`({
      note: document.querySelector('#history-list').textContent,
      count: document.querySelector('#history-count').textContent,
      stored: JSON.parse(localStorage.getItem('ab.builds') || '{}')[${JSON.stringify(KEY)}],
    })`);
    say('cleared: ' + JSON.stringify(cleared));
    ok(/None yet/.test(cleared.note) && cleared.count === 'no builds yet', 'history not cleared in UI');
    ok(Array.isArray(cleared.stored) && cleared.stored.length === 0, 'history not cleared in storage');

    say('PASS');
  } catch (err) {
    say('FAIL ' + err.message);
    out.push('FAIL');
  }
  app.exit(out[out.length - 1] === 'PASS' ? 0 : 1);
});
