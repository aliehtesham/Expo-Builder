import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const PROJ = 'F:/Android Builder/.smoke/fake-project';
const LOG = path.join(process.cwd(), '.smoke', 'e2e.log');
const say = (m: string) => { fs.appendFileSync(LOG, m + '\n'); console.log(m); };
setTimeout(() => { say('HARD-EXIT timeout'); app.exit(3); }, 120000).unref();
app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const w = new BrowserWindow({ show: true, width: 1180, height: 800, webPreferences: { preload: path.join(process.cwd(), 'out', 'preload.js'), contextIsolation: true } });
  try {
    await w.loadFile(path.join(process.cwd(), 'renderer/index.html'));
    say('loaded');
    await new Promise<void>((r) => setTimeout(r, 1000));
    const res = await Promise.race([
      w.webContents.executeJavaScript(`
        new Promise(resolve => {
          const events = [];
          const out = {events};
          window.builder.onBuildEvent(e => {
            events.push(e.type + (e.type==='line' ? ': '+String(e.text).slice(0,70) : e.type==='artifact' ? ': '+e.path : e.type==='exit' ? ' code='+e.code+' canceled='+e.canceled : ''));
          });
          window.builder.validateProject(${JSON.stringify(PROJ)}).then(v => {
            out.validated = v.ok;
            if (!v.ok) { out.fail = 'validate: ' + v.error; resolve(out); return; }
            window.builder.startBuild({
              projectDir: ${JSON.stringify(PROJ)},
              appName: 'Fake App', version: '1.0.2', versionCode: 10002,
              signed: true, keyAlias: 'test.alias', keyPassword: 'testpass123',
              keystorePassword: 'storepass123', countryCode: 'US',
              format: 'apk', archs: ['arm64-v8a'], relocate: false, debug: false
            }).then(started => {
              out.started = started;
              if (!started.ok) { resolve(out); return; }
              const t0 = Date.now();
              const poll = setInterval(() => {
                if (events.some(e => e.startsWith('exit')) || Date.now()-t0 > 60000) {
                  clearInterval(poll); resolve(out);
                }
              }, 500);
            }).catch(err => { out.fail = 'startBuild reject: ' + err; resolve(out); });
          }).catch(err => { out.fail = 'validate reject: ' + err; resolve(out); });
        })
      `, true),
      new Promise((r) => setTimeout(() => r({ fail: 'executeJavaScript timeout 100s' }), 100000)),
    ]);
    say('E2E ' + JSON.stringify(res, null, 1));
    await new Promise<void>((r) => setTimeout(r, 1500));
    fs.writeFileSync(path.join(process.cwd(), '.smoke', 'e2e-result.png'), (await w.webContents.capturePage()).toPNG());
    const check = await w.webContents.executeJavaScript(`({
      page: document.querySelector('.page.active').id,
      artifacts: [...document.querySelectorAll('.artifact-name')].map(e => e.textContent),
      phase: document.querySelector('#phase-label').textContent
    })`, true);
    say('UI ' + JSON.stringify(check));
    // verify versions written by the app
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8'));
    const appJson = JSON.parse(fs.readFileSync(path.join(PROJ, 'app.json'), 'utf8'));
    say('VERSIONS pkg=' + pkg.version + ' app=' + appJson.expo.version + ' code=' + appJson.expo.android.versionCode);
  } catch (e) { say('E2E-FAIL ' + e.message); }
  app.exit(0);
});
