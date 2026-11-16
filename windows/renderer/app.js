// SWT Capture — renderer
const $ = (id) => document.getElementById(id);
const api = window.swt;

const state = {
  mode: 'screen',
  sources: [],
  screenId: null,     // selected screen source id
  windowId: null,     // selected window source id
  area: null,         // { displayId, rect:{x,y,w,h} in DIP relative to display }
  auto: null,         // same shape, from auto-detect
  settings: {},
  platform: 'win32',
  rec: null           // active recording session
};

// ---------------- helpers ----------------
function toast(msg, action) {
  const t = $('toast'); t.innerHTML = '';
  t.append(document.createTextNode(msg));
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.fn; t.append(b); }
  t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), action ? 8000 : 4000);
}
const setStatus = (s) => ($('status').textContent = s);
const fmtTime = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); };
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function selectedScreen() { return state.sources.find(s => s.id === state.screenId) || state.sources.find(s => s.type === 'screen'); }
function displayOf(src) {
  if (src && src.display) return src.display;
  const s = selectedScreen(); return s && s.display;
}

// ---------------- settings ----------------
const SETTING_IDS = ['sysAudio', 'micAudio', 'micDevice', 'sysVol', 'micVol', 'format', 'quality', 'fps', 'countdown', 'recForMin', 'recForSec', 'autoStartStop', 'stillSec', 'idleStop', 'showBorder', 'compactBar'];
function readUI() {
  const s = { ...state.settings };
  for (const id of SETTING_IDS) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  return s;
}
function applyUI(s) {
  for (const id of SETTING_IDS) { const el = $(id); if (s[id] === undefined) continue; if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id]; }
  $('folder').textContent = s.folder; $('folder').title = s.folder;
}
function persist() { state.settings = readUI(); api.saveSettings(state.settings); }

// ---------------- sources ----------------
async function loadSources() {
  let list = [];
  for (let i = 0; i < 3 && !list.length; i++) {
    try { list = await api.getSources(); } catch (e) { list = []; }
    if (!list.length) await sleep(400);
  }
  if (list.length || !state.sources.length) state.sources = list;
  if (!state.screenId || !state.sources.find(s => s.id === state.screenId)) {
    const prim = state.sources.find(s => s.type === 'screen' && s.display && s.display.primary) || state.sources.find(s => s.type === 'screen');
    state.screenId = prim && prim.id;
  }
  renderSources();
}
function renderSources() {
  const grid = $('sources'); grid.innerHTML = '';
  const type = state.mode === 'window' ? 'window' : 'screen';
  const list = state.sources.filter(s => s.type === type);
  $('sourceTitle').textContent = type === 'window' ? 'Choose a window' : (list.length > 1 ? 'Choose a screen' : 'Screen');
  if (!list.length) { grid.innerHTML = '<p class="muted">Nothing found. Press Refresh.</p>'; return; }
  const selId = type === 'window' ? state.windowId : state.screenId;
  list.forEach((s, i) => {
    const b = document.createElement('button'); b.className = 'src' + (s.id === selId ? ' sel' : '');
    const name = s.type === 'screen' ? (s.display && s.display.primary ? 'Main screen' : `Screen ${i + 1}`) + (s.display ? ` · ${Math.round(s.display.bounds.width * s.display.scaleFactor)}×${Math.round(s.display.bounds.height * s.display.scaleFactor)}` : '') : s.name;
    b.innerHTML = `${s.thumb ? `<img class="thumb" src="${s.thumb}">` : '<div class="thumb" style="aspect-ratio:16/9;background:#000;border-radius:6px"></div>'}<div class="nm">${s.icon ? `<img src="${s.icon}">` : ''}<span></span></div>`;
    b.querySelector('.nm span').textContent = name;
    b.onclick = () => {
      if (type === 'window') state.windowId = s.id;
      else { if (state.screenId !== s.id) { state.area = null; state.auto = null; updateAreaInfo(); } state.screenId = s.id; }
      renderSources();
    };
    grid.append(b);
  });
  if (type === 'window' && !state.windowId && list[0]) { state.windowId = list[0].id; grid.firstChild.classList.add('sel'); }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('areaPanel').hidden = mode !== 'area';
  $('autoPanel').hidden = mode !== 'auto';
  $('sourcePanel').hidden = mode === 'audio';
  $('shotBtn').disabled = mode === 'audio';
  if (mode === 'auto' && !$('autoStartStop').dataset.touched) $('autoStartStop').checked = true;
  renderSources();
}

function updateAreaInfo() {
  const scr = selectedScreen(); const sf = scr && scr.display ? scr.display.scaleFactor : 1;
  const desc = (a) => a ? `${Math.round(a.rect.w * sf)} × ${Math.round(a.rect.h * sf)} px at (${Math.round(a.rect.x * sf)}, ${Math.round(a.rect.y * sf)})` : null;
  $('areaInfo').textContent = desc(state.area) || 'No area selected yet.';
  $('autoInfo').textContent = state.auto ? 'Video found: ' + desc(state.auto) : 'Nothing detected yet.';
  $('adjust').disabled = !state.auto;
}

async function pickArea(preset) {
  const scr = selectedScreen(); if (!scr) return null;
  const d = displayOf(scr);
  const r = await api.selectRegion({ displayId: d ? d.id : null, preset: preset || null });
  return r ? { displayId: d ? d.id : null, rect: r } : null;
}

// ---------------- capture streams ----------------
async function getScreenStream(sourceId, withSystemAudio) {
  await api.setPendingSource({ id: sourceId, audio: !!withSystemAudio });
  const fps = Number($('fps').value) || 30;
  // Raw, unprocessed computer sound: voice-call filters (echo/noise/gain) wreck music and video audio.
  const audio = withSystemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 2 } : false;
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio });
  for (const t of stream.getAudioTracks()) { try { await t.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); } catch {} }
  return stream;
}
async function getMicStream() {
  const id = $('micDevice').value;
  // No call-style processing: on Windows it puts the mic in "communications" mode, which ducks (turns down) all other sound.
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 }, video: false });
}
function tempVideo() {
  const v = document.createElement('video'); v.className = 'offstage'; v.muted = true; v.playsInline = true;
  document.body.append(v); return v;
}
async function playInto(video, stream) {
  video.srcObject = stream; video.muted = true;
  await video.play().catch(() => {});
  for (let i = 0; i < 50 && !video.videoWidth; i++) await sleep(50);
}

// ---------------- auto-detect ----------------
async function runDetect() {
  const scr = selectedScreen(); if (!scr) return null;
  $('detect').disabled = true; setStatus('Watching the screen for a playing video…');
  await api.hideMain(); await sleep(400);
  let stream;
  try {
    stream = await getScreenStream(scr.id, false);
    const v = tempVideo(); await playInto(v, stream);
    await sleep(300);
    const rect = await SWTDetect.detectVideoRegion(v, { seconds: 3, fps: 12 });
    // preview
    const pc = $('detectPreview'); const pctx = pc.getContext('2d');
    pc.height = Math.round(pc.width * v.videoHeight / v.videoWidth);
    pctx.drawImage(v, 0, 0, pc.width, pc.height);
    if (rect) {
      const k = pc.width / v.videoWidth;
      pctx.strokeStyle = '#ef4444'; pctx.lineWidth = 3; pctx.setLineDash([8, 5]);
      pctx.strokeRect(rect.x * k, rect.y * k, rect.w * k, rect.h * k);
    }
    pc.hidden = false;
    const d = displayOf(scr); const scale = d ? v.videoWidth / d.bounds.width : 1;
    stream.getTracks().forEach(t => t.stop()); v.remove();
    await api.showMain();
    $('detect').disabled = false;
    if (!rect) { setStatus('Ready'); toast('No playing video found. Start the video, keep the mouse still, and try again.'); return null; }
    state.auto = { displayId: d ? d.id : null, rect: { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale } };
    updateAreaInfo(); setStatus('Video detected');
    return state.auto;
  } catch (e) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    await api.showMain(); $('detect').disabled = false; setStatus('Ready');
    toast('Could not watch the screen: ' + e.message); return null;
  }
}

// ---------------- recording ----------------
function pickMime(format, hasVideo, hasAudio) {
  const C = hasVideo ? {
    mp4: hasAudio ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'] : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4'],
    webm: hasAudio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  } : { mp4: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'], webm: ['audio/webm;codecs=opus', 'audio/webm'] };
  const order = format === 'mp4' ? [...C.mp4, ...C.webm] : [...C.webm, ...C.mp4];
  const mime = order.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const ext = mime.startsWith('video/mp4') ? 'mp4' : mime.startsWith('audio/mp4') ? 'm4a' : 'webm';
  return { mime, ext };
}

async function startRecording() {
  if (state.rec) return;
  const s = readUI(); state.settings = s; api.saveSettings(s);
  const mode = state.mode;
  const wantSys = s.sysAudio, wantMic = s.micAudio;
  if (mode === 'audio' && !wantSys && !wantMic) return toast('Turn on System sound and/or Microphone to record audio.');

  // resolve what to capture
  let sourceId = null, region = null;
  if (mode === 'window') { sourceId = state.windowId; if (!sourceId) return toast('Choose a window first.'); }
  else { const scr = selectedScreen(); if (!scr) return toast('No screen found. Press Refresh.'); sourceId = scr.id; }
  if (mode === 'area') { if (!state.area) state.area = await pickArea(); if (!state.area) return; updateAreaInfo(); region = state.area; }
  if (mode === 'auto') { if (!state.auto) await runDetect(); if (!state.auto) return; region = state.auto; }

  const rec = { mode, chunks: 0, startedAt: 0, elapsed: 0, paused: false, manualPause: false, waiting: false, stopping: false, started: false, clockRunning: false, cleanup: [] };
  state.rec = rec;
  $('recordBtn').disabled = true;

  try {
    // --- speaker output (+ mic) straight from Windows, for clean sound
    if (wantSys && await api.nativeAudioAvailable()) {
      const sel = $('micDevice'); const micName = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
      setStatus('Opening sound devices…');
      const r = await api.nativeAudioStart({ sys: true, mic: wantMic, micName });
      if (r.ok) { rec.native = r; rec.cleanupNative = true; }
      else toast('Using basic sound capture (' + r.error + ').');
    }
    const useNative = !!rec.native;

    // --- video + system audio
    let display = null, sysAudioTrack = null, videoTrack = null;
    const needDisplay = mode !== 'audio' || (wantSys && !useNative);
    if (needDisplay) {
      display = await getScreenStream(sourceId, wantSys && !useNative);
      rec.cleanup.push(() => display.getTracks().forEach(t => t.stop()));
      sysAudioTrack = display.getAudioTracks()[0] || null;
      if (wantSys && !useNative && !sysAudioTrack) toast('System sound isn’t available on this device; recording without it.');
      if (mode !== 'audio') {
        const v = $('srcVideo'); await playInto(v, new MediaStream(display.getVideoTracks()));
        rec.srcVideo = v;
        display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
        if (region) {
          const scr = selectedScreen(); const d = displayOf(scr);
          const scale = d ? v.videoWidth / d.bounds.width : 1;
          const crop = { x: Math.round(region.rect.x * scale), y: Math.round(region.rect.y * scale), w: even(region.rect.w * scale), h: even(region.rect.h * scale) };
          crop.w = Math.min(crop.w, v.videoWidth - crop.x); crop.h = Math.min(crop.h, v.videoHeight - crop.y);
          rec.crop = crop;
          const c = $('cropCanvas'); c.width = even(crop.w); c.height = even(crop.h);
          const ctx = c.getContext('2d', { alpha: false });
          const fps = Number(s.fps) || 30;
          const draw = () => ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
          draw();
          const iv = setInterval(draw, 1000 / fps);
          rec.cleanup.push(() => clearInterval(iv));
          videoTrack = c.captureStream(fps).getVideoTracks()[0];
          rec.cleanup.push(() => videoTrack.stop());
          rec.size = { w: c.width, h: c.height };
        } else {
          videoTrack = display.getVideoTracks()[0];
          rec.size = { w: v.videoWidth, h: v.videoHeight };
        }
      }
    }

    // --- microphone
    let mic = null;
    if (wantMic && !useNative) {
      try { mic = await getMicStream(); rec.cleanup.push(() => mic.getTracks().forEach(t => t.stop())); }
      catch (e) { toast('Microphone unavailable: ' + e.message); }
    }

    // --- mix audio
    let audioTrack = null;
    if (sysAudioTrack && !mic && Number(s.sysVol) === 100) {
      audioTrack = sysAudioTrack; // computer sound only: record it untouched
    } else if (sysAudioTrack || mic) {
      const ac = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' }); rec.ac = ac;
      rec.cleanup.push(() => ac.close());
      const dest = ac.createMediaStreamDestination();
      if (sysAudioTrack) { const g = ac.createGain(); g.gain.value = Number(s.sysVol) / 100; ac.createMediaStreamSource(new MediaStream([sysAudioTrack])).connect(g).connect(dest); rec.sysGain = g; }
      if (mic) { const g = ac.createGain(); g.gain.value = Number(s.micVol) / 100; ac.createMediaStreamSource(mic).connect(g).connect(dest); rec.micGain = g; }
      audioTrack = dest.stream.getAudioTracks()[0];
    }

    const tracks = [videoTrack, audioTrack].filter(Boolean);
    if (!tracks.length && !useNative) throw new Error('Nothing to record.');
    const prefix = mode === 'audio' ? 'Audio' : mode === 'auto' ? 'Video' : 'Recording';
    if (!tracks.length) {
      // sound only, captured natively: no browser recorder needed
      const f = await api.recOpen({ folder: s.folder, ext: 'm4a', prefix });
      await api.recClose();
      rec.audioOut = f; rec.ext = 'm4a';
    } else {
    const { mime, ext } = pickMime(s.format, !!videoTrack, !!audioTrack && !useNative);
    const px = rec.size ? rec.size.w * rec.size.h : 1920 * 1080;
    const base = { high: 12e6, standard: 6e6, small: 2.5e6 }[s.quality] || 6e6;
    const fpsK = (Number(s.fps) || 30) / 30;
    const vbps = Math.round(Math.max(1e6, base * px / (1920 * 1080) * Math.sqrt(fpsK)));
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime || undefined, videoBitsPerSecond: videoTrack ? vbps : undefined, audioBitsPerSecond: 256000 });
    rec.recorder = recorder; rec.ext = ext; rec.mime = mime;
    rec.file = await api.recOpen({ folder: s.folder, ext, prefix });
    let queue = Promise.resolve();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) { rec.chunks++; queue = queue.then(async () => api.recChunk(new Uint8Array(await e.data.arrayBuffer()))); } };
    recorder.onstop = () => { queue.then(finishRecording); };
    }

    // --- UI: countdown, compact bar, border
    if (s.compactBar && mode !== 'audio') { document.body.classList.add('compact'); await api.compact(true); }
    $('bar').hidden = false;
    const hasMic = !!mic || !!(rec.native && rec.native.mic);
    rec.micOn = hasMic;
    $('barMic').classList.toggle('off', !hasMic); $('barMic').disabled = !hasMic;
    $('barShot').disabled = mode === 'audio';
    const cd = Number(s.countdown) || 0;
    for (let i = cd; i > 0; i--) { $('countdownOverlay').hidden = false; $('countNum').textContent = i; await sleep(1000); if (!state.rec) return; }
    $('countdownOverlay').hidden = true;
    if (region && s.showBorder) api.showFrame({ displayId: region.displayId, rect: region.rect });

    // --- start (or wait for motion)
    rec.limitMs = recordLimitMs(s);
    rec.auto = s.autoStartStop && mode !== 'audio';
    if (rec.auto) { rec.waiting = true; startMotionWatch(rec, s); }
    else recGo(rec);
    rec.tick = setInterval(() => updateBar(), 250);
    updateBar();
    setStatus('Recording…');
    $('recordLabel').textContent = 'Stop recording';
    $('recordBtn').disabled = false;
    if (useNative) stopMeters(); else startMeters(rec, sysAudioTrack, mic);
  } catch (e) {
    console.error(e);
    toast('Could not start: ' + (e.message || e));
    if (rec.native) api.nativeAudioCancel();
    await teardown(rec);
    if (rec.file) await api.recClose().then(r => r && api.deleteFile(r.file));
    state.rec = null; resetUI();
  }
}

function startMotionWatch(rec, s) {
  const mon = new SWTDetect.MotionMonitor();
  const stillMs = Number(s.stillSec) * 1000, idleMs = Number(s.idleStop) * 1000;
  let lastMotion = 0, everStarted = false;
  const iv = setInterval(() => {
    if (!state.rec || rec.stopping) return;
    const m = mon.sample(rec.srcVideo, rec.crop);
    const now = performance.now();
    const moving = m > 0.004;
    if (moving) lastMotion = now;
    if (rec.manualPause) return;
    if (moving) {
      if (!rec.started) { recGo(rec); everStarted = true; rec.waiting = false; }
      else if (!rec.clockRunning) { recResume(rec); rec.paused = false; }
    } else if (rec.clockRunning && now - lastMotion > stillMs) {
      recPause(rec); rec.paused = true;
    }
    if (everStarted && idleMs > 0 && now - lastMotion > idleMs) { toast('Video stopped — recording saved.'); stopRecording(); }
  }, 250);
  rec.cleanup.push(() => clearInterval(iv));
}

function recordLimitMs(s) {
  const m = Math.max(0, Number(s.recForMin) || 0), sec = Math.max(0, Number(s.recForSec) || 0);
  return Math.round((m * 60 + sec) * 1000);
}

// start / pause / resume both the picture recorder and the native sound capture together
function recGo(rec) {
  if (rec.recorder) rec.recorder.start(1000);
  if (rec.native) api.nativeAudioCmd('go');
  rec.started = true; rec.clockRunning = true; rec.startedAt = performance.now();
}
function recPause(rec) {
  if (!rec.clockRunning) return;
  if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.pause();
  if (rec.native) api.nativeAudioCmd('pause');
  rec.elapsed += performance.now() - rec.startedAt; rec.clockRunning = false;
}
function recResume(rec) {
  if (rec.clockRunning) return;
  if (rec.recorder && rec.recorder.state === 'paused') rec.recorder.resume();
  if (rec.native) api.nativeAudioCmd('resume');
  rec.startedAt = performance.now(); rec.clockRunning = true;
}

function updateBar() {
  const rec = state.rec; if (!rec) return;
  const running = rec.clockRunning;
  const ms = rec.elapsed + (running ? performance.now() - rec.startedAt : 0);
  $('barTime').textContent = fmtTime(ms);
  if (rec.limitMs && ms >= rec.limitMs && !rec.stopping) { toast('Time limit reached — recording saved.'); stopRecording(); return; }
  const dot = $('barDot'); dot.className = 'rec-dot' + (rec.waiting ? ' waiting' : !running ? ' paused' : '');
  $('barStatus').textContent = rec.waiting ? 'Waiting for motion…' : rec.manualPause ? 'Paused' : rec.paused ? 'Paused — no motion' : (rec.size ? `Recording ${rec.size.w}×${rec.size.h}` : 'Recording audio');
  if (rec.limitMs) $('barStatus').textContent += ` · ${fmtTime(Math.max(0, rec.limitMs - ms + 999))} left`;
  $('barPause').textContent = rec.manualPause ? '▶' : '⏸';
}

function togglePause() {
  const rec = state.rec; if (!rec || rec.stopping) return;
  if (!rec.manualPause) {
    rec.manualPause = true;
    recPause(rec);
  } else {
    rec.manualPause = false;
    if (!rec.auto) { if (!rec.started) recGo(rec); else recResume(rec); }
  }
  updateBar();
}

async function stopRecording() {
  const rec = state.rec; if (!rec || rec.stopping) return;
  rec.stopping = true;
  const r = rec.recorder;
  if (rec.clockRunning) { rec.elapsed += performance.now() - rec.startedAt; rec.clockRunning = false; }
  if (r && r.state !== 'inactive') { r.requestData(); r.stop(); }
  else if (!r && rec.native && rec.started) finishRecording();
  else { // never started (e.g. no motion ever happened)
    if (rec.native) api.nativeAudioCancel();
    await teardown(rec);
    const res = await api.recClose(); if (res) await api.deleteFile(res.file);
    state.rec = null; resetUI(); toast('Nothing was recorded.');
  }
}

async function finishRecording() {
  const rec = state.rec; if (!rec) return;
  await teardown(rec);
  setStatus('Saving…');
  let res = rec.recorder ? await api.recClose() : null;
  if (rec.native) {
    // join the picture with the clean native sound
    setStatus('Adding sound…');
    const w = await api.nativeAudioStop();
    const outFile = res ? res.file : rec.audioOut;
    const fin = w && (w.sysWav || w.micWav)
      ? await api.finalizeRecording({ videoFile: res ? res.file : null, sysWav: w.sysWav, micWav: w.micWav, sysVol: Number($('sysVol').value), micVol: rec.micMuted ? 0 : Number($('micVol').value), outFile, durationMs: Math.round(rec.elapsed) })
      : { ok: false, error: 'no sound was captured' };
    if (fin.ok) res = { file: fin.file, size: fin.size };
    else toast('Sound could not be added: ' + fin.error);
  } else
  // WebM from the browser has no duration header; patch it so players can seek.
  if (res && rec.ext === 'webm' && res.size < 1.5e9 && window.ysFixWebmDuration) {
    try {
      const buf = await api.readFile(res.file);
      const fixed = await ysFixWebmDuration(new Blob([buf], { type: rec.mime || 'video/webm' }), Math.round(rec.elapsed), { logger: false });
      await api.writeFile({ file: res.file, data: new Uint8Array(await fixed.arrayBuffer()) });
    } catch (e) { console.warn('duration fix failed', e); }
  }
  state.rec = null; resetUI();
  if (res) toast(`Saved ${fmtSize(res.size)} · ${fmtTime(rec.elapsed)}`, { label: 'Show', fn: () => api.showInFolder(res.file) });
  loadRecent();
}

async function teardown(rec) {
  clearInterval(rec.tick);
  stopMeters();
  for (const fn of rec.cleanup.reverse()) { try { await fn(); } catch {} }
  rec.cleanup = [];
  $('srcVideo').srcObject = null;
  await api.hideFrame();
}

function resetUI() {
  $('countdownOverlay').hidden = true; $('bar').hidden = true;
  if (document.body.classList.contains('compact')) { document.body.classList.remove('compact'); api.compact(false); }
  $('recordLabel').textContent = 'Start recording'; $('recordBtn').disabled = false;
  setStatus('Ready'); startPreviewMeters();
}

// ---------------- screenshot ----------------
async function screenshot() {
  if (state.mode === 'audio') return;
  let video, stream, crop = null;
  const rec = state.rec;
  try {
    if (rec && rec.srcVideo) { video = rec.srcVideo; crop = rec.crop || null; }
    else {
      const id = state.mode === 'window' ? state.windowId : (selectedScreen() || {}).id;
      if (!id) return toast('Choose a source first.');
      let region = null;
      if (state.mode === 'area') { if (!state.area) state.area = await pickArea(); region = state.area; updateAreaInfo(); if (!region) return; }
      if (state.mode === 'auto') region = state.auto || await runDetect();
      await api.hideMain(); await sleep(350);
      stream = await getScreenStream(id, false);
      video = tempVideo(); await playInto(video, stream); await sleep(250);
      if (region) { const d = displayOf(selectedScreen()); const k = d ? video.videoWidth / d.bounds.width : 1; crop = { x: region.rect.x * k, y: region.rect.y * k, w: region.rect.w * k, h: region.rect.h * k }; }
    }
    const c = document.createElement('canvas');
    const w = Math.round(crop ? crop.w : video.videoWidth), h = Math.round(crop ? crop.h : video.videoHeight);
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (crop) ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h); else ctx.drawImage(video, 0, 0);
    const file = await api.saveScreenshot({ folder: state.settings.folder, dataUrl: c.toDataURL('image/png') });
    if (stream) { stream.getTracks().forEach(t => t.stop()); video.remove(); await api.showMain(); }
    toast('Screenshot saved', { label: 'Show', fn: () => api.showInFolder(file) });
    loadRecent();
  } catch (e) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    await api.showMain(); toast('Screenshot failed: ' + e.message);
  }
}

// ---------------- level meters ----------------
let meterCtx = null, meterRAF = 0, previewMic = null;
function stopMeters() { cancelAnimationFrame(meterRAF); if (meterCtx) meterCtx.close().catch(() => {}); meterCtx = null; if (previewMic) previewMic.getTracks().forEach(t => t.stop()); previewMic = null; $('sysMeter').style.width = '0'; $('micMeter').style.width = '0'; }
function meterLoop(pairs) {
  const buf = new Float32Array(1024);
  const loop = () => {
    for (const [an, el] of pairs) { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); el.style.width = Math.min(100, p * 140) + '%'; }
    meterRAF = requestAnimationFrame(loop);
  };
  loop();
}
function startMeters(rec, sysTrack, mic) {
  stopMeters();
  meterCtx = new AudioContext(); const pairs = [];
  const add = (stream, el) => { const an = meterCtx.createAnalyser(); an.fftSize = 1024; meterCtx.createMediaStreamSource(stream).connect(an); pairs.push([an, el]); };
  if (sysTrack) add(new MediaStream([sysTrack]), $('sysMeter'));
  if (mic) add(mic, $('micMeter'));
  meterLoop(pairs);
}
async function startPreviewMeters() {
  stopMeters();
  if (!$('micAudio').checked || state.rec) return;
  try { previewMic = await getMicStream(); meterCtx = new AudioContext(); const an = meterCtx.createAnalyser(); an.fftSize = 1024; meterCtx.createMediaStreamSource(previewMic).connect(an); meterLoop([[an, $('micMeter')]]); } catch {}
}

async function loadMics() {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (devs.filter(d => d.kind === 'audioinput').every(d => !d.label) && $('micAudio').checked) {
      const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach(x => x.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    const sel = $('micDevice'); const cur = state.settings.micDevice || sel.value; sel.innerHTML = '';
    devs.filter(d => d.kind === 'audioinput').forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Microphone ${i + 1}`; sel.append(o); });
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  } catch {}
}

// ---------------- recent list ----------------
async function loadRecent() {
  const list = await api.listRecent(state.settings.folder);
  const ul = $('recent'); ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">Your recordings and screenshots will appear here.</li>'; return; }
  for (const f of list.slice(0, 12)) {
    const li = document.createElement('li');
    const icon = /\.png$/i.test(f.name) ? '🖼️' : /\.(m4a|ogg)$/i.test(f.name) || /^Audio/.test(f.name) ? '🎵' : '🎞️';
    li.innerHTML = `<span>${icon}</span><span class="n"></span><span class="s">${fmtSize(f.size)}</span><button data-a="open">Open</button><button data-a="show">Show</button>`;
    li.querySelector('.n').textContent = f.name; li.querySelector('.n').title = f.path;
    li.querySelector('[data-a=open]').onclick = () => api.openPath(f.path);
    li.querySelector('[data-a=show]').onclick = () => api.showInFolder(f.path);
    ul.append(li);
  }
}

// ---------------- wire up ----------------
api.onNative('native-level', (l) => {
  if (!state.rec || !state.rec.native) return;
  $('sysMeter').style.width = Math.min(100, l.sys * 140) + '%';
  $('micMeter').style.width = Math.min(100, l.mic * 140) + '%';
});
api.onNative('native-audio-note', (t) => toast(t));
async function init() {
  state.platform = await api.platform();
  state.settings = await api.getSettings();
  applyUI(state.settings);
  if (state.platform !== 'win32') { $('sysNote').textContent = '(Windows only)'; }
  if (!MediaRecorder.isTypeSupported('video/mp4')) { const o = $('format').querySelector('[value=mp4]'); o.textContent += ' — not supported here'; if ($('format').value === 'mp4') $('format').value = 'webm'; }

  document.querySelectorAll('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('refresh').onclick = loadSources;
  $('pickArea').onclick = async () => { const a = await pickArea(state.area && state.area.rect); if (a) { state.area = a; updateAreaInfo(); } };
  document.querySelectorAll('[data-preset]').forEach(b => b.onclick = async () => {
    const [pw, ph] = b.dataset.preset.split('x').map(Number); const d = displayOf(selectedScreen()); if (!d) return;
    const sf = d.scaleFactor, w = Math.min(pw / sf, d.bounds.width), h = Math.min(ph / sf, d.bounds.height);
    const a = await pickArea({ x: (d.bounds.width - w) / 2, y: (d.bounds.height - h) / 2, w, h });
    if (a) { state.area = a; updateAreaInfo(); }
  });
  $('detect').onclick = runDetect;
  $('adjust').onclick = async () => { if (!state.auto) return; const a = await pickArea(state.auto.rect); if (a) { state.auto = a; updateAreaInfo(); } };
  $('chooseFolder').onclick = async () => { const f = await api.chooseFolder(); if (f) { state.settings.folder = f; $('folder').textContent = f; persist(); loadRecent(); } };
  $('openFolder').onclick = () => api.openPath(state.settings.folder);
  $('recordBtn').onclick = () => state.rec ? stopRecording() : startRecording();
  $('shotBtn').onclick = screenshot;
  $('barStop').onclick = stopRecording;
  $('barPause').onclick = togglePause;
  $('barShot').onclick = screenshot;
  $('barMic').onclick = () => {
    const rn = state.rec;
    if (rn && rn.native && rn.native.mic) { rn.micMuted = !rn.micMuted; api.nativeAudioCmd(rn.micMuted ? 'mute' : 'unmute'); $('barMic').classList.toggle('off', rn.micMuted); return; }
    const r = state.rec; if (!r || !r.micGain) return; const on = r.micGain.gain.value > 0; r.micGain.gain.value = on ? 0 : Number($('micVol').value) / 100; $('barMic').classList.toggle('off', on); };
  $('autoStartStop').addEventListener('change', () => { $('autoStartStop').dataset.touched = '1'; });
  $('sysVol').oninput = () => { if (state.rec && state.rec.sysGain) state.rec.sysGain.gain.value = $('sysVol').value / 100; };
  $('micVol').oninput = () => { if (state.rec && state.rec.micGain) state.rec.micGain.gain.value = $('micVol').value / 100; };
  SETTING_IDS.forEach(id => $(id).addEventListener('change', persist));
  $('micAudio').addEventListener('change', async () => { await loadMics(); startPreviewMeters(); });
  $('micDevice').addEventListener('change', startPreviewMeters);
  api.onHotkey((cmd) => {
    if (cmd === 'toggle') state.rec ? stopRecording() : startRecording();
    if (cmd === 'pause') togglePause();
    if (cmd === 'screenshot') screenshot();
  });
  window.addEventListener('focus', () => { if (!state.rec) loadSources(); });

  await loadSources(); await loadMics(); updateAreaInfo(); loadRecent(); startPreviewMeters();
}
init();
