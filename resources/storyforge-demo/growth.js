/* StoryForge Live — quantitative-validation layer: analytics, CTA tracking, survey, sharing, referral rewards.
   Everything is recorded in this browser. Paste a GA4 measurement ID below to send the same events onward. */
(() => {
'use strict';
const GA_ID = ''; // e.g. 'G-XXXXXXXXXX' → events flow to Google Analytics 4, which Looker Studio reads natively
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const KEY = 'sf-growth-v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const G = Object.assign({ sessions: [], events: [], survey: null, ref: null, inbound: null }, load());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(G)); } catch (e) { /* session-only in private mode */ } };
const app = () => { try { return JSON.parse(localStorage.getItem('sf-live-v1')) || {}; } catch (e) { return {}; } };
const sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const session = { id: sid, t: Date.now(), steps: { view: 1 }, secs: {} };
G.sessions.push(session); if (G.sessions.length > 300) G.sessions.shift();
if (!G.ref) G.ref = Math.random().toString(36).slice(2, 8).toUpperCase();
const qs = new URLSearchParams(location.search);
if (qs.get('ref') && qs.get('ref') !== G.ref) G.inbound = qs.get('ref').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || null; // sanitised: it is rendered into the page

if (GA_ID) { const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID; document.head.appendChild(s); window.dataLayer = window.dataLayer || []; window.gtag = function () { window.dataLayer.push(arguments); }; window.gtag('js', new Date()); window.gtag('config', GA_ID); }

/* ---------- analytics core ---------- */
const STEP = { trailer_play: 'play', vote: 'vote', certificate: 'cert', door_tap: 'door', survey_submit: 'survey', signup: 'signup', share: 'share' };
const FUNNEL = [['view', 'Visited'], ['play', 'Played a trailer'], ['vote', 'Voted in a face-off'], ['cert', 'Got a certificate'], ['door', 'Opened a door'], ['survey', 'Answered the survey'], ['signup', 'Signed up'], ['share', 'Shared']];
function track(n, p = {}) {
  G.events.push({ s: sid, t: Date.now(), n, p }); if (G.events.length > 1500) G.events.shift();
  if (STEP[n]) session.steps[STEP[n]] = 1;
  save();
  (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: 'sf_' + n }, p));
  if (window.gtag) window.gtag('event', 'sf_' + n, p);
  dash(); rewards();
}
document.addEventListener('sf:event', e => track(e.detail.name, e.detail.props));
document.addEventListener('click', e => {
  const b = e.target.closest('.btn'); if (!b || b.closest('#dash,#surveyBox,#rewardBox,.nav2') || b.id === 'dashExport' || b.id === 'dashClear' || b.id === 'resetBtn') return; // utility buttons are not calls to action
  const sec = b.closest('section,header,dialog,footer'); track('cta_click', { cta: (b.dataset.cta || b.textContent).trim().replace(/\s+/g, ' ').slice(0, 40), where: (sec && (sec.id || sec.tagName.toLowerCase())) || 'page' });
});
function sections() {
  const io = new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting || session.secs[e.target.id]) return; session.secs[e.target.id] = 1; G.events.push({ s: sid, t: Date.now(), n: 'section_view', p: { section: e.target.id } }); save(); dash(); }), { threshold: .2 });
  $$('section[id]').forEach(s => io.observe(s));
}

/* ---------- simulated cohort for the Looker walkthrough (illustrative, clearly labelled) ---------- */
function simCohort() {
  let s = 20261110; const r = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const P = { play: .62, vote: .66, cert: .64, door: .58, survey: .55, signup: .6, share: .38 }, order = ['top', 'problem', 'faceoff', 'library', 'anchors', 'soon', 'instrument', 'doors', 'board', 'proof', 'stories', 'market', 'ladder', 'prfaq', 'survey', 'share', 'analytics'];
  const ctas = ['Vote in the face-off', 'Play tonight’s face-off', 'Watch the trailers', 'I’d watch this A', 'Issue my Demand Certificate ↓', 'Join as a fan', 'Bring a slate', 'Send a script'];
  const out = { sessions: [], cta: {} };
  for (let i = 0; i < 500; i++) {
    const st = { view: 1 }; let alive = true;
    ['play', 'vote', 'cert', 'door', 'survey', 'signup', 'share'].forEach(k => { if (alive && r() < P[k]) st[k] = 1; else alive = false; });
    const depth = Math.min(order.length, 2 + Math.floor(Math.pow(r(), 1.6) * order.length) + (st.vote ? 3 : 0)), secs = {}; order.slice(0, depth).forEach(k => { secs[k] = 1; });
    out.sessions.push({ id: 'sim' + i, t: Date.now() - Math.floor(r() * 6048e5), steps: st, secs });
    ctas.forEach((c, j) => { if (r() < .5 / (j + 1.2)) out.cta[c] = (out.cta[c] || 0) + 1; });
  }
  return out;
}
let view = 'device', SIM = null;

/* ---------- dashboard ---------- */
function dash() {
  const el = $('#dash'); if (!el) return;
  const sim = view === 'sim'; if (sim && !SIM) SIM = simCohort();
  const ses = sim ? SIM.sessions : G.sessions, n = ses.length || 1;
  const cta = sim ? SIM.cta : G.events.filter(e => e.n === 'cta_click').reduce((m, e) => { m[e.p.cta] = (m[e.p.cta] || 0) + 1; return m; }, {});
  const reach = {}; ses.forEach(s => Object.keys(s.secs || {}).forEach(k => { reach[k] = (reach[k] || 0) + 1; }));
  const cnt = k => ses.filter(s => s.steps[k]).length, pct = v => (v / n * 100).toFixed(v / n < .1 && v ? 1 : 0) + '%';
  const top = Object.entries(cta).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = Math.max(1, ...top.map(x => x[1]));
  const secs = $$('section[id]').map(s => s.id);
  el.innerHTML = `<div class="kv k4"><div><span class="label">Sessions</span><b>${ses.length}</b></div><div><span class="label">Voted</span><b>${pct(cnt('vote'))}</b></div><div><span class="label">Signed up</span><b>${pct(cnt('signup'))}</b></div><div><span class="label">Shared</span><b>${pct(cnt('share'))}</b></div></div>
    <div class="dgrid"><div class="dcard"><span class="label">Funnel · sessions reaching each step</span><div class="fun">${FUNNEL.map(([k, t]) => `<div><span>${t}</span><i style="--v:${cnt(k) / n}"></i><b class="num">${cnt(k)}</b><em class="num">${pct(cnt(k))}</em></div>`).join('')}</div></div>
    <div class="dcard"><span class="label">Call-to-action buttons · clicks</span><div class="fun c3">${top.length ? top.map(([t, v]) => `<div><span>${t}</span><i style="--v:${v / mx}"></i><b class="num">${v}</b></div>`).join('') : '<p class="mute">No button clicks recorded yet.</p>'}</div>
      <span class="label" style="margin-top:14px;display:block">Scroll reach · sessions that saw each section</span><div class="reach">${secs.map(k => `<span title="${k}: ${reach[k] || 0} of ${ses.length}" style="--v:${(reach[k] || 0) / n}"><i></i><em>${k}</em></span>`).join('')}</div></div></div>`;
  $('#dashNote').textContent = sim ? 'Simulated cohort of 500 sessions, generated in the browser for the Looker walkthrough. Illustrative: nothing here was measured.' : `Measured on this device: ${G.sessions.length} session${G.sessions.length === 1 ? '' : 's'}, ${G.events.length} events. ${GA_ID ? 'Also sent to GA4 ' + GA_ID + '.' : 'Not sent anywhere until a GA4 ID is added in growth.js.'}`;
}
function exportCSV() {
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"'; let rows;
  if (view === 'sim') { if (!SIM) SIM = simCohort(); rows = [['session_id', 'timestamp', 'event', 'detail']]; SIM.sessions.forEach(s => Object.keys(s.steps).forEach(k => rows.push([s.id, new Date(s.t).toISOString(), k, 'simulated']))); }
  else rows = [['session_id', 'timestamp', 'event', 'detail'], ...G.events.map(e => [e.s, new Date(e.t).toISOString(), e.n, JSON.stringify(e.p)])];
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })); a.download = `storyforge-events-${view}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- survey: five taps, each answered against the 16 discovery interviews ---------- */
const QS = [
  { k: 'door', q: 'Which door is yours?', a: ['I watch', 'I write', 'I buy', 'Just curious'] },
  { k: 'unmade', q: 'Would you watch trailers for films that don’t exist yet?', a: ['Yes', 'Maybe', 'No'], base: [11, 'said they would watch trailers for unmade films'] },
  { k: 'ai', q: 'The trailer is AI-rendered from a writer’s script. Does that bother you?', a: ['Not if the quality is there', 'Yes, it does'], base: [10, 'do not mind AI if the quality is there'] },
  { k: 'reward', q: 'If your pick gets made, what would you want back?', a: ['Early access', 'A thanks credit', 'Nothing'], base: [9, 'want early access or a screening'] },
  { k: 'screen', q: 'Where do you watch first?', a: ['Phone', 'TV', 'Laptop'], base: [14, 'watch on the phone'] }
];
let qi = 0; const ans = {};
function survey() {
  const el = $('#surveyBox'); if (!el) return;
  if (G.survey) { el.innerHTML = `<div class="sv sw"><span class="label">Thank you · recorded on this device</span><h3>Your five answers are in.</h3><div class="ballot">${QS.map(q => `<div><span>${q.q}</span><span></span><span class="ok">${G.survey[q.k] || '—'}</span></div>`).join('')}</div><button class="btn ghost sm" id="svAgain" style="justify-self:start">Answer again</button></div>`; $('#svAgain').addEventListener('click', () => { G.survey = null; qi = 0; save(); survey(); rewards(); }); return; }
  const q = QS[qi], picked = ans[q.k];
  el.innerHTML = `<div class="sv sw"><div class="dots" aria-hidden="true">${QS.map((_, i) => `<i class="${i < qi ? 'done' : i === qi ? 'cur' : ''}"></i>`).join('')}</div>
    <span class="label">Question ${qi + 1} of ${QS.length}</span><h3 id="svQ">${q.q}</h3>
    <div class="chips" role="group" aria-labelledby="svQ">${q.a.map(a => `<button class="chip" aria-pressed="${picked === a}" data-a="${a}">${a}</button>`).join('')}</div>
    ${picked && q.base ? `<div class="base"><span class="pips" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i class="${i < q.base[0] ? 'f' : ''}" style="--k:${i}"></i>`).join('')}</span><p><b>${q.base[0]} of 16</b> discovery interviewees ${q.base[1]}.</p></div>` : ''}
    ${picked ? `<button class="btn primary" id="svNext" style="justify-self:start">${qi === QS.length - 1 ? 'Submit my answers' : 'Next question →'}</button>` : ''}</div>`;
  $$('.chip', el).forEach(b => b.addEventListener('click', () => { ans[q.k] = b.dataset.a; survey(); requestAnimationFrame(() => { const p = $('.base .pips', el); if (p) p.closest('.base').classList.add('in'); const nx = $('#svNext'); if (nx) nx.focus({ preventScroll: true }); }); }));
  const nx = $('#svNext'); if (nx) nx.addEventListener('click', () => { if (qi < QS.length - 1) { qi++; survey(); } else { G.survey = Object.assign({}, ans); save(); track('survey_submit', G.survey); survey(); } });
}

/* ---------- sharing + referral ---------- */
const local = location.protocol === 'file:' || /^(127\.|localhost)/.test(location.hostname);
const link = id => location.origin + location.pathname + '?ref=' + G.ref + (id ? '&t=' + id : '');
async function share(channel, text, id, btn) {
  const url = link(id), t = encodeURIComponent(text), u = encodeURIComponent(url);
  const open = h => window.open(h, '_blank', 'noopener,noreferrer');
  if (channel === 'x') open(`https://twitter.com/intent/tweet?text=${t}&url=${u}`);
  else if (channel === 'linkedin') open(`https://www.linkedin.com/sharing/share-offsite/?url=${u}`);
  else if (channel === 'whatsapp') open(`https://wa.me/?text=${t}%20${u}`);
  else if (channel === 'email') location.href = `mailto:?subject=${encodeURIComponent('Which would you watch?')}&body=${t}%0A%0A${u}`;
  else if (channel === 'native' && navigator.share) { try { await navigator.share({ title: 'StoryForge', text, url }); } catch (e) { return; } }
  else { try { await navigator.clipboard.writeText(text + ' ' + url); } catch (e) { const ta = document.createElement('textarea'); ta.value = text + ' ' + url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } channel = 'copy'; if (btn) { const o = btn.textContent; btn.textContent = 'Link copied ✓'; setTimeout(() => { btn.textContent = o; }, 1800); } }
  track('share', { channel, what: id || 'page' });
}
const PITCH = 'Unproduced scripts become 30-second concept trailers and real audiences pick between them. Which would you watch?';
function sharing() {
  const el = $('#shareBox'); if (!el) return;
  el.innerHTML = `<span class="label">Your invite link</span><div class="lnk"><input id="refLink" readonly value="${link()}" aria-label="Your invite link"><button class="btn primary" data-ch="copy">Copy link</button></div>
    <div class="chips">${navigator.share ? '<button class="chip" data-ch="native">Share…</button>' : ''}<button class="chip" data-ch="x">Post on X</button><button class="chip" data-ch="linkedin">LinkedIn</button><button class="chip" data-ch="whatsapp">WhatsApp</button><button class="chip" data-ch="email">Email</button></div>
    <p class="mute">${local ? 'This page is running from your machine, so the link only opens here. Host the folder and the same buttons share a public link.' : 'Your invite code travels with the link. Visits are attributed to it once a GA4 ID is connected; until then each visit is logged only on the visitor’s own device.'}${G.inbound ? ` You arrived on invite <b>${G.inbound}</b>.` : ''}</p>`;
  el.addEventListener('click', e => { const b = e.target.closest('[data-ch]'); if (b) share(b.dataset.ch, PITCH, null, b); });
  $('#refLink').addEventListener('focus', e => e.target.select());
  document.addEventListener('click', e => { const b = e.target.closest('[data-share]'); if (b) share(navigator.share ? 'native' : 'copy', b.dataset.text || PITCH, b.dataset.share === 'trailer' ? b.dataset.id : null, b); });
}

/* ---------- reward ladder: earned, never bought ---------- */
function rewards() {
  const el = $('#rewardBox'); if (!el) return; const a = app();
  const tasks = [['Vote in all three face-offs', Object.keys(a.votes || {}).length >= 3, '#faceoff'], ['Answer the five-tap survey', !!G.survey, '#survey'], ['Pick your door and join', !!a.signed, '#doors'], ['Pass it on once', G.events.some(e => e.n === 'share'), '#share']];
  const done = tasks.filter(t => t[1]).length, was = el.dataset.done;
  el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><span class="label">Founding panellist · ${done} of ${tasks.length}</span><span class="illus">reward is design intent</span></div>
    <div class="track"><div class="fill" style="transform:scaleX(${done / tasks.length})"></div></div>
    <ul class="tasks">${tasks.map(([t, ok, h]) => `<li class="${ok ? 'ok' : ''}"><span class="tick" aria-hidden="true">${ok ? '✓' : ''}</span><span>${t}</span>${ok ? '<em>Done</em>' : `<a class="btn ghost sm" href="${h}">Go</a>`}</li>`).join('')}</ul>
    <div class="badge ${done === tasks.length ? 'on' : ''}"><b>${done === tasks.length ? 'Founding panellist unlocked' : 'Unlocks: founding panellist'}</b><span>Early access to every concept you backed and a thanks credit if it gets made. Earned by taking part, never sold.</span></div>`;
  if (was !== undefined && +was < tasks.length && done === tasks.length && !RM) $('.badge', el).animate([{ transform: 'scale(.94)', opacity: .4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
  el.dataset.done = done;
}

/* ---------- boot ---------- */
function boot() {
  if (boot.done) return; boot.done = true;
  survey(); sharing(); rewards(); sections();
  const seg = $('#dashSeg'); if (seg) { seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.k; $$('button', seg).forEach(x => x.setAttribute('aria-pressed', String(x === b))); const pill = $('.pill', seg); pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft}px)`; dash(); }); }
  const ex = $('#dashExport'); if (ex) ex.addEventListener('click', exportCSV);
  const cl = $('#dashClear'); if (cl) cl.addEventListener('click', () => { G.sessions = [session]; G.events = []; save(); dash(); rewards(); });
  track('page_view', { ref: G.inbound || '', src: qs.get('utm_source') || '', path: location.pathname.split('/').pop() });
  if (G.inbound) track('referral_landing', { ref: G.inbound });
  const t = qs.get('t'); if (t && window.SF) setTimeout(() => window.SF.open(t), 600);
}
document.addEventListener('sf:ready', boot); setTimeout(boot, 2500);
})();
