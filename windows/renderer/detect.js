// Video-region detection and motion monitoring (pure canvas math, no network, no libraries).
(function () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function gray(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }

  /**
   * Watch the screen for a few seconds and return the rectangle (in source-video pixels)
   * of the largest region that keeps changing — i.e. a playing video.
   */
  async function detectVideoRegion(video, opts = {}) {
    const seconds = opts.seconds || 3, fps = opts.fps || 12;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const W = 240, H = Math.max(2, Math.round(W * vh / vw));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    const frames = Math.round(seconds * fps);
    const changeCount = new Uint16Array(W * H);
    let prev = null, compared = 0;
    for (let f = 0; f < frames; f++) {
      ctx.drawImage(video, 0, 0, W, H);
      const g = gray(ctx, W, H);
      if (prev) {
        for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - prev[i]) > 6) changeCount[i]++;
        compared++;
      }
      prev = g;
      if (opts.onProgress) opts.onProgress(f / frames);
      await sleep(1000 / fps);
    }
    if (compared < 4) return null;

    // 1) cell grid of "frequently changing" pixels
    const CS = 6; const GW = Math.ceil(W / CS), GH = Math.ceil(H / CS);
    let cells = new Uint8Array(GW * GH);
    const minFrames = Math.max(2, Math.round(compared * 0.15));
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      let n = 0, tot = 0;
      for (let y = gy * CS; y < Math.min(H, gy * CS + CS); y++) for (let x = gx * CS; x < Math.min(W, gx * CS + CS); x++) {
        tot++; if (changeCount[y * W + x] >= minFrames) n++;
      }
      cells[gy * GW + gx] = n / tot > 0.08 ? 1 : 0;
    }
    // 2) close small gaps (dark/static patches inside a video)
    const morph = (src, dilate) => {
      const out = new Uint8Array(src.length);
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        let any = 0, all = 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          const v = xx < 0 || yy < 0 || xx >= GW || yy >= GH ? 0 : src[yy * GW + xx];
          any |= v; all &= v;
        }
        out[y * GW + x] = dilate ? any : all;
      }
      return out;
    };
    cells = morph(morph(cells, true), false);

    // 3) largest connected component
    const label = new Int32Array(GW * GH).fill(-1);
    let best = null;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i] || label[i] >= 0) continue;
      const stack = [i]; label[i] = i;
      let count = 0, minX = GW, minY = GH, maxX = 0, maxY = 0;
      while (stack.length) {
        const k = stack.pop(); count++;
        const x = k % GW, y = (k / GW) | 0;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
          const kk = yy * GW + xx; if (cells[kk] && label[kk] < 0) { label[kk] = i; stack.push(kk); }
        }
      }
      // score by bounding-box fill and size: videos are solid rectangles
      const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
      const score = count * Math.min(1, (count / boxArea) * 1.4);
      if (!best || score > best.score) best = { score, count, minX, minY, maxX, maxY };
    }
    if (!best || best.count < 6) return null;

    // 4) refine edges at pixel level inside the (slightly expanded) box
    let x0 = Math.max(0, (best.minX - 1) * CS), x1 = Math.min(W - 1, (best.maxX + 2) * CS - 1);
    let y0 = Math.max(0, (best.minY - 1) * CS), y1 = Math.min(H - 1, (best.maxY + 2) * CS - 1);
    const colHit = (x) => { let n = 0; for (let y = y0; y <= y1; y++) if (changeCount[y * W + x] >= minFrames) n++; return n / (y1 - y0 + 1); };
    const rowHit = (y) => { let n = 0; for (let x = x0; x <= x1; x++) if (changeCount[y * W + x] >= minFrames) n++; return n / (x1 - x0 + 1); };
    const T = 0.06;
    while (x0 < x1 && colHit(x0) < T) x0++;
    while (x1 > x0 && colHit(x1) < T) x1--;
    while (y0 < y1 && rowHit(y0) < T) y0++;
    while (y1 > y0 && rowHit(y1) < T) y1--;

    const sx = vw / W, sy = vh / H;
    let rect = { x: Math.floor(x0 * sx), y: Math.floor(y0 * sy), w: Math.ceil((x1 - x0 + 1) * sx), h: Math.ceil((y1 - y0 + 1) * sy) };
    if (rect.w * rect.h < vw * vh * 0.01) return null;
    // snap to a common aspect ratio when we're within ~3% (removes jagged edges)
    for (const ar of [16 / 9, 4 / 3, 21 / 9, 1, 9 / 16]) {
      const cur = rect.w / rect.h;
      if (Math.abs(cur - ar) / ar < 0.03) {
        const nh = Math.round(rect.w / ar); rect.y += Math.round((rect.h - nh) / 2); rect.h = nh; break;
      }
    }
    rect.x = Math.max(0, rect.x); rect.y = Math.max(0, rect.y);
    rect.w = Math.min(vw - rect.x, rect.w); rect.h = Math.min(vh - rect.y, rect.h);
    return rect;
  }

  /** Measures how much a (cropped) picture changes between calls. Returns 0..1 */
  class MotionMonitor {
    constructor() { this.c = document.createElement('canvas'); this.c.width = 96; this.c.height = 54; this.ctx = this.c.getContext('2d', { willReadFrequently: true }); this.prev = null; }
    sample(source, crop) {
      const { ctx, c } = this;
      if (crop) ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
      else ctx.drawImage(source, 0, 0, c.width, c.height);
      const g = gray(ctx, c.width, c.height);
      let changed = 0;
      if (this.prev) for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - this.prev[i]) > 10) changed++;
      this.prev = g;
      return changed / g.length;
    }
  }

  window.SWTDetect = { detectVideoRegion, MotionMonitor };
})();
