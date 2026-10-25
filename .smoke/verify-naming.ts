// Verifies the pick -> name dialog -> project card -> config flow in the real app,
// plus the saved-projects list (persist, reopen, remove).
// Requires the REAL main.js IPC surface; only the native folder picker is stubbed
// (main-process dialog.showOpenDialog) to return the fake Expo project.
// Runs with an isolated userData dir so it never touches the real saved list.
import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const FAKE = 'F:/Android Builder/.smoke/fake-project';
const NAME = 'My Renamed Project';
const out: string[] = [];
const say = (m: string) => { out.push(m); console.log('VERIFY ' + m); };
setTimeout(() => { console.log('VERIFY HARD-TIMEOUT'); app.exit(3); }, 60000).unref();

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-verify-'));
app.setPath('userData', tmpUserData);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [FAKE] });
require('../out/main.js'); // registers the real IPC handlers and creates its window

app.whenReady().then(async () => {
  try {
    let w: BrowserWindow | null = null;
    for (let i = 0; i < 40 && !w; i++) {
      await new Promise<void>((r) => setTimeout(r, 250));
      w = BrowserWindow.getAllWindows()[0] || null;
    }
    if (!w) throw new Error('main.js window never appeared');
    const win = w;
    await new Promise<void>((r) => setTimeout(r, 1000));
    const js = (code: string) => win.webContents.executeJavaScript(code, true);
    const reload = () => new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => setTimeout(resolve, 700));
      win.webContents.reload();
    });

    // The app opens on the environment gate — pass it like a user would
    // (wait for the real dependency checks to finish, then Continue).
    const passGate = async () => {
      for (let i = 0; i < 60; i++) {
        const ready = await js(`!document.querySelector('#btn-env-continue').disabled`);
        if (ready) break;
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      await js(`document.querySelector('#btn-env-continue').click()`);
      await new Promise<void>((r) => setTimeout(r, 300));
    };
    await passGate();

    // 1. Click "New Project" (picker is stubbed) -> name dialog appears
    await js(`document.querySelector('#btn-pick').click()`);
    await new Promise<void>((r) => setTimeout(r, 1500));

    const dlg = await js(`({
      visible: !document.querySelector('#dlg-name').classList.contains('hidden'),
      prefill: document.querySelector('#field-projectname').value,
      dir: document.querySelector('#dlg-name-dir').textContent,
      cardHidden: document.querySelector('#project-card').classList.contains('hidden'),
    })`);
    say('dialog: ' + JSON.stringify(dlg));
    if (!dlg.visible) throw new Error('name dialog did not appear');
    if (dlg.prefill !== 'Fake App') throw new Error('prefill wrong: ' + dlg.prefill);
    if (!dlg.cardHidden) throw new Error('project card shown before naming');
    fs.writeFileSync(path.join(process.cwd(), '.smoke', 'verify-naming-0.png'), (await win.webContents.capturePage()).toPNG());

    // 2. Empty name must be rejected
    await js(`(() => {
      const i = document.querySelector('#field-projectname');
      i.value = '';
      document.querySelector('#btn-name-ok').click();
    })()`);
    const emptyErr = await js(`({
      invalid: document.querySelector('#wrap-name').classList.contains('invalid'),
      err: document.querySelector('#err-projectname').textContent,
      stillVisible: !document.querySelector('#dlg-name').classList.contains('hidden'),
    })`);
    say('empty-name: ' + JSON.stringify(emptyErr));
    if (!emptyErr.invalid || !emptyErr.stillVisible) throw new Error('empty name was accepted');

    // 3. Escape cancels and returns to the picker state
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await new Promise<void>((r) => setTimeout(r, 300));
    const esc = await js(`({
      dialogGone: document.querySelector('#dlg-name').classList.contains('hidden'),
      cardHidden: document.querySelector('#project-card').classList.contains('hidden'),
      selectShown: !document.querySelector('#select-card').classList.contains('hidden'),
    })`);
    say('escape: ' + JSON.stringify(esc));
    if (!esc.dialogGone || !esc.cardHidden || !esc.selectShown) throw new Error('Escape did not reset the picker state');

    // 4. Pick again, type a custom name, confirm -> project defined, saved to the list
    await js(`document.querySelector('#btn-pick').click()`);
    await new Promise<void>((r) => setTimeout(r, 1200));
    await js(`(() => {
      const i = document.querySelector('#field-projectname');
      i.value = ${JSON.stringify(NAME)};
      i.dispatchEvent(new Event('input'));
      document.querySelector('#btn-name-ok').click();
    })()`);
    await new Promise<void>((r) => setTimeout(r, 400));
    const card = await js(`({
      dialogGone: document.querySelector('#dlg-name').classList.contains('hidden'),
      title: document.querySelector('#project-name').textContent,
      avatar: document.querySelector('#project-avatar').textContent,
      visible: !document.querySelector('#project-card').classList.contains('hidden'),
      metaDts: [...document.querySelectorAll('#project-meta dt')].map((e) => e.textContent),
      saved: JSON.parse(localStorage.getItem('ab.projects') || '[]'),
    })`);
    say('card: ' + JSON.stringify(card));
    if (!card.dialogGone || !card.visible) throw new Error('card not shown after naming');
    if (card.title !== NAME || card.avatar !== 'M') throw new Error('card title wrong: ' + card.title);
    if (!card.metaDts.includes('App name') || !card.metaDts.includes('Detected name')) throw new Error('meta rows wrong: ' + card.metaDts);
    if (!card.saved.length || card.saved[0].name !== NAME || card.saved[0].dir !== FAKE) {
      throw new Error('project not persisted: ' + JSON.stringify(card.saved));
    }

    // 5. Continue -> config page: appname field must be gone, identity note shows the name
    await js(`document.querySelector('#btn-continue').click()`);
    await new Promise<void>((r) => setTimeout(r, 400));
    const cfg = await js(`({
      page: document.querySelector('.page.active').id,
      appnameGone: !document.querySelector('#field-appname'),
      identityNote: document.querySelector('#identity-note').textContent,
      version: document.querySelector('#field-version').value,
      summary: document.querySelector('#summary-info').textContent,
      label: document.querySelector('#config-project-label').textContent,
    })`);
    say('config: ' + JSON.stringify(cfg));
    if (cfg.page !== 'page-config') throw new Error('not on config page');
    if (!cfg.appnameGone) throw new Error('#field-appname still exists');
    if (!cfg.summary.includes(NAME)) throw new Error('summary does not use the chosen name: ' + cfg.summary);
    if (!cfg.identityNote.includes(NAME)) throw new Error('identity note missing name');
    fs.writeFileSync(path.join(process.cwd(), '.smoke', 'verify-naming-1.png'), (await win.webContents.capturePage()).toPNG());

    // 6. Back to project page: card keeps the defined name
    await js(`document.querySelector('#btn-back-select').click()`);
    await new Promise<void>((r) => setTimeout(r, 300));
    const back = await js(`({ title: document.querySelector('#project-name').textContent })`);
    say('back: ' + JSON.stringify(back));
    if (back.title !== NAME) throw new Error('card title lost after going back');

    // 7. Reload -> saved list survives the restart and shows the project
    await reload();
    await passGate();
    const listAfterReload = await js(`({
      cardVisible: !document.querySelector('#projects-card').classList.contains('hidden'),
      names: [...document.querySelectorAll('#projects-list .project-row-text strong')].map((e) => e.textContent),
      count: document.querySelector('#projects-count').textContent,
    })`);
    say('list after reload: ' + JSON.stringify(listAfterReload));
    if (!listAfterReload.cardVisible) throw new Error('projects card hidden after reload');
    if (listAfterReload.names.length !== 1 || listAfterReload.names[0] !== NAME) {
      throw new Error('list wrong after reload: ' + JSON.stringify(listAfterReload.names));
    }
    fs.writeFileSync(path.join(process.cwd(), '.smoke', 'verify-naming-2.png'), (await win.webContents.capturePage()).toPNG());

    // 8. Click the listed project -> validates and opens the card with its stored name
    await js(`document.querySelector('#projects-list .project-row-main').click()`);
    await new Promise<void>((r) => setTimeout(r, 900));
    const opened = await js(`({
      title: document.querySelector('#project-name').textContent,
      cardVisible: !document.querySelector('#project-card').classList.contains('hidden'),
      selectHidden: document.querySelector('#select-card').classList.contains('hidden'),
      listHidden: document.querySelector('#projects-card').classList.contains('hidden'),
    })`);
    say('open from list: ' + JSON.stringify(opened));
    if (opened.title !== NAME || !opened.cardVisible || !opened.selectHidden || !opened.listHidden) {
      throw new Error('opening from the list failed: ' + JSON.stringify(opened));
    }

    // 9. Change folder -> list is back; remove the entry -> list empties and persists
    await js(`document.querySelector('#btn-repick').click()`);
    await new Promise<void>((r) => setTimeout(r, 300));
    await js(`document.querySelector('#projects-list .icon-btn').click()`);
    await new Promise<void>((r) => setTimeout(r, 300));
    const afterRemove = await js(`({
      cardHidden: document.querySelector('#projects-card').classList.contains('hidden'),
      saved: JSON.parse(localStorage.getItem('ab.projects') || '[]'),
    })`);
    say('after remove: ' + JSON.stringify(afterRemove));
    if (!afterRemove.cardHidden || afterRemove.saved.length) throw new Error('remove did not clear the list');

    // 10. Pick once more: with no saved entry the dialog prefalls to the detected name
    await js(`document.querySelector('#btn-pick').click()`);
    await new Promise<void>((r) => setTimeout(r, 1200));
    const reDlg = await js(`({
      visible: !document.querySelector('#dlg-name').classList.contains('hidden'),
      prefill: document.querySelector('#field-projectname').value,
    })`);
    say('re-pick dialog: ' + JSON.stringify(reDlg));
    if (!reDlg.visible || reDlg.prefill !== 'Fake App') throw new Error('re-pick flow broken');
    fs.writeFileSync(path.join(process.cwd(), '.smoke', 'verify-naming-3.png'), (await win.webContents.capturePage()).toPNG());

    say('PASS');
  } catch (err) {
    say('FAIL ' + err.message);
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
});
