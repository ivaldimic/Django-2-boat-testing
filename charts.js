/* Minimal dependency-free canvas line chart, tuned for live streaming data.
 * Offline-safe (no CDN) so it runs on a nav PC with no internet. */
(function (root) {
  const CSS = {
    grid: 'rgba(120,170,200,0.14)',
    axis: 'rgba(120,170,200,0.35)',
    text: '#7f9bb0',
  };

  function niceTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  class LineChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.series = [];
      this.opts = {};
      this._onResize = () => { this._resize(); this.draw(); };
      window.addEventListener('resize', this._onResize);
      this._resize();
    }

    destroy() { window.removeEventListener('resize', this._onResize); }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height || 180));
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = w; this.H = h;
    }

    // series: [{ label, color, points: [{x, y}] }]  (x in seconds)
    // opts:   { xMax, unit, includeZero }
    setSeries(series, opts) {
      this.series = series || [];
      this.opts = opts || {};
      this.draw();
    }

    draw() {
      const ctx = this.ctx;
      const W = this.W, H = this.H;
      ctx.clearRect(0, 0, W, H);

      const mL = 44, mR = 10, mT = 10, mB = 22;
      const pw = W - mL - mR, ph = H - mT - mB;
      if (pw <= 0 || ph <= 0) return;

      // bounds
      let xMax = this.opts.xMax || 0;
      let yMin = this.opts.includeZero ? 0 : Infinity;
      let yMax = this.opts.includeZero ? 0 : -Infinity;
      let hasData = false;
      for (const s of this.series) {
        for (const p of s.points) {
          hasData = true;
          if (p.x > xMax) xMax = p.x;
          if (p.y < yMin) yMin = p.y;
          if (p.y > yMax) yMax = p.y;
        }
      }
      if (!hasData) { yMin = 0; yMax = 1; }
      if (xMax <= 0) xMax = 1;
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const pad = (yMax - yMin) * 0.1;
      yMin -= pad; yMax += pad;

      const xToPx = (x) => mL + (x / xMax) * pw;
      const yToPx = (y) => mT + ph - ((y - yMin) / (yMax - yMin)) * ph;

      // y gridlines + labels
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (i / yTicks) * (yMax - yMin);
        const py = yToPx(v);
        ctx.strokeStyle = CSS.grid;
        ctx.beginPath(); ctx.moveTo(mL, py); ctx.lineTo(W - mR, py); ctx.stroke();
        ctx.fillStyle = CSS.text;
        ctx.fillText(v.toFixed(Math.abs(yMax - yMin) < 5 ? 1 : 0), mL - 6, py);
      }

      // x ticks (time)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = 4;
      for (let i = 0; i <= xTicks; i++) {
        const xv = (i / xTicks) * xMax;
        const px = xToPx(xv);
        ctx.fillStyle = CSS.text;
        ctx.fillText(niceTime(xv), px, H - mB + 5);
      }

      // zero line if in range
      if (yMin < 0 && yMax > 0) {
        ctx.strokeStyle = CSS.axis;
        ctx.beginPath(); ctx.moveTo(mL, yToPx(0)); ctx.lineTo(W - mR, yToPx(0)); ctx.stroke();
      }

      // series lines
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      for (const s of this.series) {
        if (!s.points.length) continue;
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        s.points.forEach((p, i) => {
          const px = xToPx(p.x), py = yToPx(p.y);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }

      // legend
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let lx = mL + 4;
      for (const s of this.series) {
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, mT + 4, 10, 3);
        ctx.fillStyle = CSS.text;
        ctx.fillText(s.label, lx + 14, mT + 6);
        lx += 14 + ctx.measureText(s.label).width + 18;
      }
    }
  }

  root.LineChart = LineChart;
})(typeof globalThis !== 'undefined' ? globalThis : window);
