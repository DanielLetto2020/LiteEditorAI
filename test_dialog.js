const { app, BrowserWindow, dialog } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  try {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    console.log('Dialog result:', res);
  } catch (e) {
    console.log('Dialog error:', e);
  }
  app.quit();
});
