// SWT Capture — main process
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, dialog, shell, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const downloader = require('./downloader');
const nativeAudio = require('./nativeaudio');

app.commandLine.appendSwitch('enable-features', 'MediaRecorderEnableMp4Muxer');

let win = null;          // main window (also becomes the compact control bar while recording)
let overlayWins = [];    // region-select overlays
let frameWin = null;     // click-through border around the recorded area
let pendingSource = null;
let cachedSources = [];    // DesktopCapturerSource objects from the last listing
let writeStream = null;
let currentFile = null;
let normalBounds = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {}
}
function defaultFolder() {
  return path.join(app.getPath('videos'), 'SWT Capture');
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 720, minWidth: 360, minHeight: 64,
    title: 'SWT Capture',
    backgroundColor: '#0f1720',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // getDisplayMedia() in the renderer is answered with the source the user picked in our own UI.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let out = {};
    try {
      let src = pendingSource && cachedSources.find(s => s.id === pendingSource.id);
      const sources = src ? [] : await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (!src && sources.length) cachedSources = sources;
      src = src || sources.find(s => pendingSource && s.id === pendingSource.id) || sources.find(s => s.id.startsWith('screen:'));
      if (src) {
        out = { video: src };
        if (pendingSource && pendingSource.audio && process.platform === 'win32') out.audio = 'loopback';
      }
    } catch (e) { out = {}; }
    try { callback(out); } catch (e) { console.error('display media callback failed', e); }
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler(() => true);

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  downloader.setup(() => win);
  nativeAudio.setup(() => win, downloader.ensureTools);
  const send = (cmd) => win && win.webContents.send('hotkey', cmd);
  globalShortcut.register('CommandOrControl+Shift+R', () => send('toggle'));
  globalShortcut.register('CommandOrControl+Shift+P', () => send('pause'));
  globalShortcut.register('CommandOrControl+Shift+S', () => send('screenshot'));
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

// ---------- sources ----------
ipcMain.handle('get-sources', async () => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  if (sources.length) cachedSources = sources;
  return sources
    .filter(s => !(s.name === 'SWT Capture'))
    .map(s => {
      let display = null;
      if (s.id.startsWith('screen:')) {
        display = displays.find(d => String(d.id) === String(s.display_id)) || (sources.filter(x => x.id.startsWith('screen:')).length === 1 ? primary : null);
      }
      return {
        id: s.id, name: s.name, type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        display: display ? { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, primary: display.id === primary.id } : null
      };
    });
});

ipcMain.handle('set-pending-source', (e, src) => { pendingSource = src; return true; });

// ---------- region selection overlay ----------
ipcMain.handle('select-region', async (e, { displayId, preset }) => {
  const display = screen.getAllDisplays().find(d => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  return new Promise((resolve) => {
    const o = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
      fullscreenable: false, hasShadow: false, focusable: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
    });
    o.setAlwaysOnTop(true, 'screen-saver');
    o.setContentProtection(true);
    overlayWins.push(o);
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      ipcMain.removeListener('region-result', onResult);
      if (!o.isDestroyed()) o.close();
      overlayWins = overlayWins.filter(w => w !== o);
      if (win) win.show();
      resolve(val);
    };
    const onResult = (ev, val) => { if (ev.sender === o.webContents) finish(val); };
    ipcMain.on('region-result', onResult);
    o.on('closed', () => finish(null));
    o.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { preset: preset ? JSON.stringify(preset) : '' } });
    o.once('ready-to-show', () => { o.show(); o.focus(); });
    if (win) win.hide();
  });
});

// ---------- border frame shown around the recorded area ----------
ipcMain.handle('show-frame', (e, { displayId, rect }) => {
  hideFrame();
  if (!rect) return;
  const display = screen.getAllDisplays().find(d => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  const pad = 4;
  frameWin = new BrowserWindow({
    x: Math.round(display.bounds.x + rect.x - pad), y: Math.round(display.bounds.y + rect.y - pad),
    width: Math.round(rect.w + pad * 2), height: Math.round(rect.h + pad * 2),
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, hasShadow: false
  });
  frameWin.setIgnoreMouseEvents(true);
  frameWin.setAlwaysOnTop(true, 'screen-saver');
  frameWin.setContentProtection(true); // never appears in the recording
  frameWin.loadURL('data:text/html,' + encodeURIComponent('<html><body style="margin:0;background:transparent;overflow:hidden"><div style="position:fixed;inset:0;border:3px dashed #ff4d5e;border-radius:4px;box-sizing:border-box"></div></body></html>'));
});
function hideFrame() { if (frameWin && !frameWin.isDestroyed()) frameWin.close(); frameWin = null; }
ipcMain.handle('hide-frame', () => hideFrame());

// ---------- compact control bar mode ----------
ipcMain.handle('compact', (e, on) => {
  if (!win) return;
  if (on) {
    normalBounds = win.getBounds();
    const wa = screen.getDisplayMatching(normalBounds).workArea;
    win.setMinimumSize(360, 64);
    win.setBounds({ x: wa.x + Math.round(wa.width / 2 - 230), y: wa.y + 12, width: 460, height: 68 });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true); // keep the control bar out of the recording
    win.setResizable(false);
  } else {
    win.setContentProtection(false);
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMinimumSize(720, 520);
    if (normalBounds) win.setBounds(normalBounds);
    win.show();
  }
});
ipcMain.handle('minimize', () => win && win.minimize());
ipcMain.handle('hide-main', () => win && win.hide());
ipcMain.handle('show-main', () => win && win.show());

// ---------- settings / files ----------
ipcMain.handle('get-settings', () => {
  const s = loadSettings();
  if (!s.folder) s.folder = defaultFolder();
  return s;
});
ipcMain.handle('save-settings', (e, s) => { saveSettings(s); return true; });

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

ipcMain.handle('rec-open', (e, { folder, ext, prefix }) => {
  fs.mkdirSync(folder, { recursive: true });
  currentFile = path.join(folder, `${prefix || 'Recording'} ${stamp()}.${ext}`);
  writeStream = fs.createWriteStream(currentFile);
  return currentFile;
});
ipcMain.on('rec-chunk', (e, buf) => { if (writeStream) writeStream.write(Buffer.from(buf)); });
ipcMain.handle('rec-close', async () => {
  if (!writeStream) return null;
  const file = currentFile;
  await new Promise(r => writeStream.end(r));
  writeStream = null; currentFile = null;
  let size = 0; try { size = fs.statSync(file).size; } catch {}
  return { file, size };
});
ipcMain.handle('read-file', (e, file) => fs.readFileSync(file));
ipcMain.handle('write-file', (e, { file, data }) => { fs.writeFileSync(file, Buffer.from(data)); return true; });
ipcMain.handle('delete-file', (e, file) => { try { fs.unlinkSync(file); } catch {} return true; });

ipcMain.handle('save-screenshot', (e, { folder, dataUrl }) => {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `Screenshot ${stamp()}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
});

ipcMain.handle('open-path', (e, p) => shell.openPath(p));
ipcMain.handle('show-in-folder', (e, p) => shell.showItemInFolder(p));
ipcMain.handle('list-recent', (e, folder) => {
  try {
    return fs.readdirSync(folder)
      .filter(f => /\.(mp4|webm|png|m4a|ogg)$/i.test(f))
      .map(f => { const p = path.join(folder, f); const st = fs.statSync(p); return { name: f, path: p, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime).slice(0, 30);
  } catch { return []; }
});
ipcMain.handle('platform', () => process.platform);
