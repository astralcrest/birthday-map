import * as M from './music.js';
import * as Gr from './graph.js';
import { Player } from './audio.js';
import qrcode from './vendor/qrcode.mjs';

// ---------- small things ----------
const $ = s => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const Q = new URLSearchParams(location.search);
const DEMO = Q.has('demo');
const ROLE = (Q.has('host') || (DEMO && !Q.has('guest'))) ? 'host' : 'guest';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickOne = a => a[Math.floor(Math.random() * a.length)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}
function setText(id, t) { const e = $(id); if (e && e.textContent !== t) e.textContent = t; }
function andList(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } };
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// the password is the room: pbkdf2 gives a room id and an aes key
async function derive(pw) {
  const norm = pw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  const base = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('astralcrest-party/v1'), iterations: 250000 }, base, 384));
  const roomId = [...bits.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { norm, roomId, key, code: roomId.slice(0, 4) };
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { party: 'astralcrest-party/v1', iv: b64(iv), ct: b64(ct) };
}
async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
function cleanPick(p) {
  if (!p || !p.aid) return null;
  const o = { k: p.k === 't' ? 't' : 'a', aid: +p.aid, an: String(p.an || '').slice(0, 80) };
  if (p.tid) { o.tid = +p.tid; o.tt = String(p.tt || '').slice(0, 100); }
  return o;
}
const pickLabel = p => p.k === 't' ? `${p.tt} · ${p.an}` : p.an;

// ---------- gate ----------
async function gate() {
  if (DEMO) return derive('demo');
  const frag = new URLSearchParams(location.hash.slice(1));
  const fromLink = frag.get('k');
  if (fromLink) history.replaceState(null, '', location.pathname + location.search);
  let remembered = null;
  try { remembered = sessionStorage.getItem('party.pw'); } catch (e) { /* blocked */ }
  const pre = fromLink || remembered;
  if (pre) return derive(pre).then(k => { try { sessionStorage.setItem('party.pw', k.norm); } catch (e) { /* blocked */ } return k; });
  $('#gate').classList.remove('hide');
  setText('#gate-role', ROLE === 'host' ? 'host' : 'guest');
  if (ROLE === 'host') setText('#gate-note', 'choose any password. guests type the same one.');
  $('#gate-pw').focus();
  return new Promise(res => {
    $('#gate-form').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = $('#gate-pw').value;
      if (!pw.trim()) return;
      $('#gate-go').disabled = true;
      setText('#gate-go', 'opening');
      const k = await derive(pw);
      try { sessionStorage.setItem('party.pw', k.norm); } catch (e2) { /* blocked */ }
      $('#gate').classList.add('hide');
      res(k);
    });
  });
}

// ---------- picker: up to three picks, each from a search or a pasted link ----------
function picker(root, { max = 3, onChange = () => {} } = {}) {
  const picks = new Array(max).fill(null);
  let timers = [];
  function render() {
    root.textContent = '';
    let shownEmpty = false;
    picks.forEach((p, i) => {
      const slot = el('div', { class: 'slot' });
      if (p) {
        slot.append(el('div', { class: 'chip' },
          el('div', { class: 'lab' }, el('b', {}, p.k === 't' ? p.tt : p.an), el('span', {}, p.k === 't' ? `song · ${p.an}` : 'artist')),
          el('button', { type: 'button', 'aria-label': 'remove', onclick: () => { picks[i] = null; render(); onChange(); } }, '×')));
      } else if (!shownEmpty) {
        shownEmpty = true;
        const inp = el('input', { type: 'text', placeholder: i === 0 ? 'an artist, a song, or a link' : 'another one (optional)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `pick ${i + 1}` });
        const res = el('ul', { class: 'res' });
        const run = async () => {
          const q = inp.value.trim();
          if (q.length < 2) { res.textContent = ''; return; }
          res.textContent = '';
          res.append(el('li', {}, el('p', { class: 'msg' }, 'looking')));
          let list = [], note = '';
          if (/^(https?:\/\/|spotify:)/i.test(q)) {
            const r = await M.resolveLink(q);
            if (r && r.picks) list = r.picks;
            else if (r && r.query) { note = `from your ${r.from} link: ${r.query}`; list = await M.search(r.query); if (r.kind === 'track') list.sort((a, b) => (b.k === 't') - (a.k === 't')); }
            else note = 'could not read that link. try typing the name.';
          } else list = await M.search(q);
          if (inp.value.trim() !== q) return;
          res.textContent = '';
          if (note) res.append(el('li', {}, el('p', { class: 'msg' }, note)));
          if (!list.length && !note) res.append(el('li', {}, el('p', { class: 'msg' }, 'nothing found. try fewer words.')));
          for (const r of list) {
            res.append(el('li', {}, el('button', { type: 'button', onclick: () => { picks[i] = cleanPick(r); render(); onChange(); const n = root.querySelector('input'); if (n) n.focus(); } },
              el('span', { class: 'kd' }, r.k === 't' ? 'song' : 'artist'),
              el('span', { class: 'tx' }, el('b', {}, r.k === 't' ? r.tt : r.an), r.k === 't' ? el('span', {}, r.an) : null))));
          }
        };
        inp.addEventListener('input', () => { clearTimeout(timers[i]); timers[i] = setTimeout(run, 420); });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timers[i]); run(); } });
        slot.append(inp, res);
      }
      root.append(slot);
    });
  }
  render();
  return {
    get: () => picks.filter(Boolean),
    set: arr => { picks.fill(null); (arr || []).slice(0, max).forEach((p, i) => { picks[i] = cleanPick(p); }); render(); onChange(); },
  };
}

// =====================================================================
// HOST
// =====================================================================
const H = { guests: new Map(), scores: {}, hostKey: null, played: [], online: new Set(), pwQr: false, gv: 0, peer: new Map() };
// a phone keeps one id across reloads; the network id changes each time
const who = ctx => H.peer.get(ctx.userId) || ctx.userId;
const gidOf = (v, uid) => (typeof v.id === 'string' && /^[a-f0-9]{16}$/.test(v.id)) ? 'p' + v.id : uid;
let K = null, NET = null, player = null;
let mode = 'cloud';

function guestList() {
  return [...H.guests.values()].filter(g => g.picks && g.picks.length).sort((a, b) => (a.t || 0) - (b.t || 0));
}
const nameOf = k => { const g = H.guests.get(k); return g ? g.n : ''; };

// ---- persistence: sealed with the room key, never plain ----
let saveT = 0;
function saveSoon() {
  if (DEMO) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const box = await seal(K.key, { guests: [...H.guests.values()], scores: H.scores, hostKey: H.hostKey, played: H.played });
    lsSet('party.room.' + K.roomId, JSON.stringify(box));
  }, 700);
}
async function restore() {
  const raw = lsGet('party.room.' + K.roomId);
  if (!raw) return;
  try {
    const d = await unseal(K.key, JSON.parse(raw));
    for (const g of d.guests || []) H.guests.set(g.k, g);
    H.scores = d.scores || {}; H.hostKey = d.hostKey || null; H.played = d.played || [];
  } catch (e) { /* a different password wrote this: ignore */ }
}
function upsertGuest(k, v, src) {
  if (!v || !v.n) return;
  const picks = (v.picks || []).map(cleanPick).filter(Boolean).slice(0, 3);
  const prev = H.guests.get(k);
  H.guests.set(k, { k, n: String(v.n).slice(0, 24).trim() || 'guest', picks, src, t: prev ? prev.t : Date.now() });
  H.gv++;
  saveSoon(); dataChanged();
}

// ---- derived numbers ----
const DV = { list: [], idx: new Map(), D: [], xy: [], facts: {}, dots: [], gv: -1, ver: -1, at: 0, order: [] };
const pos = new Map();
function recompute(force) {
  const ver = Gr.ver();
  if (!force && DV.gv === H.gv && DV.ver === ver) return false;
  if (!force && performance.now() - DV.at < 1200) return false;
  DV.at = performance.now(); DV.gv = H.gv; DV.ver = ver;
  const list = guestList();
  DV.list = list;
  DV.idx = new Map(list.map((g, i) => [g.k, i]));
  const { D } = Gr.guestMatrix(list);
  DV.D = D;
  // people out of reach of everyone would squash the rest into a dot: they sit on an outer ring instead
  const n = list.length;
  const lone = list.map((_, i) => n >= 3 && D[i].every((d, j) => j === i || d >= Gr.FAR));
  const core = list.map((_, i) => i).filter(i => !lone[i]);
  let xy;
  if (core.length >= 2 && core.length < n) {
    const cxy = normalize(Gr.mds(core.map(i => core.map(j => D[i][j]))));
    xy = list.map(() => [0, 0]);
    core.forEach((i, k) => { xy[i] = [cxy[k][0] * .74, cxy[k][1] * .74]; });
    const out = list.map((_, i) => i).filter(i => lone[i]);
    out.forEach((i, k) => { const a = -.7 + k * 2 * Math.PI / Math.max(5, out.length); xy[i] = [Math.cos(a), Math.sin(a)]; });
  } else xy = Gr.mds(D);
  xy = relax(normalize(align(xy, list)));
  DV.xy = xy;
  list.forEach((g, i) => { if (!pos.has(g.k)) pos.set(g.k, [xy[i][0] * .2, xy[i][1] * .2]); });
  DV.facts = list.length >= 2 ? Gr.facts(list, D) : {};
  DV.order = list.length >= 3 ? Gr.tour(list, (a, b) => D[a][b]) : list.map((_, i) => i);
  // the map behind everyone: each mapped artist sits between the people whose picks reach it
  const acc = new Map();
  list.forEach((g, i) => {
    const { dist } = Gr.bfs(g.picks.map(p => p.aid), 2);
    for (const [v, d] of dist) {
      const w = d === 0 ? 3 : d === 1 ? 1 : .3;
      const a = acc.get(v) || [0, 0, 0, 9];
      a[0] += xy[i][0] * w; a[1] += xy[i][1] * w; a[2] += w; a[3] = Math.min(a[3], d);
      acc.set(v, a);
    }
  });
  DV.dots = [...acc.entries()].slice(0, 5000).map(([v, a]) => {
    const h = (v * 2654435761) >>> 0;
    const ang = (h % 6283) / 1000, u = ((h >> 13) % 1000) / 1000;
    const rr = a[3] === 0 ? .02 : a[3] === 1 ? .05 + u * .09 : .1 + u * .16;
    return [a[0] / a[2] + Math.cos(ang) * rr, a[1] / a[2] + Math.sin(ang) * rr, v];
  });
  renderSide();
  return true;
}
function normalize(xy) {
  if (!xy.length) return xy;
  const cx = xy.reduce((s, p) => s + p[0], 0) / xy.length, cy = xy.reduce((s, p) => s + p[1], 0) / xy.length;
  let m = 1e-9;
  xy = xy.map(p => [p[0] - cx, p[1] - cy]);
  for (const p of xy) m = Math.max(m, Math.hypot(p[0], p[1]));
  return xy.map(p => [p[0] / m, p[1] / m]);
}
// keep the picture steady when someone joins: rotate or flip to match the last layout
function align(xy, list) {
  const prev = list.map(g => DV.prevXY && DV.prevXY.get(g.k));
  const pairs = xy.map((p, i) => [p, prev[i]]).filter(x => x[1]);
  let best = xy;
  if (pairs.length >= 2) {
    let bestErr = Infinity;
    for (const fx of [1, -1]) {
      const f = xy.map(p => [p[0] * fx, p[1]]);
      let sxx = 0, sxy = 0;
      pairs.forEach(([, q], j) => { const p = f[xy.indexOf(pairs[j][0])]; sxx += p[0] * q[0] + p[1] * q[1]; sxy += p[0] * q[1] - p[1] * q[0]; });
      const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
      const r = f.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
      let err = 0;
      pairs.forEach(([p0, q]) => { const p = r[xy.indexOf(p0)]; err += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; });
      if (err < bestErr) { bestErr = err; best = r; }
    }
  }
  DV.prevXY = new Map(list.map((g, i) => [g.k, best[i]]));
  return best;
}
function relax(xy) {
  const n = xy.length, min = n > 20 ? .13 : .2;
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = xy[j][0] - xy[i][0], dy = xy[j][1] - xy[i][1];
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) { dx = Math.cos(i + j); dy = Math.sin(i * 3 + j); d = 1e-3; }
      if (d < min) {
        const push = (min - d) / 2 / d;
        xy[i][0] -= dx * push; xy[i][1] -= dy * push; xy[j][0] += dx * push; xy[j][1] += dy * push;
      }
    }
  }
  return normalize(xy);
}
let dataT = 0;
function dataChanged() {
  clearTimeout(dataT);
  dataT = setTimeout(() => {
    renderJoin();
    const w = Gr.warm(guestList(), () => { recompute(); });
    if (w) w.then(bridgePass);
    recompute(true);
    publish();
  }, 150);
}

// someone whose picks reach nobody yet: search outward from them until they touch the rest
const bridged = new Set();
async function bridgePass() {
  recompute(true);
  const L = DV.list, D = DV.D;
  for (let i = 0; i < L.length; i++) {
    const g = L[i];
    const sig = g.k + ':' + g.picks.map(p => p.aid).join(',');
    if (bridged.has(sig)) continue;
    const reach = L.some((_, j) => j !== i && D[i] && D[i][j] < Gr.FAR);
    if (reach || L.length < 2) continue;
    bridged.add(sig);
    const others = L.filter(x => x.k !== g.k).flatMap(x => x.picks.map(p => p.aid));
    await Gr.pathLive(g.picks.map(p => p.aid), others, { budget: 90, beam: 18, lane: 'lo' });
    recompute(true);
  }
}

// ---- the show state that phones read ----
let RD = null; // current round
let pubT = 0;
function publish() {
  clearTimeout(pubT);
  pubT = setTimeout(() => {
    if (!NET) return;
    const list = guestList();
    const s = {
      v: 1, mode, code: K.code, t: Date.now(),
      guests: list.map(g => ({ k: g.k, n: g.n })),
      scores: H.scores,
      round: RD ? { id: RD.id, type: RD.type, open: RD.open, q: RD.q, opts: RD.opts || null, res: RD.res || null } : null,
    };
    NET.show.set(s).catch(() => {});
  }, 120);
}
function openRound(type, q, opts, truth) {
  RD = { id: rid(), type, q, opts, open: true, votes: new Map(), res: null, t0: performance.now(), truth };
  publish();
  if (DEMO) fakeVotes(RD);
  renderBoard();
  return RD;
}
function closeRound(res) {
  if (!RD) return;
  RD.open = false; RD.res = res;
  publish(); renderBoard(); saveSoon();
}
function addPoints(keys, n = 1) {
  for (const k of keys) H.scores[k] = (H.scores[k] || 0) + n;
}
function onVote(v, ctx) {
  if (!RD || !RD.open || !v || v.r !== RD.id) return;
  RD.votes.set(who(ctx), v.v);
  setText('#k-hop', roundLine());
}
function roundLine() {
  if (!RD) return '';
  const phones = DV.list.filter(g => g.src === 'p2p' || g.src === 'demo').length;
  return RD.open ? `${RD.votes.size} of ${phones || DV.list.length} in` : '';
}
// demo phones: invented guests vote a few seconds after a round opens
function fakeVotes(rd) {
  const list = DV.list;
  list.forEach((g, i) => {
    if (Math.random() < .15) return;
    setTimeout(() => {
      if (RD !== rd || !rd.open) return;
      let v;
      const t = rd.truth || {};
      if (rd.type === 'who') v = Math.random() < .4 && t.ans ? pickOne(t.ans) : pickOne(list).k;
      else if (rd.type === 'hops') v = clamp(Math.round((t.guess || 3) + (Math.random() * 4 - 2)), 0, 7);
      else if (rd.type === 'twin') { const tw = twinsOf(i); v = Math.random() < .45 && tw.length ? list[tw[0]].k : pickOne(list.filter(x => x.k !== g.k)).k; }
      else if (rd.type === 'steer') v = Math.random() < .55 && t.best ? t.best : pickOne(rd.opts).v;
      else if (rd.type === 'odd') v = Math.random() < .5 ? t.odd : Math.floor(Math.random() * 3);
      rd.votes.set(g.k, v);
      setText('#k-hop', roundLine());
    }, 1500 + Math.random() * 9000);
  });
}

// ---------- host: start ----------
async function hostMain() {
  $('#host').classList.remove('hide');
  setText('#room-tag', DEMO ? 'demo' : 'room ' + K.code);
  player = new Player();
  window.__party = { player, H, DV, M, Gr, get mode() { return mode; }, get RD() { return RD; }, get WK() { return WK; }, get OD() { return OD; }, get ST() { return ST; }, get BD() { return BD; }, enterMode: m => enterMode(m), go: () => GO[mode] && GO[mode](), savePoster: () => savePoster() };
  if (DEMO) await loadDemo();
  else {
    await restore();
    // the demo's neighborhood doubles as a warm start for common artists
    fetch('seed.json').then(r => r.ok ? r.json() : null).then(d => { if (d) { M.seed(d); dataChanged(); } }).catch(() => {});
  }
  setupStage();
  setupNav();
  setupJoin();
  setupHand();
  setupModes();
  $('#sound').classList.remove('hide');
  $('#sound-go').addEventListener('click', async () => {
    await player.unlock();
    $('#sound').classList.add('hide');
    enterMode(mode, true);
  });
  dataChanged();
  setInterval(footStats, 1000);
  if (!DEMO) startNet();
  else setText('#net-tag', 'nothing is sent');
  if (!DEMO && !guestList().length) toggleJoin(true);
  const start = Q.get('mode');
  if (start && MODES[start]) enterMode(start);
  else enterMode('cloud');
}

async function startNet() {
  setText('#net-tag', 'connecting');
  try {
    const { openRoom } = await import('./sync.js');
    NET = await openRoom(K.norm, K.roomId);
  } catch (e) {
    setText('#net-tag', 'offline: add people by hand');
    return;
  }
  const refreshOnline = () => {
    const users = NET.room.getUsers();
    H.online = new Set(Object.keys(users).map(u => H.peer.get(u) || u));
    const n = H.online.size;
    setText('#net-tag', n ? `live · ${n} phone${n === 1 ? '' : 's'}` : 'live · waiting for phones');
    $('#net-tag').classList.add('ok');
    renderJoin();
  };
  NET.room.onUserJoin(() => { refreshOnline(); publish(); });
  NET.room.onUserLeave(refreshOnline);
  const fromPeer = (uid, v) => { const k = gidOf(v, uid); H.peer.set(uid, k); upsertGuest(k, v, 'p2p'); refreshOnline(); };
  NET.guest.onChange((v, ctx) => { if (!ctx.self && v) fromPeer(ctx.userId, v); });
  for (const [k, v] of Object.entries(NET.guest.getAll())) if (k !== NET.self.userId && v) fromPeer(k, v);
  NET.vote.onChange((v, ctx) => { if (!ctx.self) onVote(v, ctx); });
  refreshOnline();
  publish();
}

async function loadDemo() {
  const [people, seed] = await Promise.all([fetch('demo.json').then(r => r.json()), fetch('seed.json').then(r => r.ok ? r.json() : null).catch(() => null)]);
  if (seed) M.seed(seed);
  const n = clamp(parseInt(Q.get('demo'), 10) || 14, 2, people.length);
  people.slice(0, n).forEach(([name, specs], i) => {
    const picks = specs.map(s => seed && seed.picks[s]).filter(Boolean).map(p => cleanPick({ k: p.k, aid: p.aid, an: p.an, tid: p.tid, tt: p.tt }));
    const k = 'demo-' + i;
    H.guests.set(k, { k, n: name, picks, src: 'demo', t: i });
  });
  H.hostKey = 'demo-0';
  H.gv++;
}

// ---------- stage ----------
const cv = () => $('#stage');
let ctx2, W = 0, Hh = 0, DPR = 1;
const COL = {};
function setupStage() {
  const c = cv();
  ctx2 = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['night', 'panel', 'ink', 'dim', 'faint', 'line', 'mint', 'rose', 'ice']) COL[k] = cs.getPropertyValue('--' + k).trim();
  const fit = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = c.clientWidth; Hh = c.clientHeight;
    c.width = Math.round(W * DPR); c.height = Math.round(Hh * DPR);
    ctx2.setTransform(DPR, 0, 0, DPR, 0, 0);
  };
  new ResizeObserver(fit).observe(c);
  fit();
  buildGrid();
  c.addEventListener('mousemove', onStageMove);
  c.addEventListener('mouseleave', () => setText('#pairs-hover', ''));
  requestAnimationFrame(frame);
}
const wide = () => W > 860 && window.innerWidth > 860;
function joinW() { return wide() && !$('#join').classList.contains('hide') ? $('#join').offsetWidth : 0; }
function pad() { return clamp(W * .026, 16, 52); }
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
function fontPx(base) { return Math.round(clamp(base * Math.min(W / 1920, Hh / 1080) * (wide() ? 1 : 1.5), base * .62, base * 1.4)); }

let lastT = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(64, t - lastT) / 1000; lastT = t;
  if (document.hidden || !W) return;
  recompute();
  const c = ctx2;
  c.clearRect(0, 0, W, Hh);
  const draw = DRAW[mode];
  if (draw) draw(c, t / 1000, dt);
}

// ---------- the cloud ----------
function cloudRect() {
  const p = pad();
  if (!wide()) return { x: 14, y: 14, w: W - 28, h: Hh - 28 };
  const x = Math.max(p + 40, W * .26);
  return { x, y: Hh * .2, w: W - joinW() - p - 60 - x, h: Hh * .68 };
}
function project(R, p) {
  const sx = R.w / 2 * .88, sy = R.h / 2 * .86;
  return [R.x + R.w / 2 + p[0] * Math.min(sx, sy * 1.7), R.y + R.h / 2 + p[1] * Math.min(sy, sx)];
}
function easePositions(dt) {
  const k = 1 - Math.pow(.02, dt);
  DV.list.forEach((g, i) => {
    const p = pos.get(g.k), q = DV.xy[i];
    if (!p || !q) return;
    p[0] += (q[0] - p[0]) * k; p[1] += (q[1] - p[1]) * k;
  });
}
function drawCloud(c, t, dt, opts = {}) {
  easePositions(dt);
  const R = opts.rect || cloudRect();
  const list = DV.list, f = DV.facts;
  if (!list.length) return;
  const breathe = (i, a) => [Math.sin(t * .21 + i * 1.7) * a, Math.cos(t * .17 + i * 2.3) * a];
  const P = list.map((g, i) => { const p = project(R, pos.get(g.k) || [0, 0]); const b = breathe(i, 3); return [p[0] + b[0], p[1] + b[1]]; });
  // the map: every related artist mapped, as a faint dot
  c.fillStyle = alpha(COL.ice, opts.poster ? .42 : .36);
  c.beginPath();
  const dr = opts.poster ? 2.4 : 1.3;
  for (const d of DV.dots) {
    const p = project(R, d);
    c.moveTo(p[0] + dr, p[1]); c.arc(p[0], p[1], dr, 0, 6.2832);
  }
  c.fill();
  // links to the two nearest people
  const n = list.length, seen = new Set();
  c.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const near = [...Array(n).keys()].filter(j => j !== i).sort((a, b) => DV.D[i][a] - DV.D[i][b]).slice(0, 2);
    for (const j of near) {
      const key = i < j ? i + '-' + j : j + '-' + i;
      if (seen.has(key)) continue; seen.add(key);
      const sim = 1 - DV.D[i][j] / Gr.FAR;
      if (sim <= .05) continue;
      c.strokeStyle = alpha(COL.ice, .16 + .6 * sim);
      curve(c, P[i], P[j], ((i * 7 + j * 13) % 5 - 2) * .08);
    }
  }
  if (opts.twins) drawTwinLines(c, P);
  // people
  const fs = opts.fs || fontPx(24);
  c.font = `500 ${fs}px "Instrument Sans", system-ui, sans-serif`;
  c.textBaseline = 'middle';
  const boxes = [];
  list.forEach((g, i) => {
    const [x, y] = P[i];
    const playing = cloudNow && cloudNow.k === g.k;
    if (i === f.center) {
      c.strokeStyle = COL.mint; c.lineWidth = 1.25;
      for (const r of [15, 25]) { c.beginPath(); c.arc(x, y, r + Math.sin(t * 1.3) * 1.5, 0, 6.2832); c.stroke(); }
    }
    if (i === f.outlier) { c.strokeStyle = COL.rose; c.lineWidth = 1.25; c.beginPath(); c.arc(x, y, 15, 0, 6.2832); c.stroke(); }
    if (playing) {
      const lv = player ? player.level() : 0;
      c.strokeStyle = COL.mint; c.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) { const ph = (t * .6 + k / 3) % 1; c.globalAlpha = 1 - ph; c.beginPath(); c.arc(x, y, 10 + ph * 46 + lv * 20, 0, 6.2832); c.stroke(); }
      c.globalAlpha = 1;
    }
    c.fillStyle = COL.ink;
    c.beginPath(); c.arc(x, y, 5, 0, 6.2832); c.fill();
    g.picks.forEach((p, k) => {
      const a = t * .25 + k * 2.0944 + i;
      c.beginPath(); c.arc(x + Math.cos(a) * 12, y + Math.sin(a) * 12, 2, 0, 6.2832); c.fill();
    });
    // label: try right, left, above, below
    const label = opts.nameOf ? opts.nameOf(g) : g.n;
    const w = c.measureText(label).width, h = fs;
    const cand = [[x + 20, y, 'left'], [x - 20 - w, y, 'left'], [x - w / 2, y - 24, 'left'], [x - w / 2, y + 26, 'left']];
    let best = cand[0], bo = Infinity;
    for (const cd of cand) {
      const b = [cd[0], cd[1] - h / 2, w, h];
      let o = 0;
      for (const q of boxes) o += Math.max(0, Math.min(b[0] + b[2], q[0] + q[2]) - Math.max(b[0], q[0])) * Math.max(0, Math.min(b[1] + b[3], q[1] + q[3]) - Math.max(b[1], q[1]));
      if (b[0] < 4 || b[0] + w > W - 4) o += 1e6;
      if (o < bo) { bo = o; best = cd; }
      if (o === 0) break;
    }
    boxes.push([best[0], best[1] - h / 2, w, h]);
    c.fillStyle = i === f.outlier ? COL.rose : i === f.center ? COL.mint : playing ? COL.mint : COL.ink;
    c.textAlign = 'left';
    c.fillText(label, best[0], best[1]);
  });
}
function curve(c, a, b, bow) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  c.beginPath(); c.moveTo(a[0], a[1]);
  c.quadraticCurveTo(mx - dy * bow, my + dx * bow, b[0], b[1]);
  c.stroke();
}

// cloud jukebox: one pick after another, the owner's point rings
let cloudNow = null, cloudTok = 0;
const JUKE = new Set(['cloud', 'pairs', 'twin']);
async function cloudShuffle() {
  const my = ++cloudTok;
  const pool = shuffle(DV.list.flatMap(g => g.picks.map(p => ({ k: g.k, p }))));
  for (const item of pool) {
    if (my !== cloudTok || !JUKE.has(mode) || !player.ready) return;
    const pv = await M.previewFor(item.p);
    if (!pv || my !== cloudTok) continue;
    cloudNow = item;
    const ok = await player.play(pv.url);
    if (!ok) continue;
    $('#cloud-now').innerHTML = '';
    $('#cloud-now').append('now: ', el('b', {}, pv.an), ` · ${pv.tt} · ${nameOf(item.k)}'s pick`);
    await sleep(20000);
  }
  await sleep(pool.length ? 0 : 3000);
  if (my === cloudTok && JUKE.has(mode)) cloudShuffle();
}

// ---------- walk renderer (walk, hops, steer, birthday) ----------
const WK = { stops: [], pts: [], i: 0, pos: 0, tok: 0, track: null, from: null, to: null, skip: null, opts: null, target: null, done: false, fromLabel: '', toLabel: '' };
const GRID = { cells: [], N: 30 };
function buildGrid() {
  const N = GRID.N, s = 2 / N;
  for (let r = 0; r * s * .866 <= 2; r++) {
    const y = -1 + r * s * .866;
    for (let q = 0; q <= N + 1; q++) {
      const x = -1 + q * s + (r % 2 ? s / 2 : 0);
      const d = Math.hypot(x, y);
      if (d <= 1 - s * .35) GRID.cells.push([x, y, d]);
    }
  }
  GRID.s = s;
  GRID.shown = new Float32Array(GRID.cells.length);
  GRID.target = new Float32Array(GRID.cells.length);
}
const portraits = new Map();
function portrait(aid) {
  if (portraits.has(aid)) return portraits.get(aid);
  const v = new Float32Array(GRID.cells.length);
  // a placeholder pattern from the id, replaced when the picture arrives
  const h = (aid * 2654435761) >>> 0, f1 = 2 + h % 5, f2 = 1 + (h >> 5) % 4;
  GRID.cells.forEach(([x, y, d], i) => { v[i] = .25 + .25 * Math.sin(d * f1 * 3.1 + Math.atan2(y, x) * f2); });
  portraits.set(aid, v);
  const url = M.picUrl(aid, 250);
  if (url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const S = 56, oc = document.createElement('canvas'); oc.width = oc.height = S;
        const x = oc.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, S, S);
        const px = x.getImageData(0, 0, S, S).data;
        let lo = 1, hi = 0;
        const raw = GRID.cells.map(([cx, cy]) => {
          const ix = clamp(Math.round((cx + 1) / 2 * (S - 1)), 0, S - 1), iy = clamp(Math.round((cy + 1) / 2 * (S - 1)), 0, S - 1);
          const o = (iy * S + ix) * 4;
          const l = (.2126 * px[o] + .7152 * px[o + 1] + .0722 * px[o + 2]) / 255;
          lo = Math.min(lo, l); hi = Math.max(hi, l);
          return l;
        });
        raw.forEach((l, i) => { v[i] = Math.pow(clamp((l - lo) / Math.max(.15, hi - lo), 0, 1), 1.1); });
      } catch (e) { /* tainted canvas: keep the pattern */ }
    };
    img.src = url;
  }
  return v;
}
function walkLayout() {
  const p = pad(), jw = joinW();
  if (wide()) {
    const R = clamp(Math.min(Hh * .25, (W - jw) * .17), 120, 300);
    return { cx: (W - jw) * .69, cy: Hh * .45, R, x0: p + 30, x1: W - jw - p - 30, y: Hh * .86, amp: Hh * .025 };
  }
  const R = clamp(Math.min(W * .3, Hh * .24), 70, 160);
  return { cx: W / 2, cy: Hh * .4, R, x0: 26, x1: W - 26, y: Hh * .86, amp: 10 };
}
function drawPortrait(c, L, aid, t) {
  if (aid == null) return;
  const tgt = portrait(aid);
  const sh = GRID.shown;
  for (let i = 0; i < sh.length; i++) sh[i] += (tgt[i] - sh[i]) * .07;
  const bands = player ? player.bands(12) : new Float32Array(12);
  const { cx, cy, R } = L, s = GRID.s * R;
  c.fillStyle = COL.ink;
  c.beginPath();
  GRID.cells.forEach(([x, y, d], i) => {
    const b = bands[Math.min(11, Math.floor(d * 12))];
    const r = Math.min(s * .56, s * .5 * (.07 + .93 * Math.sqrt(sh[i])) * (1 + .32 * b));
    const px = cx + x * R, py = cy + y * R;
    c.moveTo(px + r, py); c.arc(px, py, r, 0, 6.2832);
  });
  c.fill();
  // the sound, as a ring
  const wv = player && player.waveform();
  c.strokeStyle = COL.mint; c.lineWidth = 1.5;
  c.beginPath();
  const n = 220, R2 = R + 22;
  for (let k = 0; k <= n; k++) {
    const a = k / n * 6.2832 - Math.PI / 2;
    const sample = wv ? (wv[Math.floor(k / n * (wv.length - 1) * .5)] - 128) / 128 : 0;
    const env = Math.sin(k / n * Math.PI);
    const r = R2 + sample * 34 * (wv ? 1 : 0) * (.35 + .65 * env) + Math.sin(a * 6 + t * .8) * 1.5;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    k ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();
  // the neighborhood: related artists as dots around the ring, the next stop named
  const nb = [...Gr.nbrs(aid)].slice(0, 28);
  const next = WK.stops[WK.i + 1];
  const R3 = R + 70;
  const optOf = new Map((WK.opts || []).map(o => [o.v, o]));
  for (const o of WK.opts || []) if (!nb.includes(o.v)) nb.push(o.v);
  nb.forEach((v, k) => {
    const a = k / nb.length * 6.2832 - Math.PI / 2 + .2;
    const o = optOf.get(v);
    const x = o ? Math.min(W - 18, Math.max(18, cx + Math.cos(a) * R3)) : cx + Math.cos(a) * R3, y = cy + Math.sin(a) * R3;
    if (o) {
      c.strokeStyle = COL.ice; c.lineWidth = 1.25;
      c.beginPath(); c.arc(x, y, 13, 0, 6.2832); c.stroke();
      c.font = `500 ${fontPx(14)}px "IBM Plex Mono", monospace`; c.fillStyle = COL.ice;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(o.c, x, y + 1);
      if (wide()) { c.textAlign = Math.cos(a) >= 0 ? 'left' : 'right'; c.fillText(o.l, x + Math.cos(a) * 22, y + Math.sin(a) * 22); }
      return;
    }
    const isNext = v === next;
    c.fillStyle = isNext ? COL.mint : alpha(COL.ice, .55);
    c.beginPath(); c.arc(x, y, isNext ? 4 : 2.2, 0, 6.2832); c.fill();
    if (isNext && wide()) {
      c.strokeStyle = alpha(COL.mint, .7); c.lineWidth = 1;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R2 + 36), cy + Math.sin(a) * (R2 + 36)); c.lineTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7); c.stroke();
      c.font = `500 ${fontPx(15)}px "IBM Plex Mono", monospace`; c.fillStyle = COL.mint;
      c.textAlign = Math.cos(a) >= 0 ? 'left' : 'right'; c.textBaseline = 'middle';
      c.fillText('next: ' + M.artistName(v), x + Math.cos(a) * 12, y + Math.sin(a) * 12);
    }
  });
}
function trailPoints(L, n, steer) {
  const span = steer ? .72 : 1;
  return Array.from({ length: n }, (_, i) => {
    const u = n === 1 ? 0 : i / (steer ? Math.max(n, 4) : n - 1);
    return [L.x0 + u * span * (L.x1 - L.x0), L.y + L.amp * Math.sin(i * 1.9 + .6)];
  });
}
function drawTrail(c, t, dt, steer) {
  const L = walkLayout();
  const n = WK.stops.length;
  if (!n) return L;
  const tgt = trailPoints(L, n, steer);
  while (WK.pts.length < n) WK.pts.push(tgt[WK.pts.length].slice());
  WK.pts.length = n;
  const k = 1 - Math.pow(.01, dt);
  WK.pts.forEach((p, i) => { p[0] += (tgt[i][0] - p[0]) * k; p[1] += (tgt[i][1] - p[1]) * k; });
  WK.pos += (WK.i - WK.pos) * (1 - Math.pow(.03, dt));
  const P = WK.pts;
  // the line: walked part in mint, the rest faint
  const seg = (a, b) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 10]; return m; };
  for (let i = 0; i < n - 1; i++) {
    const a = P[i], b = P[i + 1], m = seg(a, b);
    const walked = WK.pos >= i + 1 - 1e-3;
    c.strokeStyle = walked ? COL.mint : alpha(COL.ice, .4);
    c.lineWidth = walked ? 2 : 1;
    c.beginPath(); c.moveTo(a[0], a[1]); c.quadraticCurveTo(m[0], m[1], b[0], b[1]); c.stroke();
    const part = clamp(WK.pos - i, 0, 1);
    if (part > 0 && part < 1) {
      c.strokeStyle = COL.mint; c.lineWidth = 2;
      c.beginPath(); c.moveTo(a[0], a[1]);
      for (let s = 1; s <= 24; s++) { const u = s / 24 * part; const x = (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * m[0] + u * u * b[0], y = (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * m[1] + u * u * b[1]; c.lineTo(x, y); }
      c.stroke();
    }
  }
  // stops
  const fs = fontPx(14);
  c.font = `500 ${fs}px "IBM Plex Mono", monospace`;
  c.textAlign = 'center'; c.textBaseline = 'top';
  const crowd = n > 6 || !wide();
  P.forEach((p, i) => {
    const cur = i === WK.i, past = i < WK.i;
    if (cur) { c.strokeStyle = COL.mint; c.lineWidth = 1.5; c.beginPath(); c.arc(p[0], p[1], 11 + Math.sin(t * 2) * 1.5, 0, 6.2832); c.stroke(); }
    c.fillStyle = past || cur ? COL.mint : COL.ink;
    c.beginPath(); c.arc(p[0], p[1], cur ? 5 : 4, 0, 6.2832); c.fill();
    if (!crowd || cur || i === 0 || i === n - 1) {
      c.fillStyle = cur ? COL.ink : COL.dim;
      let label = M.artistName(WK.stops[i]);
      if (label.length > 22) label = label.slice(0, 21) + '…';
      c.fillText(label, clamp(p[0], 60, W - 60), p[1] + 18 + (crowd && i % 2 ? fs * 1.3 : 0));
    }
  });
  // the traveler
  const fi = Math.floor(WK.pos), fu = WK.pos - fi;
  if (fi < n - 1 && fu > .01) {
    const a = P[fi], b = P[fi + 1], m = seg(a, b), u = ease(fu);
    const x = (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * m[0] + u * u * b[0], y = (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * m[1] + u * u * b[1];
    c.fillStyle = COL.mint; c.beginPath(); c.arc(x, y, 6, 0, 6.2832); c.fill();
  }
  // endpoints: whose picks
  c.font = `500 ${fontPx(13)}px "IBM Plex Mono", monospace`;
  c.fillStyle = COL.faint; c.textBaseline = 'bottom';
  if (WK.fromLabel) { c.textAlign = 'left'; c.fillText(WK.fromLabel, Math.max(8, P[0][0] - 10), P[0][1] - 18); }
  if (WK.toLabel && !steer) { c.textAlign = 'right'; c.fillText(WK.toLabel, Math.min(W - 8, P[n - 1][0] + 10), P[n - 1][1] - 18); }
  if (steer && WK.target) {
    const tx = L.x1, ty = L.y;
    c.strokeStyle = COL.rose; c.lineWidth = 1.5; c.beginPath(); c.arc(tx, ty, 11, 0, 6.2832); c.stroke();
    c.fillStyle = COL.rose; c.beginPath(); c.arc(tx, ty, 4, 0, 6.2832); c.fill();
    c.textAlign = 'right'; c.fillText(WK.toLabel, tx + 10, ty - 18);
    c.textBaseline = 'top'; c.fillText(M.artistName(WK.target), tx + 10, ty + 18);
    const last = P[n - 1];
    c.fillStyle = alpha(COL.rose, .6);
    for (let x = last[0] + 26; x < tx - 20; x += 14) { c.beginPath(); c.arc(x, ty + (last[1] - ty) * (1 - (x - last[0]) / (tx - last[0])), 1.3, 0, 6.2832); c.fill(); }
  }
  return L;
}
function drawWalk(c, t, dt) {
  const L = drawTrail(c, t, dt, mode === 'steer');
  if (WK.stops.length) drawPortrait(c, L, WK.stops[WK.i], t);
  if (WK.searching) {
    c.strokeStyle = alpha(COL.ice, .5); c.lineWidth = 1;
    for (let k = 0; k < 5; k++) { const ph = (t * .4 + k / 5) % 1; c.beginPath(); c.arc(L.cx, L.cy, L.R * ph * 1.2, 0, 6.2832); c.stroke(); }
  }
}

function waitSkip(ms, tok) {
  return new Promise(res => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (WK.skip === done) WK.skip = null; res(); }
    WK.skip = done;
    const chk = setInterval(() => { if (tok !== WK.tok) { clearInterval(chk); done(); } }, 200);
    setTimeout(() => clearInterval(chk), ms + 50);
  });
}
function setStop(i, pv, extra = {}) {
  const n = WK.stops.length;
  const hop = extra.hop || (i === 0 ? `start · ${WK.fromLabel}` : i === n - 1 && !extra.open ? `end · ${WK.toLabel}` : `hop ${i} of ${n - 1}`);
  setText('#k-hop', hop);
  setText('#k-name', M.artistName(WK.stops[i]) || (pv && pv.an) || '');
  setText('#k-track', pv ? pv.tt : 'no preview for this one');
}
// walk a path stop by stop with sound
async function walkPath(path, { fromPick, toPick, dwell = 11000, fromLabel = '', toLabel = '' } = {}) {
  const tok = ++WK.tok;
  WK.stops = path.slice(); WK.pts = []; WK.i = 0; WK.pos = 0; WK.fromLabel = fromLabel; WK.toLabel = toLabel; WK.done = false;
  const pre = path.map((aid, i) => M.previewFor(i === 0 && fromPick ? fromPick : i === path.length - 1 && toPick ? toPick : { aid }));
  for (let i = 0; i < path.length; i++) {
    if (tok !== WK.tok) return false;
    WK.i = i;
    portrait(path[i]);
    if (i + 1 < path.length) portrait(path[i + 1]);
    const pv = await pre[i];
    if (tok !== WK.tok) return false;
    setStop(i, pv);
    if (pv && player.ready) player.play(pv.url, { at: 2 });
    await waitSkip(i === path.length - 1 ? dwell + 3000 : dwell, tok);
  }
  WK.done = true;
  return tok === WK.tok;
}

// ---------- the walk mode ----------
let pairQueue = [];
function nextPair() {
  const L = DV.list;
  if (L.length < 2) return null;
  if (!pairQueue.length) {
    const all = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) all.push([L[i].k, L[j].k]);
    // pairs already known to connect walk first; the out-of-reach ones still come, last
    const far = (a, b) => { const i = DV.idx.get(a), j = DV.idx.get(b); return i == null || j == null || !DV.D[i] || !(DV.D[i][j] < Gr.FAR); };
    pairQueue = shuffle(all).sort((p, q) => far(...p) - far(...q));
  }
  const [a, b] = pairQueue.shift();
  const A = H.guests.get(a), B = H.guests.get(b);
  return A && B && A.picks.length && B.picks.length ? (Math.random() < .5 ? [A, B] : [B, A]) : nextPair();
}
const pathCache = new Map();
function pathFor(A, B, budget = 200) {
  const key = A.k + '>' + B.k + ':' + A.picks.map(p => p.aid).join(',') + '>' + B.picks.map(p => p.aid).join(',');
  if (!pathCache.has(key)) {
    const pr = Gr.pathLive(A.picks.map(p => p.aid), B.picks.map(p => p.aid), { budget, onStep: s => { if (WK.searching === key) setText('#k-hop', `looking for a path · ${s.checked} artists checked`); } });
    pathCache.set(key, pr);
    pr.then(r => { if (!r.path) setTimeout(() => pathCache.delete(key), 60000); });
  }
  return { key, pr: pathCache.get(key) };
}
async function findPath(A, B, budget = 200) {
  const { key, pr } = pathFor(A, B, budget);
  WK.searching = key;
  setText('#k-hop', 'looking for a path');
  const res = await pr;
  if (WK.searching === key) WK.searching = false;
  return res;
}
const pickFor = (G, aid) => G.picks.find(p => p.aid === aid) || { aid };
async function walkPair(A, B, opts = {}) {
  const tok = ++WK.tok;
  WK.stops = []; WK.pts = [];
  setText('#k-name', ''); setText('#k-track', ''); setText('#k-ans', ''); setText('#k-right', ''); setText('#k-q', '');
  setText('#m-sub', `${A.n} → ${B.n}`);
  // while the map is searched, the first pick already plays
  const first = A.picks[0];
  WK.stops = [first.aid]; WK.i = 0; WK.pos = 0; WK.fromLabel = `${opts.fromName || A.n}'s pick`; WK.toLabel = '';
  portrait(first.aid);
  const pv0 = M.previewFor(first);
  pv0.then(pv => { if (tok === WK.tok && WK.stops.length === 1) { setText('#k-name', M.artistName(first.aid) || first.an); setText('#k-track', pv ? pv.tt : ''); if (pv && player.ready) player.play(pv.url, { at: 2 }); } });
  const res = await findPath(A, B);
  if (tok !== WK.tok) return null;
  if (!res.path) {
    setText('#k-hop', '');
    setText('#k-q', `no path within ${Gr.CAP} hops.`);
    setText('#k-track', `${res.checked} artists checked.`);
    return { hops: null };
  }
  const hops = res.path.length - 1;
  setText('#m-sub', `${A.n} → ${B.n} · ${hops === 0 ? 'same artist' : hops + ' hop' + (hops === 1 ? '' : 's')}`);
  await walkPath(res.path, { fromPick: pickFor(A, res.path[0]), toPick: pickFor(B, res.path[res.path.length - 1]), fromLabel: `${opts.fromName || A.n}'s pick`, toLabel: `${opts.toName || B.n}'s pick`, dwell: opts.dwell || 11000 });
  return { hops, path: res.path };
}
async function walkLoop() {
  const tok = ++walkLoopTok;
  let pr = manualPair || nextPair();
  manualPair = null;
  while (mode === 'walk' && tok === walkLoopTok) {
    if (!pr) { setText('#k-q', 'the walk needs two people on the map.'); return; }
    const after = nextPair();
    if (after) pathFor(after[0], after[1]);
    await walkPair(pr[0], pr[1]);
    pr = manualPair || after;
    manualPair = null;
    if (tok !== walkLoopTok) return;
    await sleep(2500);
  }
}
let walkLoopTok = 0, manualPair = null;

// ---------- whose song ----------
let songRound = 0;
async function songStart() {
  const L = DV.list;
  if (L.length < 2) { setText('#k-q', 'needs two people on the map.'); return; }
  const all = L.flatMap(g => g.picks.map(p => ({ g, p, id: p.tid ? 't' + p.tid : 'a' + p.aid })));
  let pool = all.filter(x => !H.played.includes(x.id));
  if (!pool.length) { H.played = []; pool = all; }
  const item = pickOne(pool);
  H.played.push(item.id);
  const ans = [...new Set(all.filter(x => x.p.aid === item.p.aid).map(x => x.g.k))];
  songRound++;
  setText('#k-name', ''); setText('#k-ans', ''); setText('#k-right', ''); setText('#k-track', '');
  setText('#k-q', 'whose song is this?');
  setText('#k-go', 'reveal');
  openRound('who', 'whose song is this?', null, { ans, item });
  setText('#k-hop', `round ${songRound} · ` + roundLine());
  const pv = await M.previewFor(item.p);
  if (pv && player.ready) player.play(pv.url, { at: 0 });
  RD.pv = pv;
  autoClose(RD, 26000, songReveal);
}
function autoClose(rd, ms, fn) {
  const t0 = performance.now();
  rd.ms = ms;
  const tick = setInterval(() => {
    if (RD !== rd || !rd.open) { clearInterval(tick); return; }
    if (performance.now() - t0 >= ms) { clearInterval(tick); fn(); }
  }, 250);
}
function songReveal() {
  if (!RD || RD.type !== 'who' || !RD.open) return;
  const { ans, item } = RD.truth;
  const right = [...RD.votes.entries()].filter(([, v]) => ans.includes(v)).map(([k]) => k);
  addPoints(right);
  const names = ans.map(nameOf);
  const text = names.length > 1 ? `${andList(names)} all picked this.` : `it was ${names[0]}'s.`;
  setText('#k-q', '');
  setText('#k-ans', text);
  const pv = RD.pv;
  setText('#k-track', pv ? `${pv.tt} · ${pv.an}` : pickLabel(item.p));
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-hop', `round ${songRound}`);
  setText('#k-go', 'next song');
  closeRound({ text, right });
}

// ---------- how many hops ----------
async function hopsStart() {
  const pr = nextPair();
  if (!pr) { setText('#k-q', 'needs two people on the map.'); return; }
  const [A, B] = pr;
  ++WK.tok; WK.stops = []; WK.pts = [];
  setText('#k-name', ''); setText('#k-track', ''); setText('#k-ans', ''); setText('#k-right', '');
  setText('#m-sub', `${A.n} → ${B.n}`);
  setText('#k-q', `${A.n} to ${B.n}: how many hops?`);
  const opts = [0, 1, 2, 3, 4, 5, 6].map(v => ({ v, l: String(v) })).concat([{ v: 7, l: 'no path' }]);
  const known = Gr.pathKnown(A.picks.map(p => p.aid), B.picks.map(p => p.aid));
  const rd = openRound('hops', `${A.n} to ${B.n}: how many hops?`, opts, { guess: known ? known.length - 1 : 4 });
  rd.pair = [A, B];
  rd.pathP = pathFor(A, B).pr;
  setText('#k-hop', 'bets · ' + roundLine());
  setText('#k-go', 'close bets and walk');
  autoClose(rd, 25000, hopsWalk);
}
async function hopsWalk() {
  const rd = RD;
  if (!rd || rd.type !== 'hops' || !rd.open) return;
  rd.open = false; publish();
  setText('#k-q', ''); setText('#k-go', '');
  const [A, B] = rd.pair;
  const res = await rd.pathP;
  if (RD !== rd) return;
  let h = Gr.FAR;
  if (res.path) {
    h = res.path.length - 1;
    await walkPath(res.path, { fromPick: pickFor(A, res.path[0]), toPick: pickFor(B, res.path[res.path.length - 1]), fromLabel: `${A.n}'s pick`, toLabel: `${B.n}'s pick`, dwell: 6500 });
    if (RD !== rd) return;
  }
  const bets = [...rd.votes.entries()];
  let right = [], text;
  if (bets.length) {
    const best = Math.min(...bets.map(([, v]) => Math.abs(v - h)));
    right = bets.filter(([, v]) => Math.abs(v - h) === best).map(([k]) => k);
    addPoints(right, best === 0 ? 2 : 1);
  }
  text = h >= Gr.FAR ? `no path within ${Gr.CAP} hops.` : `${h} hop${h === 1 ? '' : 's'}.`;
  setText('#k-ans', text);
  setText('#k-right', right.length ? `closest: ${andList(right.map(nameOf))}` : '');
  setText('#k-go', 'next bet');
  rd.open = true; closeRound({ text, right });
}

// ---------- steer ----------
const ST = { cur: null, targets: [], visited: new Set(), steps: 0, best: 0, A: null, B: null, active: false };
async function steerStart() {
  const L = DV.list;
  if (L.length < 2) { setText('#k-q', 'needs two people on the map.'); return; }
  ++WK.tok;
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-q', ''); setText('#k-name', ''); setText('#k-track', '');
  WK.stops = []; WK.pts = [];
  let found = null;
  for (let tries = 0; tries < 6 && !found; tries++) {
    const pr = nextPair();
    if (!pr) break;
    const res = await findPath(pr[0], pr[1], 200);
    if (res.path && res.path.length - 1 >= 2) found = { A: pr[0], B: pr[1], path: res.path };
  }
  if (!found) { setText('#k-q', 'could not find a good start. try again.'); return; }
  Object.assign(ST, { A: found.A, B: found.B, cur: found.path[0], targets: found.B.picks.map(p => p.aid), visited: new Set([found.path[0]]), steps: 0, best: found.path.length - 1, active: true });
  WK.stops = [ST.cur]; WK.i = 0; WK.pos = 0; WK.fromLabel = `${ST.A.n}'s pick`; WK.toLabel = `${ST.B.n}'s pick`; WK.target = found.path[found.path.length - 1];
  setText('#m-sub', `from ${ST.A.n}'s pick to ${ST.B.n}'s · the shortest is ${ST.best} hops`);
  steerStep();
}
async function steerStep() {
  if (!ST.active || mode !== 'steer') return;
  const tok = WK.tok;
  WK.i = WK.stops.length - 1;
  const pv = await M.previewFor(WK.stops.length === 1 ? pickFor(ST.A, ST.cur) : { aid: ST.cur });
  if (tok !== WK.tok) return;
  setStop(WK.i, pv, { hop: `step ${ST.steps} · shortest ${ST.best}`, open: true });
  if (pv && player.ready) player.play(pv.url, { at: 2 });
  await M.related(ST.cur, 'hi');
  const res = await Gr.pathLive([ST.cur], ST.targets, { budget: 120 });
  if (tok !== WK.tok) return;
  const good = res.path && res.path[1];
  const dist0 = res.path ? res.path.length - 1 : Gr.FAR;
  const others = shuffle([...Gr.nbrs(ST.cur)].filter(v => v !== good && !ST.visited.has(v))).sort((a, b) => M.artistFans(b) - M.artistFans(a)).slice(0, 6);
  const picks = shuffle([good, ...shuffle(others).slice(0, good ? 2 : 3)].filter(v => v != null)).slice(0, 3);
  const opts = picks.map((v, i) => ({ v, l: M.artistName(v), c: 'abc'[i] }));
  const tdist = Gr.bfs(ST.targets, Gr.CAP).dist;
  const better = opts.filter(o => o.v === good || (tdist.get(o.v) ?? Gr.FAR) < dist0).map(o => o.v);
  WK.opts = opts;
  setText('#k-q', 'where next?');
  renderChoices(opts, v => steerChoose(v));
  const rd = openRound('steer', 'where next?', opts.map(o => ({ v: o.v, l: `${o.c}. ${o.l}` })), { best: good, better });
  setText('#k-hop', `step ${ST.steps} · shortest ${ST.best} · ` + roundLine());
  setText('#k-go', 'go with the votes');
  autoClose(rd, 16000, () => steerChoose(null));
}
function renderChoices(opts, fn) {
  const box = $('#k-choices');
  box.textContent = '';
  for (const o of opts) box.append(el('button', { class: 'choice', type: 'button', 'data-v': o.v, onclick: () => fn(o.v) }, el('i', {}, o.c), o.l));
}
async function steerChoose(forced) {
  const rd = RD;
  if (!rd || rd.type !== 'steer' || !rd.open) return;
  const tally = new Map();
  for (const v of rd.votes.values()) tally.set(v, (tally.get(v) || 0) + 1);
  let win = forced;
  if (win == null) {
    let top = -1;
    for (const o of shuffle(rd.opts)) { const n = tally.get(o.v) || 0; if (n > top) { top = n; win = o.v; } }
  }
  const right = [...rd.votes.entries()].filter(([, v]) => rd.truth.better.includes(v)).map(([k]) => k);
  addPoints(right);
  [...$('#k-choices').children].forEach(b => {
    const v = +b.dataset.v;
    b.classList.toggle('win', v === win);
    b.classList.toggle('good', rd.truth.better.includes(v));
    b.classList.toggle('bad', v !== win);
    if (tally.get(v)) b.append(el('span', { class: 'n' }, String(tally.get(v))));
  });
  closeRound({ text: `the room chose ${M.artistName(win)}`, right });
  await sleep(1600);
  if (RD !== rd) return;
  $('#k-choices').textContent = ''; WK.opts = null;
  ST.cur = win; ST.visited.add(win); ST.steps++;
  WK.stops.push(win);
  if (ST.targets.includes(win)) {
    WK.i = WK.stops.length - 1;
    const pv = await M.previewFor(pickFor(ST.B, win));
    if (pv && player.ready) player.play(pv.url, { at: 2 });
    setStop(WK.i, pv, { hop: `arrived` });
    setText('#k-q', '');
    setText('#k-ans', `made it in ${ST.steps}.`);
    setText('#k-right', `the shortest is ${ST.best}. ${ST.steps === ST.best ? 'a perfect walk.' : ''}`.trim());
    setText('#k-go', 'steer again');
    ST.active = false;
    return;
  }
  if (ST.steps >= ST.best + 6) {
    setText('#k-q', '');
    setText('#k-ans', `lost after ${ST.steps}.`);
    setText('#k-right', `the shortest was ${ST.best}.`);
    setText('#k-go', 'steer again');
    ST.active = false;
    return;
  }
  steerStep();
}

// ---------- taste twin ----------
function twinsOf(i) {
  const D = DV.D, n = D.length;
  let m = Infinity;
  for (let j = 0; j < n; j++) if (j !== i) m = Math.min(m, D[i][j]);
  if (m >= Gr.FAR) return [];
  return [...Array(n).keys()].filter(j => j !== i && D[i][j] - m < 1e-9);
}
function twinStart() {
  if (DV.list.length < 3) { setText('#k-q', 'needs three people on the map.'); return; }
  TW.reveal = false;
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-q', 'who here is your taste twin?');
  setText('#k-track', 'guess on your phone. the map decides.');
  openRound('twin', 'who here is your taste twin?', null, {});
  setText('#k-hop', roundLine());
  setText('#k-go', 'reveal');
  autoClose(RD, 30000, twinReveal);
}
const TW = { reveal: false };
function twinReveal() {
  if (!RD || RD.type !== 'twin' || !RD.open) return;
  const right = [];
  for (const [k, v] of RD.votes) {
    const i = DV.idx.get(k);
    if (i === undefined) continue;
    if (twinsOf(i).map(j => DV.list[j].k).includes(v)) right.push(k);
  }
  addPoints(right);
  TW.reveal = true;
  const mutual = [];
  DV.list.forEach((g, i) => twinsOf(i).forEach(j => { if (j > i && twinsOf(j).includes(i)) mutual.push(`${g.n} + ${DV.list[j].n}`); }));
  setText('#k-q', '');
  setText('#k-hop', 'the lines point to each twin');
  setText('#k-ans', mutual.length ? `${mutual.length} mutual pair${mutual.length === 1 ? '' : 's'}.` : 'no mutual pairs.');
  setText('#k-track', mutual.slice(0, 6).join(' · '));
  setText('#k-right', right.length ? `found their twin: ${andList(right.map(nameOf))}` : 'nobody found their twin.');
  setText('#k-go', 'guess again');
  closeRound({ text: 'lines show each twin', right });
}
function drawTwinLines(c, P) {
  if (!TW.reveal) return;
  c.strokeStyle = COL.mint; c.lineWidth = 1.5;
  DV.list.forEach((g, i) => twinsOf(i).forEach(j => {
    const a = P[i], b = P[j];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
    const e = [b[0] - ux * 14, b[1] - uy * 14];
    curve(c, a, e, .12);
    c.fillStyle = COL.mint;
    c.beginPath(); c.arc(e[0], e[1], 3, 0, 6.2832); c.fill();
  }));
}

// ---------- odd one out ----------
const OD = { clips: [], playing: -1, reveal: false, odd: -1 };
async function oddStart() {
  const L = DV.list;
  const doubles = L.filter(g => g.picks.length >= 2);
  if (!doubles.length || L.length < 2) { setText('#k-q', 'needs someone with two picks.'); return; }
  const A = pickOne(doubles);
  const ia = DV.idx.get(A.k);
  const others = L.filter(g => g.k !== A.k).sort((x, y) => DV.D[ia][DV.idx.get(y.k)] - DV.D[ia][DV.idx.get(x.k)]);
  const B = pickOne(others.slice(0, Math.max(1, Math.ceil(others.length / 2))));
  const [a1, a2] = shuffle(A.picks).slice(0, 2);
  const b1 = pickOne(B.picks);
  const clips = shuffle([{ g: A, p: a1 }, { g: A, p: a2 }, { g: B, p: b1, odd: true }]);
  OD.clips = clips; OD.reveal = false; OD.odd = clips.findIndex(x => x.odd); OD.playing = -1;
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-q', 'two of these share an owner. which one is the stranger?');
  const rd = openRound('odd', 'which one is the stranger?', [{ v: 0, l: 'one' }, { v: 1, l: 'two' }, { v: 2, l: 'three' }], { odd: OD.odd });
  setText('#k-go', 'reveal');
  const tok = ++WK.tok;
  for (let i = 0; i < 3; i++) {
    if (RD !== rd || tok !== WK.tok) return;
    OD.playing = i;
    setText('#k-hop', `${['one', 'two', 'three'][i]} · ` + roundLine());
    const pv = await M.previewFor(clips[i].p);
    if (pv && player.ready) player.play(pv.url, { at: 5 });
    await waitSkip(11000, tok);
  }
  OD.playing = -1;
  if (RD === rd && rd.open) autoClose(rd, 9000, oddReveal);
}
function oddReveal() {
  if (!RD || RD.type !== 'odd' || !RD.open) return;
  ++WK.tok;
  const right = [...RD.votes.entries()].filter(([, v]) => v === OD.odd).map(([k]) => k);
  addPoints(right);
  OD.reveal = true;
  const w = ['one', 'two', 'three'];
  const s = OD.clips[OD.odd], pair = OD.clips.filter((_, i) => i !== OD.odd);
  setText('#k-q', '');
  setText('#k-ans', `${w[OD.odd]} was ${s.g.n}'s.`);
  setText('#k-track', `the other two were ${pair[0].g.n}'s: ${pair.map(x => x.p.an).join(' and ')}.`);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-go', 'three more');
  closeRound({ text: `${w[OD.odd]} was the stranger`, right });
}

// ---------- the birthday round ----------
const BD = { rows: [], active: false, final: false };
async function bdayStart() {
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  if (!hostG || !hostG.picks.length) { setText('#k-q', 'flag the host first: open join (j) and tap “host” next to a name.'); return; }
  const tok = ++WK.tok;
  BD.active = true; BD.final = false; BD.rows = [];
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-q', 'every path leads to the host.');
  setText('#k-go', '');
  const others = DV.list.filter(g => g.k !== hostG.k);
  for (let i = 0; i < others.length; i++) {
    if (tok !== WK.tok) return;
    setText('#k-hop', `finding paths · ${i + 1} of ${others.length}`);
    const res = await pathFor(others[i], hostG, 160).pr;
    BD.rows.push({ g: others[i], path: res.path, hops: res.path ? res.path.length - 1 : null });
  }
  BD.rows.sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99));
  renderBdayList();
  const walkOrder = BD.rows.filter(r => r.path).slice().reverse();
  for (const r of walkOrder) {
    if (tok !== WK.tok) return;
    setText('#k-q', '');
    setText('#m-sub', `${r.g.n} → the host · ${r.hops} hop${r.hops === 1 ? '' : 's'}`);
    await walkPath(r.path, { fromPick: pickFor(r.g, r.path[0]), toPick: pickFor(hostG, r.path[r.path.length - 1]), fromLabel: `${r.g.n}'s pick`, toLabel: 'the host', dwell: 5000 });
  }
  if (tok !== WK.tok) return;
  BD.final = true;
  const reach = BD.rows.filter(r => r.hops != null);
  const far = Math.max(0, ...reach.map(r => r.hops));
  setText('#m-sub', 'everyone, walking home');
  setText('#k-hop', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-ans', reach.length === BD.rows.length ? `everyone is within ${far} hops of the host.` : `${reach.length} of ${BD.rows.length} are within ${Gr.CAP} hops of the host.`);
  setText('#k-right', 'happy birthday.');
  setText('#k-go', 'again');
  const hp = await M.previewFor(hostG.picks[0]);
  if (hp && player.ready) player.play(hp.url, { at: 0 });
}
function renderBdayList() {
  const ol = $('#board-ol');
  $('#board h3').textContent = 'hops to the host';
  ol.textContent = '';
  for (const r of BD.rows.slice(0, 14)) ol.append(el('li', {}, el('span', {}, r.g.n), el('span', {}, r.hops == null ? 'far' : String(r.hops))));
  $('#board').style.display = 'block';
}
function drawBdayFinal(c, t) {
  const p = pad(), jw = joinW();
  const cx = wide() ? (W - jw) * .64 : W / 2, cy = wide() ? Hh * .52 : Hh * .5;
  const Rmax = wide() ? Math.min(Hh * .4, (W - jw) * .3) : Math.min(W, Hh) * .44;
  const rows = BD.rows.filter(r => r.path);
  const maxH = Math.max(1, ...rows.map(r => r.hops));
  c.strokeStyle = alpha(COL.ice, .2); c.lineWidth = 1;
  for (let h = 1; h <= maxH; h++) { c.beginPath(); c.arc(cx, cy, Rmax * h / maxH, 0, 6.2832); c.stroke(); }
  c.font = `500 ${fontPx(16)}px "Instrument Sans", sans-serif`; c.textBaseline = 'middle';
  rows.forEach((r, k) => {
    const a = k / rows.length * 6.2832 - Math.PI / 2 + t * .02;
    const pts = r.path.map((_, i) => {
      const rem = r.hops - i;
      const rr = Rmax * rem / maxH;
      const aa = a + Math.sin(i * 1.3 + k) * .12 * (rem / maxH);
      return [cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr];
    });
    c.strokeStyle = alpha(COL.mint, .75); c.lineWidth = 1.2;
    c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.stroke();
    c.fillStyle = COL.ice;
    pts.slice(1, -1).forEach(q => { c.beginPath(); c.arc(q[0], q[1], 2, 0, 6.2832); c.fill(); });
    const s = pts[0];
    c.fillStyle = COL.ink; c.beginPath(); c.arc(s[0], s[1], 4.5, 0, 6.2832); c.fill();
    c.textAlign = Math.cos(a) >= 0 ? 'left' : 'right';
    c.fillText(r.g.n, s[0] + Math.cos(a) * 12, s[1] + Math.sin(a) * 12);
  });
  const lv = player ? player.level() : 0;
  c.fillStyle = COL.mint; c.beginPath(); c.arc(cx, cy, 7 + lv * 10, 0, 6.2832); c.fill();
  c.strokeStyle = COL.mint; c.lineWidth = 1.25;
  for (const r of [16, 28]) { c.beginPath(); c.arc(cx, cy, r + Math.sin(t * 1.4) * 2, 0, 6.2832); c.stroke(); }
}

// ---------- contour blob (whose song, twin, odd) ----------
function contours(c, cx, cy, R, t, seed, color, react) {
  const bands = react && player ? player.bands(16) : new Float32Array(16);
  for (let ring = 0; ring < 6; ring++) {
    const rr = R * (1 - ring * .15);
    c.strokeStyle = ring === 0 ? color : alpha(COL.ink, .85 - ring * .1);
    c.lineWidth = ring === 0 ? 1.75 : 1;
    c.beginPath();
    for (let i = 0; i <= 200; i++) {
      const a = i / 200 * 6.2832;
      const b = bands[Math.floor((Math.sin(a * 2 + ring) * .5 + .5) * 15.99)];
      const r = rr * (1 + .07 * Math.sin(3 * a + t * .7 + seed + ring * .4) + .045 * Math.sin(5 * a - t * 1.1 + seed * 2) + .03 * Math.sin(8 * a + t * .5 + ring)) + R * .16 * b * (1 - ring * .12);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath(); c.stroke();
  }
}
function playCenter() {
  const jw = joinW();
  if (wide()) return { cx: (W - jw) * .64, cy: Hh * .52, R: clamp(Math.min(Hh * .28, (W - jw) * .2), 120, 320) };
  return { cx: W / 2, cy: Hh / 2, R: Math.min(W, Hh) * .34 };
}
function drawSong(c, t) {
  const { cx, cy, R } = playCenter();
  contours(c, cx, cy, R, t, 1, RD && !RD.open ? COL.mint : COL.ice, true);
  if (RD && RD.type === 'who') {
    const n = RD.votes.size;
    c.fillStyle = COL.mint;
    for (let i = 0; i < n; i++) { const a = i / Math.max(n, 12) * 6.2832 - Math.PI / 2; c.beginPath(); c.arc(cx + Math.cos(a) * (R * 1.32), cy + Math.sin(a) * (R * 1.32), 4, 0, 6.2832); c.fill(); }
    if (RD.open && RD.ms) {
      const u = clamp((performance.now() - RD.t0) / RD.ms, 0, 1);
      c.strokeStyle = alpha(COL.ink, .7); c.lineWidth = 1.5;
      c.beginPath(); c.arc(cx, cy, R * 1.45, -Math.PI / 2, -Math.PI / 2 + (1 - u) * 6.2832); c.stroke();
    }
  }
}
function drawOdd(c, t) {
  const jw = joinW();
  const w = W - jw;
  const y = wide() ? Hh * .55 : Hh * .5;
  const R = wide() ? Math.min(w * .068, Hh * .14) : Math.min(W * .12, Hh * .18);
  const xs = wide() ? [w * .53, w * .7, w * .87] : [W * .19, W * .5, W * .81];
  const lab = ['one', 'two', 'three'];
  c.font = `500 ${fontPx(18)}px "IBM Plex Mono", monospace`; c.textAlign = 'center'; c.textBaseline = 'top';
  xs.forEach((x, i) => {
    let col = COL.ice;
    if (OD.reveal) col = i === OD.odd ? COL.rose : COL.mint;
    else if (OD.playing === i) col = COL.mint;
    contours(c, x, y, R, t, i * 2.1, col, OD.playing === i);
    c.fillStyle = OD.reveal ? col : COL.dim;
    c.fillText(lab[i], x, y + R * 1.35);
    if (OD.reveal && OD.clips[i]) { c.fillStyle = COL.dim; c.fillText(OD.clips[i].g.n, x, y + R * 1.35 + fontPx(18) * 1.6); }
  });
}

// ---------- pairs ----------
let pairsGeom = null;
function drawPairs(c, t) {
  const L = DV.list, n = L.length;
  if (n < 2) return;
  const order = DV.order;
  const jw = joinW();
  const right = wide() ? Math.min(W * .3, 520) + pad() * 2 : 0;
  const lab = Math.min(150, Math.max(70, W * .07));
  const avail = wide() ? Math.min(W - jw - right - pad() * 2 - lab - 40, Hh * .72 - lab) : Math.min(W - lab - 20, Hh - lab - 20);
  const cs = Math.max(6, avail / n);
  const x0 = wide() ? pad() + lab + 20 : lab + 6, y0 = wide() ? Hh * .2 + lab : lab + 10;
  pairsGeom = { x0, y0, cs, order };
  const f = DV.facts;
  const fs = clamp(cs * .55, 9, fontPx(15));
  c.font = `500 ${fs}px "IBM Plex Mono", monospace`;
  order.forEach((gi, r) => {
    c.fillStyle = COL.dim; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(L[gi].n, x0 - 10, y0 + r * cs + cs / 2);
    c.save(); c.translate(x0 + r * cs + cs / 2, y0 - 10); c.rotate(-Math.PI / 3); c.textAlign = 'left'; c.fillText(L[gi].n, 0, 0); c.restore();
  });
  order.forEach((gi, r) => order.forEach((gj, q) => {
    const x = x0 + q * cs + cs / 2, y = y0 + r * cs + cs / 2;
    if (gi === gj) { c.fillStyle = alpha(COL.faint, .6); c.beginPath(); c.arc(x, y, 1.2, 0, 6.2832); c.fill(); return; }
    const sc = Gr.score(DV.D[gi][gj]) / 100;
    const isClose = f.closest && ((f.closest[0] === gi && f.closest[1] === gj) || (f.closest[1] === gi && f.closest[0] === gj));
    const isFar = f.farthest && ((f.farthest[0] === gi && f.farthest[1] === gj) || (f.farthest[1] === gi && f.farthest[0] === gj));
    const rr = Math.max(.8, cs * .46 * Math.sqrt(sc));
    c.fillStyle = isClose ? COL.mint : COL.ink;
    c.beginPath(); c.arc(x, y, rr, 0, 6.2832); c.fill();
    if (isFar) { c.strokeStyle = COL.rose; c.lineWidth = 1.25; c.beginPath(); c.arc(x, y, cs * .4, 0, 6.2832); c.stroke(); }
  }));
  if (hoverCell) {
    const [r, q] = hoverCell;
    c.strokeStyle = COL.mint; c.lineWidth = 1;
    c.strokeRect(x0 + q * cs + .5, y0 + .5, cs - 1, n * cs - 1);
    c.strokeRect(x0 + .5, y0 + r * cs + .5, n * cs - 1, cs - 1);
  }
}
let hoverCell = null;
function onStageMove(e) {
  if (mode !== 'pairs' || !pairsGeom) return;
  const r = cv().getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const { x0, y0, cs, order } = pairsGeom, n = order.length;
  const q = Math.floor((x - x0) / cs), rr = Math.floor((y - y0) / cs);
  if (q < 0 || rr < 0 || q >= n || rr >= n) { hoverCell = null; setText('#pairs-hover', ''); return; }
  hoverCell = [rr, q];
  const gi = order[rr], gj = order[q];
  if (gi === gj) { setText('#pairs-hover', DV.list[gi].n); return; }
  const d = DV.D[gi][gj];
  setText('#pairs-hover', `${DV.list[gi].n} × ${DV.list[gj].n} · ${Gr.score(d)} · ${d >= Gr.FAR ? 'far' : d.toFixed(1) + ' hops'}`);
}

// ---------- the playlist ----------
let tourItems = [], tourTok = 0, tourIdx = -1;
function buildTour() {
  const L = DV.list;
  const seen = new Map();
  for (const g of L) for (const p of g.picks) {
    const id = p.tid ? 't' + p.tid : 'a' + p.aid;
    if (seen.has(id)) seen.get(id).who.push(g.n);
    else seen.set(id, { id, p, who: [g.n], k: g.k });
  }
  const items = [...seen.values()];
  if (!items.length) return [];
  const sd = new Map();
  const dist = (i, j) => {
    const a = items[i].p.aid, b = items[j].p.aid;
    if (a === b) return 0;
    if (!sd.has(a)) sd.set(a, Gr.bfs([a], Gr.CAP).dist);
    const d = sd.get(a).get(b);
    return d === undefined ? Gr.FAR : d;
  };
  return Gr.tour(items, dist).map(i => items[i]);
}
function renderList() {
  tourItems = buildTour();
  const ol = $('#list-ol');
  ol.textContent = '';
  tourItems.forEach((it, i) => {
    const q = it.p.k === 't' ? `${it.p.tt} ${it.p.an}` : it.p.an;
    ol.append(el('li', { 'data-i': i },
      el('span', { class: 'i' }, String(i + 1).padStart(2, '0')),
      el('span', { class: 't' }, el('b', {}, it.p.k === 't' ? it.p.tt : it.p.an), el('span', {}, `${it.p.k === 't' ? it.p.an + ' · ' : 'artist · '}${it.who.join(' + ')}`)),
      el('span', { class: 'a' },
        el('button', { type: 'button', onclick: () => playTour(i, true) }, 'play'),
        el('a', { href: M.spotifySearch(q), target: '_blank', rel: 'noopener noreferrer' }, 'spotify'),
        el('a', { href: M.appleSearch(q), target: '_blank', rel: 'noopener noreferrer' }, 'apple'))));
  });
  setText('#m-sub', `${tourItems.length} tracks, one tour.`);
}
function tourText() {
  return ['a birthday map · the playlist', ...tourItems.map((it, i) => `${String(i + 1).padStart(2, '0')}. ${it.p.k === 't' ? `${it.p.tt} · ${it.p.an}` : `${it.p.an} (artist)`} · ${it.who.join(' + ')}`)].join('\n');
}
async function playTour(from = 0, single = false) {
  const tok = ++tourTok;
  setText('#list-play', 'stop the tour');
  for (let i = from; i < tourItems.length; i++) {
    if (tok !== tourTok || mode !== 'list') return;
    tourIdx = i;
    [...$('#list-ol').children].forEach((li, k) => li.classList.toggle('on', k === i));
    const li = $('#list-ol').children[i];
    if (li && li.scrollIntoView && wide()) li.scrollIntoView({ block: 'nearest' });
    const pv = await M.previewFor(tourItems[i].p);
    if (pv && player.ready) await player.play(pv.url, { at: 0 });
    await sleep(single ? 29000 : 16000);
    if (single) break;
  }
  if (tok === tourTok) stopTour();
}
function stopTour() {
  tourTok++; tourIdx = -1;
  setText('#list-play', 'play the tour');
  [...$('#list-ol').children].forEach(li => li.classList.remove('on'));
}
function drawList(c, t, dt) {
  easePositions(dt);
  const p = pad();
  const R = wide() ? { x: p + 20, y: Hh * .24, w: (W - joinW()) * .4, h: Hh * .6 } : { x: 14, y: 14, w: W - 28, h: Hh - 28 };
  const ptsOf = it => {
    const g = H.guests.get(it.k); const q = pos.get(it.k) || [0, 0];
    const base = project(R, q);
    const k = g ? g.picks.findIndex(pp => (pp.tid ? 't' + pp.tid : 'a' + pp.aid) === it.id) : 0;
    const a = k * 2.0944 + 0.5;
    return [base[0] + Math.cos(a) * 16, base[1] + Math.sin(a) * 16];
  };
  const P = tourItems.map(ptsOf);
  c.strokeStyle = alpha(COL.ice, .55); c.lineWidth = 1;
  c.beginPath();
  P.forEach((q, i) => {
    if (!i) { c.moveTo(q[0], q[1]); return; }
    const a = P[i - 1], m = [(a[0] + q[0]) / 2 + (q[1] - a[1]) * .15, (a[1] + q[1]) / 2 - (q[0] - a[0]) * .15];
    c.quadraticCurveTo(m[0], m[1], q[0], q[1]);
  });
  c.stroke();
  P.forEach((q, i) => {
    c.fillStyle = i === tourIdx ? COL.mint : COL.ink;
    c.beginPath(); c.arc(q[0], q[1], i === tourIdx ? 6 : 3, 0, 6.2832); c.fill();
  });
  if (tourIdx >= 0 && P[tourIdx]) {
    const q = P[tourIdx], lv = player.level();
    c.strokeStyle = COL.mint; c.lineWidth = 1.25; c.beginPath(); c.arc(q[0], q[1], 14 + lv * 24, 0, 6.2832); c.stroke();
  }
  c.font = `500 ${fontPx(15)}px "Instrument Sans", sans-serif`; c.fillStyle = COL.dim; c.textAlign = 'center'; c.textBaseline = 'top';
  DV.list.forEach(g => { const b = project(R, pos.get(g.k) || [0, 0]); c.fillText(g.n, b[0], b[1] + 24); });
}

// ---------- modes ----------
const DRAW = {
  cloud: (c, t, dt) => drawCloud(c, t, dt),
  walk: drawWalk, hops: drawWalk, steer: drawWalk,
  bday: (c, t, dt) => BD.final ? drawBdayFinal(c, t) : drawWalk(c, t, dt),
  song: drawSong, odd: drawOdd,
  twin: (c, t, dt) => drawCloud(c, t, dt, { twins: true, rect: twinRect() }),
  pairs: drawPairs, list: drawList,
};
function twinRect() {
  if (!wide()) return { x: 14, y: 14, w: W - 28, h: Hh - 28 };
  const jw = joinW();
  return { x: (W - jw) * .46, y: Hh * .2, w: (W - jw) * .5, h: Hh * .66 };
}
const MODES = {
  cloud: { title: 'the cloud', sub: 'everyone, placed by how close their picks sit on the related-artist map.', go: '' },
  walk: { title: 'the walk', sub: '', go: 'next pair' },
  song: { title: 'whose song', sub: 'vote on your phone.', go: 'play a song' },
  pairs: { title: 'pairs', sub: 'every two people, scored by hops between their picks.', go: '' },
  list: { title: 'the playlist', sub: '', go: '' },
  hops: { title: 'how many hops', sub: 'bet on your phone, then we walk it.', go: 'start a bet' },
  steer: { title: 'steer', sub: 'the room picks each hop. can you find the short way?', go: 'start' },
  twin: { title: 'taste twin', sub: 'guess who sits closest to you on the map.', go: 'open the guesses' },
  odd: { title: 'odd one out', sub: 'three songs. two belong to one person.', go: 'play three' },
  bday: { title: 'the birthday round', sub: 'every path, walked to the host.', go: 'start the finale' },
};
const GO = { walk: () => { ++walkLoopTok; walkLoop(); }, song: () => RD && RD.type === 'who' && RD.open ? songReveal() : songStart(),
  hops: () => RD && RD.type === 'hops' && RD.open ? hopsWalk() : hopsStart(),
  steer: () => RD && RD.type === 'steer' && RD.open ? steerChoose(null) : (ST.active ? null : steerStart()),
  twin: () => RD && RD.type === 'twin' && RD.open ? twinReveal() : twinStart(),
  odd: () => RD && RD.type === 'odd' && RD.open ? oddReveal() : oddStart(),
  bday: () => bdayStart(),
  list: () => tourTok && tourIdx >= 0 ? stopTour() : playTour(0),
  cloud: () => { if (!player.ready) return; if (cloudNow) { cloudTok++; cloudNow = null; player.stop(); setText('#cloud-now', 'paused. space plays.'); } else cloudShuffle(); },
};
function enterMode(m, keepAudio) {
  if (!MODES[m]) return;
  const changed = m !== mode;
  mode = m;
  $('#host').dataset.mode = m;
  document.querySelectorAll('#modes button[data-mode]').forEach(b => { if (b.dataset.mode !== 'join') b.setAttribute('aria-current', String(b.dataset.mode === m)); });
  if (changed || !keepAudio) {
    ++WK.tok; ++walkLoopTok; cloudTok++; cloudNow = null; stopTour(); ST.active = false; BD.active = false; BD.final = false; TW.reveal = false; OD.reveal = false; OD.playing = -1;
    WK.stops = []; WK.pts = []; WK.opts = null; WK.target = null; WK.searching = false;
    if (RD && RD.open) { RD.open = false; }
    RD = null;
    if (player && player.ready) player.stop();
  }
  ['#k-hop', '#k-name', '#k-track', '#k-q', '#k-ans', '#k-right', '#cloud-now'].forEach(id => setText(id, ''));
  $('#k-choices').textContent = '';
  $('#board h3').textContent = 'points';
  $('#board').style.display = '';
  setText('#m-title', MODES[m].title);
  setText('#m-sub', MODES[m].sub);
  setText('#k-go', MODES[m].go);
  renderBoard();
  if (m === 'walk') { fillWalkSelects(); GO.walk(); }
  if (m === 'list') renderList();
  if (JUKE.has(m) && player && player.ready) cloudShuffle();
  if (m === 'cloud' && player && !player.ready) setText('#cloud-now', '');
  publish();
}
function setupModes() {
  $('#k-go').addEventListener('click', () => { const f = GO[mode]; if (f) f(); });
  $('#walk-go').addEventListener('click', () => {
    const a = H.guests.get($('#walk-a').value), b = H.guests.get($('#walk-b').value);
    if (!a || !b || a === b) return;
    manualPair = [a, b]; ++walkLoopTok; walkLoop();
  });
  $('#list-play').addEventListener('click', () => GO.list());
  $('#list-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tourText()); setText('#list-copy', 'copied'); }
    catch (e) { setText('#list-copy', 'copy blocked: use save the playlist'); }
    setTimeout(() => setText('#list-copy', 'copy as text'), 2200);
  });
  $('#list-spotify').addEventListener('click', makeSpotifyPlaylist);
}
function fillWalkSelects() {
  const a = $('#walk-a'), b = $('#walk-b');
  const va = a.value, vb = b.value;
  a.textContent = ''; b.textContent = '';
  for (const g of DV.list) { a.append(el('option', { value: g.k }, g.n)); b.append(el('option', { value: g.k }, g.n)); }
  if (va) a.value = va;
  if (vb) b.value = vb; else if (DV.list[1]) b.value = DV.list[1].k;
}
// hook for later: a real spotify playlist needs a client id and the pkce login flow. not built.
const SPOTIFY_CLIENT_ID = '';
function makeSpotifyPlaylist() {
  if (!SPOTIFY_CLIENT_ID) return;
}

function renderBoard() {
  if (mode === 'bday') return;
  const ol = $('#board-ol');
  ol.textContent = '';
  const rows = Object.entries(H.scores).filter(([k]) => H.guests.has(k)).sort((a, b) => b[1] - a[1]);
  if (!rows.length) { ol.append(el('li', { class: 'more' }, el('span', {}, 'no points yet'))); return; }
  rows.slice(0, 10).forEach(([k, v]) => ol.append(el('li', {}, el('span', {}, nameOf(k)), el('span', {}, String(v)))));
  if (rows.length > 10) ol.append(el('li', { class: 'more' }, el('span', {}, `and ${rows.length - 10} more`)));
}
function renderSide() {
  const f = DV.facts, L = DV.list;
  const box = $('#cloud-facts'), pbox = $('#pairs-facts');
  box.textContent = ''; pbox.textContent = '';
  const fact = (k, v, cls, s) => el('div', { class: 'fact' }, el('div', { class: 'k' }, k), el('div', { class: 'v ' + (cls || '') }, v), s ? el('div', { class: 's' }, s) : null);
  if (L.length < 2) {
    box.append(fact('on the map', String(L.length), '', L.length ? 'one more and the map wakes up.' : 'open join (j) and scan the code.'));
    return;
  }
  box.append(fact('the middle of the room', L[f.center].n, 'mint'), fact('furthest out', L[f.outlier].n, 'rose'));
  if (f.bridge) box.append(fact('the bridge', M.artistName(f.bridge), 'ice', `on ${f.bridgeCount} of the shortest paths between you`));
  const D = DV.D;
  pbox.append(
    fact('closest pair', `${L[f.closest[0]].n} + ${L[f.closest[1]].n}`, 'mint', `${Gr.score(D[f.closest[0]][f.closest[1]])} · ${D[f.closest[0]][f.closest[1]].toFixed(1)} hops`),
    fact('farthest pair', `${L[f.farthest[0]].n} + ${L[f.farthest[1]].n}`, 'rose', `${Gr.score(D[f.farthest[0]][f.farthest[1]])} · ${D[f.farthest[0]][f.farthest[1]] >= Gr.FAR ? 'out of reach' : D[f.farthest[0]][f.farthest[1]].toFixed(1) + ' hops'}`),
    fact('the middle', L[f.center].n, '', `${f.mean[f.center].toFixed(1)} hops from everyone, on average`));
  if (f.widest >= 0) pbox.append(fact('widest taste', L[f.widest].n, '', `own picks ${f.widestHops >= Gr.FAR ? 'out of reach of each other' : f.widestHops.toFixed(1) + ' hops apart'}`));
  if (f.bridge) pbox.append(fact('the bridge', M.artistName(f.bridge), 'ice'));
  if (mode === 'walk') fillWalkSelects();
}
function footStats() {
  const s = Gr.size();
  const pend = M.pending();
  setText('#foot-stats', `${DV.list.length} on the map · ${s.nodes.toLocaleString()} artists mapped · ${s.links.toLocaleString()} links${pend ? ` · ${pend} lookups waiting` : ''}`);
  if (RD && RD.open) {
    const line = roundLine();
    const cur = $('#k-hop').textContent;
    if (RD.type === 'who') setText('#k-hop', `round ${songRound} · ${line}`);
    else if (RD.type === 'twin') setText('#k-hop', line);
    else if (RD.type === 'hops') setText('#k-hop', 'bets · ' + line);
    else if (RD.type === 'steer') setText('#k-hop', `step ${ST.steps} · shortest ${ST.best} · ` + line);
    else if (RD.type === 'odd' && OD.playing >= 0) setText('#k-hop', `${['one', 'two', 'three'][OD.playing]} · ` + line);
    else if (RD.type === 'odd') setText('#k-hop', line);
    void cur;
  }
}

// ---------- nav, keys, idle ----------
function setupNav() {
  document.querySelectorAll('#modes button[data-mode]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.mode === 'join') toggleJoin(); else enterMode(b.dataset.mode);
  }));
  const keys = { 1: 'cloud', 2: 'walk', 3: 'song', 4: 'pairs', 5: 'list', 6: 'hops', 7: 'steer', 8: 'twin', 9: 'odd', 0: 'bday' };
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#hand').classList.contains('hide')) return;
    wake();
    if (keys[e.key]) { enterMode(keys[e.key]); e.preventDefault(); }
    else if (e.key === 'j') toggleJoin();
    else if (e.key === 'k') savePoster();
    else if (e.key === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (e.key === ' ' || e.key === 'Enter') { if (e.target.closest('button')) return; e.preventDefault(); const f = GO[mode]; if (f) f(); }
    else if (e.key === 'n' || e.key === 'ArrowRight') {
      if (WK.skip) WK.skip();
      else if (mode === 'walk') GO.walk();
      else if (mode === 'song' || mode === 'hops' || mode === 'twin' || mode === 'odd') GO[mode]();
    }
  });
  let idleT = 0;
  const wake = () => { $('#host').classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (wide() && matchMedia('(hover: hover)').matches) $('#host').classList.add('idle'); }, 6000); };
  document.addEventListener('mousemove', wake);
  document.addEventListener('pointerdown', wake);
  wake();
}

// ---------- join panel ----------
function joinUrl() {
  const u = location.origin + location.pathname;
  return H.pwQr && K && !DEMO ? u + '#k=' + encodeURIComponent(K.norm) : u;
}
function toggleJoin(force) {
  const j = $('#join');
  const show = force !== undefined ? force : j.classList.contains('hide');
  j.classList.toggle('hide', !show);
  $('#host').classList.toggle('joined', show);
  $('#modes .join-btn').setAttribute('aria-pressed', String(show));
  if (show) { drawQR(); renderJoin(); }
}
function drawQR() {
  const qr = qrcode(0, 'M');
  qr.addData(joinUrl());
  qr.make();
  const n = qr.getModuleCount(), m = 2, S = 8;
  const c = $('#qr');
  c.width = c.height = (n + m * 2) * S;
  const x = c.getContext('2d');
  x.fillStyle = COL.ink || '#efe9ff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = COL.night || '#06010f';
  for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (qr.isDark(r, q)) x.fillRect((q + m) * S, (r + m) * S, S, S);
  const u = new URL(joinUrl());
  setText('#join-link', u.host + u.pathname);
  setText('#join-pwnote', H.pwQr ? 'the code carries the password. keep it in the room.' : 'then the password. ask the host.');
}
function renderJoin() {
  const ul = $('#join-list');
  if (!ul) return;
  ul.textContent = '';
  const all = [...H.guests.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
  setText('#join-count', String(all.filter(g => g.picks.length).length));
  for (const g of all) {
    const on = g.src === 'p2p' ? H.online.has(g.k) : g.src === 'demo';
    ul.append(el('li', {},
      el('span', { class: 'dot' + (on ? ' on' : ''), title: g.src === 'hand' ? 'added by hand' : on ? 'phone connected' : 'phone away' }),
      el('span', { class: 'nm' }, g.n),
      el('span', { class: 'pc' }, `${g.picks.length} pick${g.picks.length === 1 ? '' : 's'}`),
      el('button', { type: 'button', 'aria-pressed': String(H.hostKey === g.k), title: 'mark as the host for the birthday round', onclick: () => { H.hostKey = H.hostKey === g.k ? null : g.k; saveSoon(); renderJoin(); } }, 'host'),
      el('button', { type: 'button', 'aria-label': `remove ${g.n}`, onclick: () => { H.guests.delete(g.k); delete H.scores[g.k]; if (H.hostKey === g.k) H.hostKey = null; H.gv++; saveSoon(); dataChanged(); } }, '×')));
  }
}
function setupJoin() {
  $('#join-pwqr').addEventListener('click', () => {
    H.pwQr = !H.pwQr;
    $('#join-pwqr').setAttribute('aria-pressed', String(H.pwQr));
    setText('#join-pwqr', `password in the code: ${H.pwQr ? 'on' : 'off'}`);
    drawQR();
  });
  $('#join-save').addEventListener('click', async () => {
    const box = await seal(K.key, { guests: [...H.guests.values()], scores: H.scores, hostKey: H.hostKey });
    download(new Blob([JSON.stringify(box)], { type: 'application/json' }), 'party-room.json');
    setText('#join-msg', 'saved. the file opens only with this password.');
  });
  $('#join-open').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const data = d.ct ? await unseal(K.key, d) : d;
      let n = 0;
      for (const g of data.guests || []) {
        const k = g.k || 'h-' + rid();
        upsertGuest(k, { n: g.n || g.name, picks: g.picks }, g.src || 'hand'); n++;
      }
      if (data.scores) Object.assign(H.scores, data.scores);
      if (data.hostKey) H.hostKey = data.hostKey;
      setText('#join-msg', `opened. ${n} people.`);
    } catch (err) { setText('#join-msg', 'could not open that file with this password.'); }
  });
  $('#join-clear').addEventListener('click', () => {
    if (!confirm('clear everyone and every point from this room?')) return;
    H.guests.clear(); H.scores = {}; H.hostKey = null; H.played = []; H.gv++;
    if (!DEMO) lsDel('party.room.' + K.roomId);
    dataChanged(); renderBoard();
  });
  $('#keep-png').addEventListener('click', savePoster);
  $('#keep-txt').addEventListener('click', () => { if (!tourItems.length) tourItems = buildTour(); download(new Blob([tourText() + '\n'], { type: 'text/plain' }), 'birthday-playlist.txt'); });
}
function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function setupHand() {
  const pk = picker($('#h-picks'), { onChange: () => upd() });
  const upd = () => { $('#h-ok').disabled = !($('#h-name').value.trim() && pk.get().length); };
  $('#h-name').addEventListener('input', upd);
  $('#join-add').addEventListener('click', () => { $('#hand').classList.remove('hide'); $('#h-name').value = ''; pk.set([]); $('#h-name').focus(); });
  $('#h-cancel').addEventListener('click', () => $('#hand').classList.add('hide'));
  $('#h-ok').addEventListener('click', () => {
    upsertGuest('h-' + rid(), { n: $('#h-name').value.trim(), picks: pk.get() }, 'hand');
    $('#hand').classList.add('hide');
  });
}

// ---------- keepsake poster ----------
async function savePoster() {
  recompute(true);
  if (DV.list.length < 1) return;
  await document.fonts.load('600 100px "Instrument Sans"');
  await document.fonts.load('500 30px "IBM Plex Mono"');
  const PW = 2400, PH = 3000;
  const oc = document.createElement('canvas'); oc.width = PW; oc.height = PH;
  const c = oc.getContext('2d');
  c.fillStyle = COL.night; c.fillRect(0, 0, PW, PH);
  const saveW = W, saveH = Hh;
  W = PW; Hh = PH;
  DV.list.forEach((g, i) => { const p = pos.get(g.k); if (p && DV.xy[i]) { p[0] = DV.xy[i][0]; p[1] = DV.xy[i][1]; } });
  drawCloud(c, 0, 0, { rect: { x: 240, y: 620, w: PW - 480, h: 1750 }, fs: 40, poster: true });
  W = saveW; Hh = saveH;
  c.fillStyle = COL.ink; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.font = '600 150px "Instrument Sans", sans-serif';
  c.fillText('a birthday map', 160, 300);
  c.font = '500 34px "IBM Plex Mono", monospace'; c.fillStyle = COL.dim;
  const s = Gr.size();
  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toLowerCase();
  c.fillText(`${month} · ${DV.list.length} people · ${s.nodes.toLocaleString()} artists · ${s.links.toLocaleString()} links`, 164, 380);
  const f = DV.facts, L = DV.list;
  const lines = [];
  if (L.length >= 2) {
    lines.push(['the middle of the room', L[f.center].n, COL.mint], ['furthest out', L[f.outlier].n, COL.rose], ['closest pair', `${L[f.closest[0]].n} + ${L[f.closest[1]].n}`, COL.ink]);
    if (f.bridge) lines.push(['the bridge', M.artistName(f.bridge), COL.ice]);
  }
  lines.forEach(([k, v, col], i) => {
    const x = 160 + (i % 2) * 1060, y = 2560 + Math.floor(i / 2) * 170;
    c.font = '500 30px "IBM Plex Mono", monospace'; c.fillStyle = COL.faint; c.fillText(k, x, y);
    c.font = '600 64px "Instrument Sans", sans-serif'; c.fillStyle = col; c.fillText(v, x, y + 74);
  });
  c.font = '400 26px "IBM Plex Mono", monospace'; c.fillStyle = COL.faint;
  c.fillText('placed by hops between everyone’s picks on deezer’s related-artist map. a toy.', 160, PH - 90);
  oc.toBlob(b => { if (b) download(b, 'birthday-map.png'); }, 'image/png');
  window.__party.lastPoster = { w: PW, h: PH, people: L.length };
}

// =====================================================================
// GUEST
// =====================================================================
async function guestMain() {
  $('#guest').classList.remove('hide');
  setText('#g-code', DEMO ? 'demo' : 'room ' + K.code);
  const me = { id: '', name: '', picks: [] };
  const pk = picker($('#g-picks'), { onChange: () => upd() });
  const upd = () => { $('#g-send').disabled = !($('#g-name').value.trim() && pk.get().length); };
  $('#g-name').addEventListener('input', upd);
  const myKey = 'party.me.' + K.roomId;
  let NETg = null, lastShow = null, voted = {};
  window.__party = { get show() { return lastShow; }, get net() { return NETg; } };
  const saveMe = async () => { if (!DEMO) lsSet(myKey, JSON.stringify(await seal(K.key, me))); };
  const raw = !DEMO && lsGet(myKey);
  if (raw) { try { Object.assign(me, await unseal(K.key, JSON.parse(raw))); } catch (e) { /* other password */ } }
  if (!/^[a-f0-9]{16}$/.test(me.id || '')) me.id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

  const showRoom = () => {
    $('#g-form').classList.add('hide'); $('#g-room').classList.remove('hide');
    setText('#g-hi', `you are on the map, ${me.name}.`);
    const ul = $('#g-mine'); ul.textContent = '';
    for (const p of me.picks) ul.append(el('li', {}, el('b', {}, p.k === 't' ? p.tt : p.an), el('span', {}, p.k === 't' ? `song · ${p.an}` : 'artist')));
    render();
  };
  $('#g-send').addEventListener('click', async () => {
    me.name = $('#g-name').value.trim().slice(0, 24);
    me.picks = pk.get();
    await saveMe();
    if (NETg) NETg.guest.set({ id: me.id, n: me.name, picks: me.picks, t: Date.now() }).catch(() => {});
    showRoom();
  });
  $('#g-edit').addEventListener('click', () => {
    $('#g-room').classList.add('hide'); $('#g-form').classList.remove('hide');
    $('#g-name').value = me.name; pk.set(me.picks); upd();
  });

  const modeNames = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.title]));
  function render() {
    const s = lastShow;
    const st = $('#g-status');
    if (DEMO) st.textContent = 'demo: nothing leaves this phone.';
    else if (!NETg) st.textContent = 'connecting to the room';
    else if (!s) st.textContent = waited > 14 ? `no host in this room yet. check the password: your room code is ${K.code}, and the screen shows its code too.` : 'looking for the host';
    else st.textContent = `the screen: ${modeNames[s.mode] || s.mode}`;
    const my = 'p' + me.id;
    const pts = s && s.scores && my ? s.scores[my] || 0 : 0;
    setText('#g-score', s ? `your points: ${pts}` : '');
    const r = s && s.round;
    const box = $('#g-vote');
    const res = $('#g-res');
    if (!r) { box.classList.add('hide'); res.textContent = ''; return; }
    if (r.open) {
      box.classList.remove('hide');
      res.textContent = ''; res.classList.remove('ok');
      setText('#g-q', r.q);
      let opts = r.opts;
      if (!opts) opts = (s.guests || []).filter(g => !(r.type === 'twin' && g.k === my)).map(g => ({ v: g.k, l: g.n }));
      const wrap = $('#g-opts');
      const sig = r.id + ':' + opts.map(o => o.v).join(',');
      if (wrap.dataset.sig !== sig) {
        wrap.dataset.sig = sig; wrap.textContent = '';
        for (const o of opts) wrap.append(el('button', { type: 'button', 'data-v': String(o.v), 'aria-pressed': 'false', onclick: () => cast(r, o.v) }, o.l));
      }
      const mine = voted[r.id];
      [...wrap.children].forEach(b => { const on = mine !== undefined && b.dataset.v === String(mine); b.setAttribute('aria-pressed', String(on)); b.disabled = mine !== undefined; });
      setText('#g-vmsg', mine !== undefined ? 'in. watch the screen.' : '');
    } else {
      box.classList.add('hide');
      if (r.res) {
        const got = my && (r.res.right || []).includes(my);
        res.textContent = r.res.text + (voted[r.id] !== undefined ? (got ? ' you got a point.' : '') : '');
        res.classList.toggle('ok', !!got);
      } else res.textContent = '';
    }
  }
  function cast(r, v) {
    if (voted[r.id] !== undefined) return;
    voted[r.id] = v;
    if (NETg) NETg.vote.set({ r: r.id, v }).catch(() => {});
    render();
  }

  let waited = 0;
  if (me.name && me.picks.length) showRoom();
  if (DEMO) { render(); return; }
  setText('#g-net', 'connecting');
  const ticker = setInterval(() => { waited++; render(); if (lastShow) clearInterval(ticker); }, 1000);
  try {
    const { openRoom } = await import('./sync.js');
    NETg = await openRoom(K.norm, K.roomId);
  } catch (e) { setText('#g-net', 'offline'); render(); return; }
  setText('#g-net', 'live'); $('#g-net').classList.add('ok');
  NETg.show.onChange(v => { lastShow = v; render(); });
  if (NETg.show.get()) lastShow = NETg.show.get();
  if (me.name && me.picks.length) NETg.guest.set({ id: me.id, n: me.name, picks: me.picks, t: Date.now() }).catch(() => {});
  render();
}

// ---------- go ----------
(async () => {
  K = await gate();
  if (ROLE === 'host') await hostMain(); else await guestMain();
})();
