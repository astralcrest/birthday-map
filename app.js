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
  if (p.s === 0 || p.s === 1 || p.s === 2) o.s = p.s;
  if (p.tid) { o.tid = +p.tid; o.tt = String(p.tt || '').slice(0, 100); }
  return o;
}
// three named slots; every one is optional and takes a song, an artist or a link
const SLOTS = [
  { l: 'your forever song', h: "the one you'd keep if you could only keep one", n: 'forever song' },
  { l: 'your song at 16', h: 'whatever you had on repeat then', n: 'song at 16' },
  { l: 'your right-now artist', h: "who you've played most lately", n: 'right-now artist' },
];
const GP = { l: 'your guilty pleasure', h: 'stays secret until the game', n: 'guilty pleasure' };
const slotName = p => p && p.s !== undefined ? SLOTS[p.s].n : '';
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
function picker(root, { max = 3, onChange = () => {}, labels = null } = {}) {
  const picks = new Array(max).fill(null);
  let timers = [];
  function render() {
    root.textContent = '';
    let shownEmpty = false;
    picks.forEach((p, i) => {
      const slot = el('div', { class: 'slot' });
      if (labels) slot.append(el('span', { class: 'slot-l' }, labels[i].l));
      if (p) {
        slot.append(el('div', { class: 'chip' },
          el('div', { class: 'lab' }, el('b', {}, p.k === 't' ? p.tt : p.an), el('span', {}, p.k === 't' ? `song · ${p.an}` : 'artist')),
          el('button', { type: 'button', 'aria-label': 'remove', onclick: () => { picks[i] = null; render(); onChange(); } }, '×')));
      } else if (labels || !shownEmpty) {
        shownEmpty = true;
        const inp = el('input', { type: 'text', placeholder: labels ? labels[i].h : i === 0 ? 'an artist, a song, or a link' : 'another one (optional)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `pick ${i + 1}` });
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
            res.append(el('li', {}, el('button', { type: 'button', onclick: () => { picks[i] = cleanPick(r); if (labels) picks[i].s = i; render(); onChange(); const n = root.querySelector('input'); if (n) n.focus(); } },
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
    set: arr => {
      picks.fill(null);
      for (const q of arr || []) {
        const c = cleanPick(q);
        if (!c) continue;
        const i = labels && c.s !== undefined && !picks[c.s] && c.s < max ? c.s : picks.findIndex(x => !x);
        if (i < 0) break;
        if (labels) c.s = i;
        picks[i] = c;
      }
      render(); onChange();
    },
  };
}

// =====================================================================
// HOST
// =====================================================================
const H = { guests: new Map(), scores: {}, hostKey: null, played: [], online: new Set(), pwQr: false, gv: 0, peer: new Map(), teams: null };
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
let saveT = 0, savedAt = 0;
function saveSoon() {
  if (DEMO) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    savedAt = Date.now();
    const box = await seal(K.key, { t: savedAt, guests: [...H.guests.values()], scores: H.scores, hostKey: H.hostKey, played: H.played, teams: H.teams });
    lsSet('party.room.' + K.roomId, JSON.stringify(box));
    pushVault(box);
  }, 700);
}
// every phone in the room keeps this sealed copy, so the room outlives this tab and this computer
function pushVault(box) {
  if (!NET || !box) return;
  const v = { t: savedAt, box };
  if (JSON.stringify(v).length < 60000) NET.vault.set(v).catch(() => {});
}
async function adopt(v) {
  if (!v || !v.box || !(v.t > savedAt)) return;
  let d;
  try { d = await unseal(K.key, v.box); } catch (e) { return; }
  if (!(v.t > savedAt)) return;
  for (const g of d.guests || []) if (g && g.k && !H.guests.has(g.k)) H.guests.set(g.k, g);
  H.scores = Object.assign({}, d.scores || {}, H.scores);
  for (const k in d.scores || {}) H.scores[k] = Math.max(H.scores[k] || 0, d.scores[k] || 0);
  if (!H.hostKey) H.hostKey = d.hostKey || null;
  if (!H.played.length) H.played = d.played || [];
  if (!H.teams && d.teams) H.teams = d.teams;
  H.gv++;
  setText('#join-msg', `picked the room back up from a phone. ${guestList().length} people.`);
  saveSoon(); dataChanged(); renderBoard(); publish();
}
async function restore() {
  const raw = lsGet('party.room.' + K.roomId);
  if (!raw) return;
  try {
    const d = await unseal(K.key, JSON.parse(raw));
    for (const g of d.guests || []) H.guests.set(g.k, g);
    H.scores = d.scores || {}; H.hostKey = d.hostKey || null; H.played = d.played || []; H.teams = d.teams || null;
    savedAt = d.t || 1;
  } catch (e) { /* a different password wrote this: ignore */ }
}
function upsertGuest(k, v, src) {
  if (!v || !v.n) return;
  const picks = (v.picks || []).map(cleanPick).filter(Boolean).slice(0, 3);
  const prev = H.guests.get(k);
  H.guests.set(k, { k, n: String(v.n).slice(0, 24).trim() || 'guest', picks, gp: cleanPick(v.gp), src, t: prev ? prev.t : Date.now() });
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
      ask: RD && RD.open && RD.ask ? RD.ask : null,
      teams: H.teams ? { n: H.teams.n, m: teamMap(), tot: teamTotals() } : null,
    };
    NET.show.set(s).catch(() => {});
  }, 120);
}
function openRound(type, q, opts, truth) {
  RD = { id: rid(), type, q, opts, open: true, votes: new Map(), vt: new Map(), res: null, t0: performance.now(), truth };
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
  RD.votes.set(who(ctx), v.v); RD.vt.set(who(ctx), performance.now() - RD.t0);
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
      else if (rd.type === 'nth') v = Math.random() < .6 ? t.ans : pickOne(['a', 'b']);
      else if (rd.type === 'match') v = Math.random() < .45 ? t.ans : pickOne(rd.opts).v;
      else if (rd.type === 'far') v = Math.random() < .4 && t.ans ? pickOne(t.ans) : pickOne(rd.opts).v;
      else if (rd.type === 'guilty') v = Math.random() < .4 ? t.owner : pickOne(list.filter(x => x.k !== g.k)).k;
      else if (rd.type === 'bridge') v = Math.random() < .55 ? 'y' : 'n';
      else if (rd.type === 'decade') v = Math.random() < .35 ? t.decade : pickOne(rd.opts).v;
      rd.votes.set(g.k, v); rd.vt.set(g.k, performance.now() - rd.t0);
      setText('#k-hop', roundLine());
    }, 1500 + Math.random() * 9000);
  });
}

// ---------- host: start ----------
async function hostMain() {
  $('#host').classList.remove('hide');
  setText('#room-tag', DEMO ? 'demo' : 'room ' + K.code);
  player = new Player();
  window.__party = { player, H, DV, save: saveSoon, M, Gr, get mode() { return mode; }, get RD() { return RD; }, get WK() { return WK; }, get OD() { return OD; }, get ST() { return ST; }, get BD() { return BD; }, get X() { return { NT, MT, BR, DC, TM }; }, enterMode: m => enterMode(m), go: () => GO[mode] && GO[mode](), savePoster: () => savePoster() };
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
  setupBulk();
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
  NET.reply.onChange((v, ctx) => { if (!ctx.self) onReply(v, ctx); });
  // ask the phones for the newest copy of the room; whoever holds a newer one answers
  NET.keep.onChange((v, ctx) => { if (!ctx.self && v) adopt(v); });
  for (const [k, v] of Object.entries(NET.keep.getAll())) if (k !== NET.self.userId && v) adopt(v);
  NET.vault.onChange((v, ctx) => { if (!ctx.self && v) adopt(v); });
  if (NET.vault.get()) adopt(NET.vault.get());
  const ask = () => NET.need.set({ t: savedAt, at: Date.now() }).catch(() => {});
  ask(); setTimeout(ask, 6000);
  const raw = lsGet('party.room.' + K.roomId);
  if (raw && savedAt) { try { pushVault(JSON.parse(raw)); } catch (e) { /* unreadable */ } }
  refreshOnline();
  publish();
}

async function loadDemo() {
  const [people, seed] = await Promise.all([fetch('demo.json').then(r => r.json()), fetch('seed.json').then(r => r.ok ? r.json() : null).catch(() => null)]);
  if (seed) M.seed(seed);
  const n = clamp(parseInt(Q.get('demo'), 10) || 14, 2, people.length);
  people.slice(0, n).forEach(([name, specs], i) => {
    const picks = specs.map(s => seed && seed.picks[s]).filter(Boolean).map((p, j) => cleanPick({ k: p.k, aid: p.aid, an: p.an, tid: p.tid, tt: p.tt, s: j }));
    const k = 'demo-' + i;
    const sk = seed ? Object.keys(seed.picks) : [], gs = i % 3 === 2 || !sk.length ? null : seed.picks[sk[(i * 11 + 5) % sk.length]];
    H.guests.set(k, { k, n: name, picks, gp: gs ? cleanPick(gs) : null, src: 'demo', t: i });
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
  const P = list.map((g, i) => { let q = pos.get(g.k) || [0, 0]; if (opts.off) { const o = opts.off(g, q); q = [q[0] + o[0], q[1] + o[1]]; } const p = project(R, q); const b = breathe(i, 3); return [p[0] + b[0], p[1] + b[1]]; });
  // the map: every related artist mapped, as a faint dot
  c.fillStyle = alpha(COL.ice, opts.poster ? .42 : .36);
  c.beginPath();
  const dr = opts.poster ? 2.4 : 1.3;
  if (!opts.off) for (const d of DV.dots) {
    const p = project(R, d);
    c.moveTo(p[0] + dr, p[1]); c.arc(p[0], p[1], dr, 0, 6.2832);
  }
  c.fill();
  // links to the two nearest people
  const n = list.length, seen = new Set();
  c.lineWidth = 1;
  for (let i = 0; i < n && !opts.lit; i++) {
    const near = [...Array(n).keys()].filter(j => j !== i).sort((a, b) => DV.D[i][a] - DV.D[i][b]).slice(0, 2);
    for (const j of near) {
      const key = i < j ? i + '-' + j : j + '-' + i;
      if (seen.has(key)) continue; seen.add(key);
      const sim = 1 - DV.D[i][j] / Gr.FAR;
      if (sim <= .05) continue;
      if (opts.off && opts.tint(list[i]) !== opts.tint(list[j])) continue;
      c.strokeStyle = alpha(COL.ice, .16 + .6 * sim);
      curve(c, P[i], P[j], ((i * 7 + j * 13) % 5 - 2) * .08);
    }
  }
  if (opts.twins) drawTwinLines(c, P);
  if (opts.line) { c.strokeStyle = COL.mint; c.lineWidth = 2.5; curve(c, P[opts.line[0]], P[opts.line[1]], .1); }
  // people
  const fs = opts.fs || fontPx(24);
  c.font = `500 ${fs}px "Instrument Sans", system-ui, sans-serif`;
  c.textBaseline = 'middle';
  const boxes = [];
  list.forEach((g, i) => {
    const [x, y] = P[i];
    const playing = cloudNow && cloudNow.k === g.k;
    const dim = opts.lit && !opts.lit.has(g.k), tint = opts.tint ? opts.tint(g) : null;
    c.globalAlpha = dim ? .3 : 1;
    if (opts.lit && !dim) { c.strokeStyle = COL.mint; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 16 + Math.sin(t * 2) * 1.5, 0, 6.2832); c.stroke(); }
    if (opts.lit || opts.off) { /* no rings on a focused map */ } else if (i === f.center) {
      c.strokeStyle = COL.mint; c.lineWidth = 1.25;
      for (const r of [15, 25]) { c.beginPath(); c.arc(x, y, r + Math.sin(t * 1.3) * 1.5, 0, 6.2832); c.stroke(); }
    }
    if (!opts.lit && !opts.off && i === f.outlier) { c.strokeStyle = COL.rose; c.lineWidth = 1.25; c.beginPath(); c.arc(x, y, 15, 0, 6.2832); c.stroke(); }
    if (playing) {
      const lv = player ? player.level() : 0;
      c.strokeStyle = COL.mint; c.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) { const ph = (t * .6 + k / 3) % 1; c.globalAlpha = 1 - ph; c.beginPath(); c.arc(x, y, 10 + ph * 46 + lv * 20, 0, 6.2832); c.stroke(); }
      c.globalAlpha = 1;
    }
    c.fillStyle = tint || COL.ink;
    c.beginPath(); c.arc(x, y, opts.lit && !dim ? 6.5 : 5, 0, 6.2832); c.fill();
    g.picks.forEach((p, k) => {
      const a = t * .25 + k * 2.0944 + i;
      c.beginPath(); c.arc(x + Math.cos(a) * 12, y + Math.sin(a) * 12, 2, 0, 6.2832); c.fill();
    });
    // label: try right, left, above, below
    const label = opts.nameOf ? opts.nameOf(g) : g.n;
    if (!label) { c.globalAlpha = 1; return; }
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
    c.fillStyle = tint || (opts.lit ? COL.mint : i === f.outlier ? COL.rose : i === f.center ? COL.mint : playing ? COL.mint : COL.ink);
    c.textAlign = 'left';
    c.fillText(label, best[0], best[1]);
    c.globalAlpha = 1;
  });
  return P;
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
  const sl = slotName(item.p);
  const text = names.length > 1 ? `${andList(names)} all picked this.` : `it was ${names[0]}'s${sl ? ' ' + sl : ''}.`;
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
  setText('#k-ans', `${w[OD.odd]} was ${s.g.n}'s${slotName(s.p) ? ' ' + slotName(s.p) : ''}.`);
  setText('#k-track', `the other two were ${pair[0].g.n}'s: ${pair.map(x => x.p.an).join(' and ')}.`);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-go', 'three more');
  closeRound({ text: `${w[OD.odd]} was the stranger`, right });
}

// ---------- the birthday round: six degrees to the birthday baby ----------
const BD = { rows: [], active: false, final: false };
async function bdayStart() {
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  if (!hostG || !hostG.picks.length) { setText('#k-q', 'flag the birthday baby first: open join (j) and tap “birthday baby” next to a name.'); return; }
  const tok = ++WK.tok;
  BD.active = true; BD.final = false; BD.rows = [];
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-q', 'every path leads to the birthday baby.');
  setText('#k-go', '');
  const others = DV.list.filter(g => g.k !== hostG.k);
  for (let i = 0; i < others.length; i++) {
    if (tok !== WK.tok) return;
    setText('#k-hop', `finding paths · ${i + 1} of ${others.length}`);
    const res = await pathFor(others[i], hostG, 160).pr;
    BD.rows.push({ g: others[i], path: res.path, hops: res.path ? res.path.length - 1 : null });
  }
  if (tok !== WK.tok) return;
  BD.rows.sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99));
  if (BD.rows.length < 3) { bdayWalk(); return; }
  const eff = r => r.hops ?? 99;
  const byFar = BD.rows.slice().sort((a, b) => eff(b) - eff(a));
  const top = eff(byFar[0]);
  const ans = byFar.filter(r => eff(r) === top).map(r => r.g.k);
  const opts = shuffle([...byFar.slice(0, 3), ...shuffle(byFar.slice(3)).slice(0, 5)]).map(r => ({ v: r.g.k, l: r.g.n }));
  setText('#k-q', 'who is farthest from the birthday baby?');
  setText('#k-go', 'reveal');
  const rd = openRound('far', 'who is farthest from the birthday baby?', opts, { ans, top });
  rd.hp = 'guess · ';
  setText('#k-hop', 'guess · ' + roundLine());
  M.previewFor(hostG.picks[0]).then(pv => { if (RD === rd && rd.open && pv && player.ready) player.play(pv.url, { at: 0 }); });
  autoClose(rd, 24000, bdayWalk);
}
async function bdayWalk() {
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  if (!hostG || !BD.active) return;
  let note = '';
  if (RD && RD.type === 'far' && RD.open) {
    const { ans, top } = RD.truth;
    const right = [...RD.votes.entries()].filter(([, v]) => ans.includes(v)).map(([k]) => k);
    addPoints(right, 2);
    const nm = andList(ans.map(nameOf));
    const text = top >= 99 ? `${nm} ${ans.length > 1 ? 'are' : 'is'} out of reach.` : `farthest: ${nm}, ${top} hops.`;
    note = text + (right.length ? ` got it: ${andList(right.map(nameOf))}.` : ' nobody got it.');
    closeRound({ text, right });
  }
  renderBdayList();
  setText('#k-go', ''); setText('#k-q', ''); setText('#k-right', note);
  const walkOrder = BD.rows.filter(r => r.path).slice().reverse();
  for (const r of walkOrder) {
    setText('#m-sub', `${r.g.n} → the birthday baby · ${r.hops} hop${r.hops === 1 ? '' : 's'}`);
    const ok = await walkPath(r.path, { fromPick: pickFor(r.g, r.path[0]), toPick: pickFor(hostG, r.path[r.path.length - 1]), fromLabel: `${r.g.n}'s pick`, toLabel: 'the birthday baby', dwell: 5000 });
    if (!ok) return;
  }
  BD.final = true;
  const reach = BD.rows.filter(r => r.hops != null);
  const far = Math.max(0, ...reach.map(r => r.hops));
  setText('#m-sub', 'everyone, walking home');
  setText('#k-hop', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-ans', reach.length === BD.rows.length ? `everyone is within ${far} hops of the birthday baby.` : `${reach.length} of ${BD.rows.length} are within ${Gr.CAP} hops of the birthday baby.`);
  setText('#k-right', 'happy birthday.');
  setText('#k-go', 'again');
  const hp = await M.previewFor(hostG.picks[0]);
  if (hp && player.ready) player.play(hp.url, { at: 0 });
}
function renderBdayList() {
  const ol = $('#board-ol');
  $('#board h3').textContent = 'hops to the birthday baby';
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

// =====================================================================
// MORE GAMES: name that hop, matchmaker, guilty pleasure, bridge builder, team split, decade roulette
// =====================================================================
const NEWM = new Set(['nth', 'match', 'guilty', 'bridge', 'teams', 'decade']);
const clearTexts = () => ['#k-ans', '#k-right', '#k-name', '#k-track', '#k-q', '#k-hop'].forEach(id => setText(id, ''));
const eligible = () => DV.list.filter(g => g.src === 'demo' || (g.src === 'p2p' && H.online.has(g.k)));
const fastPts = (rd, k) => (rd.vt.get(k) ?? 1e9) < rd.ms * .4 ? 2 : 1;
async function loopClip(pvs, tok, rd, at = 3, every = 6500) {
  for (let i = 0; tok === WK.tok && RD === rd && rd.open; i++) {
    const pv = Array.isArray(pvs) ? pvs[i % pvs.length] : pvs;
    if (pv && player.ready) player.play(pv.url, { at, fadeIn: .4 });
    await sleep(every);
  }
}
function sideRect(h = .64, x = .4) {
  if (!wide()) return { x: 14, y: 14, w: W - 28, h: Hh - 28 };
  const jw = joinW();
  return { x: (W - jw) * x, y: Hh * .2, w: (W - jw) * (.96 - x), h: Hh * h };
}

// ---- name that hop ----
const NT = { reveal: false, A: null, B: null, h: 0 };
async function nthStart() {
  if (DV.list.length < 3) { setText('#k-q', 'needs three people on the map.'); return; }
  const tok = ++WK.tok;
  NT.reveal = false; WK.stops = []; WK.pts = []; WK.lit = -1; ST.active = false;
  clearTexts();
  let found = null;
  for (let tries = 0; tries < 12 && !found; tries++) {
    const pr = nextPair();
    if (!pr) break;
    setText('#k-hop', 'picking two people and a path');
    const res = await findPath(pr[0], pr[1], 160);
    if (tok !== WK.tok) return;
    const h = res.path ? res.path.length - 1 : 0;
    if (h < 3) continue;
    for (const i of shuffle([...Array(h - 1).keys()].map(x => x + 1).filter(i => 2 * i !== h))) {
      const pv = await M.previewFor({ aid: res.path[i] });
      if (tok !== WK.tok) return;
      if (pv) { found = { A: pr[0], B: pr[1], path: res.path, i, pv }; break; }
    }
  }
  if (!found) { setText('#k-hop', ''); setText('#k-q', 'no long enough path yet. try again.'); return; }
  const { A, B, path, i, pv } = found, h = path.length - 1;
  Object.assign(NT, { A, B, h });
  setText('#m-sub', `${A.n} and ${B.n} are ${h} hops apart.`);
  setText('#k-q', 'this artist sits on the path between them. nearer to whom?');
  setText('#k-go', 'reveal');
  const rd = openRound('nth', `listen. nearer ${A.n} or ${B.n}?`, [{ v: 'a', l: `nearer ${A.n}` }, { v: 'b', l: `nearer ${B.n}` }], { ans: i < h - i ? 'a' : 'b', i, h });
  Object.assign(rd, { pair: [A, B], path, pv, hp: 'nearer · ' });
  setText('#k-hop', 'nearer · ' + roundLine());
  autoClose(rd, 22000, nthReveal);
  loopClip(pv, tok, rd, 4, 6500);
}
async function nthReveal() {
  const rd = RD;
  if (!rd || rd.type !== 'nth' || !rd.open) return;
  const [A, B] = rd.pair, { ans, i, h } = rd.truth;
  const right = [...rd.votes.entries()].filter(([k, v]) => v === ans && k !== A.k && k !== B.k).map(([k]) => k);
  right.forEach(k => addPoints([k], fastPts(rd, k)));
  const nm = M.artistName(rd.path[i]) || rd.pv.an;
  const text = `${nm}: ${i} hop${i === 1 ? '' : 's'} from ${A.n}, ${h - i} from ${B.n}.`;
  setText('#k-q', ''); setText('#k-ans', `nearer ${ans === 'a' ? A.n : B.n}.`); setText('#k-track', text);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-go', 'next clip');
  closeRound({ text, right });
  NT.reveal = true; WK.lit = i;
  await walkPath(rd.path, { fromPick: pickFor(A, rd.path[0]), toPick: pickFor(B, rd.path[h]), fromLabel: `${A.n}'s pick`, toLabel: `${B.n}'s pick`, dwell: 3800 });
}
function drawNth(c, t) {
  drawSong(c, t, .7, Hh * .08);
  if (!NT.A) return;
  const L = walkLayout(), n = NT.h + 1, pts = trailPoints(L, n, false);
  c.strokeStyle = alpha(COL.ice, .4); c.lineWidth = 1;
  c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.stroke();
  pts.forEach((p, i) => { const end = i === 0 || i === n - 1; c.fillStyle = end ? COL.mint : COL.ink; c.beginPath(); c.arc(p[0], p[1], end ? 6 : 3.5, 0, 6.2832); c.fill(); });
  c.font = `500 ${fontPx(20)}px "Instrument Sans", sans-serif`; c.fillStyle = COL.ink; c.textBaseline = 'bottom';
  c.textAlign = 'left'; c.fillText(NT.A.n, pts[0][0], pts[0][1] - 16);
  c.textAlign = 'right'; c.fillText(NT.B.n, pts[n - 1][0], pts[n - 1][1] - 16);
}

// ---- matchmaker ----
const MT = { a: null, b: null, reveal: false };
async function matchStart() {
  const L = DV.list;
  if (L.length < 4) { setText('#k-q', 'needs four people on the map.'); return; }
  const conn = [];
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (DV.D[i][j] < Gr.FAR) conn.push([i, j]);
  if (!conn.length) { setText('#k-q', 'nobody is within reach of anybody yet.'); return; }
  const tok = ++WK.tok;
  const [i, j] = pickOne(conn);
  const key = (a, b) => L[a].k < L[b].k ? L[a].k + '|' + L[b].k : L[b].k + '|' + L[a].k;
  const others = [...L.keys()].filter(x => x !== i && x !== j);
  const seen = new Set([key(i, j)]), pairs = [[i, j]];
  for (let g = 0; pairs.length < 4 && g < 60; g++) {
    const a = g % 4 === 0 ? i : g % 4 === 1 ? j : pickOne(others), b = pickOne(others);
    if (a === b || seen.has(key(a, b))) continue;
    seen.add(key(a, b)); pairs.push([a, b]);
  }
  const opts = shuffle(pairs).map(([a, b]) => ({ v: key(a, b), l: `${L[a].n} + ${L[b].n}` }));
  const A = L[i], B = L[j], d = DV.D[i][j];
  Object.assign(MT, { a: A.k, b: B.k, reveal: false, d });
  clearTexts();
  setText('#m-sub', 'two dots are lit. everyone else is dimmed.');
  setText('#k-q', 'who are these two?');
  setText('#k-track', `similarity ${Gr.score(d)} · ${d.toFixed(1)} hops apart. their picks play.`);
  setText('#k-go', 'reveal');
  const rd = openRound('match', 'who are the two lit dots?', opts, { ans: key(i, j) });
  Object.assign(rd, { hp: 'pair · ', pair: [A, B] });
  setText('#k-hop', 'pair · ' + roundLine());
  autoClose(rd, 28000, matchReveal);
  Promise.all([M.previewFor(A.picks[0]), M.previewFor(B.picks[0])]).then(pvs => loopClip(pvs.filter(Boolean), tok, rd, 3, 9000));
}
function matchReveal() {
  const rd = RD;
  if (!rd || rd.type !== 'match' || !rd.open) return;
  const [A, B] = rd.pair;
  const right = [...rd.votes.entries()].filter(([k, v]) => v === rd.truth.ans && k !== A.k && k !== B.k).map(([k]) => k);
  addPoints(right);
  MT.reveal = true;
  const text = `${A.n} + ${B.n}`;
  setText('#k-q', ''); setText('#k-ans', text + '.');
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-go', 'next pair');
  closeRound({ text, right });
}
function drawMatch(c, t, dt) {
  const ia = DV.idx.get(MT.a), ib = DV.idx.get(MT.b);
  const P = drawCloud(c, t, dt, { rect: sideRect(), lit: new Set([MT.a, MT.b]), nameOf: g => g.k !== MT.a && g.k !== MT.b ? '' : MT.reveal ? g.n : '?', fs: fontPx(30), line: ia !== undefined && ib !== undefined ? [ia, ib] : null });
  if (!P || ia === undefined || ib === undefined) return;
  const d = MT.d !== undefined ? MT.d : DV.D[ia][ib], m = [(P[ia][0] + P[ib][0]) / 2, (P[ia][1] + P[ib][1]) / 2 - 44];
  c.font = `500 ${fontPx(16)}px "IBM Plex Mono", monospace`; c.fillStyle = COL.mint; c.textAlign = 'center'; c.textBaseline = 'bottom';
  c.fillText(`${Gr.score(d)} · ${d.toFixed(1)} hops`, m[0], m[1]);
}

// ---- guilty pleasure ----
let gpRound = 0;
async function guiltyStart() {
  const have = DV.list.filter(g => g.gp);
  clearTexts();
  if (have.length < 2) { setText('#k-q', 'needs two guilty pleasures.'); setText('#k-track', `${have.length} in. phones add one under “change my picks”, or add by hand.`); return; }
  const tok = ++WK.tok;
  let pool = have.filter(g => !H.played.includes('g:' + g.k));
  if (!pool.length) { H.played = H.played.filter(x => x[0] !== 'g'); pool = have; }
  let item = null, pv = null;
  for (const g of shuffle(pool)) { pv = await M.previewFor(g.gp); if (tok !== WK.tok) return; if (pv) { item = g; break; } }
  if (!item) { setText('#k-q', 'no secret has a clip right now. try again.'); return; }
  H.played.push('g:' + item.k);
  gpRound++;
  setText('#k-q', 'whose guilty pleasure is this?');
  setText('#k-track', `${have.length} secrets in. one of you hid this.`);
  setText('#k-go', 'reveal');
  const rd = openRound('guilty', 'whose guilty pleasure is this?', null, { owner: item.k });
  Object.assign(rd, { pv, item, hp: `secret ${gpRound} · ` });
  setText('#k-hop', rd.hp + roundLine());
  autoClose(rd, 28000, guiltyReveal);
  loopClip(pv, tok, rd, 8, 12000);
}
function guiltyReveal() {
  const rd = RD;
  if (!rd || rd.type !== 'guilty' || !rd.open) return;
  const o = rd.truth.owner;
  const right = [...rd.votes.entries()].filter(([k, v]) => v === o && k !== o).map(([k]) => k);
  addPoints(right);
  const text = `it was ${nameOf(o)}'s guilty pleasure.`;
  setText('#k-q', ''); setText('#k-ans', text);
  setText('#k-track', `${rd.pv.tt} · ${rd.pv.an}`);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-hop', `secret ${gpRound}`);
  setText('#k-go', 'next secret');
  closeRound({ text, right });
}

// ---- bridge builder: the rule is a detour of at most two hops ----
const BR = { A: null, B: null, cur: null, t0: 0 };
const BR_RULE = 'a bridge adds two hops at most.';
async function bridgeStart() {
  const E = eligible();
  if (E.length < 2 || DV.list.length < 3) { setText('#k-q', 'needs two phones on the map and a third person to vote.'); return; }
  const pairs = [];
  for (let a = 0; a < E.length; a++) for (let b = a + 1; b < E.length; b++) { const d = DV.D[DV.idx.get(E[a].k)][DV.idx.get(E[b].k)]; if (d < Gr.FAR) pairs.push([E[a], E[b], d]); }
  clearTexts();
  if (!pairs.length) { setText('#k-q', 'the phones on the map are out of reach of each other.'); return; }
  pairs.sort((x, y) => y[2] - x[2]);
  const [A, B] = pickOne(pairs.slice(0, 4));
  const tok = ++WK.tok;
  Object.assign(BR, { A, B, cur: null });
  setText('#m-sub', `${A.n} and ${B.n} are far apart on the map.`);
  setText('#k-q', `${A.n} and ${B.n}: name one artist that connects you.`);
  setText('#k-track', BR_RULE + ' everyone else votes.');
  setText('#k-go', 'test the bridges');
  const rd = openRound('bridge', `will ${A.n} and ${B.n} find a bridge?`, [{ v: 'y', l: 'they will find a bridge' }, { v: 'n', l: 'they will not' }], {});
  Object.assign(rd, { ask: { k: [A.k, B.k], n: [A.n, B.n] }, replies: new Map(), hp: 'bridge · ', pathP: pathFor(A, B, 200).pr });
  publish();
  setText('#k-hop', 'bridge · ' + roundLine());
  autoClose(rd, 55000, bridgeReveal);
  if (DEMO) fakeReplies(rd);
  void tok;
}
function onReply(v, ctx) { if (v) takeReply(who(ctx), cleanPick(v.pick), v.r); }
function takeReply(k, p, r) {
  const rd = RD;
  if (!rd || !rd.open || rd.type !== 'bridge' || r !== rd.id || !p || !rd.ask.k.includes(k)) return;
  rd.replies.set(k, p);
  setText('#k-right', `${rd.replies.size} of 2 named`);
  if (rd.replies.size === 2 && !rd.soon) { rd.soon = true; setTimeout(() => { if (RD === rd && rd.open) bridgeReveal(); }, 8000); }
}
function fakeReplies(rd) {
  [BR.A, BR.B].forEach((g, i) => setTimeout(() => {
    if (RD !== rd || !rd.open) return;
    const path = Gr.pathKnown(BR.A.picks.map(p => p.aid), BR.B.picks.map(p => p.aid));
    const mid = path && path.length > 2 && Math.random() < .65 ? path[1 + Math.floor(Math.random() * (path.length - 2))] : null;
    const aid = mid || +pickOne(Object.keys(M.mem.art));
    takeReply(g.k, { k: 'a', aid, an: M.artistName(aid) }, rd.id);
  }, 3000 + i * 3500));
}
async function bridgeTest(A, B, p, short) {
  const x = +p.aid, aA = A.picks.map(q => +q.aid), aB = B.picks.map(q => +q.aid);
  if (short == null) return { p, ok: false, why: 'they have no path.' };
  if (aA.includes(x) || aB.includes(x)) return { p, ok: false, why: 'that is already one of their picks.' };
  await M.related(x, 'hi');
  const [ra, rb] = await Promise.all([Gr.pathLive([x], aA, { budget: 80 }), Gr.pathLive([x], aB, { budget: 80 })]);
  if (!ra.path || !rb.path) return { p, ok: false, why: 'out of reach.', dA: ra.path ? ra.path.length - 1 : null, dB: rb.path ? rb.path.length - 1 : null };
  const dA = ra.path.length - 1, dB = rb.path.length - 1;
  return { p, ok: dA + dB <= short + 2, dA, dB, short, path: ra.path.slice().reverse().concat(rb.path.slice(1)), xi: dA };
}
async function bridgeReveal() {
  const rd = RD;
  if (!rd || rd.type !== 'bridge' || !rd.open) return;
  rd.open = false; publish();
  const { A, B } = BR;
  setText('#k-go', ''); setText('#k-q', ''); setText('#k-right', '');
  setText('#k-track', 'testing. ' + BR_RULE);
  const sr = await rd.pathP;
  if (RD !== rd) return;
  const short = sr.path ? sr.path.length - 1 : null;
  const results = [];
  for (const [k, p] of rd.replies) {
    const by = k === A.k ? A : B, nm = M.artistName(p.aid) || p.an;
    setText('#k-hop', `${by.n} named ${nm}`); setText('#k-ans', ''); setText('#k-track', 'testing. ' + BR_RULE);
    const r = await bridgeTest(A, B, p, short);
    if (RD !== rd) return;
    r.by = by; r.nm = nm; results.push(r);
    BR.cur = r; BR.t0 = performance.now();
    setText('#k-ans', r.ok ? 'a bridge.' : 'not a bridge.');
    setText('#k-track', r.why ? `${nm}: ${r.why}` : `${nm} is ${r.dA} from ${A.n}'s picks and ${r.dB} from ${B.n}'s. shortest is ${short}.`);
    await sleep(5200);
    if (RD !== rd) return;
  }
  for (const k of rd.ask.k) if (!rd.replies.has(k)) { setText('#k-track', `${nameOf(k)} did not name one.`); }
  const any = results.some(r => r.ok);
  const voters = [...rd.votes.entries()].filter(([k]) => !rd.ask.k.includes(k));
  const right = voters.filter(([, v]) => v === (any ? 'y' : 'n')).map(([k]) => k);
  addPoints(right);
  if (any) { addPoints([A.k, B.k], 2); right.push(A.k, B.k); }
  const text = any ? `${andList(results.filter(r => r.ok).map(r => r.nm))} bridges ${A.n} and ${B.n}.` : `no bridge between ${A.n} and ${B.n}.`;
  setText('#k-hop', ''); setText('#k-ans', any ? 'bridge found.' : 'no bridge.');
  setText('#k-right', right.length ? `points: ${andList(right.map(nameOf))}` : 'no points.');
  setText('#k-go', 'again');
  closeRound({ text, right });
}
function drawBridge(c, t, dt) {
  const { A, B } = BR;
  if (!A) { drawCloud(c, t, dt, { rect: sideRect() }); return; }
  const P = drawCloud(c, t, dt, { rect: sideRect(), lit: new Set([A.k, B.k]), fs: fontPx(30) });
  const ia = DV.idx.get(A.k), ib = DV.idx.get(B.k);
  if (!P || ia === undefined || ib === undefined) return;
  const pa = P[ia], pb = P[ib], len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
  const nx = -(pb[1] - pa[1]) / len, ny = (pb[0] - pa[0]) / len, R = BR.cur;
  c.font = `500 ${fontPx(18)}px "IBM Plex Mono", monospace`; c.textAlign = 'center';
  if (!R) {
    c.strokeStyle = alpha(COL.ice, .6); c.lineWidth = 1.5; c.setLineDash([3, 8]);
    c.beginPath(); c.moveTo(pa[0], pa[1]); c.lineTo(pb[0], pb[1]); c.stroke(); c.setLineDash([]);
    c.fillStyle = COL.ice; c.textBaseline = 'middle'; c.fillText('?', (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2);
    return;
  }
  const col = R.ok ? COL.mint : COL.rose;
  const u = ease(clamp((performance.now() - BR.t0) / 1400, 0, 1));
  if (!R.path) {
    const m = [(pa[0] + pb[0]) / 2 + nx * len * .25, (pa[1] + pb[1]) / 2 + ny * len * .25];
    c.strokeStyle = alpha(COL.rose, .7); c.lineWidth = 1.5; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(pa[0], pa[1]); c.lineTo(m[0], m[1]); c.lineTo(pb[0], pb[1]); c.stroke(); c.setLineDash([]);
    c.fillStyle = COL.rose; c.beginPath(); c.arc(m[0], m[1], 7 * u, 0, 6.2832); c.fill();
    c.font = `600 ${fontPx(26)}px "Instrument Sans", sans-serif`; c.textBaseline = 'bottom'; c.fillText(R.nm, m[0], m[1] - 16);
    return;
  }
  const n = R.path.length, shown = u * (n - 1);
  const pt = f => [pa[0] + (pb[0] - pa[0]) * f + nx * Math.sin(f * Math.PI) * len * .24, pa[1] + (pb[1] - pa[1]) * f + ny * Math.sin(f * Math.PI) * len * .24];
  c.strokeStyle = col; c.lineWidth = 2.5; c.setLineDash(R.ok ? [] : [8, 6]);
  c.beginPath();
  for (let s = 0; s <= 80; s++) { const f = s / 80 * u; const q = pt(f); s ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }
  c.stroke(); c.setLineDash([]);
  for (let i = 0; i < n; i++) {
    if (i > shown + .01) break;
    const q = pt(i / (n - 1));
    if (i === R.xi) {
      c.fillStyle = col; c.beginPath(); c.arc(q[0], q[1], 9, 0, 6.2832); c.fill();
      c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.arc(q[0], q[1], 17 + Math.sin(t * 2) * 1.5, 0, 6.2832); c.stroke();
      c.font = `600 ${fontPx(28)}px "Instrument Sans", sans-serif`; c.textBaseline = 'bottom'; c.fillStyle = col; c.fillText(R.nm, q[0], q[1] - 28);
    } else if (i > 0 && i < n - 1) { c.fillStyle = COL.ice; c.beginPath(); c.arc(q[0], q[1], 3, 0, 6.2832); c.fill(); }
  }
}

// ---- team split ----
const TM = { t0: 0 };
function teamOfKey(k) {
  const T = H.teams;
  if (T.m[k] !== undefined) return T.m[k];
  const i = DV.idx.get(k), av = [[], []];
  if (i !== undefined) for (const [kk, t] of Object.entries(T.m)) { const j = DV.idx.get(kk); if (j !== undefined) av[t].push(DV.D[i][j]); }
  const m = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 99;
  return (T.m[k] = m(av[1]) < m(av[0]) ? 1 : 0);
}
function teamMap() { for (const g of DV.list) teamOfKey(g.k); return H.teams.m; }
function teamTotals() {
  const t = [0, 0];
  for (const [k, v] of Object.entries(H.scores)) if (H.guests.has(k)) t[teamOfKey(k)] += v;
  return t;
}
function teamsSplit() {
  const L = DV.list, n = L.length, D = DV.D, xy = DV.xy;
  if (n < 4) { setText('#k-q', 'needs four people on the map.'); return; }
  const dd = (i, j) => D[i][j] + .001 * Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
  let [m0, m1] = DV.facts.farthest, side = [];
  for (let it = 0; it < 14; it++) {
    side = L.map((_, i) => i === m0 ? 0 : i === m1 ? 1 : dd(i, m0) <= dd(i, m1) ? 0 : 1);
    const nm = [0, 1].map(t => {
      const mem = side.map((s, i) => s === t ? i : -1).filter(i => i >= 0);
      let best = mem[0], bs = Infinity;
      for (const i of mem) { const sc = mem.reduce((a, j) => a + dd(i, j), 0); if (sc < bs) { bs = sc; best = i; } }
      return best;
    });
    if (nm[0] === m0 && nm[1] === m1) break;
    [m0, m1] = nm;
  }
  const need = Math.max(2, Math.floor(n * .3));
  for (const t of [0, 1]) while (side.filter(s => s === t).length < need) {
    const mo = t ? m1 : m0, ot = t ? m0 : m1;
    let best = -1, bv = Infinity;
    side.forEach((s, i) => { if (s !== t && i !== ot) { const v = dd(i, mo) - dd(i, ot); if (v < bv) { bv = v; best = i; } } });
    if (best < 0) break;
    side[best] = t;
  }
  const cov = [new Map(), new Map()], sz = [0, 0];
  L.forEach((g, i) => { sz[side[i]]++; for (const v of Gr.bfs(g.picks.map(p => p.aid), 1).dist.keys()) cov[side[i]].set(v, (cov[side[i]].get(v) || 0) + 1); });
  const nameFor = t => {
    let best = null, bs = 0;
    for (const [v, c] of cov[t]) {
      if (c < 2 || !M.artistName(v)) continue;
      const sc = c / sz[t] - (cov[1 - t].get(v) || 0) / sz[1 - t] + M.artistFans(v) / 1e12;
      if (sc > bs) { bs = sc; best = v; }
    }
    return 'team ' + (best != null ? M.artistName(best) : L[t ? m1 : m0].n).toLowerCase();
  };
  const names = [nameFor(0), nameFor(1)];
  if (names[0] === names[1]) names[1] = 'team ' + L[m1].n.toLowerCase();
  H.teams = { n: names, m: Object.fromEntries(L.map((g, i) => [g.k, side[i]])), at: Date.now() };
  TM.t0 = performance.now();
  saveSoon(); publish(); renderBoard(); teamsTexts();
}
function mergeTeams() {
  H.teams = null; TM.t0 = 0;
  saveSoon(); publish(); renderBoard();
  if (mode === 'teams') { clearTexts(); teamsTexts(); }
}
function teamsTexts() {
  const T = H.teams;
  setText('#k-go', T ? 'merge' : 'split the room');
  if (!T) return;
  const cnt = [0, 0], tot = teamTotals();
  DV.list.forEach(g => cnt[teamOfKey(g.k)]++);
  setText('#k-hop', 'two taste camps');
  setText('#k-q', `${T.n[0]} vs ${T.n[1]}`);
  setText('#k-track', `${cnt[0]} and ${cnt[1]} people. points ${tot[0]} to ${tot[1]}.`);
}
function drawTeams(c, t, dt) {
  const T = H.teams, R = sideRect(.66, .36);
  if (!T) { drawCloud(c, t, dt, { rect: R }); return; }
  const s = ease(clamp((performance.now() - TM.t0) / 1800, 0, 1));
  const cen = [[0, 0, 0], [0, 0, 0]];
  for (const g of DV.list) { const p = pos.get(g.k) || [0, 0], q = cen[teamOfKey(g.k)]; q[0] += p[0]; q[1] += p[1]; q[2]++; }
  for (const q of cen) { q[0] /= q[2] || 1; q[1] /= q[2] || 1; }
  let dx = cen[1][0] - cen[0][0], dy = cen[1][1] - cen[0][1];
  const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const P = drawCloud(c, t, dt, {
    rect: R, fs: fontPx(22),
    off: (g, q) => { const tt = teamOfKey(g.k), sg = tt ? 1 : -1, ce = cen[tt]; return [(ce[0] - q[0]) * .35 * s + dx * sg * .4 * s, (ce[1] - q[1]) * .35 * s + dy * sg * .4 * s]; },
    tint: g => teamOfKey(g.k) ? COL.rose : COL.mint,
  });
  if (!P) return;
  const tot = teamTotals();
  c.font = `600 ${fontPx(30)}px "Instrument Sans", sans-serif`; c.textBaseline = 'bottom';
  [0, 1].forEach(tt => {
    const mem = P.filter((_, i) => teamOfKey(DV.list[i].k) === tt);
    if (!mem.length) return;
    const x = mem.reduce((a, p) => a + p[0], 0) / mem.length, y = Math.min(...mem.map(p => p[1])) - 44;
    c.fillStyle = tt ? COL.rose : COL.mint; c.globalAlpha = s; c.textAlign = 'center';
    c.fillText(`${T.n[tt]} · ${tot[tt]}`, clamp(x, 120, W - 120), Math.max(fontPx(34), y));
    c.globalAlpha = 1;
  });
}

// ---- decade roulette ----
const DC = { reveal: false, year: 0, lit: null };
const decOf = y => y < 1970 ? 1960 : Math.min(2020, Math.floor(y / 10) * 10);
const DECS = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
let yearWarm = null;
function warmYears() {
  if (yearWarm) return yearWarm;
  yearWarm = (async () => { for (const g of DV.list) for (const p of g.picks) { try { await M.yearOf(p); } catch (e) { /* skip */ } } yearWarm = null; })();
  return yearWarm;
}
const avgYear = g => { const ys = g.picks.map(p => M.mem.yr[p.tid ? 't' + p.tid : 'a' + p.aid]).filter(y => y > 0); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null; };
async function decadeStart() {
  const L = DV.list;
  if (L.length < 2) { setText('#k-q', 'needs two people on the map.'); return; }
  const tok = ++WK.tok;
  DC.reveal = false; DC.lit = null; DC.year = 0;
  clearTexts();
  setText('#k-hop', 'looking for a song with a date');
  warmYears();
  let found = null;
  for (const it of shuffle(L.flatMap(g => g.picks.flatMap(p => p.s === 1 ? [{ g, p }, { g, p }] : [{ g, p }]))).slice(0, 10)) {
    const [y, pv] = await Promise.all([M.yearOf(it.p), M.previewFor(it.p)]);
    if (tok !== WK.tok) return;
    if (y && pv) { found = { it, y, pv }; break; }
  }
  if (!found) { setText('#k-hop', ''); setText('#k-q', 'could not find a dated song. try again.'); return; }
  setText('#k-hop', '');
  setText('#k-q', 'which decade is this song from?');
  setText('#k-go', 'reveal');
  const opts = DECS.map(v => ({ v, l: v === 1960 ? '60s or earlier' : String(v).slice(2) + 's' }));
  const rd = openRound('decade', 'which decade is this song from?', opts, { decade: decOf(found.y), year: found.y });
  Object.assign(rd, { pv: found.pv, it: found.it, hp: 'decade · ' });
  setText('#k-hop', 'decade · ' + roundLine());
  autoClose(rd, 24000, decadeReveal);
  loopClip(found.pv, tok, rd, 6, 10000);
}
async function decadeReveal() {
  const rd = RD;
  if (!rd || rd.type !== 'decade' || !rd.open) return;
  const { decade, year } = rd.truth;
  const right = [...rd.votes.entries()].filter(([, v]) => v === decade).map(([k]) => k);
  addPoints(right);
  DC.year = year; DC.reveal = true; DC.lit = new Set();
  const lab = decade === 1960 ? '60s or earlier' : String(decade).slice(2) + 's';
  const text = `${year}. the ${lab}.`;
  setText('#k-hop', ''); setText('#k-q', ''); setText('#k-ans', text);
  setText('#k-track', `${rd.pv.tt} · ${rd.pv.an}`);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : 'nobody got it.');
  setText('#k-go', 'spin again');
  closeRound({ text, right });
  await Promise.race([warmYears(), sleep(8000)]);
  if (RD !== rd) return;
  const near = DV.list.map(g => [g, avgYear(g)]).filter(x => x[1] != null).sort((a, b) => Math.abs(a[1] - year) - Math.abs(b[1] - year)).slice(0, 3);
  DC.lit = new Set(near.map(x => x[0].k));
  if (near.length) setText('#k-right', `${right.length ? `got it: ${andList(right.map(nameOf))}. ` : 'nobody got it. '}picks closest in years: ${andList(near.map(([g, a]) => `${g.n} (${Math.round(a)})`))}`);
}
function drawDecade(c, t, dt) {
  if (DC.reveal) {
    drawCloud(c, t, dt, { rect: sideRect(.58, .36), lit: DC.lit || new Set(), nameOf: g => DC.lit && DC.lit.has(g.k) ? g.n : '', fs: fontPx(30) });
  } else drawSong(c, t, .7, Hh * .08);
  const jw = joinW(), p = pad(), x0 = p + 30, x1 = W - jw - p - 30, y = Hh * (wide() ? .87 : .93), w = (x1 - x0) / 7;
  c.strokeStyle = alpha(COL.ice, .4); c.lineWidth = 1;
  c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
  c.font = `500 ${fontPx(16)}px "IBM Plex Mono", monospace`; c.textAlign = 'center'; c.textBaseline = 'top';
  const tally = new Array(7).fill(0);
  if (!DC.reveal && RD && RD.type === 'decade') for (const v of RD.votes.values()) { const i = (v - 1960) / 10; if (i >= 0 && i < 7) tally[i]++; }
  DECS.forEach((d, i) => {
    const cx = x0 + (i + .5) * w;
    c.strokeStyle = alpha(COL.ice, .4); c.beginPath(); c.moveTo(x0 + i * w, y - 5); c.lineTo(x0 + i * w, y + 5); c.stroke();
    c.fillStyle = DC.reveal && decOf(DC.year) === d ? COL.mint : COL.dim;
    c.fillText(d === 1960 ? 'pre-70' : String(d).slice(2) + 's', cx, y + 10);
    c.fillStyle = COL.ink;
    for (let k = 0; k < tally[i]; k++) { c.beginPath(); c.arc(cx - 6 + (k % 2) * 12, y - 16 - Math.floor(k / 2) * 12, 4, 0, 6.2832); c.fill(); }
  });
  c.beginPath(); c.moveTo(x1, y - 5); c.lineTo(x1, y + 5); c.stroke();
  if (DC.reveal && DC.year) {
    const fr = DC.year < 1970 ? .5 : (DC.year % 10) / 10, mx = x0 + ((decOf(DC.year) - 1960) / 10 + fr) * w;
    c.fillStyle = COL.mint; c.beginPath(); c.moveTo(mx, y - 4); c.lineTo(mx - 8, y - 20); c.lineTo(mx + 8, y - 20); c.closePath(); c.fill();
    c.font = `600 ${fontPx(30)}px "Instrument Sans", sans-serif`; c.textBaseline = 'bottom'; c.fillText(String(DC.year), mx, y - 26);
  }
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
function drawSong(c, t, k = 1, up = 0) {
  const pc = playCenter(), cx = pc.cx, cy = pc.cy - up, R = pc.R * k;
  contours(c, cx, cy, R, t, 1, RD && !RD.open ? COL.mint : COL.ice, true);
  if (RD) {
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
  bday: (c, t, dt) => BD.final ? drawBdayFinal(c, t) : RD && RD.type === 'far' && RD.open ? drawSong(c, t) : drawWalk(c, t, dt),
  song: (c, t) => drawSong(c, t), odd: drawOdd,
  nth: (c, t, dt) => NT.reveal ? drawWalk(c, t, dt) : drawNth(c, t), match: drawMatch, guilty: (c, t) => drawSong(c, t), bridge: drawBridge, teams: drawTeams, decade: drawDecade,
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
  bday: { title: 'six degrees to the birthday baby', sub: 'guess who is farthest, then watch every path walk home.', go: 'start the finale' },
  nth: { title: 'name that hop', sub: 'one clip from somewhere on a path. nearer which end?', go: 'start' },
  match: { title: 'matchmaker', sub: 'two dots are lit. who are they?', go: 'light two dots' },
  guilty: { title: 'guilty pleasure', sub: 'one secret song. whose is it?', go: 'play a secret' },
  bridge: { title: 'bridge builder', sub: 'two people name one artist that connects them.', go: 'pick two' },
  teams: { title: 'team split', sub: 'two taste camps, pulled apart.', go: 'split the room' },
  decade: { title: 'decade roulette', sub: 'which decade is this song from?', go: 'spin' },
};
const GO = { walk: () => { ++walkLoopTok; walkLoop(); }, song: () => RD && RD.type === 'who' && RD.open ? songReveal() : songStart(),
  hops: () => RD && RD.type === 'hops' && RD.open ? hopsWalk() : hopsStart(),
  steer: () => RD && RD.type === 'steer' && RD.open ? steerChoose(null) : (ST.active ? null : steerStart()),
  twin: () => RD && RD.type === 'twin' && RD.open ? twinReveal() : twinStart(),
  odd: () => RD && RD.type === 'odd' && RD.open ? oddReveal() : oddStart(),
  bday: () => RD && RD.type === 'far' && RD.open ? bdayWalk() : bdayStart(),
  nth: () => RD && RD.type === 'nth' && RD.open ? nthReveal() : nthStart(),
  match: () => RD && RD.type === 'match' && RD.open ? matchReveal() : matchStart(),
  guilty: () => RD && RD.type === 'guilty' && RD.open ? guiltyReveal() : guiltyStart(),
  bridge: () => RD && RD.type === 'bridge' && RD.open ? bridgeReveal() : bridgeStart(),
  teams: () => H.teams ? mergeTeams() : teamsSplit(),
  decade: () => RD && RD.type === 'decade' && RD.open ? decadeReveal() : decadeStart(),
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
    ++WK.tok; ++walkLoopTok; cloudTok++; cloudNow = null; stopTour(); ST.active = false; BD.active = false; BD.final = false; TW.reveal = false; OD.reveal = false; OD.playing = -1; NT.reveal = false; MT.reveal = false; BR.cur = null; BR.A = null; DC.reveal = false; DC.lit = null; WK.lit = -1;
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
  if (m === 'teams') teamsTexts();
  $('#more-btn').setAttribute('aria-current', String(NEWM.has(m)));
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
  $('#team-merge').classList.toggle('hide', !H.teams);
  if (H.teams) {
    const tot = teamTotals();
    [0, 1].forEach(t => ol.append(el('li', { class: 'team t' + t }, el('span', {}, H.teams.n[t]), el('span', {}, String(tot[t])))));
  }
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
  if (mode === 'teams' && H.teams) teamsTexts();
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
    else if (RD.hp !== undefined && RD.open) setText('#k-hop', RD.hp + line);
    void cur;
  }
}

// ---------- nav, keys, idle ----------
function setupNav() {
  document.querySelectorAll('#modes button[data-mode]').forEach(b => b.addEventListener('click', () => {
    $('#more').classList.add('hide'); $('#more-btn').setAttribute('aria-expanded', 'false');
    if (b.dataset.mode === 'join') toggleJoin(); else enterMode(b.dataset.mode);
  }));
  $('#more-btn').addEventListener('click', e => { e.stopPropagation(); const o = $('#more').classList.toggle('hide'); $('#more-btn').setAttribute('aria-expanded', String(!o)); });
  document.addEventListener('click', e => { if (!e.target.closest('#more')) { $('#more').classList.add('hide'); $('#more-btn').setAttribute('aria-expanded', 'false'); } });
  $('#team-merge').addEventListener('click', mergeTeams);
  const keys = { 1: 'cloud', 2: 'walk', 3: 'song', 4: 'pairs', 5: 'list', 6: 'hops', 7: 'steer', 8: 'twin', 9: 'odd', 0: 'bday' };
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#hand').classList.contains('hide') || !$('#bulk').classList.contains('hide')) return;
    if (e.key === 'Escape') { $('#more').classList.add('hide'); return; }
    wake();
    if (keys[e.key]) { enterMode(keys[e.key]); e.preventDefault(); }
    else if (e.key === 'j') toggleJoin();
    else if (e.key === 'k') savePoster();
    else if (e.key === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (e.key === ' ' || e.key === 'Enter') { if (e.target.closest('button')) return; e.preventDefault(); const f = GO[mode]; if (f) f(); }
    else if (e.key === 'n' || e.key === 'ArrowRight') {
      if (WK.skip) WK.skip();
      else if (mode === 'walk') GO.walk();
      else if (mode === 'song' || mode === 'hops' || mode === 'twin' || mode === 'odd' || mode === 'nth' || mode === 'match' || mode === 'guilty' || mode === 'decade') GO[mode]();
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
      el('button', { type: 'button', 'aria-pressed': String(H.hostKey === g.k), title: 'flag the birthday baby for the birthday round', onclick: () => { H.hostKey = H.hostKey === g.k ? null : g.k; saveSoon(); renderJoin(); } }, 'birthday baby'),
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
    H.guests.clear(); H.scores = {}; H.hostKey = null; H.played = []; H.teams = null; H.gv++;
    saveSoon();
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
  const pk = picker($('#h-picks'), { labels: SLOTS, onChange: () => upd() });
  const gpk = picker($('#h-gp'), { max: 1, labels: [GP] });
  const upd = () => { $('#h-ok').disabled = !($('#h-name').value.trim() && pk.get().length); };
  $('#h-name').addEventListener('input', upd);
  $('#join-add').addEventListener('click', () => { $('#hand').classList.remove('hide'); $('#h-name').value = ''; pk.set([]); gpk.set([]); $('#h-name').focus(); });
  $('#h-cancel').addEventListener('click', () => $('#hand').classList.add('hide'));
  $('#h-ok').addEventListener('click', () => {
    upsertGuest('h-' + rid(), { n: $('#h-name').value.trim(), picks: pk.get(), gp: gpk.get()[0] }, 'hand');
    $('#hand').classList.add('hide');
  });
}

// ---------- bulk import: a list or a csv collected in advance ----------
const BK = { people: [], busy: false, tok: 0 };
const EMAIL = /\S+@\S+\.\S+/, PHONE = /^[+(]?\d[\d\s().\-]{6,}$/;
const NAMEH = /^(name|guest|guest name|first name|full name|invitee)$/i;
const SKIPH = /^(status|rsvp|e-?mail|phone|mobile|cell|number|date|time|created|updated|timestamp|plus|\+\d|guests|party|count|response|attending|id|notes?|last name|surname)\b|e-?mail|phone|mobile/i;
const junk = v => !v || EMAIL.test(v) || PHONE.test(v) || /^(yes|no|going|maybe|not going|declined|attending|invited|waitlist|pending|\d{1,2})$/i.test(v) || /^\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/.test(v);
function csvRows(text, d) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && !cell) q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}
function parseBulk(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const tabs = (first.match(/\t/g) || []).length, commas = (first.match(/,/g) || []).length;
  const rows = csvRows(text, tabs && tabs >= commas ? '\t' : ',');
  if (!rows.length) return [];
  const cleanName = n => { n = (n || '').trim(); return !n || EMAIL.test(n) || PHONE.test(n) ? '' : n.slice(0, 24); };
  const out = [], ni = rows[0].findIndex(h => NAMEH.test(h.trim()));
  if (ni >= 0) {
    const cols = rows[0].map((h, i) => ({ i, gp: /guilty/i.test(h), slot: /forever/i.test(h) ? 0 : /\b(16|sixteen)\b/i.test(h) ? 1 : /right ?now|lately|recent/i.test(h) ? 2 : -1 }))
      .filter(c => c.i !== ni && (c.gp || !SKIPH.test(rows[0][c.i].trim())));
    const ans = cols.filter(c => !c.gp);
    if (ans.length === 3 && ans.every(c => c.slot < 0)) ans.forEach((c, k) => { c.slot = k; });
    for (const r of rows.slice(1)) {
      const n = cleanName(r[ni]); if (!n) continue;
      const items = [];
      for (const c of cols) for (const part of (r[c.i] || '').split(c.gp || ans.length !== 1 ? /;|\s\/\s|\n/ : /;|,|\s\/\s|\n/)) {
        const v = part.trim();
        if (!junk(v)) items.push({ typed: v, s: c.slot >= 0 ? c.slot : undefined, secret: c.gp });
      }
      out.push({ n, items: items.filter(x => x.secret).slice(0, 1).concat(items.filter(x => !x.secret).slice(0, 3)) });
    }
    return out;
  }
  for (const r of rows) {
    const toks = r.flatMap(c => c.split(/;|\s\/\s|\t/)).map(x => x.trim()).filter(Boolean);
    if (!toks.length) continue;
    let name = toks[0];
    const m = /^([^:/]{1,24}):\s*(\S.*)$/.exec(name);
    if (m && !/^(https?|spotify)$/i.test(m[1])) { name = m[1]; toks[0] = m[2]; } else toks.shift();
    name = cleanName(name); if (!name) continue;
    const items = toks.filter(v => !junk(v)).slice(0, 3).map(v => ({ typed: v }));
    if (items.length === 3) items.forEach((x, k) => { x.s = k; });
    out.push({ n: name, items });
  }
  return out;
}
const normS = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
async function resolveAnswer(raw) {
  const s = raw.replace(/^\s*(\d{1,2}[.)]|[-•*])\s+/, '').replace(/^["“‘']+|["”’']+$/g, '').trim();
  let q = s, song = false, list;
  if (/^(https?:\/\/|spotify:)/i.test(s)) {
    const r = await M.resolveLink(s);
    if (r && r.picks) return cleanPick(r.picks[0]);
    if (!r || !r.query) return null;
    list = await M.search(r.query);
    if (r.kind === 'track') list.sort((a, b) => (b.k === 't') - (a.k === 't'));
    return cleanPick(list[0]);
  }
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s) || /^(.+?)\s+by\s+(.+)$/i.exec(s);
  if (m) { q = m[1] + ' ' + m[2]; song = true; }
  list = await M.search(q);
  if (!song) return cleanPick(list[0]);
  const nq = normS(q), tr = list.filter(x => x.k === 't');
  return cleanPick(tr.find(t => nq.includes(normS(t.an)) && nq.includes(normS(t.tt))) || tr.find(t => nq.includes(normS(t.an))) || tr[0] || list[0]);
}
async function bulkRead(text) {
  const tok = ++BK.tok;
  BK.people = parseBulk(text).map(p => ({ n: p.n, items: p.items.map(it => ({ ...it, pick: null, done: false })) }));
  if (!BK.people.length) { setText('#b-msg', 'nobody found in that. name first, then songs or artists.'); renderBulk(); return; }
  BK.busy = true; renderBulk();
  let i = 0; const total = BK.people.reduce((a, p) => a + p.items.length, 0);
  for (const p of BK.people) for (const it of p.items) {
    if (tok !== BK.tok) return;
    setText('#b-msg', `looking up ${++i} of ${total}`);
    try { it.pick = await resolveAnswer(it.typed); } catch (e) { it.pick = null; }
    if (it.pick && it.s !== undefined) it.pick.s = it.s;
    it.done = true; renderBulk();
    await sleep(250);
  }
  BK.busy = false;
  setText('#b-msg', 'fix or drop anything red, then add all.');
  renderBulk();
}
function renderBulk() {
  const ul = $('#b-list');
  ul.textContent = '';
  for (const p of BK.people) {
    const pu = el('ul', { class: 'bk-picks' });
    for (const it of p.items) {
      const tag = it.secret ? 'guilty · ' : it.s !== undefined ? SLOTS[it.s].n + ' · ' : '';
      const li = el('li', {},
        el('span', { class: 'ty' }, tag + it.typed),
        el('span', { class: 'mt ' + (!it.done ? '' : it.pick ? 'ok' : 'no') }, !it.done ? 'waiting' : it.pick ? pickLabel(it.pick) : 'no match'),
        BK.busy ? null : el('button', { type: 'button', onclick: () => { it.fixing = !it.fixing; renderBulk(); } }, 'fix'),
        BK.busy ? null : el('button', { type: 'button', onclick: () => { p.items = p.items.filter(x => x !== it); renderBulk(); } }, 'drop'));
      if (it.fixing) {
        const box = el('div', { class: 'picker' });
        li.append(box);
        const pk = picker(box, { max: 1, labels: [{ l: 'search again', h: 'an artist, a song, or a link' }], onChange: () => { const g = pk.get()[0]; if (g) { it.pick = it.s !== undefined ? { ...g, s: it.s } : { ...g, s: undefined }; it.fixing = false; renderBulk(); } } });
      }
      pu.append(li);
    }
    ul.append(el('li', { class: 'bk-p' },
      el('div', { class: 'bk-h' }, el('input', { type: 'text', value: p.n, maxlength: 24, 'aria-label': 'name', readonly: BK.busy, oninput: e => { p.n = e.target.value; } }),
        BK.busy ? null : el('button', { type: 'button', onclick: () => { BK.people = BK.people.filter(x => x !== p); renderBulk(); } }, 'drop')),
      pu));
  }
  $('#b-add').disabled = BK.busy || !BK.people.some(p => p.items.some(i => i.pick && !i.secret));
}
function setupBulk() {
  const close = () => { BK.tok++; BK.busy = false; $('#bulk').classList.add('hide'); };
  $('#join-bulk').addEventListener('click', () => { $('#bulk').classList.remove('hide'); $('#b-text').focus(); });
  $('#b-close').addEventListener('click', close);
  $('#b-read').addEventListener('click', () => { const t = $('#b-text').value; $('#b-text').value = ''; if (t.trim()) bulkRead(t); });
  $('#b-file').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) bulkRead(await f.text()); });
  $('#b-add').addEventListener('click', () => {
    let n = 0; const left = [];
    for (const p of BK.people) {
      const picks = p.items.filter(i => i.pick && !i.secret).map(i => i.pick).slice(0, 3);
      const sec = p.items.find(i => i.secret && i.pick);
      if (picks.length && p.n.trim()) { upsertGuest('h-' + rid(), { n: p.n.trim(), picks, gp: sec && sec.pick }, 'hand'); n++; } else left.push(p);
    }
    BK.people = left; renderBulk();
    setText('#b-msg', `added ${n}.${left.length ? ` ${left.length} with no match are still listed.` : ''}`);
    if (!left.length) setTimeout(close, 900);
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
  const me = { id: '', name: '', picks: [], gp: null };
  const pk = picker($('#g-picks'), { labels: SLOTS, onChange: () => upd() });
  const gpk = picker($('#g-gp'), { max: 1, labels: [GP] });
  const apk = picker($('#g-ask-pick'), { max: 1, labels: [{ l: 'one artist', h: 'an artist, a song, or a link' }], onChange: () => { $('#g-ask-send').disabled = !apk.get().length || !!asked[askId]; } });
  let askId = '';
  const asked = {};
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
    for (const p of me.picks) ul.append(el('li', {}, el('b', {}, p.k === 't' ? p.tt : p.an), el('span', {}, (slotName(p) ? slotName(p) + ' · ' : '') + (p.k === 't' ? `song · ${p.an}` : 'artist'))));
    if (me.gp) ul.append(el('li', {}, el('b', {}, me.gp.k === 't' ? me.gp.tt : me.gp.an), el('span', {}, 'guilty pleasure · only you can see this')));
    render();
  };
  $('#g-send').addEventListener('click', async () => {
    me.name = $('#g-name').value.trim().slice(0, 24);
    me.picks = pk.get(); me.gp = gpk.get()[0] || null;
    await saveMe();
    if (NETg) NETg.guest.set({ id: me.id, n: me.name, picks: me.picks, gp: me.gp, t: Date.now() }).catch(() => {});
    showRoom();
  });
  $('#g-edit').addEventListener('click', () => {
    $('#g-room').classList.add('hide'); $('#g-form').classList.remove('hide');
    $('#g-name').value = me.name; pk.set(me.picks); gpk.set(me.gp ? [me.gp] : []); upd();
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
    const tm = s && s.teams;
    setText('#g-team', tm && tm.m[my] !== undefined ? `you are on ${tm.n[tm.m[my]]}. ${tm.n[0]} ${tm.tot[0]} · ${tm.n[1]} ${tm.tot[1]}` : '');
    const ask = r && r.open && s.ask && s.ask.k.includes(my) ? s.ask : null;
    $('#g-ask').classList.toggle('hide', !ask);
    if (ask) {
      box.classList.add('hide'); res.textContent = '';
      if (askId !== r.id) { askId = r.id; apk.set([]); $('#g-ask-send').disabled = true; setText('#g-ask-msg', ''); }
      setText('#g-ask-q', `name one artist that connects you to ${ask.n[ask.k.indexOf(my) ? 0 : 1]}`);
      return;
    }
    if (!r) { box.classList.add('hide'); res.textContent = ''; return; }
    if (r.open) {
      box.classList.remove('hide');
      res.textContent = ''; res.classList.remove('ok');
      setText('#g-q', r.q);
      let opts = r.opts;
      if (!opts) opts = (s.guests || []).filter(g => !((r.type === 'twin' || r.type === 'guilty') && g.k === my)).map(g => ({ v: g.k, l: g.n }));
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
  $('#g-ask-send').addEventListener('click', () => {
    const p = apk.get()[0];
    if (!p || asked[askId]) return;
    asked[askId] = true;
    if (NETg) NETg.reply.set({ r: askId, pick: p }).catch(() => {});
    $('#g-ask-send').disabled = true;
    setText('#g-ask-msg', 'sent. watch the screen.');
  });
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
  // keep the host's sealed backup; hand it to a host that comes back with less
  const vKey = 'party.vault.' + K.roomId;
  let mine = null, offerT = 0;
  try { mine = JSON.parse(lsGet(vKey) || 'null'); } catch (e) { mine = null; }
  const hold = v => { if (v && v.box && (!mine || v.t > mine.t)) { mine = v; lsSet(vKey, JSON.stringify(v)); } };
  NETg.vault.onChange(hold); hold(NETg.vault.get());
  NETg.keep.onChange((v, ctx) => { if (!ctx.self) hold(v); });
  const offer = n => {
    clearTimeout(offerT);
    if (!n || !mine || !(mine.t > (n.t || 0))) return;
    offerT = setTimeout(() => {
      const others = Object.values(NETg.keep.getAll()).some(o => o && o.t >= mine.t && o.at >= n.at);
      if (!others) NETg.keep.set({ t: mine.t, box: mine.box, at: n.at }).catch(() => {});
    }, 300 + Math.random() * 2500);
  };
  NETg.need.onChange(offer); offer(NETg.need.get());
  if (NETg.show.get()) lastShow = NETg.show.get();
  if (me.name && me.picks.length) NETg.guest.set({ id: me.id, n: me.name, picks: me.picks, gp: me.gp, t: Date.now() }).catch(() => {});
  render();
}

// ---------- go ----------
(async () => {
  K = await gate();
  if (ROLE === 'host') await hostMain(); else await guestMain();
})();
