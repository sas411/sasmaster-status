/* StoryForge Live — Dr. Scoop, the guide. A companion in the corner who walks the page stop by stop.
   He opens only when tapped. With the card open he follows the scroll, so the tour and free roaming are the same thing.
   Vanilla JS, no dependencies, independent of app.js. Each stop describes what is on the page and nothing else. */
(() => {
'use strict';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STOPS = [
  ['top', 'The concept reel', 'Every trailer in this frame was rendered from a writer’s unproduced script. Sound and Next sit at the bottom of the picture.'],
  ['faceoff', 'Tonight’s face-off', 'Two trailers, one question: which would you watch? Play both, then pick one. The tap is the vote.'],
  ['soon', 'Not out yet', 'Real trailers for films that are still ahead. Tap the ones you would watch. Each is scored the weekend it opens.'],
  ['about', 'What StoryForge is', 'Unproduced scripts become 30-second concept trailers, real audiences pick between them, and every greenlight gets a number.'],
  ['instrument', 'From script to number', 'Five steps: Resolve, Decode, Render, Read, Signal. Tap any step to see what it does.'],
  ['doors', 'Three doors', 'Pick yours: I watch, I write or I buy. Each door shows what you get and lets you join.'],
  ['founding', 'Founding 50', 'Fifty writers open the library. Every writer you bring in who publishes adds six free months.'],
  ['board', 'The leaderboard', 'The Demand Index for every concept on the slate. It moves when you vote.'],
  ['survey', 'Five-tap survey', 'Five quick questions. After each answer you see how the 16 discovery interviewees answered.'],
  ['share', 'Pass it on', 'Your own link to this page. A face-off is better with someone to argue with.']
].map(s => ({ el: document.getElementById(s[0]), id: s[0], title: s[1], text: s[2] })).filter(s => s.el);
if (!STOPS.length) return;
const N = STOPS.length;

const root = document.createElement('div'); root.className = 'scoop';
root.innerHTML = `<div class="scoop-card" id="scoopCard" role="dialog" aria-label="Dr. Scoop, your guide" hidden>
    <button class="scoop-x" type="button" aria-label="Close the guide">×</button>
    <span class="label" id="scoopStep"></span><h3 id="scoopTitle"></h3><p id="scoopText"></p>
    <div class="scoop-nav"><button type="button" id="scoopBack">Back</button><button type="button" class="go" id="scoopNext"></button></div>
  </div>
  <button class="scoop-fab" type="button" id="scoopFab" aria-expanded="false" aria-controls="scoopCard" aria-label="Dr. Scoop, your guide to this page"><img src="media/dr-scoop.webp" alt="" width="76" height="144"></button>`;
document.body.appendChild(root);
const $ = s => root.querySelector(s), card = $('#scoopCard'), fab = $('#scoopFab'), step = $('#scoopStep'), title = $('#scoopTitle'), text = $('#scoopText'), back = $('#scoopBack'), next = $('#scoopNext');
let i = -1, open = false, started = false, lock = 0;

/* the stop the reader is looking at: the deepest one that holds the middle of the screen */
const here = () => { const mid = innerHeight * .46; let k = 0; STOPS.forEach((s, j) => { const r = s.el.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) k = j; }); return k; };
function render() {
  const s = STOPS[i];
  step.textContent = s ? `Dr. Scoop · stop ${i + 1} of ${N}` : 'Dr. Scoop · your guide';
  title.textContent = s ? s.title : 'Hi, I’m Dr. Scoop.';
  text.textContent = s ? s.text : `I’ll walk you through StoryForge in ${N} short stops. Or just scroll, and I’ll keep up.`;
  back.hidden = !s || i === 0; next.textContent = !s ? 'Start the tour' : i === N - 1 ? 'Finish' : 'Next';
  if (!RM) [title, text].forEach(el => { el.classList.remove('sw'); void el.offsetWidth; el.classList.add('sw'); });
}
function go(k) {
  i = Math.max(0, Math.min(N - 1, k)); started = true; render(); lock = Date.now() + 1800;
  const s = STOPS[i];
  if (s.id === 'top') scrollTo({ top: 0, behavior: RM ? 'auto' : 'smooth' }); else s.el.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' });
}
function show() {
  open = true; root.classList.add('open'); root.classList.remove('nudge'); card.classList.remove('out'); card.hidden = false; fab.setAttribute('aria-expanded', 'true');
  if (started) i = here(); render(); next.focus({ preventScroll: true });
}
function hide() {
  open = false; root.classList.remove('open'); fab.setAttribute('aria-expanded', 'false');
  if (RM) { card.hidden = true; return; }
  card.classList.add('out'); setTimeout(() => { if (!open) card.hidden = true; }, 190);
}
fab.addEventListener('click', () => (open ? hide() : show()));
$('.scoop-x').addEventListener('click', () => { hide(); fab.focus({ preventScroll: true }); });
next.addEventListener('click', () => { if (!started) go(here()); else if (i === N - 1) { hide(); fab.focus({ preventScroll: true }); } else go(i + 1); });
back.addEventListener('click', () => go(i - 1));
root.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { hide(); fab.focus({ preventScroll: true }); } });
let tick = false;
addEventListener('scrollend', () => { lock = 0; }); // the smooth scroll to a stop has landed
addEventListener('scroll', () => { // free roaming: with the card open, he keeps up with the reader
  if (!open || !started || tick || Date.now() < lock) return; tick = true;
  requestAnimationFrame(() => { tick = false; const k = here(); if (k !== i) { i = k; render(); } });
}, { passive: true });
/* one quiet ring around him once the page has settled, so he is noticed without talking first */
const nudge = () => setTimeout(() => { if (!open && !started) root.classList.add('nudge'); }, 2600);
if (window.SF) nudge(); else document.addEventListener('sf:ready', nudge, { once: true });
})();
