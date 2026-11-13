/* StoryForge Live — interaction layer. Vanilla JS, CSS transitions + Web Animations API only.
   Motion: one easing (--ease), three durations, transform/opacity only, reduced-motion respected. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOVER = matchMedia('(hover: hover) and (pointer: fine)').matches;
const EASE = 'cubic-bezier(.16,1,.3,1)';
const KEY = 'sf-live-v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const S = Object.assign({ votes: {}, watch: {}, doors: { watch: 0, write: 0, buy: 0 }, signed: null, sim: true, theme: 'dark' }, load());
const emit = (name, props = {}) => document.dispatchEvent(new CustomEvent('sf:event', { detail: { name, props } })); // growth.js listens: analytics, rewards
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode: state lives for the session only */ } };

/* ---------- data ---------- */
const M = 'media/'; // each player adds its own ?c= tag: Chrome serialises same-URL media requests, which stalls a second player on one file
const ITEMS = {
  ash: { t: 'Ash Wednesday', g: 'Horror', cat: 'horror', f: 'ash-wednesday', dur: '0:28', concept: true, w: 262,
    log: 'In a Welsh mining valley, a chapel warden wakes to a hillside of cross-shaped scorch marks. Then the ash starts spelling names.',
    tags: ['folk horror', 'slow dread', 'small town', 'faith'], prov: 'Three 8-second shots plus title card. Logged render cost: $1.20 per shot.',
    dna: { hook: .86, conflict: .7, stakes: .78, warmth: .32, darkness: .92, humor: .08, arc: .66 } },
  lunch: { t: 'The Long Way to Lunch', g: 'Animated adventure', cat: 'adventure', f: 'long-way-to-lunch', dur: '0:07', concept: true, w: 248,
    log: 'A food writer and his golden retriever canoe upriver to find the one dumpling he never got to taste, before the jungle kitchen closes for good.',
    tags: ['warm', 'wanderlust', 'buddy comedy', 'food-obsessed'], prov: 'Founder-generated render, first shot of the trailer.',
    dna: { hook: .72, conflict: .44, stakes: .5, warmth: .94, darkness: .12, humor: .8, arc: .7 } },
  deck: { t: 'Deck Nine', g: 'Sci-fi', cat: 'scifi', f: 'deck-nine', dur: '0:10', concept: true, sample: true, w: 204,
    log: 'The last crew member awake on a failing station is its rescue dog, and he still answers the alarm.',
    tags: ['survival', 'loyalty', 'contained', 'creature-eye view'], prov: 'Single-prompt render. Sample title and logline.',
    dna: { hook: .78, conflict: .62, stakes: .74, warmth: .68, darkness: .55, humor: .2, arc: .58 } },
  salt: { t: 'The Salt Map', g: 'Mystery', cat: 'mystery', f: 'salt-map', dur: '0:08', concept: true, sample: true, w: 188,
    log: 'Two retired academics inherit a map that redraws itself every night. Tonight it shows their own street.',
    tags: ['puzzle box', 'late-life leads', 'warm dread', 'two-hander'], prov: 'Dialogue test render. Sample title and logline.',
    dna: { hook: .68, conflict: .52, stakes: .48, warmth: .74, darkness: .4, humor: .3, arc: .62 } },
  ashN: { t: 'Ash Wednesday · “The ash is spelling names”', g: 'Shot 3 of 3', cat: 'render', f: 'ash-shot-names', dur: '0:08',
    log: 'The closing shot on its own: ash arranging itself into handwriting, one whispered line, hard cut to black.', tags: ['single shot', 'dialogue', 'the button'], prov: 'One Veo shot. Logged render cost: $1.20.' },
  ashA: { t: 'Ash Wednesday · opening, render A', g: 'Render test', cat: 'render', f: 'ash-render-a', dur: '0:08',
    log: 'The valley from above: slag heaps, chimneys, low cloud at dawn.', tags: ['establishing shot', 'render A'], prov: 'Several renders per concept: same beat, different take.' },
  ashB: { t: 'Ash Wednesday · opening, render B', g: 'Render test', cat: 'render', f: 'ash-render-b', dur: '0:08',
    log: 'The pithead up close: winding gear, wet road, smoke off the stacks.', tags: ['establishing shot', 'render B'], prov: 'Several renders per concept: same beat, different take.' }
};
Object.entries(ITEMS).forEach(([id, c]) => { c.id = id; c.src = M + c.f + '.mp4'; c.poster = M + c.f + '.jpg'; });
const NT = [ // sample slate entries with no trailer rendered yet
  { id: 'harrow', t: 'Harrow Season', g: 'Horror', w: 236 }, { id: 'nine', t: 'Nine Quiet Floors', g: 'Thriller', w: 224 },
  { id: 'low', t: 'Low Orbit Motel', g: 'Sci-fi', w: 196 }, { id: 'kind', t: 'The Kindling Hour', g: 'Horror', w: 152 }, { id: 'dead', t: 'Dead Reckoner', g: 'Thriller', w: 136 }
];
const BASE_N = 400;
const ROUNDS = [
  { id: 'r1', a: 'ash', b: 'salt', q: 'Which would you watch?', base: [236, 164] },
  { id: 'r2', a: 'lunch', b: 'deck', q: 'Two dogs, two worlds. Which would you watch?', base: [229, 171] },
  { id: 'r3', a: 'ashA', b: 'ashB', q: 'Same concept, two renders. Which opens the film better?', base: [188, 212], render: true }
];
const LIB = ['ash', 'lunch', 'deck', 'salt', 'ashN', 'ashA', 'ashB'];
const ANCHORS = [['Smile', 2022, 'BcDK7lkzzsU'], ['Talk to Me', 2023, 'aLAKJu9aJys'], ['M3GAN', 2022, 'BRb4U99OU80'], ['Longlegs', 2024, '48wg-_VzD04'], ['Barbarian', 2022, 'Dr89pmKrqkI'], ['Terrifier 2', 2022, '6KkONLf_ZKU'], ['Skinamarink', 2023, 'APQqilSTxz0'], ['Paranormal Activity', 2007, '5od3NGHrXrI']];
/* unreleased films: titles, dates, art and official trailer keys pulled from TMDB on 10 Nov 2026 */
const UPCOMING = [{"id": 1003596, "t": "Avengers: Doomsday", "d": "2026-12-18", "g": "Science Fiction · Action", "yt": "irVNGjRFZGk", "b": "/rObL4of4eFA8yWaN9pRFo9aOVNi.jpg", "col": "The Avengers Collection", "vt": "Official Trailer"}, {"id": 1300968, "t": "The Hunger Games: Sunrise on the Reaping", "d": "2026-11-20", "g": "Science Fiction · Action", "yt": "fS35YSjopjE", "b": "/aqFZcr2dxSZ2UwWSo1WC6C0rwDf.jpg", "col": "The Hunger Games – New Trilogy Collection", "vt": "Official Trailer"}, {"id": 1170608, "t": "Dune: Part Three", "d": "2026-12-18", "g": "Science Fiction · Adventure", "yt": "3_9vCamtuPY", "b": "/i5E9H7Ik0u61ylDDTbmUpTL3Yw.jpg", "col": "Dune Collection", "vt": "Official Teaser Trailer"}, {"id": 1538497, "t": "Hexed", "d": "2026-11-25", "g": "Adventure · Animation", "yt": "mtC4sjABZNw", "b": "/wZ9Me7OndzgBOEAa8nSBNPu3Sl4.jpg", "col": null, "vt": "Teaser Trailer"}, {"id": 1400336, "t": "Focker-in-Law", "d": "2026-11-25", "g": "Comedy · Romance", "yt": "vyISuWUWcFs", "b": "/AttXyiHvoOlqYXmAgO8EmgSt5ZC.jpg", "col": "Meet the Parents Collection", "vt": "Official Trailer"}, {"id": 1457866, "t": "The Further Mis-Adventures of Cliff Booth", "d": "2026-11-25", "g": "Drama · Comedy", "yt": "RjEZaUBbUvU", "b": "/qqPspJFy0XrEoVTKZdp0Em7kej6.jpg", "col": "Once Upon a Time... in Hollywood Collection", "vt": "Official Trailer"}, {"id": 1260649, "t": "Jumanji: Open World", "d": "2026-12-25", "g": "Adventure · Comedy", "yt": "zhApeaHMvfs", "b": "/vaYfhMuwFwsMqyMnu9amtS9hUHE.jpg", "col": "Jumanji Collection", "vt": "Official Trailer"}, {"id": 1440769, "t": "The Beekeeper 2", "d": "2027-01-15", "g": "Action · Crime", "yt": "5HK3wimDxBI", "b": "/zdZmiPdzrBlioFVvROuA57kPs4G.jpg", "col": "The Beekeeper Collection", "vt": "Official Teaser Trailer"}, {"id": 1340208, "t": "Karōshi", "d": "2027-02-05", "g": "Action · Thriller", "yt": "jQHoAsDcjVU", "b": "/9BV0sX13uzERMgamOFslyFD5Dqk.jpg", "col": null, "vt": "Official Trailer"}, {"id": 1147572, "t": "Narnia: The Magician's Nephew", "d": "2027-02-12", "g": "Fantasy · Adventure", "yt": "gDJ-ini7fF0", "b": "/3jA1wHHFl3lUcVdGXq4ZsBscHCU.jpg", "col": null, "vt": "Official Trailer"}, {"id": 1421903, "t": "Werwulf", "d": "2026-12-25", "g": "Horror", "yt": "cmjpadVj-Vk", "b": "/jmW9NkzbpI9vhyxJU2x644Nj7VU.jpg", "col": null, "vt": "Official Trailer"}, {"id": 1297467, "t": "The Exorcist: Martyrs", "d": "2027-03-12", "g": "Horror", "yt": "iIEYfH-jg1Y", "b": "/e0pOcLgfYVDfeGDB1oEv8JUlc41.jpg", "col": null, "vt": "Official Trailer"}, {"id": 940009, "t": "Ray Gunn", "d": "2026-12-04", "g": "Animation · Science Fiction", "yt": "VL-xjzQFWsY", "b": "/hhBoWDKmq9u8V2qi0Rtm3XGiydn.jpg", "col": null, "vt": "Official Trailer"}, {"id": 1492198, "t": "Artificial", "d": "2026-12-25", "g": "Comedy · Drama", "yt": "rDZplZFnbOk", "b": "/qt79gpmITExaeb3Y74gxgkVSvaZ.jpg", "col": null, "vt": "Official Teaser Trailer"}];
const sim = { w: {}, n: {}, total: 0 };

/* ---------- maths: index = share of head-to-head wins, 95% sampling interval ---------- */
function stat(id) {
  const c = ITEMS[id] || NT.find(x => x.id === id);
  let w = c.w + (sim.w[id] || 0), n = BASE_N + (sim.n[id] || 0);
  ROUNDS.forEach(r => { const v = S.votes[r.id]; if (r.render || !v) return; if (r.a === id || r.b === id) { n++; if (r[v] === id) w++; } });
  const p = w / n;
  return { w, n, p, ix: p * 100, err: 196 * Math.sqrt(p * (1 - p) / n) };
}
function roundCounts(r) { const v = S.votes[r.id]; return [r.base[0] + (v === 'a' ? 1 : 0), r.base[1] + (v === 'b' ? 1 : 0)]; }
const totalReads = () => ROUNDS.reduce((s, r) => s + roundCounts(r)[0] + roundCounts(r)[1], 0) + sim.total;

/* ---------- helpers ---------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
function countTo(el, to, { dec = 0, suf = '', dur = 900 } = {}) {
  if (RM) { el.textContent = to.toFixed(dec) + suf; return; }
  const t0 = performance.now();
  const f = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.textContent = (to * e).toFixed(dec) + suf; if (k < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
function movePill(seg) {
  const on = $('[aria-pressed="true"],[aria-selected="true"]', seg), pill = $('.pill', seg); if (!on || !pill) return;
  pill.style.width = on.offsetWidth + 'px'; pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
const safePlay = v => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
const ringHTML = ix => `<span class="ring" data-ix="${ix.toFixed(0)}"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="bg" cx="24" cy="24" r="20"/><circle class="fg" cx="24" cy="24" r="20"/></svg><b>${ix.toFixed(0)}</b></span>`;
const drawRings = root => $$('.ring', root).forEach(r => { $('.fg', r).style.strokeDashoffset = 126 - 126 * (+r.dataset.ix) / 100; });

/* ---------- hero reel ---------- */
function hero() {
  const v = $('#heroVid'), list = ['ash', 'lunch', 'deck', 'salt'], bar = $('#nowBar'), snd = $('#heroSnd'); let i = 0, visible = true;
  function show(k) {
    i = (k + list.length) % list.length; const c = ITEMS[list[i]];
    v.classList.remove('on');
    setTimeout(() => {
      v.poster = c.poster; v.src = c.src + '?c=hero'; v.load();
      $('#nowTitle').textContent = c.t; $('#nowMeta').textContent = `${c.g} · AI concept trailer · ${c.dur}`; bar.style.transform = 'scaleX(0)';
      v.classList.add('on'); // the poster carries the frame until the clip is ready
      if (!RM && visible) safePlay(v);
    }, RM ? 0 : 420);
  }
  v.addEventListener('playing', () => v.classList.add('on'));
  v.addEventListener('loadeddata', () => v.classList.add('on'));
  v.addEventListener('timeupdate', () => { if (v.duration) bar.style.transform = `scaleX(${v.currentTime / v.duration})`; });
  v.addEventListener('ended', () => show(i + 1));
  v.addEventListener('error', () => show(i + 1), { once: true });
  $('#heroNext').addEventListener('click', () => show(i + 1));
  snd.addEventListener('click', () => { v.muted = !v.muted; snd.textContent = v.muted ? 'SOUND OFF' : 'SOUND ON'; snd.setAttribute('aria-pressed', String(!v.muted)); if (!v.muted) safePlay(v); });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (RM) return; visible ? safePlay(v) : v.pause(); }, { threshold: .15 }).observe($('.hero'));
  hero.pause = () => v.pause(); hero.resume = () => { if (visible && !RM) safePlay(v); };
  show(0);
}

/* ---------- ticker ---------- */
function ticker() {
  const items = ['<em>LIVE</em> 3 face-offs tonight', 'Ash Wednesday <em>' + stat('ash').ix.toFixed(1) + ' ± ' + stat('ash').err.toFixed(1) + '</em>', '400 paired reads per concept', 'Render cost <em>$1.20</em> per 8-second shot', 'The Long Way to Lunch <em>▲</em>', 'Test screening <em>$25K</em> · StoryForge read <em>&lt;$200</em>', 'Panel: US · UK · 18–34', '<em>NOT OUT YET</em> ' + UPCOMING.length + ' official trailers', '9 of 10 top US films in 2024 were sequels', 'The renderer is replaceable. <em>The ledger is the moat.</em>'];
  const h = items.map(t => `<span>${t}</span>`).join(''); $('#track').innerHTML = h + h;
}

/* ---------- problem: when does the audience get asked ---------- */
function chain() {
  const seg = $('#chainSeg'), pin = $('#pin'), st = $$('#stages .st');
  const set = k => {
    $$('button', seg).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === k))); movePill(seg);
    const sf = k === 'sf';
    pin.style.transform = `translateX(${sf ? 0 : 400}%)`; $('#pinLab').textContent = sf ? 'StoryForge read' : 'First audience read';
    st.forEach((s, i) => s.classList.toggle('spent', !sf && i < 5));
    $('#readCost').textContent = sf ? '<$200' : '$25K';
    $('#readNote').textContent = sf ? '≈ $100 render + ≈ $70 paid panel, before a dollar of production. The read moves from the end of the chain to the start.' : 'Recruited test screening, at rough cut. Measures the film, not the concept, and arrives too late to change the bet.';
  };
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) set(b.dataset.k); });
  set('today'); chain.set = set;
}

/* ---------- face-off ---------- */
let cur = 0, foVisible = false;
const foVideos = () => $$('#fo video');
function sideHTML(c, L, r) {
  return `<article class="side ${L} enter" data-s="${L}">
    <div class="screen"><video playsinline muted loop preload="metadata" poster="${c.poster}" src="${c.src}?c=fo"></video>
      <span class="tag">Real AI render · ${c.dur}</span><span class="tag r">${c.g}</span><span class="tag mine">Your read</span>
      <button class="pp" aria-label="Play or pause ${c.t}"><span></span></button><span class="tl"><i></i></span></div>
    <div class="meta"><h3>${c.t}${c.sample ? ' <span class="illus">sample title</span>' : ''}</h3><p class="log">${c.log}</p></div>
    <div class="row"><button class="snd" aria-pressed="false">▶ PLAY WITH SOUND</button><button class="btn primary pick" data-cta="${r.render ? 'This render' : 'I’d watch this'} ${L.toUpperCase()}">${r.render ? 'This render' : 'I’d watch this'} <span class="kbd">${L.toUpperCase()}</span></button></div>
    <div class="res" hidden><div class="pct"><b class="num">0%</b><span class="num"></span></div><div class="track"><div class="fill"></div></div></div>
  </article>`;
}
function renderRound(k, instant) {
  cur = k; const r = ROUNDS[k], fo = $('#fo');
  $('#foLabel').textContent = `Tonight’s face-off · ${k + 1} of ${ROUNDS.length}${r.render ? ' · render test' : ''}`;
  $('#foQ').textContent = r.q;
  $$('#foDots i').forEach((d, i) => { d.className = S.votes[ROUNDS[i].id] ? 'done' : i === k ? 'cur' : ''; });
  fo.classList.remove('done');
  fo.innerHTML = sideHTML(ITEMS[r.a], 'a', r) + '<span class="vs" aria-hidden="true">VS</span>' + sideHTML(ITEMS[r.b], 'b', r);
  $$('.side', fo).forEach(side => {
    const v = $('video', side), scr = $('.screen', side), snd = $('.snd', side), tl = $('.tl i', side);
    v.addEventListener('playing', () => scr.classList.add('playing'));
    v.addEventListener('pause', () => scr.classList.remove('playing'));
    v.addEventListener('timeupdate', () => { if (v.duration) tl.style.transform = `scaleX(${v.currentTime / v.duration})`; });
    $('.pp', side).addEventListener('click', () => v.paused ? safePlay(v) : v.pause());
    snd.addEventListener('click', () => {
      const on = v.muted;
      foVideos().forEach(o => { o.muted = true; }); $$('#fo .snd').forEach(b => { b.textContent = '▶ PLAY WITH SOUND'; b.setAttribute('aria-pressed', 'false'); });
      if (on) { v.muted = false; v.currentTime = 0; safePlay(v); snd.textContent = '■ SOUND OFF'; snd.setAttribute('aria-pressed', 'true'); hero.pause(); }
    });
    $('.pick', side).addEventListener('click', () => pick(side.dataset.s));
  });
  if (foVisible && !RM) foVideos().forEach(safePlay);
  if (S.votes[r.id]) showResult(true); else $('#foFoot').innerHTML = `<p>Watch both, then pick one. <b>The tap is the vote.</b> Press <span class="kbd">A</span> or <span class="kbd">B</span> on a keyboard.</p>`;
  if (instant) $$('.side', fo).forEach(s => s.classList.remove('enter'));
}
function pick(s) {
  const r = ROUNDS[cur]; if (S.votes[r.id]) return;
  S.votes[r.id] = s; save(); showResult(false); emit('vote', { round: r.id, pick: r[s] });
  const picked = ITEMS[r[s]]; if (picked.concept) board.update(picked.id);
  $('#liveReads').textContent = totalReads().toLocaleString();
}
function showResult(restored) {
  const r = ROUNDS[cur], v = S.votes[r.id], [a, b] = roundCounts(r), n = a + b, fo = $('#fo'), win = a >= b ? 'a' : 'b';
  fo.classList.add('done');
  $$('#foDots i').forEach((d, i) => { d.className = S.votes[ROUNDS[i].id] ? 'done' : ''; });
  $$('.side', fo).forEach(side => {
    const L = side.dataset.s, cnt = L === 'a' ? a : b, pct = cnt / n * 100, res = $('.res', side);
    side.classList.toggle('win', L === win); side.classList.toggle('lose', L !== win); side.classList.toggle('mine', L === v);
    $('.pick', side).disabled = true; $('.pick', side).innerHTML = L === v ? 'Your pick ✓' : 'Not picked';
    res.hidden = false; $('.pct span', res).textContent = `${cnt} of ${n} reads`;
    restored ? $('.pct b', res).textContent = pct.toFixed(1) + '%' : countTo($('.pct b', res), pct, { dec: 1, suf: '%' });
    requestAnimationFrame(() => requestAnimationFrame(() => { $('.fill', res).style.transform = `scaleX(${pct / 100})`; }));
  });
  const agreed = v === win, last = cur === ROUNDS.length - 1, allDone = ROUNDS.every(x => S.votes[x.id]);
  $('#foFoot').innerHTML = `<p>${agreed ? '<b>You sided with the panel.</b>' : '<b>You went against the panel.</b>'} Your read is counted: n = ${n}. ${r.render ? 'Render tests pick the cut that goes to the panel; they never touch the Demand Index.' : 'One tap moved the index by a fraction of a point, which is the point: it takes 400 to make a number.'}</p>
    <button class="btn primary" id="foNext">${last ? (allDone ? 'Issue my Demand Certificate ↓' : 'Back to round 1') : 'Next face-off →'}</button>`;
  $('#foNext').addEventListener('click', () => {
    if (!last) return swapRound(cur + 1);
    if (allDone) { cert(true); } else swapRound(0);
  });
  if (allDone && restored) cert(false);
}
function swapRound(k) {
  const sides = $$('#fo .side');
  if (RM || !sides.length) return renderRound(k);
  sides.forEach(s => { s.classList.remove('enter'); s.classList.add('leave'); });
  setTimeout(() => renderRound(k), 240);
}
function faceoff() {
  const first = ROUNDS.findIndex(r => !S.votes[r.id]);
  renderRound(first < 0 ? ROUNDS.length - 1 : first, true);
  new IntersectionObserver(([e]) => { foVisible = e.isIntersecting; foVideos().forEach(v => (foVisible && !RM && !$('#theater').open) ? safePlay(v) : v.pause()); }, { threshold: .25 }).observe($('#fo'));
  addEventListener('keydown', e => {
    if (!foVisible || $('#theater').open || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase(); if (k === 'a' || k === 'b') pick(k);
  });
}

/* ---------- demand certificate + matching preview ---------- */
const BUYERS = {
  horror: [['Genre label · mid-size studio', 'Greenlights 4–6 features a year at $3–15M', 92], ['Streamer horror vertical', 'US + UK · elevated folk horror on the wishlist', 84], ['Independent financier', 'Contained locations, under $8M', 77]],
  adventure: [['Family animation label', 'Original features, $25–40M', 90], ['Streamer kids & family', 'Food and travel co-viewing slate', 82], ['Co-production fund · APAC', 'Animated road-trip comedies', 74]],
  scifi: [['Streamer sci-fi vertical', 'Contained survival, one location', 88], ['Genre label · mid-size studio', 'Creature-led originals at $10–20M', 81], ['Independent financier', 'Animal-lead family crossover', 70]],
  mystery: [['Premium TV limited-series desk', 'Two-hander mysteries, 6 × 45', 86], ['Streamer drama vertical', 'Older-skewing leads, UK panel strength', 79], ['Independent producer', 'Puzzle-box features under $6M', 71]]
};
function cert(scroll) {
  const picks = ROUNDS.filter(r => !r.render).map(r => ITEMS[r[S.votes[r.id]]]);
  const top = picks.sort((x, y) => stat(y.id).ix - stat(x.id).ix)[0], st = stat(top.id);
  let agree = 0;
  const rows = ROUNDS.map((r, i) => { const [a, b] = roundCounts(r), n = a + b, v = S.votes[r.id], win = a >= b ? 'a' : 'b', ok = v === win; if (ok) agree++;
    return `<div><span>R${i + 1} · ${ITEMS[r[v]].t}</span><span class="num">${(a / n * 100).toFixed(1)} – ${(b / n * 100).toFixed(1)}</span><span class="${ok ? 'ok' : 'no'}">${ok ? 'WITH PANEL' : 'AGAINST'}</span></div>`; }).join('');
  const serial = 'SF-' + (Object.values(S.votes).join('').split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 2026) % 0xFFFFF).toString(16).toUpperCase().padStart(5, '0');
  const d = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const w = $('#certWrap');
  w.innerHTML = `<div class="cert" aria-label="Demand Certificate">
      <div class="hd"><span class="label">Demand Certificate · specimen</span><span class="label num">${serial} · ${d}</span></div>
      <span class="stamp" aria-hidden="true">COUNTED · N = 1</span>
      <div><h3 style="font-size:clamp(1.5rem,1.2rem + 1.4vw,2.2rem)">${top.t}</h3><span class="label">${top.g} · concept trailer · your strongest pick</span></div>
      <div class="ix"><span class="big num">${st.ix.toFixed(1)}</span><span class="pm num">± ${st.err.toFixed(1)} · 95% · sampling error only</span></div>
      <div class="ebar" aria-hidden="true"><span class="mid"></span><span class="ci" style="left:${st.ix - st.err}%;width:${st.err * 2}%"></span><span class="pt" style="left:${st.ix}%"></span></div>
      <span class="label" style="text-transform:none;letter-spacing:.03em">Share of head-to-head wins across ${st.n} paired reads (sample panel + you). 50 is a coin flip.</span>
      <div class="ballot">${rows}</div>
      <p style="color:var(--muted);font-size:.9rem">You agreed with the panel on <b style="color:var(--text)">${agree} of ${ROUNDS.length}</b>. On the live platform, agreement on released-film anchors is what earns a panellist more weight.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary sm" href="#board">See it on the leaderboard</a><button class="btn sm" id="certWatch">Watch the trailer</button><button class="btn sm" data-share="cert" data-id="${top.id}" data-text="I backed ${top.t} on StoryForge: Demand Index ${st.ix.toFixed(1)} ± ${st.err.toFixed(1)}. Which would you watch?">Share my pick</button><button class="btn ghost sm" id="certAgain">Vote again</button></div>
    </div>
    <div class="match"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><span class="label">Next · injection 3</span><span class="illus">illustrative · design intent</span></div>
      <h3>Agentic IP-to-buyer matching</h3>
      <p style="color:var(--muted);font-size:.92rem">A validated story profile is matched to buyer preferences, production criteria and commercial requirements. For <b style="color:var(--text)">${top.t}</b>, the first three doors it would knock on:</p>
      <ul>${BUYERS[top.cat].map((b, i) => `<li style="--i:${i}"><b>${b[0]}</b><span>${b[1]}</span><em class="num">${b[2]}% fit</em></li>`).join('')}</ul>
    </div>`;
  w.classList.remove('on'); void w.offsetWidth; w.classList.add('on');
  $('#certWatch').addEventListener('click', () => theater.open(top.id));
  $('#certAgain').addEventListener('click', reset);
  if (scroll) emit('certificate', { top: top.id, agree });
  if (scroll) w.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
}
function reset() {
  S.votes = {}; save(); sim.w = {}; sim.n = {}; sim.total = 0;
  $('#certWrap').classList.remove('on'); $('#certWrap').innerHTML = '';
  renderRound(0); board.update(); $('#liveReads').textContent = totalReads().toLocaleString();
  $('#faceoff').scrollIntoView({ behavior: RM ? 'auto' : 'smooth' }); toast('Votes cleared. Round 1 is yours again.');
}

/* ---------- library ---------- */
function library() {
  const cats = [['all', 'All'], ['horror', 'Horror'], ['adventure', 'Adventure'], ['scifi', 'Sci-fi'], ['mystery', 'Mystery'], ['render', 'Shots & render tests']];
  $('#chips').innerHTML = cats.map(([k, t], i) => `<button class="chip" data-k="${k}" aria-pressed="${!i}">${t}</button>`).join('');
  const grid = $('#grid');
  grid.innerHTML = LIB.map((id, i) => { const c = ITEMS[id];
    return `<button class="tc rv${i === 0 ? ' feat' : ''}" style="--i:${i % 3}" data-id="${id}" data-cat="${c.cat}" aria-label="Play ${c.t}">
      <span class="screen"><img src="${c.poster}" alt="" loading="lazy" decoding="async"><video muted playsinline loop preload="none"></video><span class="tag">${c.concept ? 'Concept trailer' : c.g} · ${c.dur}</span><span class="pp" aria-hidden="true"><span></span></span></span>
      <span class="info"><h3>${c.t}</h3>${c.concept ? ringHTML(stat(id).ix) : ''}<p>${c.concept ? c.g + ' · ' : ''}${c.log}</p></span></button>`; }).join('');
  $$('.tc', grid).forEach(card => {
    const v = $('video', card), c = ITEMS[card.dataset.id];
    card.addEventListener('click', () => theater.open(c.id));
    if (!HOVER || RM) return;
    v.addEventListener('playing', () => card.classList.add('prev'));
    card.addEventListener('pointerenter', () => { if (!v.src) v.src = c.src + '?c=lib'; safePlay(v); });
    card.addEventListener('pointerleave', () => { v.pause(); card.classList.remove('prev'); try { v.currentTime = 0; } catch (e) { /* not loaded yet */ } });
  });
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    $$('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const shown = $$('.tc', grid).filter(card => { const ok = b.dataset.k === 'all' || card.dataset.cat === b.dataset.k; card.classList.toggle('hide', !ok); card.classList.toggle('feat', false); return ok; });
    if (b.dataset.k === 'all') shown[0].classList.add('feat');
    if (!RM) shown.forEach((card, i) => card.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 50, easing: EASE, fill: 'backwards' }));
  });
  new IntersectionObserver((es, io) => es.forEach(e => { if (e.isIntersecting) { drawRings(grid); io.disconnect(); } }), { threshold: .2 }).observe(grid);
}

/* ---------- theatre (dialog): concept trailers and released anchors ---------- */
const theater = {
  el: null, id: null,
  init() {
    this.el = $('#theater');
    this.el.addEventListener('click', e => { if (e.target === this.el || e.target.closest('[data-close]')) this.close(); });
    this.el.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.el.addEventListener('keydown', e => { if (!this.id || /VIDEO/.test(e.target.tagName)) return; if (e.key === 'ArrowRight') this.step(1); if (e.key === 'ArrowLeft') this.step(-1); });
  },
  show(html) {
    this.el.innerHTML = html;
    if (!this.el.open) { this.el.showModal(); hero.pause(); foVideos().forEach(v => v.pause()); }
  },
  open(id) {
    emit('trailer_play', { id, kind: 'concept' });
    this.id = id; const c = ITEMS[id], st = c.concept ? stat(id) : null, round = ROUNDS.find(r => r.a === id || r.b === id);
    const dna = c.dna ? `<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="label">Narrative DNA · decoded on upload</span><span class="illus">illustrative</span></div><div class="dna">${Object.entries(c.dna).map(([k, v], i) => `<div style="--i:${i}"><span>${k}</span><i style="--v:0" data-v="${v}"></i><span class="num">${Math.round(v * 100)}</span></div>`).join('')}</div></div>` : '';
    this.show(`<div class="th"><div class="stage"><video controls autoplay playsinline poster="${c.poster}" src="${c.src}?c=th"></video></div>
      <div class="side2"><div class="bar2"><span class="label">${c.concept ? 'Concept trailer' : c.g} · real AI render · ${c.dur}</span><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <h3>${c.t}</h3>${c.sample ? '<span class="illus" style="justify-self:start">sample title and logline</span>' : ''}<p style="color:var(--muted)">${c.log}</p>
        <div class="tags">${c.tags.map(t => `<span>${t}</span>`).join('')}</div>
        ${st ? `<div class="kv"><div><span class="label">Demand Index</span><b>${st.ix.toFixed(1)} ± ${st.err.toFixed(1)}</b></div><div><span class="label">Paired reads</span><b>${st.n}</b></div></div>` : ''}
        ${dna}<p class="label" style="text-transform:none;letter-spacing:.03em">${c.prov}</p>
        <div class="nav2"><button class="btn ghost sm" data-step="-1" aria-label="Previous trailer">← Prev</button><button class="btn ghost sm" data-step="1" aria-label="Next trailer">Next →</button><button class="btn ghost sm" data-share="trailer" data-id="${id}" data-text="${c.t}: a concept trailer for a film nobody has made yet. Would you watch it?">Share</button>${round ? `<button class="btn primary sm" data-vote="${ROUNDS.indexOf(round)}">${S.votes[round.id] ? 'See its face-off' : 'Vote in its face-off'}</button>` : ''}</div>
      </div></div>`);
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.dna i', this.el).forEach(i => i.style.setProperty('--v', i.dataset.v))));
    $$('[data-step]', this.el).forEach(b => b.addEventListener('click', () => this.step(+b.dataset.step)));
    const vb = $('[data-vote]', this.el); if (vb) vb.addEventListener('click', () => { this.close(); renderRound(+vb.dataset.vote); $('#faceoff').scrollIntoView({ behavior: RM ? 'auto' : 'smooth' }); });
  },
  anchor(title, year, yt, o = {}) {
    emit('trailer_play', { id: title, kind: o.kind ? 'unreleased' : 'anchor' });
    this.id = null; const local = location.protocol === 'file:';
    this.show(`<div class="th"><div class="stage">${local ? `<img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;opacity:.55">` : `<iframe src="https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&rel=0&playsinline=1" title="${title} official trailer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`}</div>
      <div class="side2"><div class="bar2"><span class="label">${o.kind || 'Released film · official trailer'}</span><button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <h3>${title}</h3><span class="label">${o.sub || year + ' · calibration anchor'}</span>
        <p style="color:var(--muted)">${o.body || 'Not a StoryForge title. Released films are seeded into face-offs as known answers: panellists whose picks among them match how those films really performed carry more weight on unmade concepts.'}</p>
        ${local ? '<p style="color:var(--muted);font-size:.88rem">YouTube blocks embedded playback on pages opened straight from a file. Serve this folder over http to play it here, or open it on YouTube.</p>' : ''}
        <a class="btn primary sm" style="justify-self:start" href="https://www.youtube.com/watch?v=${yt}" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>
      </div></div>`);
  },
  step(d) { const i = LIB.indexOf(this.id); this.open(LIB[(i + d + LIB.length) % LIB.length]); },
  close() {
    const el = this.el; if (!el.open || el.classList.contains('closing')) return;
    const done = () => { el.classList.remove('closing'); el.close(); el.innerHTML = ''; this.id = null; hero.resume(); if (foVisible && !RM) foVideos().forEach(safePlay); };
    if (RM) return done();
    el.classList.add('closing'); setTimeout(done, 200);
  }
};
function anchors() {
  $('#rail').innerHTML = ANCHORS.map(([t, y, yt]) => `<button class="an" data-yt="${yt}" aria-label="Play the ${t} trailer"><span class="screen"><img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" loading="lazy" decoding="async"><span class="tag">Released · ${y}</span><span class="pp" aria-hidden="true"><span></span></span></span><h3>${t}</h3><p>Official trailer · anchor only</p></button>`).join('');
  $('#rail').addEventListener('click', e => { const b = e.target.closest('.an'); if (!b) return; const a = ANCHORS.find(x => x[2] === b.dataset.yt); theater.anchor(...a); });
}

/* ---------- coming soon: real trailers for films that are not out yet ---------- */
function upcoming() {
  const rail = $('#soonRail'), now = new Date(), fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const days = d => Math.ceil((new Date(d + 'T12:00:00') - now) / 864e5);
  const when = d => { const n = days(d); return n > 1 ? `In ${n} days` : n === 1 ? 'Tomorrow' : n === 0 ? 'Today' : 'Now released'; };
  rail.innerHTML = UPCOMING.map(u => `<article class="up" data-id="${u.id}">
      <button class="screen" aria-label="Play the ${u.t} trailer"><img src="https://image.tmdb.org/t/p/w780${u.b}" alt="" loading="lazy" decoding="async"><span class="tag">${when(u.d)}</span>${u.col ? '<span class="tag r fr">Franchise</span>' : ''}<span class="pp" aria-hidden="true"><span></span></span></button>
      <h3>${u.t}</h3><p>${u.g} · ${fmt(u.d)}</p>
      <button class="chip watch" aria-pressed="${!!S.watch[u.id]}">${S.watch[u.id] ? '✓ On my slate' : '+ I’d watch this'}</button></article>`).join('');
  const tally = () => {
    const mine = UPCOMING.filter(u => S.watch[u.id]), fr = mine.filter(u => u.col).length, all = UPCOMING.filter(u => u.col).length;
    $('#soonTally').innerHTML = (mine.length ? `<b>Your forward slate: ${mine.length} pick${mine.length > 1 ? 's' : ''}</b> · ${fr} franchise · ${mine.length - fr} standalone. ` : '<b>Tap the ones you’d watch.</b> ') + `${all} of these ${UPCOMING.length} sit in a franchise collection on TMDB. Nobody knows yet how any of them will open, which is exactly when a read is worth something.`;
  };
  rail.addEventListener('click', e => {
    const card = e.target.closest('.up'); if (!card) return; const u = UPCOMING.find(x => x.id === +card.dataset.id);
    if (e.target.closest('.watch')) { const b = e.target.closest('.watch'); S.watch[u.id] ? delete S.watch[u.id] : S.watch[u.id] = 1; save(); b.setAttribute('aria-pressed', String(!!S.watch[u.id])); b.textContent = S.watch[u.id] ? '✓ On my slate' : '+ I’d watch this'; tally(); emit('slate_toggle', { title: u.t, on: !!S.watch[u.id] }); return; }
    if (e.target.closest('.screen')) theater.anchor(u.t, '', u.yt, { kind: 'Unreleased film · official trailer', sub: `${u.g} · ${days(u.d) > 0 ? 'in cinemas ' : 'released '}${fmt(u.d)}`, body: `Not a StoryForge title. ${u.col ? 'Part of the ' + u.col.replace(/^The /, '') + ' on TMDB.' : 'No franchise collection listed on TMDB.'} A real trailer for a film nobody has seen: the same forward read StoryForge takes on unmade concepts, here with an outcome that will be public soon and can be scored on the ledger.` });
  });
  tally();
}

/* ---------- instrument ---------- */
function instrument() {
  const STEPS = [
    ['Resolve', 'One identity per title', 'Every script, trailer and comparable is joined on a certified spine, so a read is never credited to the wrong film.', '12.96M', 'row identity spine · 220K-title pool · 25.6% bad matches rejected'],
    ['Decode', 'Narrative DNA', 'Hook, conflict, stakes, warmth, darkness, humour and arc are scored the moment a script is uploaded.', '7', 'narrative traits per script · 43-title pilot'],
    ['Render', 'Concept trailer', 'Script to beats to a 30-second 9:16 concept trailer, writer-approved, with several renders per concept.', '$1.20', 'logged cost per 8-second shot on the trailers above'],
    ['Read', 'Head-to-head', 'A paid panel picks between pairs. Calibrated panellists, the ones who read released films right, weigh more.', '400', 'paired reads per concept'],
    ['Signal', 'Demand Index', 'A number with an error bar and a five-surface profile, box office first, joined to realised outcomes on the ledger.', '± 4.7', 'typical 95% interval at 400 reads']
  ];
  const tabs = $('#steps'), panel = $('#stepPanel'); let i = -1, auto = true, timer = null, vis = false;
  tabs.innerHTML = STEPS.map((s, k) => `<button class="step" role="tab" aria-selected="false" data-k="${k}"><span class="n">0${k + 1}</span><b>${s[0]}</b></button>`).join('');
  const set = (k, user) => {
    i = k; if (user) auto = false;
    $$('.step', tabs).forEach((b, j) => { b.classList.toggle('on', j === k && auto); b.classList.toggle('past', j < k || (j === k && !auto)); b.setAttribute('aria-selected', String(j === k)); });
    const s = STEPS[k];
    panel.innerHTML = `<div class="txt sw"><span class="label">Step 0${k + 1} · ${s[0]}</span><h3>${s[1]}</h3><p>${s[2]}</p></div><div class="fig"><b class="num">${s[3]}</b><span>${s[4]}</span></div>`;
    clearTimeout(timer); if (auto && vis && !RM) timer = setTimeout(() => set((i + 1) % STEPS.length), 5000);
  };
  tabs.addEventListener('click', e => { const b = e.target.closest('.step'); if (b) set(+b.dataset.k, true); });
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; if (vis && auto) set(Math.max(i, 0)); else clearTimeout(timer); }, { threshold: .4 }).observe(tabs);
  set(0); $$('.step', tabs)[0].classList.remove('on');
}

/* ---------- founding 50: discount grows with what a writer publishes (proposed terms) ---------- */
function founding() {
  if (!$('#unlock')) return;
  let step = 0, n = 1; const btns = $$('#unlock button'), stack = $('#stack');
  const MSG = ['Invite a script writer to start. Nothing unlocks until their script is a trailer.', 'Invite sent. The discount waits for them to publish.', 'Script published. One step left: the writer approves a trailer.', ''];
  const won = () => `off the writer plan for ${6 * n} months. ${n === 1 ? 'One invited writer' : n + ' invited writers'} published a script and turned it into a trailer. Each one adds six months.`;
  const paint = () => { btns.forEach(b => b.classList.toggle('on', +b.dataset.s <= step)); $('#tierPct').textContent = step === 3 ? '100%' : '0%'; $('#tierTxt').textContent = step === 3 ? won() : MSG[step]; $('#tierFill').style.transform = `scaleX(${step / 3})`; if (stack.hidden === (step === 3)) { stack.hidden = step !== 3; stack.classList.toggle('in', step === 3); } $('#stackN').textContent = n; };
  $('#stackMore').addEventListener('click', () => { n = Math.min(10, n + 1); paint(); });
  $('#stackLess').addEventListener('click', () => { n = Math.max(1, n - 1); paint(); });
  btns.forEach(b => b.addEventListener('click', () => { const s = +b.dataset.s; step = step === s ? s - 1 : Math.min(s, step + 1); paint(); if (step === 3) emit('referral_unlock_demo', {}); }));
  paint();
  let code = ''; try { code = (JSON.parse(localStorage.getItem('sf-growth-v1')) || {}).ref || ''; } catch (e) { /* no code yet */ }
  const inv = $('#invLink'); inv.value = location.origin + location.pathname + '?invite=' + (code || 'WRITER') + '#founding'; inv.addEventListener('focus', () => inv.select());
  $('#invCopy').addEventListener('click', async e => { const b = e.currentTarget, o = b.textContent; try { await navigator.clipboard.writeText(inv.value); } catch (err) { inv.select(); document.execCommand('copy'); } b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = o; }, 1600); emit('share', { channel: 'copy', what: 'writer_invite' }); });
  $('#foundForm').addEventListener('submit', e => {
    e.preventDefault(); const inp = $('#fEmail');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(inp.value.trim())) { inp.classList.remove('err'); void inp.offsetWidth; inp.classList.add('err'); inp.setAttribute('aria-invalid', 'true'); inp.focus(); toast('That email doesn’t look right.'); return; }
    inp.classList.remove('err'); inp.removeAttribute('aria-invalid'); inp.value = ''; $('#foundForm').classList.add('done');
    emit('founding_apply', { festival: $('#fFest').value }); toast('Shown on this device only. Nothing was sent.');
  });
}

/* ---------- three doors ---------- */
const DOORS = {
  watch: { h: 'Fans who want a say in what gets made', f: 'Fans on the phone, in three-minute units, who want a say in what gets made.', o: 'Watch: four face-offs a night. The tap is the vote. See which one won, and what happened next.', u: 'Reboots, remakes, AI slop and 15 minutes of searching for something to watch.', rev: 'Freemium', revd: 'The feed is free. Micro-transactions buy weighted votes and backing on the concepts fans want made.', st: 'Get four face-offs a night', ss: 'Free to watch. Early access if your pick gets made.', sb: 'Join as a fan', ph: 'you@email.com' },
  write: { h: 'Screenwriters with an unproduced script', f: 'Screenwriters with unproduced scripts and no way past the barriers to entry.', o: 'A sell kit from your own material: one-sheet, treatment, concept trailer, later a signed Demand Certificate.', u: 'Labs and fellowships at 2% odds. No training on your script, and you keep 100% of the rights.', rev: 'Subscription', revd: 'Private and public marketplaces, an automated pitch deck, and demand data on every concept you list.', st: 'Send one horror script', ss: 'Founding slate is sourced from lab and fellowship cohorts. Private by default.', sb: 'Join as a writer', ph: 'you@writersroom.com' },
  buy: { h: 'Studios, streamers and producers', f: 'Studios, streamers and producers deciding what to greenlight or option.', o: 'A Demand Certificate per concept: an audience read under NDA, with error bars, before a dollar of production.', u: '$25K test screenings at rough cut, coverage, comps and gut feel.', rev: 'Demand data', revd: 'Per-concept certificates for private slate reads. Later, the slate-scoring API and the calibration ledger as a feed.', st: 'Bring 5–10 concepts under NDA', ss: 'Be one of five founding pricing conversations.', sb: 'Join as a buyer', ph: 'you@studio.com' }
};
let door = 'watch';
function setDoor(k, count) {
  door = k; const d = DOORS[k], seg = $('#doorSeg');
  $$('button', seg).forEach(b => b.setAttribute('aria-selected', String(b.dataset.k === k))); movePill(seg);
  $('#doorPanel').innerHTML = `<div class="body sw"><div><span class="label">Door · ${k === 'watch' ? 'I watch' : k === 'write' ? 'I write' : 'I buy'}</span><h3 style="font-size:clamp(1.3rem,1.1rem + 1vw,1.9rem);margin-top:8px">${d.h}</h3></div>
    <div class="fou"><div><span class="label">For</span><p>${d.f}</p></div><div><span class="label">Our</span><p>${d.o}</p></div><div><span class="label">Unlike</span><p>${d.u}</p></div></div>
    <div style="border-top:1px solid var(--hair);padding-top:14px;display:grid;gap:4px"><span class="label">Revenue line · ${d.rev}</span><p style="color:var(--muted);font-size:.92rem">${d.revd}</p></div></div>`;
  $('#suTitle').textContent = d.st; $('#suSub').textContent = d.ss; $('#suBtn').textContent = S.signed === k ? 'You’re on the list ✓' : d.sb; $('#email').placeholder = d.ph;
  $('#signup').classList.toggle('done', S.signed === k);
  if (count) { S.doors[k]++; save(); emit('door_tap', { door: k }); }
  const max = Math.max(1, ...Object.values(S.doors));
  $('#funnel').innerHTML = ['watch', 'write', 'buy'].map(x => `<div><span>I ${x}</span><i style="--v:${S.doors[x] / max}"></i><span class="num">${S.doors[x]}</span></div>`).join('');
}
function doors() {
  $('#doorSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setDoor(b.dataset.k, true); });
  $$('[data-door]').forEach(a => a.addEventListener('click', () => setDoor(a.dataset.door, true)));
  $('#signup').addEventListener('submit', e => {
    e.preventDefault(); const inp = $('#email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(inp.value.trim())) { inp.classList.remove('err'); void inp.offsetWidth; inp.classList.add('err'); inp.setAttribute('aria-invalid', 'true'); inp.focus(); toast('That email doesn’t look right.'); return; }
    inp.classList.remove('err'); inp.removeAttribute('aria-invalid'); inp.value = ''; S.signed = door; save(); setDoor(door); emit('signup', { door }); toast('Saved on this device only. Nothing was sent.');
  });
  setDoor('watch');
}

/* ---------- leaderboard (FLIP reorder) ---------- */
const board = {
  rows: {},
  init() {
    const el = $('#boardEl');
    el.innerHTML = `<div class="brow head"><span>#</span><span>Concept</span><span class="c">Win rate</span><span class="c">Reads</span><span style="text-align:right">Index</span></div>`;
    [...Object.values(ITEMS).filter(c => c.concept), ...NT].forEach(c => {
      const r = document.createElement('div'); r.className = 'brow' + (c.concept ? '' : ' nt'); r.dataset.id = c.id;
      r.innerHTML = `<span class="rk"></span><span class="ti"><b>${c.t}<small>${c.g.toUpperCase()}${c.concept ? '' : ' · NO TRAILER YET'}</small></b><span class="track"><span class="fill" style="display:block;transform:scaleX(0)"></span></span></span><span class="c wr"></span><span class="c rd"></span><span class="ix"><span class="v"></span><small class="e"></small></span>`;
      el.appendChild(r); this.rows[c.id] = r;
    });
    this.update();
  },
  update(flashId) {
    const el = $('#boardEl'), ids = Object.keys(this.rows).sort((a, b) => stat(b).ix - stat(a).ix);
    const before = {}; ids.forEach(id => { before[id] = this.rows[id].getBoundingClientRect().top; });
    ids.forEach((id, k) => { const r = this.rows[id], s = stat(id); el.appendChild(r);
      $('.rk', r).textContent = String(k + 1).padStart(2, '0'); $('.fill', r).style.transform = `scaleX(${s.p})`;
      $('.wr', r).textContent = s.p.toFixed(3); $('.rd', r).textContent = s.n; $('.v', r).textContent = s.ix.toFixed(1); $('.e', r).textContent = '± ' + s.err.toFixed(1); });
    if (!RM) ids.forEach(id => { const r = this.rows[id], dy = before[id] - r.getBoundingClientRect().top; if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: EASE }); });
    if (flashId && this.rows[flashId]) { const r = this.rows[flashId]; r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); }
    $$('#grid .ring').forEach(ring => { const id = ring.closest('.tc').dataset.id; ring.dataset.ix = stat(id).ix.toFixed(0); $('b', ring).textContent = ring.dataset.ix; if ($('.fg', ring).style.strokeDashoffset) drawRings(ring.parentNode); });
  }
};
function simFeed() {
  const sw = $('#simSw'); let vis = false;
  const paint = () => sw.setAttribute('aria-checked', String(S.sim)); paint();
  sw.addEventListener('click', () => { S.sim = !S.sim; save(); paint(); toast(S.sim ? 'Simulated panel feed on.' : 'Simulated panel feed paused.'); });
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; }, { threshold: .2 }).observe($('#boardEl'));
  const ids = Object.keys(board.rows);
  setInterval(() => {
    if (!S.sim || !vis || document.hidden) return;
    const a = ids[Math.floor(Math.random() * ids.length)]; let b = a; while (b === a) b = ids[Math.floor(Math.random() * ids.length)];
    const pa = stat(a).p, pb = stat(b).p, win = Math.random() < pa / (pa + pb) ? a : b;
    [a, b].forEach(id => { sim.n[id] = (sim.n[id] || 0) + 1; }); sim.w[win] = (sim.w[win] || 0) + 1; sim.total++;
    board.update(win); $('#liveReads').textContent = totalReads().toLocaleString();
  }, 2600);
  $('#resetBtn').addEventListener('click', reset);
}

/* ---------- validation + market ---------- */
function proof() {
  const INS = [[14, 16, 'The phone is the premiere', 'Watch on the phone; 11/16 open YouTube or Instagram first and decide in 3 seconds to a minute.', '9:16 vertical master, three-minute units, mobile KPIs.'],
    [10, 16, 'AI is fine, slop is not', 'Do not mind AI if the quality is there. Put-offs: artificial faces, poor render and sound, predictable plots.', 'Writer-origin, approved beats, curated library, no infinite feed.'],
    [11, 16, 'Unmade films are watchable', 'Would watch trailers for films that do not exist and want to know what happened next.', 'Always close the loop: show the result instantly after the tap.'],
    [11, 16, 'The tap is a follow, not a ballot', 'Would tap; the return driver is seeing which one won. Several read the tap as “request an update”.', 'Design the tap as follow + reveal. No paywall at first contact.'],
    [9, 16, 'Early access beats credit', 'Want early access or a screening if their pick gets made; 5/16 want nothing in return.', 'Rewards earned, never bought: early access and thanks credits.'],
    [3, 3, 'Writers need a door, not a vote', 'Experts converged: the barrier is the kit, the attachment and the credentials.', 'Sell kit + no-training contract; founding slate from lab cohorts.']];
  $('#ins').innerHTML = INS.map(([a, b, h, p, act], i) => `<article class="in-card rv" style="--i:${i % 3}"><span class="frac num">${a}<small>/${b}</small></span><span class="pips" aria-hidden="true">${Array.from({ length: b }, (_, k) => `<i class="${k < a ? 'f' : ''}" style="--k:${k}"></i>`).join('')}</span><h3>${h}</h3><p>${p}</p><p class="act"><b>→</b>${act}</p></article>`).join('');
  const MK = [['$255B', 'Global content spend, 2026', 'Streamers ≈ $101B of it. Context, not addressable.'], ['$1.6B', 'TAM · two pools, per year', 'B2B $0.49B: demand analytics, audience and concept research, script coverage. B2C $1.10B: what genre fans already pay for stories.'], ['$152M', 'SAM · the wedge, per year', 'B2B $29M: ≈ 270 genre buyers and 5,300 writers. B2C $123M: ≈ 27M horror-leaning fans 18–34, US + UK.'], ['$8–36M', 'Reachable at list price, per year', 'Low / base / high. Year-5 plan is a hypothesis: $1.2M / $4.4M / $17M.']];
  $('#mrows').innerHTML = MK.map(([v, h, p], i) => `<button class="mrow" data-i="${i}"><b class="num">${v}</b><h3>${h}</h3><p>${p}</p></button>`).join('') + '<span class="label" style="padding:12px 8px 0;text-transform:none;letter-spacing:.03em">Rings are labelled, not to scale.</span>';
  const rings = $$('#rings i'), rows = $$('.mrow'), hi = k => { rings.forEach((r, i) => r.classList.toggle('on', i === k)); rows.forEach((r, i) => r.classList.toggle('on', i === k)); };
  rows.forEach((r, i) => { r.addEventListener('pointerenter', () => hi(i)); r.addEventListener('focus', () => hi(i)); r.addEventListener('click', () => hi(i)); });
}

/* ---------- page chrome: theme, progress, nav, reveals, counters ---------- */
function chrome() {
  const root = document.documentElement; root.dataset.theme = S.theme;
  const pc = $('#protoClose'); if (pc) pc.addEventListener('click', () => { $('#proto').remove(); root.style.scrollPaddingTop = '72px'; });
  $('#themeBtn').addEventListener('click', () => { S.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; root.dataset.theme = S.theme; save(); });
  const bar = $('#progress'); let tick = false;
  addEventListener('scroll', () => { if (tick) return; tick = true; requestAnimationFrame(() => { const h = document.documentElement; bar.style.transform = `scaleX(${h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)})`; tick = false; }); }, { passive: true });
  const links = $$('.nav a'), navIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id)); }), { rootMargin: '-45% 0px -50% 0px' });
  $$('section[id]').forEach(s => navIO.observe(s));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  $$('.rv').forEach(el => io.observe(el));
  const cio = new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting) return; const el = e.target; countTo(el, +el.dataset.count, { dec: +(el.dataset.dec || 0), suf: el.dataset.suf || '', dur: 1200 }); cio.unobserve(el); }), { threshold: .6 });
  $$('[data-count]').forEach(el => cio.observe(el));
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => $$('.seg').forEach(movePill), 120); });
  $('#liveReads').textContent = totalReads().toLocaleString();
}

/* ---------- boot: entrances wait for fonts so nothing replays on swap ---------- */
function init() {
  if (init.done) return; init.done = true;
  theater.init(); ticker(); if ($('#chainSeg')) chain(); library(); anchors(); upcoming(); instrument(); founding(); doors(); board.init(); if ($('#ins')) proof(); faceoff(); simFeed(); hero(); chrome();
  $$('.seg').forEach(movePill);
  requestAnimationFrame(() => document.documentElement.classList.add('ready'));
  window.SF = { open: id => { if (ITEMS[id]) theater.open(id); } }; document.dispatchEvent(new CustomEvent('sf:ready'));
}
const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
fonts.then(init); setTimeout(init, 1000); // never hold the page hostage to a slow font host
})();
