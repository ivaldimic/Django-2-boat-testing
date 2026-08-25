/* Offline track plot: draws boats and their tracks in a local north-up plane
 * (equal metres on both axes), auto-fitting the view, with a range line between
 * the boats, waypoint marks and a scale bar. Zoomable & pannable (wheel, pinch,
 * drag) with a Fit reset. No tiles, no network. */
(function (root) {
  const CSS = {
    grid: 'rgba(30,55,80,0.09)',
    axis: 'rgba(30,55,80,0.4)',
    text: '#5a6b7a',
    faint: '#9aa7b3',
    mark: '#d98a00',
  };
  const LAT_M = 111132;

  function niceDist(x) {
    if (!isFinite(x) || x <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / pow;
    const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return step * pow;
  }

  class TrackMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.data = { boats: [] };
      this.userScale = 1;
      this.userPan = { x: 0, y: 0 };
      this.locked = false;                 // true once the user zooms/pans
      this.base = { cx: 0, cy: 0, scale: 1, lat0: 0, lon0: 0 };
      this.pointers = new Map();
      this._pinchDist = 0;
      this._onResize = () => { this._resize(); this.draw(); };
      window.addEventListener('resize', this._onResize);
      this._bind();
      this._resize();
    }
    destroy() {
      window.removeEventListener('resize', this._onResize);
      for (const [type, fn] of this._handlers) this.canvas.removeEventListener(type, fn);
    }

    _bind() {
      this._handlers = [];
      const add = (type, fn, opts) => { this.canvas.addEventListener(type, fn, opts); this._handlers.push([type, fn]); };
      add('wheel', (e) => {
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });
      add('pointerdown', (e) => {
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        this._pinchDist = 0;
      });
      add('pointermove', (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        const prev = this.pointers.get(e.pointerId);
        const cur = { x: e.offsetX, y: e.offsetY };
        this.pointers.set(e.pointerId, cur);
        if (this.pointers.size === 1) {
          this.panBy(cur.x - prev.x, cur.y - prev.y);
        } else if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (this._pinchDist > 0 && d > 0) this.zoomAt(mid.x, mid.y, d / this._pinchDist);
          this._pinchDist = d;
        }
      });
      const up = (e) => { this.pointers.delete(e.pointerId); this._pinchDist = 0; };
      add('pointerup', up); add('pointercancel', up); add('pointerleave', up);
      add('dblclick', () => this.fit());
    }

    zoomAt(mx, my, factor) {
      this._lock();
      const f = Math.max(0.2, Math.min(50, this.userScale * factor)) / this.userScale;
      this.userScale *= f;
      this.userPan.x = this.userPan.x - (mx - this.W / 2 - this.userPan.x) * (f - 1);
      this.userPan.y = this.userPan.y + (this.H / 2 + this.userPan.y - my) * (f - 1);
      this.draw();
    }
    panBy(dx, dy) { this._lock(); this.userPan.x += dx; this.userPan.y += dy; this.draw(); }
    fit() { this.locked = false; this.userScale = 1; this.userPan = { x: 0, y: 0 }; this.draw(); }
    _lock() { if (!this.locked) { this.locked = true; } }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width || this.canvas.clientWidth || 320));
      const h = Math.max(1, Math.floor(rect.height || this.canvas.clientHeight || 300));
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = w; this.H = h;
    }

    // data: { boats:[{name,color,lat,lon,hdg,cog,track}], range, bearing, marks:[{name,lat,lon,color}] }
    setData(data) { this.data = data || { boats: [] }; this.draw(); }

    draw() {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.clearRect(0, 0, W, H);
      if (W <= 4 || H <= 4) return;

      const boats = (this.data.boats || []).filter((b) => b.lat != null && b.lon != null);
      if (!boats.length) {
        ctx.fillStyle = CSS.faint; ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Waiting for position fixes…', W / 2, H / 2);
        return;
      }

      // Auto-fit projection (recomputed only while unlocked).
      let B;
      if (!this.locked) {
        const lat0 = boats.reduce((s, b) => s + b.lat, 0) / boats.length;
        const lonM = LAT_M * Math.cos(lat0 * Math.PI / 180);
        const proj0 = (lat, lon) => ({ x: (lon - boats[0].lon) * lonM, y: (lat - lat0) * LAT_M });
        const pts = [];
        for (const b of boats) { pts.push(proj0(b.lat, b.lon)); for (const t of (b.track || [])) pts.push(proj0(t.lat, t.lon)); }
        for (const m of (this.data.marks || [])) if (m.lat != null) pts.push(proj0(m.lat, m.lon));
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        let spanX = Math.max(maxX - minX, 40), spanY = Math.max(maxY - minY, 40);
        const pad = 30;
        this.base = {
          cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
          scale: Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY),
          lat0, lon0: boats[0].lon,
        };
      }
      B = this.base;
      const lonM = LAT_M * Math.cos(B.lat0 * Math.PI / 180);
      const proj = (lat, lon) => ({ x: (lon - B.lon0) * lonM, y: (lat - B.lat0) * LAT_M });
      const scale = B.scale * this.userScale;
      const ox = W / 2 + this.userPan.x, oy = H / 2 + this.userPan.y;
      const toPx = (p) => ({ x: ox + (p.x - B.cx) * scale, y: oy - (p.y - B.cy) * scale });
      const worldX = (px) => B.cx + (px - ox) / scale;
      const worldY = (py) => B.cy + (oy - py) / scale;

      // Grid over the visible world extent.
      const visSpan = Math.max(W, H) / scale;
      const gridM = niceDist(visSpan / 4);
      const wL = worldX(0), wR = worldX(W), wT = worldY(0), wB = worldY(H);
      ctx.strokeStyle = CSS.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (let gx = Math.ceil(wL / gridM) * gridM; gx <= wR; gx += gridM) { const px = toPx({ x: gx, y: 0 }).x; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
      for (let gy = Math.ceil(wB / gridM) * gridM; gy <= wT; gy += gridM) { const py = toPx({ x: 0, y: gy }).y; ctx.moveTo(0, py); ctx.lineTo(W, py); }
      ctx.stroke();

      // Tracks
      for (const b of boats) {
        const tr = b.track || [];
        if (tr.length > 1) {
          ctx.strokeStyle = b.color; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
          ctx.beginPath();
          tr.forEach((t, i) => { const p = toPx(proj(t.lat, t.lon)); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
          ctx.stroke(); ctx.globalAlpha = 1;
        }
      }

      // Waypoint marks (diamonds)
      for (const m of (this.data.marks || [])) {
        if (m.lat == null) continue;
        const p = toPx(proj(m.lat, m.lon)); const s = 6;
        ctx.strokeStyle = m.color || CSS.mark; ctx.fillStyle = 'rgba(255,209,102,0.18)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y); ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        if (m.name) { ctx.fillStyle = m.color || CSS.mark; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(m.name, p.x + s + 3, p.y); }
      }

      // Range line between the first two boats
      if (boats.length >= 2) {
        const a = toPx(proj(boats[0].lat, boats[0].lon));
        const c = toPx(proj(boats[1].lat, boats[1].lon));
        ctx.strokeStyle = CSS.axis; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.setLineDash([]);
        if (this.data.range != null) {
          const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
          const label = `${Math.round(this.data.range)} m` + (this.data.bearing != null ? `  ${String(Math.round(this.data.bearing)).padStart(3, '0')}°` : '');
          ctx.font = '11px ui-monospace, Menlo, monospace';
          const w = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(mx - w / 2 - 5, my - 9, w + 10, 18);
          ctx.fillStyle = '#1c2b38'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, mx, my);
        }
      }

      // Boat markers + heading ticks
      for (const b of boats) {
        const p = toPx(proj(b.lat, b.lon));
        const dir = (b.hdg != null ? b.hdg : b.cog);
        if (dir != null) {
          const r = dir * Math.PI / 180; ctx.strokeStyle = b.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(r) * 16, p.y - Math.cos(r) * 16); ctx.stroke();
        }
        ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1c2b38'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(b.name, p.x + 8, p.y - 6);
      }

      // North arrow
      ctx.strokeStyle = CSS.axis; ctx.fillStyle = CSS.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(18, 30); ctx.lineTo(18, 12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(18, 10); ctx.lineTo(14, 17); ctx.lineTo(22, 17); ctx.closePath(); ctx.fill();
      ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N', 18, 31);

      // Scale bar (reflects current zoom)
      const barM = niceDist(visSpan / 4);
      const barPx = barM * scale;
      const bx = W - 18 - barPx, by = H - 18;
      ctx.strokeStyle = CSS.axis; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
      ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4); ctx.stroke();
      ctx.fillStyle = CSS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, bx + barPx / 2, by - 6);

      if (this.locked) {
        ctx.fillStyle = CSS.faint; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('zoomed · Fit to reset', 8, 8);
      }
    }
  }

  root.TrackMap = TrackMap;
})(typeof globalThis !== 'undefined' ? globalThis : window);
