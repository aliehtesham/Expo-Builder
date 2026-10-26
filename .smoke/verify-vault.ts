// Verifies the encrypted signing-credentials vault end to end in the real app:
// save (safeStorage/DPAPI) of the key alias + passwords, status, load
// round-trip (Windows Hello is skipped via AB_NO_HELLO=1 — run this test with
// that set), partial-update merge, the on-disk file holding no plaintext,
// and forget.
// Runs with an isolated userData dir so it never touches the real vault.
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const FAKE = 'F:/Android Builder/.smoke/fake-project';
const out: string[] = [];
const say = (m: string) => { out.push(m); console.log('VERIFY ' + m); };
setTimeout(() => { console.log('VERIFY HARD-TIMEOUT'); app.exit(3); }, 60000).unref();

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-vault-'));
app.setPath('userData', tmpUserData);
require('../out/main.js'); // registers the real IPC handlers and creates its window

app.whenReady().then(async () => {
  let okAll = true;
  const ok = (cond: boolean, msg: string) => {
    if (!cond) { okAll = false; say('FAIL ' + msg); } else say('PASS ' + msg);
  };
  try {
    let w: BrowserWindow | null = null;
    for (let i = 0; i < 40 && !w; i++) {
      await new Promise<void>((r) => setTimeout(r, 250));
      w = BrowserWindow.getAllWindows()[0] || null;
    }
    if (!w) throw new Error('main.js window never appeared');
    const win = w;
    await new Promise<void>((r) => setTimeout(r, 1200));
    const js = (code: string) => win.webContents.executeJavaScript(code, true);

    // 1. Empty vault.
    const empty = await js(`window.builder.secretStatus(${JSON.stringify(FAKE)})`);
    ok(empty && empty.has === false, 'vault starts empty');
    const none = await js(`window.builder.loadSecrets(${JSON.stringify(FAKE)})`);
    ok(none && none.ok === false && none.reason === 'empty', 'load on an empty vault reports "empty"');
    const noCancel = await js(`window.builder.cancelVaultAuth()`);
    ok(noCancel && noCancel.ok === false, 'cancelVaultAuth with no pending prompt is a no-op');

    // 2. Save + status + decrypt round-trip (alias travels with the passwords).
    const saved = await js(`window.builder.saveSecrets(${JSON.stringify(FAKE)}, { alias: 'my.app.release', keypass: 'kp-secret-1', storepass: 'sp-secret-1' })`);
    ok(saved && saved.ok === true, 'saveSecrets ok');
    const st = await js(`window.builder.secretStatus(${JSON.stringify(FAKE)})`);
    ok(st && st.has === true, 'status reports the saved entry');
    const loaded = await js(`window.builder.loadSecrets(${JSON.stringify(FAKE)})`);
    ok(!!loaded && loaded.ok === true && loaded.secrets.alias === 'my.app.release' && loaded.secrets.keypass === 'kp-secret-1' && loaded.secrets.storepass === 'sp-secret-1',
      `round-trip decrypts (auth=${loaded && loaded.ok ? loaded.auth : loaded && loaded.reason})`);

    // 3. Partial update merges — the untouched fields must survive.
    const upd = await js(`window.builder.saveSecrets(${JSON.stringify(FAKE)}, { keypass: 'kp-secret-2' })`);
    ok(upd && upd.ok === true, 'partial save ok');
    const loaded2 = await js(`window.builder.loadSecrets(${JSON.stringify(FAKE)})`);
    ok(!!loaded2 && loaded2.ok === true && loaded2.secrets.keypass === 'kp-secret-2' && loaded2.secrets.storepass === 'sp-secret-1' && loaded2.secrets.alias === 'my.app.release',
      'partial update keeps the other password and the alias');

    // 4. The on-disk vault file must hold no plaintext — only base64 blobs.
    const vaultPath = path.join(tmpUserData, 'password-vault.json');
    const raw = fs.readFileSync(vaultPath, 'utf8');
    ok(!raw.includes('kp-secret-2') && !raw.includes('sp-secret-1') && !raw.includes('my.app.release'), 'vault file contains no plaintext');
    ok(raw.includes('keypass') && raw.includes('alias'), 'vault file contains the encrypted blobs');

    // 5. Forget clears the entry.
    const forgot = await js(`window.builder.forgetSecrets(${JSON.stringify(FAKE)})`);
    ok(forgot && forgot.ok === true, 'forgetSecrets ok');
    const gone = await js(`window.builder.secretStatus(${JSON.stringify(FAKE)})`);
    ok(gone && gone.has === false, 'forget clears the entry');
    const relNone = await js(`window.builder.loadSecrets(${JSON.stringify(FAKE)})`);
    ok(relNone && relNone.ok === false && relNone.reason === 'empty', 'load after forget reports "empty"');

    // 6. Keystore archive (rename): android-key → android-key-old, with
    // numbered collisions and a missing-folder error. Nothing is deleted.
    // Runs on a throwaway folder so the fake project's tracked keystore,
    // which the e2e signs with, is never touched.
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-keyreset-'));
    const keyDir = path.join(tmpProj, 'android-key');
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, 'android-key.jks'), 'fake-jks-bytes');
    const rn1 = await js(`window.builder.renameKeystore(${JSON.stringify(tmpProj)})`);
    ok(rn1 && rn1.ok === true && rn1.to.endsWith('android-key-old'), 'rename archives to android-key-old');
    ok(fs.existsSync(path.join(tmpProj, 'android-key-old', 'android-key.jks')), 'archived key file survived');
    ok(!fs.existsSync(keyDir), 'original folder is gone after rename');
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, 'android-key.jks'), 'fake-jks-bytes-2');
    const rn2 = await js(`window.builder.renameKeystore(${JSON.stringify(tmpProj)})`);
    ok(rn2 && rn2.ok === true && rn2.to.endsWith('android-key-old-2'), 'second rename picks android-key-old-2');
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, 'android-key.jks'), 'fake-jks-bytes-3');
    const rn3 = await js(`window.builder.renameKeystore(${JSON.stringify(tmpProj)})`);
    ok(rn3 && rn3.ok === true && rn2.ok && rn3.to.endsWith('android-key-old-3'), 'third rename picks android-key-old-3');
    const rn4 = await js(`window.builder.renameKeystore(${JSON.stringify(tmpProj)})`);
    ok(rn4 && rn4.ok === false && /No android-key folder/.test(rn4.error), 'rename without the folder reports an error');
    fs.rmSync(tmpProj, { recursive: true, force: true });
  } catch (err) {
    say('FAIL ' + (err as Error).message);
    okAll = false;
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(okAll ? 0 : 1);
});
