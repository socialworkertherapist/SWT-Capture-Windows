const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('swt', {
  getSources: invoke('get-sources'),
  setPendingSource: invoke('set-pending-source'),
  selectRegion: invoke('select-region'),
  showFrame: invoke('show-frame'),
  hideFrame: invoke('hide-frame'),
  compact: invoke('compact'),
  minimize: invoke('minimize'),
  hideMain: invoke('hide-main'),
  showMain: invoke('show-main'),
  getSettings: invoke('get-settings'),
  saveSettings: invoke('save-settings'),
  chooseFolder: invoke('choose-folder'),
  recOpen: invoke('rec-open'),
  recChunk: (buf) => ipcRenderer.send('rec-chunk', buf),
  recClose: invoke('rec-close'),
  readFile: invoke('read-file'),
  writeFile: invoke('write-file'),
  deleteFile: invoke('delete-file'),
  saveScreenshot: invoke('save-screenshot'),
  openPath: invoke('open-path'),
  showInFolder: invoke('show-in-folder'),
  listRecent: invoke('list-recent'),
  platform: invoke('platform'),
  onHotkey: (fn) => ipcRenderer.on('hotkey', (e, cmd) => fn(cmd)),
  // downloader
  dlInfo: invoke('dl-info'),
  dlStart: invoke('dl-start'),
  dlCancel: invoke('dl-cancel'),
  dlUpdate: invoke('dl-update'),
  dlToolsVersion: invoke('dl-tools-version'),
  webOpen: invoke('web-open'),
  webFound: invoke('web-found'),
  webClearFound: invoke('web-clear-found'),
  webSignout: invoke('web-signout'),
  on: (ch, fn) => { if (['dl-progress', 'dl-status', 'web-found-update', 'web-closed', 'web-download-page'].includes(ch)) ipcRenderer.on(ch, (e, d) => fn(d)); },
  // native sound capture
  nativeAudioAvailable: invoke('native-audio-available'),
  nativeAudioStart: invoke('native-audio-start'),
  nativeAudioCmd: invoke('native-audio-cmd'),
  nativeAudioStop: invoke('native-audio-stop'),
  nativeAudioCancel: invoke('native-audio-cancel'),
  finalizeRecording: invoke('finalize-recording'),
  onNative: (ch, fn) => { if (['native-level', 'native-audio-note'].includes(ch)) ipcRenderer.on(ch, (e, d) => fn(d)); },
  // overlay
  regionResult: (val) => ipcRenderer.send('region-result', val)
});
