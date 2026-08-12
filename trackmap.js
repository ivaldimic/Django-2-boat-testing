/* Offline track plot: draws boats and their tracks in a local north-up plane
 * (equal metres on both axes), auto-fitting the view, with a range line between
 * the boats and a scale bar. No tiles, no network. */
(function (root) {
  const CSS = {
    grid: 'rgba(120,170,200,0.10)',
    axis: 'rgba(120,170,200,0.5)',
    text: '#7f9bb0',
    faint: '#4d6a80',
  };
  const LAT_M = 111132;

  function niceDist(x) {
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
      this._onResize = () => { this._resize(); this.draw(); };
      window.addEventListener('resize', this._onResize);
      this._resize();
    }
    destroy() { window.removeEventListener('resize', this._onResize); }

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

    // data: { boats: [{ name, color, lat, lon, hdg, cog, track:[{lat,lon}] }], range, bearing }
    setData(data) { this.data = data || { boats: [] }; this.draw(); }

    draw() {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.clearRect(0, 0, W, H);
      if (W <= 4 || H <= 4) return;

      const boats = (this.data.boats || []).filter((b) => b.lat != null && b.lon != null);
      if (!boats.length) {
        ctx.fillStyle = CSS.faint;
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Waiting for position fixes…', W / 2, H / 2);
        return;
      }

      // reference for the local projection
      const lat0 = boats.reduce((s, b) => s + b.lat, 0) / boats.length;
      const lonM = LAT_M * Math.cos(lat0 * Math.PI / 180);
      const proj = (lat, lon) => ({ x: (lon - boats[0].lon) * lonM, y: (lat - lat0) * LAT_M });

      // collect all points to fit
      const pts = [];
      for (const b of boats) {
        pts.push(proj(b.lat, b.lon));
        for (const t of (b.track || [])) pts.push(proj(t.lat, t.lon));
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
      let spanX = maxX - minX, spanY = maxY - minY;
      const minSpan = 40; // metres, so overlapping boats don't zoom to infinity
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      spanX = Math.max(spanX, minSpan); spanY = Math.max(spanY, minSpan);

      const pad = 26;
      const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
      const toPx = (p) => ({ x: W / 2 + (p.x - cx) * scale, y: H / 2 - (p.y - cy) * scale });

      // grid
      const gridM = niceDist(Math.max(spanX, spanY) / 4);
      ctx.strokeStyle = CSS.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.ceil((cx - spanX) / gridM) * gridM; gx <= cx + spanX; gx += gridM) {
        const px = toPx({ x: gx, y: cy }).x; ctx.moveTo(px, 0); ctx.lineTo(px, H);
      }
      for (let gy = Math.ceil((cy - spanY) / gridM) * gridM; gy <= cy + spanY; gy += gridM) {
        const py = toPx({ x: cx, y: gy }).y; ctx.moveTo(0, py); ctx.lineTo(W, py);
      }
      ctx.stroke();

      // tracks
      for (const b of boats) {
        const tr = b.track || [];
        if (tr.length > 1) {
          ctx.strokeStyle = b.color; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
          ctx.beginPath();
          tr.forEach((t, i) => { const p = toPx(proj(t.lat, t.lon)); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
          ctx.stroke(); ctx.globalAlpha = 1;
        }
      }

      // range line between the first two boats
      if (boats.length >= 2) {
        const a = toPx(proj(boats[0].lat, boats[0].lon));
        const c = toPx(proj(boats[1].lat, boats[1].lon));
        ctx.strokeStyle = CSS.axis; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        ctx.setLineDash([]);
        if (this.data.range != null) {
          const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
          const label = `${Math.round(this.data.range)} m` + (this.data.bearing != null ? `  ${String(Math.round(this.data.bearing)).padStart(3, '0')}°` : '');
          ctx.font = '11px ui-monospace, Menlo, monospace';
          const w = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(8,21,33,0.85)'; ctx.fillRect(mx - w / 2 - 5, my - 9, w + 10, 18);
          ctx.fillStyle = '#dceaf4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(label, mx, my);
        }
      }

      // boat markers + heading ticks
      for (const b of boats) {
        const p = toPx(proj(b.lat, b.lon));
        const dir = (b.hdg != null ? b.hdg : b.cog);
        if (dir != null) {
          const r = dir * Math.PI / 180;
          ctx.strokeStyle = b.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(r) * 16, p.y - Math.cos(r) * 16); ctx.stroke();
        }
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#dceaf4'; ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(b.name, p.x + 8, p.y - 6);
      }

      // north arrow
      ctx.strokeStyle = CSS.axis; ctx.fillStyle = CSS.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(18, 30); ctx.lineTo(18, 12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(18, 10); ctx.lineTo(14, 17); ctx.lineTo(22, 17); ctx.closePath(); ctx.fill();
      ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('N', 18, 31);

      // scale bar
      const barM = niceDist(spanX / 4);
      const barPx = barM * scale;
      const bx = W - 18 - barPx, by = H - 18;
      ctx.strokeStyle = CSS.axis; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
      ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
      ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4); ctx.stroke();
      ctx.fillStyle = CSS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, bx + barPx / 2, by - 6);
    }
  }

  root.TrackMap = TrackMap;
})(typeof globalThis !== 'undefined' ? globalThis : window);
