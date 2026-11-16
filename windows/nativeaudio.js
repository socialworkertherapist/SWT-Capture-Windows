// SWT Capture — native Windows sound capture (speaker output + microphone) and final mixing.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let proc = null, session = null;
let getWin = () => null;
let ensureTools = null;

const toolsSrc = () => app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, 'tools');
const helperPath = () => process.env.SWT_AUDIO_HELPER || path.join(toolsSrc(), 'swt-audio.exe');
const send = (ch, d) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, d); };

function setup(winGetter, toolsFn) {
  getWin = winGetter;
  ensureTools = toolsFn;

  ipcMain.handle('native-audio-available', () => (process.platform === 'win32' || !!process.env.SWT_AUDIO_HELPER) && fs.existsSync(helperPath()));

  // Starts the helper (capturing, but not yet saving). Resolves once devices are open.
  ipcMain.handle('native-audio-start', (e, { sys, mic, micName }) => new Promise((resolve) => {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    const dir = path.join(app.getPath('userData'), 'audio-temp');
    fs.mkdirSync(dir, { recursive: true });
    const id = Date.now();
    session = { sysWav: sys ? path.join(dir, `sys-${id}.wav`) : null, micWav: mic ? path.join(dir, `mic-${id}.wav`) : null, ready: {}, done: null };
    const args = [];
    if (sys) args.push('-sys', session.sysWav);
    if (mic) args.push('-mic', session.micWav, '-micname', micName || '');
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      proc = spawn(helperPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ ok: false, error: String(err.message || err) });
    }
    const p = proc;
    let buf = '';
    const expect = (sys ? 1 : 0) + (mic ? 1 : 0);
    let readyCount = 0;
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const parts = line.split(' ');
        if (parts[0] === 'READY') {
          session.ready[parts[1]] = { rate: +parts[2], channels: +parts[3], bits: +parts[4], float: parts[5] === 'true' };
          readyCount++;
        } else if (parts[0] === 'NOMIC') {
          session.micWav = null; readyCount++;
          send('native-audio-note', 'Microphone not available — recording without it.');
        } else if (parts[0] === 'LEVEL') {
          send('native-level', { sys: +parts[1], mic: +parts[2] });
        } else if (parts[0] === 'ERROR') {
          finish({ ok: false, error: line.slice(6) });
        } else if (parts[0] === 'DONE') {
          if (session && session.done) session.done();
        }
        if (readyCount >= expect) finish({ ok: true, sys: session.ready.sys || null, mic: session.ready.mic || null });
      }
    });
    p.on('error', (err) => finish({ ok: false, error: String(err.message || err) }));
    p.on('exit', () => { if (proc === p) proc = null; finish({ ok: false, error: 'sound helper stopped' }); if (session && session.done) session.done(); });
    setTimeout(() => finish({ ok: false, error: 'sound devices did not respond' }), 5000);
  }));

  ipcMain.handle('native-audio-cmd', (e, cmd) => {
    if (proc && proc.stdin.writable) proc.stdin.write(cmd + '\n');
    return !!proc;
  });

  // Stops the helper and waits for the WAV files to be closed.
  ipcMain.handle('native-audio-stop', () => new Promise((resolve) => {
    const s = session;
    if (!s) return resolve(null);
    const out = () => resolve({ sysWav: s.sysWav && fs.existsSync(s.sysWav) ? s.sysWav : null, micWav: s.micWav && fs.existsSync(s.micWav) ? s.micWav : null });
    if (!proc) return out();
    let called = false;
    s.done = () => { if (!called) { called = true; setTimeout(out, 100); } };
    try { proc.stdin.write('stop\n'); } catch {}
    setTimeout(() => { if (!called) { try { proc && proc.kill(); } catch {} s.done(); } }, 8000);
  }));

  ipcMain.handle('native-audio-cancel', () => {
    if (proc) { try { proc.stdin.write('stop\n'); } catch {} setTimeout(() => { try { proc && proc.kill(); } catch {} }, 3000); }
    cleanup(session); session = null;
    return true;
  });

  // Joins the picture with the recorded sound (speaker + mic), levelled with a limiter so it never clips.
  ipcMain.handle('finalize-recording', async (e, { videoFile, sysWav, micWav, sysVol, micVol, outFile, durationMs }) => {
    const { ffmpegDir } = await ensureTools();
    const ffmpeg = ffmpegDir ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';
    const inputs = [];
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (videoFile) { args.push('-i', videoFile); inputs.push('v'); }
    const audio = [];
    if (sysWav) { args.push('-i', sysWav); audio.push({ idx: inputs.length, vol: sysVol }); inputs.push('s'); }
    if (micWav) { args.push('-i', micWav); audio.push({ idx: inputs.length, vol: micVol }); inputs.push('m'); }
    const tmpOut = outFile + '.part' + path.extname(outFile);
    const isWebm = /\.webm$/i.test(outFile);
    let filter = audio.map((a, i) => `[${a.idx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(a.vol / 100).toFixed(2)}[a${i}]`).join(';');
    filter += ';' + (audio.length > 1 ? audio.map((a, i) => `[a${i}]`).join('') + `amix=inputs=${audio.length}:normalize=0:duration=longest[mx];[mx]` : '[a0]');
    filter += 'alimiter=limit=0.89:attack=5:release=60:level=false[aout]';
    args.push('-filter_complex', filter);
    if (videoFile) args.push('-map', '0:v:0', '-c:v', 'copy');
    args.push('-map', '[aout]');
    args.push('-c:a', isWebm ? 'libopus' : 'aac', '-b:a', isWebm ? '192k' : '256k', '-ar', '48000');
    if (durationMs) args.push('-t', (durationMs / 1000).toFixed(3));
    if (!isWebm) args.push('-movflags', '+faststart');
    args.push(tmpOut);
    const r = await new Promise((resolve) => {
      const p = spawn(ffmpeg, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('error', (x) => resolve({ code: -1, err: String(x.message) }));
      p.on('close', (code) => resolve({ code, err }));
    });
    if (r.code !== 0 || !fs.existsSync(tmpOut)) return { ok: false, error: r.err.trim().split('\n').pop() || 'ffmpeg failed' };
    try { if (videoFile && videoFile !== outFile) fs.unlinkSync(videoFile); } catch {}
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
    fs.renameSync(tmpOut, outFile);
    cleanup({ sysWav, micWav });
    return { ok: true, file: outFile, size: fs.statSync(outFile).size };
  });
}

function cleanup(s) {
  if (!s) return;
  for (const f of [s.sysWav, s.micWav]) { try { if (f) fs.unlinkSync(f); } catch {} }
}

module.exports = { setup };
