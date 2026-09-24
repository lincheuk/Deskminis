const { app, BrowserWindow } = require('electron');
const http = require('http'); const path = require('path');
http.createServer((q, r) => { r.setHeader('content-type','text/html'); r.end('<html><body>evil</body></html>'); }).listen(47811);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  app.on('browser-window-created', (_e, child) => {
    child.webContents.on('did-finish-load', async () => {
      const url = child.webContents.getURL();
      if (!url.includes('evil')) return;
      const v = await child.webContents.executeJavaScript('typeof window.marker === "object" ? window.marker.secret() : "NO-PRELOAD"');
      console.log('CHILD', url, '=>', v); app.exit(0);
    });
  });
  await win.loadFile(path.join(__dirname, 'page.html'));
  console.log('PARENT has marker =>', await win.webContents.executeJavaScript('typeof window.marker'));
  await win.webContents.executeJavaScript('document.getElementById("l").click()', true);
  setTimeout(() => { console.log('TIMEOUT no child'); app.exit(1); }, 8000);
});
