// SWT Capture — Download tab (renderer)
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.swt;
  const dl = { kind: 'video', info: null, infoUrl: '', jobs: [], running: 0, toolsChecked: false };
  const MAX_PARALLEL = 2;

  const fmtBytes = (b) => b == null ? '' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  const fmtDur = (s) => { if (!s) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const say = (msg, action) => (typeof toast === 'function' ? toast(msg, action) : alert(msg));

  // ---------------- tabs ----------------
  function showTab(tab) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('recordView').hidden = tab !== 'record';
    $('dlView').hidden = tab !== 'download';
    if (tab === 'download' && !dl.toolsChecked) {
      dl.toolsChecked = true;
      $('dlVersion').textContent = 'preparing…';
      api.dlToolsVersion().then(v => { $('dlVersion').textContent = v ? 'yt-dlp ' + v : 'downloader not available'; });
    }
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  // ---------------- settings ----------------
  const IDS = ['dlQuality', 'dlCompatible', 'dlAudioFmt', 'dlSubs', 'dlAutoSubs', 'dlEmbedSubs'];
  function loadSettings() {
    const s = (typeof state !== 'undefined' && state.settings) || {};
    for (const id of IDS) { if (s[id] === undefined) continue; const el = $(id); if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id]; }
    if (s.dlKind) setKind(s.dlKind);
  }
  function saveSettings() {
    if (typeof state === 'undefined') return;
    for (const id of IDS) { const el = $(id); state.settings[id] = el.type === 'checkbox' ? el.checked : el.value; }
    state.settings.dlKind = dl.kind;
    api.saveSettings(state.settings);
  }
  IDS.forEach(id => $(id).addEventListener('change', saveSettings));

  function setKind(k) {
    dl.kind = k;
    document.querySelectorAll('#dlKind button').forEach(b => b.classList.toggle('active', b.dataset.kind === k));
    $('videoOpts').hidden = k !== 'video';
    $('audioOpts').hidden = k !== 'audio';
    $('embedRow').hidden = k !== 'video';
  }
  document.querySelectorAll('#dlKind button').forEach(b => b.onclick = () => { setKind(b.dataset.kind); saveSettings(); });

  // ---------------- link + info ----------------
  $('dlLogin').onchange = () => { $('loginRow').hidden = !$('dlLogin').checked; };
  $('dlPaste').onclick = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) { $('dlUrl').value = t.trim(); check(); } } catch { $('dlUrl').focus(); }
  };
  $('dlUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  $('dlCheck').onclick = () => check();
  $('dlSignin').onclick = () => api.webOpen(normalUrl($('dlUrl').value) || 'https://www.google.com/');
  $('dlSignout').onclick = async () => { await api.webSignout(); say('Signed out of all sites in the sign-in browser.'); };
  $('dlFindOpen').onclick = () => { $('dlLogin').checked = true; $('loginRow').hidden = false; api.webOpen(normalUrl($('dlUrl').value) || 'https://www.google.com/'); };

  function normalUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  async function check(opts = {}) {
    const url = normalUrl($('dlUrl').value);
    if (!url) return say('Paste a video link first.');
    $('dlUrl').value = url;
    const box = $('dlInfo');
    box.hidden = false; box.className = 'info'; box.innerHTML = '<span class="muted">Looking up the video…</span>';
    $('dlCheck').disabled = true;
    const info = await api.dlInfo({ url, useLogin: $('dlLogin').checked, referer: opts.referer });
    $('dlCheck').disabled = false;
    dl.infoUrl = url;
    if (info.error) { dl.info = null; box.className = 'info err'; box.textContent = info.error; $('playlistPanel').hidden = true; return null; }
    dl.info = info;
    const heights = info.heights.length ? 'Up to ' + info.heights[0] + 'p' : '';
    const subs = info.subs.length ? `Subtitles: ${info.subs.slice(0, 6).join(', ')}${info.subs.length > 6 ? '…' : ''}` : (info.autoSubs.length ? 'Auto-captions available' : 'No subtitles');
    box.innerHTML = `${info.thumbnail ? `<img src="${esc(info.thumbnail)}" referrerpolicy="no-referrer">` : ''}
      <div class="meta"><div class="t">${esc(info.title)}</div>
      <div class="s">${esc([info.uploader, info.isPlaylist ? info.count + ' videos' : fmtDur(info.duration), heights, info.isLive ? 'LIVE' : ''].filter(Boolean).join(' · '))}</div>
      ${info.isPlaylist ? '' : `<div class="s">${esc(subs)}</div>`}
      ${info.isPlaylist ? `<ol class="entries">${info.entries.slice(0, 100).map(x => `<li>${esc(x.title)} ${x.duration ? '<span>(' + fmtDur(x.duration) + ')</span>' : ''}</li>`).join('')}</ol>` : ''}</div>`;
    const img = box.querySelector('img'); if (img) img.onerror = () => img.remove();
    // playlist choice
    if (info.isPlaylist || info.inPlaylist) {
      $('playlistPanel').hidden = false;
      $('dlPlaylist').checked = info.isPlaylist;
      $('playlistNote').textContent = info.isPlaylist ? `${info.count} videos — each is saved in its own folder named after the playlist.` : 'This video is part of a playlist. Tick to download the whole playlist instead.';
    } else {
      $('playlistPanel').hidden = true;
    }
    if (info.isLive) say('This is a live stream — it will download until the stream ends or you cancel.');
    return info;
  }

  // ---------------- queue ----------------
  $('dlGo').onclick = () => {
    const url = normalUrl($('dlUrl').value);
    if (!url) return say('Paste a video link first.');
    const info = dl.info && dl.infoUrl === url ? dl.info : null;
    addJob({ url, title: info ? info.title : url, playlist: !$('playlistPanel').hidden && $('dlPlaylist').checked });
  };

  function addJob({ url, title, playlist, referer, nameHint, useLogin }) {
    const s = (typeof state !== 'undefined' && state.settings) || {};
    const job = {
      id: 'j' + Date.now() + Math.random().toString(36).slice(2, 6),
      url, title: title || url, playlist: !!playlist, referer: referer || null, nameHint: nameHint || null,
      kind: dl.kind, height: Number($('dlQuality').value), compatible: $('dlCompatible').checked, audioFormat: $('dlAudioFmt').value,
      subs: $('dlSubs').value, autoSubs: $('dlAutoSubs').checked, embedSubs: $('dlEmbedSubs').checked,
      useLogin: useLogin != null ? useLogin : $('dlLogin').checked,
      folder: s.folder, status: 'queued', el: null
    };
    dl.jobs.unshift(job);
    renderJob(job);
    pump();
  }

  function pump() {
    while (dl.running < MAX_PARALLEL) {
      const next = [...dl.jobs].reverse().find(j => j.status === 'queued');
      if (!next) break;
      startJob(next);
    }
  }

  async function startJob(job) {
    job.status = 'running'; dl.running++;
    updateJob(job, { text: 'Starting…', indet: true });
    const { el, ...payload } = job;
    const r = await api.dlStart(payload);
    dl.running--;
    if (r.cancelled) { job.status = 'cancelled'; updateJob(job, { text: 'Cancelled', percent: 0 }); }
    else if (r.error) { job.status = 'error'; updateJob(job, { text: r.error, err: true, percent: 0 }); }
    else {
      job.status = 'done'; job.file = r.file;
      updateJob(job, { text: r.warning || 'Done', percent: 100, err: !!r.warning });
      if (typeof loadRecent === 'function') loadRecent();
    }
    pump();
  }

  function renderJob(job) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="q-top"><span>${job.kind === 'audio' ? '🎵' : '🎞️'}</span><span class="q-name"></span>
      <button data-a="cancel">Cancel</button><button data-a="open" hidden>Open</button><button data-a="show" hidden>Show</button><button data-a="retry" hidden>Retry</button></div>
      <div class="q-bar"><i></i></div><div class="q-sub">Waiting…</div>`;
    li.querySelector('.q-name').textContent = job.title + (job.playlist ? ' (playlist)' : '');
    li.querySelector('.q-name').title = job.url;
    li.querySelector('[data-a=cancel]').onclick = () => {
      if (job.status === 'queued') { job.status = 'cancelled'; updateJob(job, { text: 'Cancelled' }); }
      else if (job.status === 'running') api.dlCancel(job.id);
    };
    li.querySelector('[data-a=open]').onclick = () => job.file ? api.openPath(job.file) : api.openPath(job.folder);
    li.querySelector('[data-a=show]').onclick = () => job.file ? api.showInFolder(job.file) : api.openPath(job.folder);
    li.querySelector('[data-a=retry]').onclick = () => { job.status = 'queued'; updateJob(job, { text: 'Waiting…', percent: 0 }); pump(); };
    job.el = li;
    const q = $('dlQueue');
    const empty = q.querySelector('.empty'); if (empty) empty.remove();
    q.prepend(li);
  }

  function updateJob(job, { text, percent, indet, err } = {}) {
    const li = job.el; if (!li) return;
    const bar = li.querySelector('.q-bar'), sub = li.querySelector('.q-sub');
    if (text != null) sub.textContent = text;
    sub.classList.toggle('err', !!err);
    bar.classList.toggle('indet', !!indet);
    if (percent != null) bar.querySelector('i').style.width = percent + '%';
    const st = job.status;
    li.querySelector('[data-a=cancel]').hidden = !(st === 'queued' || st === 'running');
    li.querySelector('[data-a=open]').hidden = st !== 'done';
    li.querySelector('[data-a=show]').hidden = st !== 'done';
    li.querySelector('[data-a=retry]').hidden = !(st === 'error' || st === 'cancelled');
  }

  api.on('dl-progress', (p) => {
    const job = dl.jobs.find(j => j.id === p.id); if (!job || job.status !== 'running') return;
    const pre = p.items ? `Video ${p.item || 1} of ${p.items} · ` : '';
    if (p.phase === 'download') {
      const parts = [];
      if (p.percent != null) parts.push(p.percent.toFixed(0) + '%');
      if (p.total) parts.push(`${fmtBytes(p.done)} of ${fmtBytes(p.total)}`); else if (p.done) parts.push(fmtBytes(p.done));
      if (p.speed) parts.push(fmtBytes(p.speed) + '/s');
      if (p.eta != null && p.eta > 0) parts.push(fmtDur(p.eta) + ' left');
      updateJob(job, { text: pre + (parts.join(' · ') || 'Downloading…'), percent: p.percent, indet: p.percent == null });
    } else if (p.phase === 'post') {
      updateJob(job, { text: pre + p.text, indet: true });
    } else if (p.phase === 'item') {
      updateJob(job, { text: pre + 'Starting…' });
    }
  });
  api.on('dl-status', (t) => { const st = $('status'); if (st) st.textContent = t || 'Ready'; });

  // ---------------- found on page ----------------
  function renderFound(list) {
    const ul = $('foundList'); ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="muted">Nothing found yet.</li>'; return; }
    [...list].reverse().forEach(f => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="tag">${esc(f.type)}</span><span class="u"></span>${f.size ? `<span class="muted">${fmtBytes(f.size)}</span>` : ''}<button>Download</button>`;
      li.querySelector('.u').textContent = (f.title ? f.title + ' — ' : '') + f.url;
      li.querySelector('.u').title = f.url;
      li.querySelector('button').onclick = () => addJob({ url: f.url, title: f.title || f.url, referer: f.pageUrl, nameHint: f.title, useLogin: true });
      ul.append(li);
    });
  }
  api.on('web-found-update', renderFound);
  api.on('web-download-page', ({ url, title }) => {
    showTab('download');
    $('dlUrl').value = url; $('dlLogin').checked = true; $('loginRow').hidden = false;
    check();
  });
  $('dlOpenFolder').onclick = () => api.openPath(state.settings.folder);
  $('dlUpdate').onclick = async (e) => {
    e.preventDefault();
    $('dlVersion').textContent = 'updating…';
    const r = await api.dlUpdate();
    say(r.ok ? 'Downloader: ' + r.text : 'Update failed: ' + r.text);
    $('dlVersion').textContent = 'yt-dlp ' + (await api.dlToolsVersion());
  };

  // init (after app.js has loaded settings)
  setKind('video');
  const waitSettings = setInterval(() => {
    if (typeof state !== 'undefined' && state.settings && state.settings.folder) { clearInterval(waitSettings); loadSettings(); }
  }, 100);
  $('dlQueue').innerHTML = '<li class="empty muted">Downloads will appear here.</li>';
  renderFound([]);
  window.SWTDownload = { showTab, addJob, check };
})();
