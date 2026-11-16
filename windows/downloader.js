// SWT Capture — video downloader (main process side).
// Uses yt-dlp + ffmpeg (bundled in tools/, copied to the user's app-data folder on first use).
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const WEB_PARTITION = 'persist:swt-web';
const jobs = new Map();        // id -> { proc, cancelled }
let getMainWindow = () => null;
let webWin = null;
let found = [];                // media URLs spotted in the sign-in browser

const isWin = process.platform === 'win32';
const toolsSrc = () => app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, 'tools');
const binDir = () => path.join(app.getPath('userData'), 'bin');

function send(ch, data) { const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send(ch, data); }

// ---------------- tools ----------------
let toolsReady = null;
function ensureTools() {
  if (toolsReady) return toolsReady;
  toolsReady = (async () => {
    // Developer/testing override (e.g. Linux): use tools on PATH
    if (process.env.SWT_YTDLP) return { ytdlp: process.env.SWT_YTDLP, ffmpegDir: process.env.SWT_FFMPEG_DIR || '' };
    const dir = binDir();
    fs.mkdirSync(dir, { recursive: true });
    const ytdlp = path.join(dir, 'yt-dlp.exe');
    if (!fs.existsSync(ytdlp)) fs.copyFileSync(path.join(toolsSrc(), 'yt-dlp.exe'), ytdlp);
    const ffDir = path.join(dir, 'ffmpeg');
    const stamp = path.join(ffDir, '.bundle-size');
    const archive = path.join(toolsSrc(), 'ffmpeg.tar.gz');
    const size = String(fs.statSync(archive).size);
    const current = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
    if (current !== size || !fs.existsSync(path.join(ffDir, 'ffmpeg.exe'))) {
      send('dl-status', 'Setting up the downloader (first time only)…');
      fs.rmSync(ffDir, { recursive: true, force: true });
      fs.mkdirSync(ffDir, { recursive: true });
      const tar = require('tar');
      await tar.x({ file: archive, cwd: ffDir });
      fs.writeFileSync(stamp, size);
      send('dl-status', '');
    }
    return { ytdlp, ffmpegDir: ffDir };
  })();
  toolsReady.catch(() => { toolsReady = null; });
  return toolsReady;
}

// ---------------- cookies from the sign-in browser ----------------
async function exportCookies() {
  const ses = session.fromPartition(WEB_PARTITION);
  const cookies = await ses.cookies.get({});
  if (!cookies.length) return null;
  const lines = ['# Netscape HTTP Cookie File', '# Exported by SWT Capture'];
  for (const c of cookies) {
    let domain = (c.domain || '').replace(/^\./, '');
    const sub = c.hostOnly ? 'FALSE' : 'TRUE';
    if (!c.hostOnly) domain = '.' + domain;
    const exp = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'));
  }
  const file = path.join(app.getPath('userData'), 'site-cookies.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return { file, ua: ses.getUserAgent() };
}

// ---------------- yt-dlp runner ----------------
function run(args, { onLine, onSpawn } = {}) {
  return ensureTools().then(({ ytdlp }) => new Promise((resolve) => {
    const proc = spawn(ytdlp, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '', err = '', buf = '';
    const feed = (chunk, isErr) => {
      const s = chunk.toString('utf8');
      if (isErr) err += s; else out += s;
      buf += s;
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() && onLine) onLine(line); }
    };
    proc.stdout.on('data', d => feed(d, false));
    proc.stderr.on('data', d => feed(d, true));
    proc.on('error', e => resolve({ code: -1, out, err: err + String(e.message) }));
    proc.on('close', code => resolve({ code, out, err, proc }));
    if (onSpawn) onSpawn(proc);
  }));
}

function friendlyError(err) {
  const e = String(err || '');
  if (/DRM/i.test(e)) return 'This video is copy-protected (DRM) and can’t be downloaded.';
  if (/Sign in to confirm|login required|requires authentication|members-only|Private video|HTTP Error 401|HTTP Error 403/i.test(e))
    return 'The site wants you to be signed in. Turn on “Use my login”, open the sign-in browser, log in, then try again.';
  if (/Unsupported URL/i.test(e)) return 'This page isn’t supported directly. Try “Find videos on page”: open it in the sign-in browser and play the video.';
  if (/HTTP Error 404|Video unavailable|not available/i.test(e)) return 'The video is unavailable (removed, private, or blocked in your region).';
  if (/getaddrinfo|Unable to download webpage|timed out|ConnectionError/i.test(e)) return 'Couldn’t reach the site. Check your internet connection.';
  const m = e.match(/ERROR: (.+)/);
  return m ? m[1].slice(0, 300) : (e.trim().split('\n').pop() || 'Download failed').slice(0, 300);
}

async function commonArgs(opts) {
  const { ffmpegDir } = await ensureTools();
  const a = ['--no-colors', '--encoding', 'utf-8', '--no-warnings'];
  if (ffmpegDir) a.push('--ffmpeg-location', ffmpegDir);
  if (opts.useLogin) {
    const c = await exportCookies();
    if (c) a.push('--cookies', c.file, '--user-agent', c.ua);
  }
  if (opts.referer) a.push('--referer', opts.referer);
  return a;
}

// ---------------- IPC ----------------
function setup(mainWindowGetter) {
  getMainWindow = mainWindowGetter;

  ipcMain.handle('dl-info', async (e, { url, useLogin, referer }) => {
    const args = [...await commonArgs({ useLogin, referer }), '-J', '--flat-playlist', '--', url];
    const r = await run(args);
    if (r.code !== 0) return { error: friendlyError(r.err) };
    let j;
    try { j = JSON.parse(r.out); } catch { return { error: 'Couldn’t read the video details.' }; }
    const isPlaylist = j._type === 'playlist' || Array.isArray(j.entries);
    const heights = new Set();
    for (const f of (j.formats || [])) if (f.height && f.vcodec !== 'none') heights.add(f.height);
    const langs = (o) => Object.keys(o || {}).filter(k => k !== 'live_chat');
    return {
      title: j.title || j.id, uploader: j.uploader || j.channel || j.extractor_key, duration: j.duration || null,
      thumbnail: j.thumbnail || (j.thumbnails && j.thumbnails.length ? j.thumbnails[j.thumbnails.length - 1].url : null),
      extractor: j.extractor_key, isPlaylist, count: isPlaylist ? (j.playlist_count || (j.entries || []).length) : 1,
      entries: isPlaylist ? (j.entries || []).slice(0, 300).map(x => ({ title: x.title || x.id, duration: x.duration || null })) : [],
      heights: [...heights].sort((a, b) => b - a),
      subs: langs(j.subtitles), autoSubs: langs(j.automatic_captions).slice(0, 200),
      inPlaylist: !isPlaylist && /[?&]list=/.test(url),
      isLive: !!j.is_live
    };
  });

  ipcMain.handle('dl-start', async (e, job) => {
    const id = job.id;
    const state = { proc: null, cancelled: false };
    jobs.set(id, state);
    let file = null, item = null, total = null;
    try {
      const a = await commonArgs(job);
      a.push('--newline', '--progress', '--no-mtime', '--windows-filenames', '--concurrent-fragments', '4', '--retries', '10', '--fragment-retries', '10');
      // each job works in its own temp folder; only finished files land in the user's folder
      const tmp = path.join(app.getPath('userData'), 'dl-temp', String(id).replace(/[^\w-]/g, ''));
      fs.mkdirSync(tmp, { recursive: true });
      state.tmp = tmp;
      a.push('-P', job.folder, '-P', 'temp:' + tmp);
      const hint = job.nameHint ? String(job.nameHint).replace(/[\\/:*?"<>|%\r\n\t]+/g, ' ').trim().slice(0, 120) : '';
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
      a.push('-o', job.playlist ? '%(playlist_title,playlist_id)s/%(playlist_index)03d - %(title).150B.%(ext)s'
        : hint ? `${hint} (${stamp}).%(ext)s` : '%(title).150B [%(id)s].%(ext)s');
      a.push(job.playlist ? '--yes-playlist' : '--no-playlist');
      a.push('--progress-template', 'download:SWTP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s');
      if (job.kind === 'audio') {
        a.push('-f', job.audioFormat === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b', '-x', '--audio-format', job.audioFormat || 'mp3', '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail');
      } else {
        const h = Number(job.height) || 0;
        a.push('-f', h ? `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b` : 'bv*+ba/b');
        a.push('-S', (h ? `res:${h},` : '') + (job.compatible ? 'vcodec:h264,acodec:m4a' : 'res,fps,vcodec,acodec:m4a'));
        a.push('--merge-output-format', 'mp4', '--embed-metadata');
      }
      if (job.subs && job.subs !== 'none') {
        a.push('--write-subs');
        if (job.autoSubs) a.push('--write-auto-subs');
        a.push('--sub-langs', job.subs === 'all' ? 'all,-live_chat' : `${job.subs}.*,${job.subs}`, '--convert-subs', 'srt');
        if (job.kind !== 'audio' && job.embedSubs) a.push('--embed-subs');
      }
      a.push('--', job.url);

      const r = await run(a, {
        onSpawn: (p) => { state.proc = p; if (state.cancelled) p.kill(); },
        onLine: (line) => {
          let m;
          if ((m = line.match(/^SWTP (\S+) (\S+) (\S+) (\S+) (\S+)/))) {
            const n = (v) => (v === 'NA' || v === 'None' ? null : Number(v));
            const done = n(m[1]), tot = n(m[2]) || n(m[3]);
            send('dl-progress', { id, phase: 'download', percent: tot ? Math.min(100, done / tot * 100) : null, done, total: tot, speed: n(m[4]), eta: n(m[5]), item, items: total });
          } else if ((m = line.match(/Downloading (?:item|video) (\d+) of (\d+)/))) {
            item = Number(m[1]); total = Number(m[2]);
            send('dl-progress', { id, phase: 'item', item, items: total });
          } else if ((m = line.match(/^\[(?:download|ExtractAudio|VideoConvertor)\] Destination: (.+)$/))) {
            file = m[1].trim();
          } else if ((m = line.match(/^\[Merger\] Merging formats into "(.+)"$/))) {
            file = m[1]; send('dl-progress', { id, phase: 'post', text: 'Joining video and sound…', item, items: total });
          } else if ((m = line.match(/^\[download\] (.+) has already been downloaded/))) {
            file = m[1].trim();
          } else if (/^\[ExtractAudio\]/.test(line)) {
            send('dl-progress', { id, phase: 'post', text: 'Converting audio…', item, items: total });
          } else if (/^\[(EmbedSubtitle|SubtitlesConvertor)\]/.test(line)) {
            send('dl-progress', { id, phase: 'post', text: 'Adding subtitles…', item, items: total });
          } else if (/^\[(EmbedThumbnail|Metadata)\]/.test(line)) {
            send('dl-progress', { id, phase: 'post', text: 'Finishing…', item, items: total });
          }
        }
      });
      jobs.delete(id);
      setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
      if (state.cancelled) return { id, cancelled: true };
      if (r.code !== 0) {
        // playlists: some items may fail (e.g. private) but others succeed
        if (job.playlist && file) return { id, ok: true, file, warning: 'Some items couldn’t be downloaded: ' + friendlyError(r.err) };
        return { id, error: friendlyError(r.err) };
      }
      if (file && !path.isAbsolute(file)) file = path.join(job.folder, file);
      // yt-dlp may report the pre-conversion name; prefer the final extension if it exists
      if (file && job.kind === 'audio') {
        const alt = file.replace(/\.[^.\\/]+$/, '.' + (job.audioFormat || 'mp3'));
        if (fs.existsSync(alt)) file = alt;
      }
      return { id, ok: true, file: file && fs.existsSync(file) ? file : null };
    } catch (err) {
      jobs.delete(id);
      return { id, error: String(err.message || err) };
    }
  });

  ipcMain.handle('dl-cancel', (e, id) => {
    const s = jobs.get(id);
    if (!s || !s.proc) return false;
    s.cancelled = true;
    if (isWin) execFile('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], () => {});
    else s.proc.kill('SIGTERM');
    return true;
  });

  ipcMain.handle('dl-update', async () => {
    const r = await run(['-U']);
    const text = (r.out + '\n' + r.err).trim().split('\n').filter(Boolean).pop() || '';
    return { ok: r.code === 0, text };
  });

  ipcMain.handle('dl-tools-version', async () => {
    try { const r = await run(['--version']); return r.out.trim(); } catch { return ''; }
  });

  // ---------- sign-in browser + "find videos on this page" ----------
  ipcMain.handle('web-open', (e, url) => { openWeb(url); return true; });
  ipcMain.handle('web-found', () => found);
  ipcMain.handle('web-clear-found', () => { found = []; return true; });
  ipcMain.handle('web-signout', async () => {
    await session.fromPartition(WEB_PARTITION).clearStorageData();
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'site-cookies.txt')); } catch {}
    return true;
  });

  // watch network traffic of the sign-in browser for video streams/files
  const ses = session.fromPartition(WEB_PARTITION);
  ses.webRequest.onResponseStarted((d) => {
    try {
      const url = d.url;
      if (!/^https?:/i.test(url)) return;
      const headers = d.responseHeaders || {};
      const ct = String((headers['content-type'] || headers['Content-Type'] || [''])[0]).toLowerCase();
      const len = Number((headers['content-length'] || headers['Content-Length'] || ['0'])[0]);
      let type = null;
      if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/.test(ct)) type = 'HLS stream';
      else if (/\.mpd(\?|$)/i.test(url) || /dash\+xml/.test(ct)) type = 'DASH stream';
      else if ((/\.(mp4|m4v|webm|mov)(\?|$)/i.test(url) || /^video\//.test(ct)) && !/\.(ts|m4s)(\?|$)/i.test(url) && (len === 0 || len > 300000)) type = 'Video file';
      if (!type) return;
      const key = url.split('#')[0];
      if (found.some(f => f.url === key)) return;
      // skip HLS sub-playlists when we already have the master from the same folder
      const wc = d.webContents;
      const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : (d.referrer || '');
      const title = wc && !wc.isDestroyed() ? wc.getTitle() : '';
      found.push({ url: key, type, pageUrl, title, size: len || null, at: Date.now() });
      if (found.length > 60) found.shift();
      send('web-found-update', found);
    } catch {}
  });
}

function openWeb(url) {
  if (webWin && !webWin.isDestroyed()) {
    if (url) webWin.loadURL(url);
    webWin.show(); webWin.focus();
    return;
  }
  webWin = new BrowserWindow({
    width: 1200, height: 820, title: 'SWT Capture — sign-in browser',
    autoHideMenuBar: false,
    webPreferences: { partition: WEB_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const nav = (fn) => () => { if (webWin && !webWin.isDestroyed()) fn(webWin.webContents); };
  webWin.setMenu(Menu.buildFromTemplate([
    { label: '← Back', click: nav(wc => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
    { label: 'Forward →', click: nav(wc => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
    { label: '⟳ Reload', accelerator: 'F5', click: nav(wc => wc.reload()) },
    { label: '⬇ Download this page', click: nav(wc => { send('web-download-page', { url: wc.getURL(), title: wc.getTitle() }); const m = getMainWindow(); if (m) m.focus(); }) },
    { label: 'Done', click: () => webWin && webWin.close() }
  ]));
  // pop-ups (e.g. "Sign in with Google") open inside the same signed-in browser
  webWin.webContents.setWindowOpenHandler(({ url: u }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: WEB_PARTITION, sandbox: true } }
  }));
  webWin.webContents.on('page-title-updated', (e, t) => { if (webWin) webWin.setTitle('SWT Capture — ' + t); });
  webWin.on('closed', () => { webWin = null; send('web-closed', true); });
  webWin.loadURL(url || 'about:blank');
}

module.exports = { setup, ensureTools };
