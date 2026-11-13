/* StoryForge Live — stage layer: the film frame around the landing reel, and the tick field behind About us.
   Vanilla JS, canvas 2D + Web Animations API. No dependencies. Loaded before app.js; starts on sf:ready, which app.js fires after fonts settle.
   Motion: transform/opacity on DOM, reduced-motion respected (the field is drawn still and the film does not run). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOVER = matchMedia('(hover: hover) and (pointer: fine)').matches;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CONCEPTS = ['ash', 'lunch', 'deck', 'salt'];
/* app.js is untouched: the Demand Index is read where the page already prints it, the leaderboard */
const read = id => {
  const r = $(`#boardEl .brow[data-id="${id}"]`); if (!r) return null;
  const b = $('.ti b', r), ix = parseFloat($('.v', r).textContent), err = parseFloat($('.e', r).textContent.replace(/[^0-9.]/g, ''));
  return isNaN(ix) ? null : { t: b && b.firstChild ? b.firstChild.textContent.trim() : '', ix, err: isNaN(err) ? 0 : err };
};

/* the frame fills the first screen under the sticky header; measured now (not at boot) so nothing shifts later */
const head = $('header.chrome'), fit = () => { if (head) document.documentElement.style.setProperty('--chrome-h', head.offsetHeight + 'px'); };
fit(); addEventListener('resize', fit); if (head && window.ResizeObserver) new ResizeObserver(fit).observe(head);

/* ---------- film frame: perforations run while the trailer plays, a cut pulls the film down ---------- */
function film() {
  const hero = $('.hero'), v = $('#heroVid'); if (!hero || !v) return;
  const runs = $$('.perf .run', hero), flash = $('.flash', hero), tc = $('#reelTc'), no = $('#reelNo'), ix = $('#reelIx');
  let first = true, raf = 0, last = '';
  const pull = () => {
    if (RM) return;
    const pitch = parseFloat(getComputedStyle(hero).getPropertyValue('--pitch')) || 30, n = first ? 16 : 10;
    runs.forEach(r => r.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-pitch * n}px)` }], { duration: first ? 1100 : 520, easing: first ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.4,0,.2,1)' }));
    if (!first && flash) flash.animate([{ opacity: 0 }, { opacity: .32, offset: .3 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
    first = false;
  };
  const label = d => {
    if (no) no.textContent = `Reel ${d.i + 1} of ${d.n}`;
    const s = read(d.id); if (ix) ix.innerHTML = s ? `Demand index <b>${s.ix.toFixed(1)}</b> ± ${s.err.toFixed(1)}` : '';
  };
  const title = $('#nowTitle'); let shown = '';
  const cut = () => { // app.js swaps the title as each new clip is loaded: that is the cut
    const t = title.textContent.trim(); if (t === shown) return; shown = t;
    const id = CONCEPTS.find(c => { const s = read(c); return s && s.t === t; });
    if (id) label({ i: CONCEPTS.indexOf(id), n: CONCEPTS.length, id });
    pull();
  };
  new MutationObserver(cut).observe(title, { childList: true, characterData: true, subtree: true });
  const stamp = () => {
    const t = v.currentTime || 0, m = Math.floor(t / 60), s = t - m * 60;
    const txt = String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
    if (txt !== last) { tc.textContent = last = txt; }
    raf = requestAnimationFrame(stamp);
  };
  const roll = on => { hero.classList.toggle('rolling', on && !RM); cancelAnimationFrame(raf); if (on && tc) raf = requestAnimationFrame(stamp); };
  v.addEventListener('playing', () => roll(true));
  ['pause', 'waiting', 'ended', 'emptied'].forEach(n => v.addEventListener(n, () => roll(false)));
  if (!v.paused) roll(true);
  cut(); // thread up on the first reel
}

/* ---------- about us: a field of ticks. Turbulent where the section opens, ordered where it ends.
   It parts around the copy, leans toward the pointer, and inside #fieldRead the ticks that fall within
   the current Demand Index hatch in, so the number is drawn by the field itself. ---------- */
function field() {
  const sec = $('#about'), cv = $('#field'), region = $('#fieldRead'); if (!sec || !cv || !cv.getContext) return;
  const ctx = cv.getContext('2d'), glyph = document.createElement('canvas'), gctx = glyph.getContext('2d', { willReadFrequently: true });
  let W = 0, H = 0, dpr = 1, g = 18, cols = 0, rows = 0, k = new Float32Array(0), gdata = null, gw = 0, gh = 0, gkey = '';
  let col = {}, vis = false, raf = 0, t0 = performance.now(), px = -9999, py = -9999, ci = 0, cur = null;
  const tone = () => { col = { tick: css('--tick') || '#C7D0DE', accent: css('--accent') || '#1568CF' }; };
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g = W < 768 ? 13 : 18; cols = Math.ceil(W / g) + 1; rows = Math.ceil(H / g) + 1;
    if (k.length !== cols * rows) k = new Float32Array(cols * rows);
    gkey = '';
  };
  /* the number, rasterised once per change into an alpha map the ticks sample */
  const ink = (w, h) => {
    if (!cur || w < 40 || h < 40) { gdata = null; return; }
    const txt = cur.ix.toFixed(0), key = txt + '|' + w + '|' + h; if (key === gkey) return; gkey = key;
    gw = glyph.width = Math.round(w); gh = glyph.height = Math.round(h);
    const fs = Math.min(h * .9, w * .8 / (.62 * txt.length));
    gctx.clearRect(0, 0, gw, gh); gctx.fillStyle = '#000'; gctx.textAlign = 'center'; gctx.textBaseline = 'alphabetic';
    gctx.font = `800 ${fs}px ${css('--display') || 'sans-serif'}`;
    const m = gctx.measureText(txt), asc = m.actualBoundingBoxAscent || fs * .72;
    gctx.fillText(txt, gw / 2, (gh - 28 + asc) / 2); // sits above the caption line
    gdata = gctx.getImageData(0, 0, gw, gh).data;
  };
  const caption = () => {
    const a = $('#frIx'), b = $('#frT'); if (!cur || !a || !b) return;
    a.textContent = `${cur.ix.toFixed(1)} ± ${cur.err.toFixed(1)}`; b.textContent = cur.t;
    if (!RM) [a, b].forEach(el => { el.classList.remove('sw'); void el.offsetWidth; el.classList.add('sw'); });
  };
  const next = step => { ci = (ci + step + CONCEPTS.length) % CONCEPTS.length; cur = read(CONCEPTS[ci]); gkey = ''; caption(); };
  const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

  function draw(now) {
    raf = 0; if (!vis) return;
    const t = RM ? 0 : (now - t0) / 1000;
    const cr = cv.getBoundingClientRect(), sr = sec.getBoundingClientRect(), offY = cr.top - sr.top, secH = sr.height || 1;
    const clear = $$('[data-clear]', sec).map(el => { const r = el.getBoundingClientRect(); return [r.left - cr.left - 14, r.top - cr.top - 12, r.right - cr.left + 14, r.bottom - cr.top + 12]; }).filter(r => r[3] > -60 && r[1] < H + 60);
    let rx = 0, ry = 0, rw = 0, rh = 0;
    if (region) { const r = region.getBoundingClientRect(); rx = r.left - cr.left; ry = r.top - cr.top; rw = r.width; rh = r.height; ink(rw, rh); }
    const lx = px - cr.left, ly = py - cr.top, R = 150;
    const quiet = new Path2D(), loud = new Path2D(), inked = new Path2D();
    let moving = false;
    for (let j = 0; j < rows; j++) {
      const y = j * g + g / 2, wy = y + offY, order = smooth(.3, .92, wy / secH), wild = 1 - order;
      for (let i = 0; i < cols; i++) {
        const x = i * g + g / 2, id = j * cols + i;
        /* how much of the tick survives next to copy */
        let keep = 1;
        for (let c = 0; c < clear.length; c++) { const r = clear[c], dx = Math.max(r[0] - x, 0, x - r[2]), dy = Math.max(r[1] - y, 0, y - r[3]), d = Math.hypot(dx, dy); if (d < 44) { keep = Math.min(keep, smooth(0, 44, d)); if (keep < .04) break; } }
        /* is this tick inside the number */
        let on = 0;
        if (gdata && keep > .04) { const u = Math.round(x - rx), w = Math.round(y - ry); if (u >= 0 && w >= 0 && u < gw && w < gh && gdata[(w * gw + u) * 4 + 3] > 96) on = 1; }
        let kv = k[id]; if (RM) kv = on; else if (kv !== on) { kv += (on - kv) * .16; if (Math.abs(on - kv) < .01) kv = on; else moving = true; } k[id] = kv;
        if (keep < .04 && kv < .04) continue;
        /* flow: three slow sines, sampled in page space so the pattern travels with the scroll */
        const f = Math.sin(x * .0061 + t * .21) * Math.cos(wy * .0052 - t * .16) + .6 * Math.sin((x + wy) * .0033 + t * .11) + .35 * Math.sin(x * .013 - wy * .009 + t * .27);
        let ang = f * 1.9 * wild, len = (9 - 4 * order) * keep, loudTick = wild > .25 && f > 1.22;
        if (HOVER && !RM) { const dx = lx - x, dy = ly - y, d = Math.hypot(dx, dy); if (d < R) { const s = (1 - d / R) ** 2; ang += (Math.atan2(dy, dx) - ang) * s; len += 5 * s * keep; if (s > .3) loudTick = true; } }
        if (kv > .02) { ang += (-1.02 - ang) * kv; len = len * (1 - kv) + 12 * kv; }
        if (len < .6) continue;
        const hx = Math.cos(ang) * len / 2, hy = Math.sin(ang) * len / 2, p = kv > .5 ? inked : loudTick ? loud : quiet;
        p.moveTo(x - hx, y - hy); p.lineTo(x + hx, y + hy);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.lineCap = 'round';
    ctx.strokeStyle = col.tick; ctx.lineWidth = 1; ctx.stroke(quiet);
    ctx.strokeStyle = col.accent; ctx.globalAlpha = .7; ctx.lineWidth = 1.1; ctx.stroke(loud);
    ctx.globalAlpha = 1; ctx.lineWidth = 1.7; ctx.stroke(inked);
    if (!RM || moving) raf = requestAnimationFrame(draw);
  }
  const kick = () => { if (vis && !raf) raf = requestAnimationFrame(draw); };

  tone(); size(); next(0);
  new MutationObserver(() => { tone(); kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; kick(); }, { rootMargin: '80px 0px' }).observe(sec);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { size(); kick(); }, 120); });
  addEventListener('scroll', kick, { passive: true }); // reduced motion: the still field is redrawn only as the page moves
  if (HOVER && !RM) { addEventListener('pointermove', e => { px = e.clientX; py = e.clientY; }, { passive: true }); document.addEventListener('pointerleave', () => { px = py = -9999; }); }
  document.addEventListener('sf:event', e => { if (e.detail && e.detail.name === 'vote') { cur = read(CONCEPTS[ci]); gkey = ''; caption(); kick(); } }); // a vote moves the index, so redraw the number
  let seen = false;
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; }, { threshold: .35 }).observe(region || sec);
  if (!RM) setInterval(() => { if (seen && !document.hidden) next(1); }, 5200);
}

function boot() { if (boot.done) return; boot.done = true; film(); field(); }
document.addEventListener('sf:ready', boot);
if (window.SF) boot(); else setTimeout(boot, 2500);
})();
