const {app, BrowserWindow} = require('electron');
const path = require('path');
const fs = require('fs');
app.whenReady().then(async () => {
  const w = new BrowserWindow({show:true, width:1180, height:800, webPreferences:{preload:path.join(process.cwd(),'preload.js'), contextIsolation:true}});
  try {
    await w.loadFile(path.join(process.cwd(),'renderer/index.html'), {query:{demo:'1'}});
    await new Promise(r=>setTimeout(r,1100));
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const shot = async n => { await sleep(400); fs.writeFileSync(path.join(process.cwd(),'.smoke',n+'.png'), (await w.webContents.capturePage()).toPNG()); };
    await w.webContents.executeJavaScript(`window.__demo.config(); undefined`, true);
    await sleep(700);
    await w.webContents.executeJavaScript(`document.querySelector('#seg-format').scrollIntoView({block:'center'}); undefined`, true);
    await shot('6-config-format');
    await w.webContents.executeJavaScript(`document.querySelector('#signing-card').scrollIntoView({block:'start'}); undefined`, true);
    await shot('7-config-signing');
    await w.webContents.executeJavaScript(`window.__demo.countryOpen(); undefined`, true);
    await shot('8-country-search');
    await w.webContents.executeJavaScript(`window.__demo.countryOpen('united'); undefined`, true);
    await shot('9-country-filtered');
    await w.webContents.executeJavaScript(`window.__demo.failDialog(); undefined`, true);
    await shot('10-fail-dialog');
    console.log('INSPECT DONE');
  } catch (e) { console.log('INSPECT-FAIL ' + e.message); }
  app.exit(0);
});
