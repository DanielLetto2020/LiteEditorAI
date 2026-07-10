const { app, BrowserWindow } = require('electron');
app.on('ready', () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.webContents.on('console-message', (e, level, msg) => {
    console.log('[WIN CONSOLE]', msg);
  });
  win.loadFile('renderer/index.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      try {
        const textproc = window.lite; // Wait, textproc isn't exposed
        // Let's just override positionNearRange to log.
        fetch('./modules/textproc.js')
          .then(r => r.text())
          .then(code => {
             code = code.replace(/import .*/g, '');
             code = code.replace(/module\.exports = /, 'window.textproc_module = ');
             const script = document.createElement('script');
             script.textContent = code;
             document.head.appendChild(script);
             
             setTimeout(() => {
                 const lite = window.lite || { win: {} };
                 const host = window.host || { iconBtn: () => document.createElement('button'), el: (tag, cls) => { const e = document.createElement(tag); if(cls) e.className=cls; return e; } };
                 document.body.innerHTML += '<div id="menu-layer"></div><div id="doc-editor-wysiwyg"><p>Hello world</p></div>';
                 const tp = window.textproc_module(lite, host);
                 tp.setDocOpen(true);
                 const ed = document.getElementById('doc-editor-wysiwyg');
                 const sel = window.getSelection();
                 const range = document.createRange();
                 range.setStart(ed.firstChild.firstChild, 0);
                 range.setEnd(ed.firstChild.firstChild, 5);
                 sel.removeAllRanges();
                 sel.addRange(range);
                 
                 // Intercept maybeShowSelectionUI if possible, or just call it:
                 ed.dispatchEvent(new MouseEvent('mouseup'));
                 
                 const popups = document.querySelectorAll('.tp-sel-popup');
                 console.log("Popups found: " + popups.length);
                 popups.forEach(p => {
                    const rect = p.getBoundingClientRect();
                    console.log("Popup hidden: " + p.hidden + " top: " + p.style.top + " rect: " + rect.width + "x" + rect.height);
                 });
             }, 500);
          });
      } catch (e) {
        console.error("ERROR " + e.stack);
      }
    `);
    setTimeout(() => app.quit(), 2000);
  });
});
