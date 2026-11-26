import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import type { Meta, Leg } from './engine';

const INF = 0x3fffffff;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WALK_M_PER_MIN = 60; // visual halo only: ~3.6 km/h effective walk

interface State { a: L.LatLng; b: L.LatLng | null; t: number; budget: number; day: number }
const istDay = () => { const d = new Date(Date.now() + 5.5 * 3600e3); return (d.getUTCDay() + 6) % 7; };
const st: State = { a: L.latLng(12.9777, 77.5722), b: null, t: 540, budget: 45, day: istDay() };

// ---------- hash state ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const ll = (s: string | null) => { if (!s) return null; const [x, y] = s.split(',').map(Number); return isFinite(x) && isFinite(y) ? L.latLng(x, y) : null; };
  const a = ll(p.get('a')); if (a) st.a = a;
  const b = ll(p.get('b')); if (b) st.b = b;
  const t = Number(p.get('t')); if (p.has('t') && t >= 0 && t <= 1435) st.t = t;
  const m = Number(p.get('m')); if (p.has('m') && m >= 10 && m <= 120) st.budget = m;
  const d = Number(p.get('d')); if (p.has('d') && d >= 0 && d <= 6) st.day = d;
}
function writeHash() {
  const f = (l: L.LatLng) => `${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
  const p = new URLSearchParams({ a: f(st.a), t: String(st.t), m: String(st.budget), d: String(st.day) });
  if (st.b) p.set('b', f(st.b));
  history.replaceState(null, '', '#' + p.toString());
}
readHash();

// ---------- helpers ----------
const hhmm = (sec: number) => { const s = Math.round(sec / 60); const h = Math.floor(s / 60) % 24, m = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
const RAMP: [number, number, number][] = [[255, 241, 118], [255, 160, 60], [236, 64, 122], [124, 77, 255]];
function ramp(f: number): [number, number, number] {
  f = Math.min(1, Math.max(0, f)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f)), k = f - i;
  return [0, 1, 2].map((c) => Math.round(RAMP[i][c] + (RAMP[i + 1][c] - RAMP[i][c]) * k)) as [number, number, number];
}
const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---------- map ----------
const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 9, maxZoom: 17 }).setView([12.9716, 77.5946], 11);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'dark-tiles', attribution: '© OpenStreetMap contributors',
}).addTo(map);
map.setMaxBounds(L.latLngBounds([12.5, 77.2], [13.5, 78.0]).pad(0.5));
if (!location.hash) map.setView(st.a, 12);
else map.setView(st.a, 12);
if (window.innerWidth <= 640) map.panBy([0, 150], { animate: false });

const pinIcon = (label: string, cls: string) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${label}</span></div>`, iconSize: [30, 38], iconAnchor: [15, 36] });
const markerA = L.marker(st.a, { draggable: true, icon: pinIcon('A', 'pa'), zIndexOffset: 1000 }).addTo(map);
let markerB: L.Marker | null = null;

// ---------- data/worker ----------
let meta: Meta; let ready = false;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let arrs: Int32Array[] = [];
let inflight = false, pending = false, scanId = 0;
let lastInfo = { ms: 0, scanned: 0, nConn: 0 };
const traceCbs = new Map<number, (legs: Leg[]) => void>();
let reqId = 0;

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'ready') { ready = true; $('loading').classList.add('hide'); requestScan(); requestProfile(); }
  else if (m.type === 'scan') {
    inflight = false;
    if (m.id === scanId) { arrs = m.arrs; lastInfo = { ms: m.ms, scanned: m.scanned, nConn: m.nConn }; afterScan(); }
    if (pending) { pending = false; requestScan(); }
  } else if (m.type === 'trace') { traceCbs.get(m.req)?.(m.legs); traceCbs.delete(m.req); }
  else if (m.type === 'profile') { if (m.id === profId) { profile = m.counts; drawProfile(); } }
};

async function gz(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const ds = new DecompressionStream('gzip');
  return new Response(r.body!.pipeThrough(ds)).arrayBuffer();
}
(async () => {
  try {
    const base = import.meta.env.BASE_URL;
    const [mb, bin] = await Promise.all([gz(base + 'data/reach-meta.json.gz'), gz(base + 'data/reach.bin.gz')]);
    meta = JSON.parse(new TextDecoder().decode(mb));
    $('loadMsg').textContent = 'Building connection index…';
    worker.postMessage({ type: 'init', meta, bin }, [bin]);
  } catch (err) {
    $('loadMsg').textContent = 'Could not load timetable data: ' + (err as Error).message;
  }
})();

function origins() { return [st.a, ...(st.b ? [st.b] : [])].map((l) => ({ lat: l.lat, lon: l.lng })); }
function requestScan() {
  if (!ready) return;
  if (inflight) { pending = true; return; }
  inflight = true; scanId++;
  worker.postMessage({ type: 'scan', id: scanId, origins: origins(), t0: st.t * 60, maxSecs: st.budget * 60, day: st.day });
}

// ---------- canvas layer ----------
const canvas = document.createElement('canvas');
canvas.className = 'reach-canvas';
map.getPanes().overlayPane.appendChild(canvas);
const ctx = canvas.getContext('2d')!;
let hits: { x: number; y: number; s: number }[] = [];
let overlay: { stop: number; best: number } | null = null;
let routeLines: L.Polyline[] = [];

function layout() {
  const sz = map.getSize(), dpr = window.devicePixelRatio || 1;
  canvas.width = sz.x * dpr; canvas.height = sz.y * dpr;
  canvas.style.width = sz.x + 'px'; canvas.style.height = sz.y + 'px';
  L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
}
function draw() {
  if (!meta) return;
  layout();
  const dpr = window.devicePixelRatio || 1;
  const sz = map.getSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sz.x, sz.y);
  hits = [];
  if (!arrs.length) return;
  const zoom = map.getZoom();
  const mpp = (40075016.686 * Math.cos((12.97 * Math.PI) / 180)) / (256 * Math.pow(2, zoom));
  const budgetSec = st.budget * 60, t0 = st.t * 60;
  const two = arrs.length > 1;
  const A = arrs[0], B = two ? arrs[1] : null;
  const n = meta.stops.n.length;
  const pts: { x: number; y: number; s: number; col: number[]; halo: number; big: boolean; both: boolean }[] = [];
  for (let s = 0; s < n; s++) {
    const a = A[s], b = B ? B[s] : INF;
    if (a >= INF && b >= INF) continue;
    const p = map.latLngToContainerPoint([meta.stops.lat[s], meta.stops.lon[s]]);
    if (p.x < -60 || p.y < -60 || p.x > sz.x + 60 || p.y > sz.y + 60) continue;
    const both = a < INF && b < INF;
    let col: number[], rem: number;
    if (!two) { const f = (a - t0) / budgetSec; col = ramp(f); rem = budgetSec - (a - t0); }
    else if (both) { col = [190, 255, 94]; rem = budgetSec - Math.max(a, b) + t0; }
    else if (a < INF) { const f = (a - t0) / budgetSec; col = [90 + (1 - f) * 80, 200 + (1 - f) * 45, 255]; rem = budgetSec - (a - t0); }
    else { const f = (b - t0) / budgetSec; col = [255, 150 + (1 - f) * 70, 60 + (1 - f) * 40]; rem = budgetSec - (b - t0); }
    pts.push({ x: p.x, y: p.y, s, col, halo: Math.min(rem / 60, 12) * WALK_M_PER_MIN / mpp, big: both, both });
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const q of pts) {
    if (q.halo < 1) continue;
    ctx.fillStyle = rgb(q.col, zoom < 13 ? 0.055 : 0.035);
    ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(2, q.halo), 0, 6.2832); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  const r = Math.max(1.4, Math.min(4.5, (zoom - 9) * 0.65 + 0.8));
  for (const q of pts) {
    ctx.fillStyle = rgb(q.col, 0.95);
    ctx.beginPath(); ctx.arc(q.x, q.y, q.big ? r * 1.25 : r, 0, 6.2832); ctx.fill();
    hits.push({ x: q.x, y: q.y, s: q.s });
  }
  if (overlay) {
    const p = map.latLngToContainerPoint([meta.stops.lat[overlay.best], meta.stops.lon[overlay.best]]);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, 6.2832); ctx.stroke();
  }
}
map.on('move zoom viewreset resize', draw);
map.on('moveend zoomend', draw);

// ---------- results panel ----------
let meetStops: { s: number; ta: number; tb: number }[] = [];
function afterScan() {
  draw();
  const t0 = st.t * 60;
  const n = meta.stops.n.length;
  const A = arrs[0], B = arrs[1];
  let na = 0, nb = 0, nboth = 0;
  meetStops = [];
  for (let s = 0; s < n; s++) {
    const a = A[s] < INF, b = B ? B[s] < INF : false;
    if (a) na++; if (b) nb++;
    if (a && b) { nboth++; meetStops.push({ s, ta: (A[s] - t0) / 60, tb: (B[s] - t0) / 60 }); }
  }
  const pct = (x: number) => ((100 * x) / n).toFixed(x / n < 0.1 ? 1 : 0);
  let html = `<div class="big"><b>${na.toLocaleString()}</b> stops reachable from <span class="ca">A</span> <small>(${pct(na)}% of ${n.toLocaleString()})</small></div>`;
  if (B) html += `<div class="big"><b>${nb.toLocaleString()}</b> from <span class="cb">B</span> · <b>${nboth.toLocaleString()}</b> reachable from both</div>`;
  html += `<div class="eng">${lastInfo.nConn.toLocaleString()} connections indexed, ${lastInfo.scanned.toLocaleString()} scanned in ${lastInfo.ms.toFixed(1)} ms</div>`;
  $('stats').innerHTML = html;
  $('legLabelB').textContent = st.budget + ' min';

  const meet = $('meet');
  if (B) {
    meetStops.sort((x, y) => Math.max(x.ta, x.tb) - Math.max(y.ta, y.tb) || x.ta + x.tb - y.ta - y.tb);
    const seen = new Set<string>();
    const top: typeof meetStops = [];
    for (const m of meetStops) { const nm = meta.stops.n[m.s]; if (seen.has(nm)) continue; seen.add(nm); top.push(m); if (top.length >= 5) break; }
    overlay = top.length ? { stop: top[0].s, best: top[0].s } : null;
    meet.innerHTML = top.length
      ? `<div class="ph">Balanced meeting stops (bus stops, not vetted places)</div>` + top.map((m, i) => `<button class="meetrow" data-s="${m.s}"><span>${i + 1}. ${esc(meta.stops.n[m.s])}</span><small><span class="ca">A ${Math.round(m.ta)}m</span> <span class="cb">B ${Math.round(m.tb)}m</span></small></button>`).join('')
      : `<div class="ph">No shared stop within ${st.budget} min. Try a bigger budget or another time.</div>`;
    meet.querySelectorAll<HTMLButtonElement>('.meetrow').forEach((bt) => bt.onclick = () => { const s = +bt.dataset.s!; map.flyTo([meta.stops.lat[s], meta.stops.lon[s]], Math.max(map.getZoom(), 14), { duration: 0.6 }); showJourney(s); });
  } else { overlay = null; meet.innerHTML = ''; }
  draw();
  writeHash();
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---------- journey ----------
function clearRoute() { routeLines.forEach((l) => l.remove()); routeLines = []; }
function showJourney(stop: number) {
  clearRoute();
  const jr = $('journey');
  const which: number[] = [];
  arrs.forEach((a, i) => { if (a[stop] < INF) which.push(i); });
  if (!which.length) { jr.innerHTML = ''; return; }
  jr.innerHTML = `<div class="ph">Fastest scheduled trip to <b>${esc(meta.stops.n[stop])}</b> <button id="closeJ" class="x">×</button></div><div id="jlegs"></div>`;
  $('closeJ').onclick = () => { jr.innerHTML = ''; clearRoute(); };
  which.forEach((oi) => {
    const req = ++reqId;
    traceCbs.set(req, (legs) => renderLegs(oi, legs));
    worker.postMessage({ type: 'trace', req, origin: oi, stop });
  });
}
function renderLegs(oi: number, legs: Leg[]) {
  const o = oi === 0 ? st.a : st.b!;
  const cls = oi === 0 ? 'ca' : 'cb';
  const pos = (s: number) => (s < 0 ? o : L.latLng(meta.stops.lat[s], meta.stops.lon[s]));
  const items: string[] = [];
  for (const l of legs) {
    const a = pos(l.from), b = pos(l.to);
    if (l.kind === 'walk' && l.from === l.to) continue;
    routeLines.push(L.polyline([a, b], { color: l.kind === 'bus' ? '#ffffff' : '#9aa7b3', weight: l.kind === 'bus' ? 3 : 2, dashArray: l.kind === 'bus' ? undefined : '4 6', opacity: 0.9, interactive: false }).addTo(map));
    const from = l.from < 0 ? 'your pin' : meta.stops.n[l.from];
    items.push(l.kind === 'bus'
      ? `<li><b>Bus ${esc(l.route ?? '')}</b> ${hhmm(l.dep)} ${esc(from)} → ${hhmm(l.arr)} ${esc(meta.stops.n[l.to])}</li>`
      : `<li class="w">Walk ${Math.max(1, Math.round((l.arr - l.dep) / 60))} min ${l.from < 0 ? 'to' : 'to'} ${esc(meta.stops.n[l.to])}</li>`);
  }
  const box = $('jlegs'); if (!box) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="jh"><span class="${cls}">${oi === 0 ? 'From A' : 'From B'}</span></div><ol>${items.join('')}</ol>`;
  box.appendChild(wrap);
}

// ---------- hover + click ----------
const tip = $('tip');
function nearest(px: number, py: number, rad = 14) {
  let best: { x: number; y: number; s: number } | null = null, bd = rad * rad;
  for (const h of hits) { const d = (h.x - px) ** 2 + (h.y - py) ** 2; if (d < bd) { bd = d; best = h; } }
  return best;
}
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  const h = nearest(e.containerPoint.x, e.containerPoint.y);
  if (!h) { tip.style.display = 'none'; return; }
  const t0 = st.t * 60;
  const parts: string[] = [];
  arrs.forEach((a, i) => { if (a[h.s] < INF) parts.push(`${arrs.length > 1 ? (i ? 'B ' : 'A ') : ''}${Math.round((a[h.s] - t0) / 60)} min`); });
  tip.innerHTML = `<b>${esc(meta.stops.n[h.s])}</b><br>${parts.join(' · ')}`;
  tip.style.display = 'block'; tip.style.left = e.containerPoint.x + 14 + 'px'; tip.style.top = e.containerPoint.y + 14 + 'px';
});
map.on('mouseout', () => (tip.style.display = 'none'));
map.on('click', (e: L.LeafletMouseEvent) => {
  const h = nearest(e.containerPoint.x, e.containerPoint.y, 18);
  if (h) showJourney(h.s);
  else { $('journey').innerHTML = ''; clearRoute(); }
});

// ---------- markers ----------
function onDrag(m: L.Marker, which: 'a' | 'b') { st[which] = m.getLatLng(); clearRoute(); $('journey').innerHTML = ''; requestScan(); }
markerA.on('drag', () => onDrag(markerA, 'a'));
markerA.on('dragend', () => { requestProfile(); });
function addB() {
  const c = map.getCenter();
  st.b = L.latLng(c.lat + 0.01, c.lng + 0.02);
  makeB();
}
function makeB() {
  markerB = L.marker(st.b!, { draggable: true, icon: pinIcon('B', 'pb'), zIndexOffset: 900 }).addTo(map);
  markerB.on('drag', () => onDrag(markerB!, 'b'));
  $('addB').textContent = '− Remove second pin';
  requestScan();
}
$('addB').onclick = () => {
  if (st.b) { st.b = null; markerB?.remove(); markerB = null; $('addB').textContent = '+ Add second pin'; overlay = null; clearRoute(); $('journey').innerHTML = ''; requestScan(); }
  else addB();
};
if (st.b) makeB();
markerA.setLatLng(st.a);

// ---------- controls ----------
const daysEl = $('days');
DAYS.forEach((d, i) => { const b = document.createElement('button'); b.textContent = d; b.onclick = () => { st.day = i; syncUI(); requestScan(); requestProfile(); }; daysEl.appendChild(b); });
const timeEl = $<HTMLInputElement>('time'), budEl = $<HTMLInputElement>('budget');
timeEl.oninput = () => { st.t = +timeEl.value; syncUI(); requestScan(); };
budEl.oninput = () => { st.budget = +budEl.value; syncUI(); requestScan(); };
budEl.onchange = () => requestProfile();
function syncUI() {
  timeEl.value = String(st.t); budEl.value = String(st.budget);
  $('timeLabel').textContent = hhmm(st.t * 60);
  $('budgetLabel').textContent = st.budget + ' min';
  [...daysEl.children].forEach((c, i) => c.classList.toggle('on', i === st.day));
  drawProfile();
}
let playTimer = 0;
$('play').onclick = () => {
  if (playTimer) { clearInterval(playTimer); playTimer = 0; $('play').textContent = '▶'; return; }
  $('play').textContent = '❚❚';
  playTimer = window.setInterval(() => { st.t = st.t >= 1430 ? 0 : st.t + 5; syncUI(); requestScan(); }, 90);
};
$('share').onclick = async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); $('share').textContent = 'Copied'; } catch { $('share').textContent = 'Copy the address bar'; } setTimeout(() => ($('share').textContent = 'Copy link'), 1800); };
$('collapse').onclick = () => $('panel').classList.toggle('min');
const bar = $('legBar'); bar.style.background = `linear-gradient(90deg, ${[0, 0.33, 0.66, 1].map((f) => rgb(ramp(f))).join(',')})`;

// ---------- day profile ----------
let profile: number[] = [], profId = 0, profTimer = 0;
function requestProfile() {
  if (!ready) return;
  clearTimeout(profTimer);
  profTimer = window.setTimeout(() => { profId++; worker.postMessage({ type: 'profile', id: profId, origin: { lat: st.a.lat, lon: st.a.lng }, day: st.day, maxSecs: st.budget * 60 }); }, 250);
}
const pc = $<HTMLCanvasElement>('profile');
function drawProfile() {
  const w = pc.clientWidth || 300, h = 70, dpr = window.devicePixelRatio || 1;
  pc.width = w * dpr; pc.height = h * dpr;
  const c = pc.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  if (!profile.length) return;
  const max = Math.max(1, ...profile);
  const bw = w / profile.length;
  profile.forEach((v, i) => {
    const hh = (v / max) * (h - 16);
    const tHour = 4 + i * 0.5;
    const cur = Math.abs(tHour * 60 - st.t) < 15;
    c.fillStyle = cur ? '#ffffff' : 'rgba(85,242,208,0.65)';
    c.fillRect(i * bw + 0.5, h - 12 - hh, bw - 1.5, hh);
  });
  c.fillStyle = '#8a97a3'; c.font = '10px system-ui';
  [4, 8, 12, 16, 20].forEach((hr) => c.fillText(String(hr).padStart(2, '0'), ((hr - 4) * 2) * bw, h - 1));
  c.fillText('max ' + max.toLocaleString(), w - 62, 10);
}
pc.onclick = (e) => {
  if (!profile.length) return;
  const i = Math.floor((e.offsetX / pc.clientWidth) * profile.length);
  st.t = Math.round((4 + i * 0.5) * 60); syncUI(); requestScan();
};
window.addEventListener('resize', drawProfile);
syncUI();
(window as any).__reach = { st, map, get arrs() { return arrs; }, get ready() { return ready; } };
