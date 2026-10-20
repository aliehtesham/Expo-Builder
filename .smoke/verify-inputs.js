// Exercises EVERY input in the real app (text fields, the country combobox,
// password toggles, generator, error states, dialogs) and checks geometry,
// floating labels, sync and clipping. Writes screenshots to .smoke/inputs-*.png.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAKE = 'F:/Android Builder/.smoke/fake-project';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
setTimeout(() => { console.log('VERIFY HARD-TIMEOUT'); app.exit(3); }, 90000).unref();

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-inputs-'));
app.setPath('userData', tmpUserData);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [FAKE] });
require('../main.js');

app.whenReady().then(async () => {
  try {
    let w = null;
    for (let i = 0; i < 40 && !w; i++) {
      await new Promise((r) => setTimeout(r, 250));
      w = BrowserWindow.getAllWindows()[0] || null;
    }
    if (!w) throw new Error('window never appeared');
    await new Promise((r) => setTimeout(r, 1000));
    const js = (code) => w.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      w.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 150));
      fs.writeFileSync(path.join(process.cwd(), '.smoke', name), (await w.webContents.capturePage()).toPNG());
    };

    // The app opens on the environment gate — pass it like a user would
    // (wait for the real dependency checks to finish, then Continue).
    for (let i = 0; i < 60; i++) {
      const ready = await js(`!document.querySelector('#btn-env-continue').disabled`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await js(`document.querySelector('#btn-env-continue').click()`);
    await new Promise((r) => setTimeout(r, 300));

    // ── reach the config page through the real flow ──
    await js(`document.querySelector('#btn-pick').click()`);
    await new Promise((r) => setTimeout(r, 1300));
    const dlgGeo = await js(`(() => {
      const d = document.querySelector('#dlg-name').getBoundingClientRect();
      const f = document.querySelector('#wrap-name').getBoundingClientRect();
      const i = document.querySelector('#field-projectname');
      const l = document.querySelector('#wrap-name label');
      i.value = 'Input Test';
      i.dispatchEvent(new Event('input'));
      return {
        dlgW: Math.round(d.width),
        fieldW: Math.round(f.width),
        fieldInDlg: f.left >= d.left && f.right <= d.right,
        padRight: getComputedStyle(i).paddingRight,
        floatTransform: getComputedStyle(l).transform,
        typeable: (() => { i.value = 'Input Test 2'; i.dispatchEvent(new Event('input')); return i.value; })(),
      };
    })()`);
    check('name-dialog field inside dialog', dlgGeo.fieldInDlg, JSON.stringify(dlgGeo));
    check('name-dialog input accepts typing', dlgGeo.typeable === 'Input Test 2');
    check('name-dialog floating label lifts', dlgGeo.floatTransform !== 'none', dlgGeo.floatTransform);
    await js(`document.querySelector('#btn-name-ok').click()`);
    await new Promise((r) => setTimeout(r, 300));
    await js(`document.querySelector('#btn-continue').click()`);
    await new Promise((r) => setTimeout(r, 400));

    // ── geometry of the identity grid ──
    const geo = await js(`(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width) }; };
      return {
        version: r('#wrap-version'), versioncode: r('#wrap-versioncode'),
        alias: r('#wrap-alias'), country: r('#wrap-country'),
        keypass: r('#wrap-keypass'), storepass: r('#wrap-storepass'),
        keypassPad: getComputedStyle(document.querySelector('#field-keypass')).paddingRight,
        storepassPad: getComputedStyle(document.querySelector('#field-storepass')).paddingRight,
      };
    })()`);
    check('version & versionCode same row, equal halves',
      geo.version.t === geo.versioncode.t && Math.abs(geo.version.w - geo.versioncode.w) <= 3,
      JSON.stringify(geo.version) + ' vs ' + JSON.stringify(geo.versioncode));
    check('alias & country same row, equal halves',
      geo.alias.t === geo.country.t && Math.abs(geo.alias.w - geo.country.w) <= 3,
      JSON.stringify(geo.alias) + ' vs ' + JSON.stringify(geo.country));
    check('keypass & storepass same row, equal halves',
      geo.keypass.t === geo.storepass.t && Math.abs(geo.keypass.w - geo.storepass.w) <= 3,
      JSON.stringify(geo.keypass) + ' vs ' + JSON.stringify(geo.storepass));
    check('password inputs clear the trail buttons',
      parseInt(geo.keypassPad) >= 80 && parseInt(geo.storepassPad) >= 80,
      'padding-right ' + geo.keypassPad + '/' + geo.storepassPad);

    // ── lead icons reserve space; combo label floats inside the button ──
    const leads = await js(`(() => {
      const pad = (id) => getComputedStyle(document.querySelector(id)).paddingLeft;
      const combo = document.querySelector('#wrap-country');
      const label = document.querySelector('#wrap-country .float-label');
      const btn = document.querySelector('#country-btn').getBoundingClientRect();
      const lb = label.getBoundingClientRect();
      return {
        alias: pad('#field-alias'), keypass: pad('#field-keypass'), storepass: pad('#field-storepass'),
        comboHasValue: combo.classList.contains('has-value'),
        labelInsideBtn: lb.top >= btn.top && lb.bottom <= btn.bottom && lb.left >= btn.left,
        labelText: label.textContent,
      };
    })()`);
    check('lead icons reserve input space',
      parseInt(leads.alias) >= 46 && parseInt(leads.keypass) >= 46 && parseInt(leads.storepass) >= 46,
      `padding-left ${leads.alias}/${leads.keypass}/${leads.storepass}`);
    check('country label floats inside the button', leads.comboHasValue && leads.labelInsideBtn && leads.labelText.includes('Country'),
      JSON.stringify(leads));
    await shot('inputs-1-config.png');

    // ── version -> versionCode sync + summary ──
    const sync = await js(`(() => {
      const v = document.querySelector('#field-version');
      v.value = '2.3.4';
      v.dispatchEvent(new Event('input'));
      return {
        code: document.querySelector('#field-versioncode').value,
        summary: document.querySelector('#summary-info').textContent,
      };
    })()`);
    check('version -> versionCode auto-derives', sync.code === '20304', sync.code);
    check('summary reflects typed version', sync.summary.includes('2.3.4'), sync.summary);

    // ── country combobox ──
    await js(`document.querySelector('#signing-card').scrollIntoView({ block: 'center' })`);
    await new Promise((r) => setTimeout(r, 250));
    await js(`document.querySelector('#country-btn').click()`);
    await new Promise((r) => setTimeout(r, 450));
    const open = await js(`(() => {
      const menu = document.querySelector('#country-menu');
      const b = menu.getBoundingClientRect();
      const search = document.querySelector('#country-search');
      search.value = 'unit';
      search.dispatchEvent(new Event('input'));
      const wrap = document.querySelector('#wrap-country');
      const btn = document.querySelector('#country-btn').getBoundingClientRect();
      return {
        visible: getComputedStyle(menu).display !== 'none',
        bottom: Math.round(b.bottom), top: Math.round(b.top), vh: window.innerHeight,
        classes: wrap.className,
        btnTop: Math.round(btn.top), btnBottom: Math.round(btn.bottom),
        menuH: menu.offsetHeight,
        items: [...document.querySelectorAll('.combo-item')].filter((e) => e.textContent.includes('United States')).length,
        searchW: Math.round(search.getBoundingClientRect().width),
      };
    })()`);
    check('country menu opens', open.visible, 'bottom=' + open.bottom);
    check('country menu above the fold', open.bottom <= open.vh + 1 && open.top >= -1,
      JSON.stringify({ bottom: open.bottom, top: open.top, vh: open.vh, classes: open.classes, btnTop: open.btnTop, menuH: open.menuH }));
    check('country search filters to United States', open.items >= 1);
    check('country search input usable width', open.searchW > 120, String(open.searchW));
    await shot('inputs-2-country-open.png');
    const picked = await js(`(() => {
      const item = [...document.querySelectorAll('.combo-item')].find((e) => e.textContent.includes('United States'));
      item.click();
      const btn = document.querySelector('#country-btn').getBoundingClientRect();
      const menu = document.querySelector('#country-menu');
      return {
        value: document.querySelector('#country-value').textContent,
        closed: getComputedStyle(menu).display === 'none',
        btnW: Math.round(btn.width),
      };
    })()`);
    check('country select sets value + closes', picked.value.includes('United States') && picked.closed, picked.value);
    await js(`document.querySelector('#country-btn').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await js(`(() => {
      const item = [...document.querySelectorAll('.combo-item')].find((e) => e.textContent.includes('United States'));
      if (item) item.click();
    })()`);
    await new Promise((r) => setTimeout(r, 250));

    // ── password fields: reveal toggle + long value under trail buttons ──
    const pw = await js(`(() => {
      const k = document.querySelector('#field-keypass');
      const s = document.querySelector('#field-storepass');
      k.value = 'AveryLongPasswordValue123!@#';
      k.dispatchEvent(new Event('input'));
      s.value = 'AnotherLongSecret456$%^';
      s.dispatchEvent(new Event('input'));
      document.querySelector('[data-toggle-pass="field-keypass"]').click();
      const revealed = k.type === 'text';
      document.querySelector('[data-toggle-pass="field-keypass"]').click();
      return { revealed, backToPw: k.type === 'password', kVal: k.value, sVal: s.value };
    })()`);
    check('password reveal toggles and restores', pw.revealed && pw.backToPw);
    check('long values kept in both password fields',
      pw.kVal === 'AveryLongPasswordValue123!@#' && pw.sVal === 'AnotherLongSecret456$%^',
      `len ${pw.kVal.length}/${pw.sVal.length}`);
    await shot('inputs-3-passwords.png');

    // ── validation errors render without clipping ──
    const errs = await js(`(() => {
      document.querySelector('#field-alias').value = '';
      document.querySelector('#field-keypass').value = 'abc';
      document.querySelector('#field-storepass').value = '';
      ['field-alias', 'field-keypass', 'field-storepass'].forEach((id) => document.getElementById(id).dispatchEvent(new Event('input')));
      document.querySelector('#btn-validate').click();
      const sf = document.querySelector('#sign-fields');
      const bad = ['wrap-alias', 'wrap-keypass', 'wrap-storepass'].filter((id) => !document.getElementById(id).classList.contains('invalid'));
      return {
        missingInvalid: bad,
        aliasErr: document.querySelector('#err-alias').textContent,
        clip: sf.scrollHeight - sf.clientHeight,
      };
    })()`);
    check('invalid fields flagged', errs.missingInvalid.length === 0, JSON.stringify(errs.missingInvalid));
    check('error messages shown', errs.aliasErr.includes('required'), errs.aliasErr);
    check('sign-fields not clipped with errors', errs.clip <= 2, 'overflow ' + errs.clip + 'px');
    await shot('inputs-4-errors.png');

    // ── generator dialog fills a password ──
    await js(`document.querySelector('[data-gen="keypass"]').click()`);
    await new Promise((r) => setTimeout(r, 450));
    const gen = await js(`(() => {
      const out = document.querySelector('#gen-output').textContent;
      document.querySelector('#btn-gen-use').click();
      const k = document.querySelector('#field-keypass');
      const l = document.querySelector('#wrap-keypass label');
      return {
        outLen: out.length,
        applied: k.value === out,
        scrimGone: document.querySelector('#scrim').classList.contains('hidden'),
        float: getComputedStyle(l).transform,
      };
    })()`);
    check('generator produces a password', gen.outLen >= 8, 'len ' + gen.outLen);
    check('generator applies to target field + label floats', gen.applied && gen.float !== 'none' && gen.scrimGone);
    await shot('inputs-5-generator-applied.png');

    // ── signed toggle collapse/expand ──
    const tog = await js(`(() => {
      const sf = document.querySelector('#sign-fields');
      const s = document.querySelector('#field-signed');
      s.checked = false;
      s.dispatchEvent(new Event('change'));
      return { collapseStarted: sf.classList.contains('collapsed') };
    })()`);
    await new Promise((r) => setTimeout(r, 600)); // let the max-height transition finish
    const tog2 = await js(`(() => {
      const sf = document.querySelector('#sign-fields');
      const s = document.querySelector('#field-signed');
      const collapsed = getComputedStyle(sf).maxHeight === '0px';
      s.checked = true;
      s.dispatchEvent(new Event('change'));
      return { collapsed };
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    const tog3 = await js(`(() => {
      const sf = document.querySelector('#sign-fields');
      return { reopened: getComputedStyle(sf).maxHeight !== '0px', cleared: sf.classList.contains('collapsed') === false };
    })()`);
    check('signed toggle collapses/expands fields', tog.collapseStarted && tog2.collapsed && tog3.reopened && tog3.cleared,
      JSON.stringify({ tog, tog2, tog3 }));

    // ── back to page 1: rename dialog input again (stored-name prefill) ──
    await js(`document.querySelector('#btn-back-select').click()`);
    await new Promise((r) => setTimeout(r, 300));
    await js(`document.querySelector('#btn-repick').click()`);
    await js(`document.querySelector('#btn-pick').click()`);
    await new Promise((r) => setTimeout(r, 1300));
    const again = await js(`(() => {
      const i = document.querySelector('#field-projectname');
      const v = i.value;
      i.value = '';
      i.dispatchEvent(new Event('input'));
      const l = document.querySelector('#wrap-name label');
      const errBefore = document.querySelector('#wrap-name').classList.contains('invalid');
      document.querySelector('#btn-name-ok').click();
      const errAfter = document.querySelector('#wrap-name').classList.contains('invalid');
      return { v, errBefore, errAfter };
    })()`);
    check('re-pick prefills saved name', again.v === 'Input Test 2', again.v);
    check('cleared name flags error on confirm', !again.errBefore && again.errAfter);
    await shot('inputs-6-name-dialog-error.png');
    await js(`(() => {
      const i = document.querySelector('#field-projectname');
      i.value = 'Input Test';
      i.dispatchEvent(new Event('input'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    })()`);

    const failed = results.filter((r) => !r.ok);
    console.log(`INPUTS_RESULT ${JSON.stringify({ ok: failed.length === 0, failed: failed.map((f) => f.name) })}`);
  } catch (err) {
    console.log('INPUTS_RESULT ' + JSON.stringify({ ok: false, error: String(err) }));
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(0);
});
