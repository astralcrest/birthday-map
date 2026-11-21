import * as M from './music.js?v=20261121f';
import * as Gr from './graph.js?v=20261121f';
import { Player } from './audio.js?v=20261121f';
import qrcode from './vendor/qrcode.mjs';
document.documentElement.classList.add('booted');

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
  // phones turn ' into ’ and -- into a dash; fold them so every keyboard lands in the same room
  const norm = pw.normalize('NFKC').replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'").replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-').trim().toLowerCase().replace(/\s+/g, ' ');
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
  { l: 'your forever song', h: "the one you'd keep forever", n: 'forever song' },
  { l: 'your song at 16', h: 'whatever you had on repeat then', n: 'song at 16' },
  { l: 'your right-now artist', h: "who you've played most lately", n: 'right-now artist' },
];
const GP = { l: 'your guilty pleasure', h: 'stays secret until the game', n: 'guilty pleasure' };
const slotName = p => p && p.s !== undefined ? SLOTS[p.s].n : '';
const pickLabel = p => p.k === 't' ? `${p.tt} · ${p.an}` : p.an;

// ---------- gate ----------
// a private start link can carry the guest list after the #, so it never leaves the browser
let AUTOLIST = '';
async function gate() {
  if (DEMO) return derive('demo');
  const frag = new URLSearchParams(location.hash.slice(1));
  const fromLink = frag.get('k');
  try { const l = frag.get('l'); if (l && ROLE === 'host') { AUTOLIST = new TextDecoder().decode(Uint8Array.from(atob(l.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); sessionStorage.setItem('party.list', AUTOLIST); } else if (ROLE === 'host') AUTOLIST = sessionStorage.getItem('party.list') || ''; } catch (e) { /* unreadable list */ }
  if (fromLink || frag.get('l')) history.replaceState(null, '', location.pathname + location.search);
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
function picker(root, { max = 3, onChange = () => {}, labels = null, q0 = '' } = {}) {
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
        const inp = el('input', { type: 'text', placeholder: labels ? labels[i].h : i === 0 ? 'artist, song or link' : 'another one (optional)', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': `pick ${i + 1}` });
        // keep the results above the phone keyboard
        inp.addEventListener('focus', () => { if (innerWidth < 700) { document.body.classList.add('typing'); setTimeout(() => slot.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); } });
        inp.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') document.body.classList.remove('typing'); }, 200));
        const res = el('ul', { class: 'res' });
        const run = async () => {
          const q = inp.value.trim();
          if (q.length < 2) { res.textContent = ''; return; }
          res.textContent = '';
          res.append(el('li', {}, el('p', { class: 'msg' }, 'looking')));
          let list = [], note = '';
          if (/(https?:\/\/|spotify:)/i.test(q)) {
            const r = await M.resolveLink(q);
            if (r && r.refuse) note = r.refuse;
            else if (r && r.picks) list = r.picks;
            else if (r && r.query) { note = `from your ${r.from} link: ${r.query}`; list = await M.search(r.query); if (r.kind === 'track') list.sort((a, b) => (b.k === 't') - (a.k === 't')); }
            else note = 'could not read that link. try typing the name.';
          } else {
            const qx = expand(q), f0 = M.stats.fails;
            const m = /^(.+?)\s+(?:-|–|—|by)\s+(.+)$/i.exec(qx);
            const [l, sg] = await Promise.all([M.search(qx), m ? M.findSong(m[1], m[2]).then(r => r && r.how === 'song' ? r : M.findSong(m[2], m[1])) : null]);
            list = sg && sg.how === 'song' ? [sg.pick, ...l.filter(x => !(x.k === 't' && x.tid === sg.pick.tid))] : l;
            if (!list.length && M.stats.busy && Date.now() - M.stats.busy < 8000) note = 'the music service is busy. trying again…';
            else if (!list.length && M.stats.fails > f0) note = 'the music search is not answering. check the wifi and try again. you can still play along without picks.';
            if (note) { await new Promise(r => setTimeout(r, 2500)); if (inp.value.trim() === q) { list = await M.search(qx); if (list.length) note = ''; } }
          }
          if (inp.value.trim() !== q) return;
          res.textContent = '';
          if (note) res.append(el('li', {}, el('p', { class: 'msg' }, note)));
          if (!list.length && !note) res.append(el('li', {}, el('p', { class: 'msg' }, 'nothing found. try fewer words.')));
          else if (!note && list.filter(x => x.k === 't' && M.norm(x.tt) === M.norm(q)).length >= 2) res.append(el('li', {}, el('p', { class: 'msg' }, 'more than one song has this name. not here? add the artist.')));
          for (const r of list) {
            res.append(el('li', {}, el('button', { type: 'button', onclick: () => { picks[i] = cleanPick(r); if (labels) picks[i].s = i; render(); onChange(); const n = root.querySelector('input'); if (n) n.focus(); } },
              el('span', { class: 'kd' }, r.k === 't' ? 'song' : 'artist'),
              el('span', { class: 'tx' }, el('b', {}, r.k === 't' ? r.tt : r.an), r.k === 't' ? el('span', {}, r.an) : null))));
          }
        };
        inp.addEventListener('input', () => { clearTimeout(timers[i]); timers[i] = setTimeout(run, 420); });
        if (q0) { inp.value = q0; q0 = ''; setTimeout(run, 0); }
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
// the flagged guest shows as "the birthday baby" everywhere; unflagging gives the old name back
const HOSTN = 'the birthday baby';
function setHost(k) {
  const old = H.hostKey && H.guests.get(H.hostKey);
  if (old && old.n0) { old.n = old.n0; delete old.n0; }
  H.hostKey = k;
  const g = k && H.guests.get(k);
  if (g && g.n !== HOSTN) { g.n0 = g.n; g.n = HOSTN; }
  H.gv++; saveSoon(); dataChanged(); renderBoard();
}

// ---- persistence: sealed with the room key, never plain ----
let saveT = 0, savedAt = 0;
function saveSoon() {
  if (DEMO) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    savedAt = Date.now();
    const box = await seal(K.key, { t: savedAt, guests: [...H.guests.values()], scores: H.scores, hostKey: H.hostKey, played: H.played, teams: H.teams, set: { v: SETV, n: SETN, pos: setPos, last: setLast }, at: mode });
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
const oldHost = g => { if (g && g.n === 'the host') g.n = HOSTN; return g; };
async function adopt(v) {
  if (!v || !v.box || !(v.t > savedAt)) return;
  let d;
  try { d = await unseal(K.key, v.box); } catch (e) { return; }
  if (!(v.t > savedAt)) return;
  for (const g of d.guests || []) if (g && g.k && !H.guests.has(g.k)) H.guests.set(g.k, oldHost(g));
  H.scores = Object.assign({}, d.scores || {}, H.scores);
  for (const k in d.scores || {}) H.scores[k] = Math.max(H.scores[k] || 0, d.scores[k] || 0);
  if (!H.hostKey) H.hostKey = d.hostKey || null;
  if (!H.played.length) H.played = d.played || [];
  if (!H.teams && d.teams) H.teams = d.teams;
  if (!SETN.some(Boolean)) { setRestore(d.set); nextUp(); }
  H.gv++;
  setText('#join-msg', `picked the room back up from a phone. ${guestList().length} people.`);
  saveSoon(); dataChanged(); renderBoard(); publish();
}
async function restore() {
  const raw = lsGet('party.room.' + K.roomId);
  if (!raw) return;
  try {
    const d = await unseal(K.key, JSON.parse(raw));
    for (const g of d.guests || []) H.guests.set(g.k, oldHost(g));
    H.scores = d.scores || {}; H.hostKey = d.hostKey || null; H.played = d.played || []; H.teams = d.teams || null;
    setRestore(d.set);
    savedAt = d.t || 1;
    // a reload mid-game lands back on the same screen; the open round itself starts fresh
    if (d.at && MODES[d.at] && Date.now() - savedAt < 30 * 60e3) resumeAt = d.at;
  } catch (e) { /* a different password wrote this: ignore */ }
}
let resumeAt = null;
function upsertGuest(k, v, src) {
  if (!v || !v.n) return;
  let picks = (v.picks || []).map(cleanPick).filter(Boolean).slice(0, 3);
  let prev = H.guests.get(k);
  let n = String(v.n).slice(0, 24).trim() || 'guest';
  const fresh = src === 'p2p' && (!prev || prev.src !== 'p2p');
  if (fresh) {
    // someone from the pasted list picking up their phone is the same person, not a second dot
    const low = n.toLowerCase();
    const c = (v.claim && H.guests.get(v.claim)) || [...H.guests.values()].find(g => g.src === 'hand' && g.k !== H.hostKey && g.n.toLowerCase() === low);
    if (c && c.src === 'hand' && c.k !== k) {
      H.guests.delete(c.k);
      if (H.scores[c.k]) { H.scores[k] = (H.scores[k] || 0) + H.scores[c.k]; delete H.scores[c.k]; }
      if (pos.has(c.k)) pos.set(k, pos.get(c.k));
      if (H.hostKey === c.k) H.hostKey = k;
      prev = { ...c, k };
      n = c.n;
    }
  }
  // a phone that sends no picks never wipes the ones already on the map
  if (!picks.length && prev && prev.picks && prev.picks.length) picks = prev.picks;
  if (prev && prev.n.toLowerCase() === n.toLowerCase()) n = prev.n;
  if (k === H.hostKey) n = HOSTN;
  const taken = new Set([...H.guests.values()].filter(g => g.k !== k).map(g => g.n.toLowerCase()));
  if (taken.has(n.toLowerCase())) {
    if (prev && prev.n.toLowerCase().startsWith(n.toLowerCase() + ' ') && !taken.has(prev.n.toLowerCase())) n = prev.n;
    else { let i = 2; while (taken.has(`${n.slice(0, 21)} ${i}`.toLowerCase())) i++; n = `${n.slice(0, 21)} ${i}`; }
  }
  H.guests.set(k, { k, n, picks, gp: v.gp ? cleanPick(v.gp) : prev ? prev.gp || null : null, src, t: prev ? prev.t : Date.now() });
  H.gv++;
  if (fresh) {
    JOINS.push({ k, n, t: performance.now() }); joinCalm();
    if (picks.length) flyIn(k);
    if (!$('#bigjoin').classList.contains('hide')) chime(JOINS.length);
  }
  saveSoon(); dataChanged();
  bigJoinText();
}
// while phones are arriving, the screen and the background lookups go easy
const JOINS = [];
let calmUntil = 0;
function joinCalm() { calmUntil = performance.now() + 30000; M.calm(30000); }
function frameGap() {
  if (!$('#bigjoin').classList.contains('hide')) return 250;
  return performance.now() < calmUntil && mode === 'cloud' ? 33 : 0;
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
  // the wildcard is whoever sits furthest out, never the birthday baby
  const hi = DV.idx.get(H.hostKey), fm = DV.facts.mean;
  if (fm && hi !== undefined && DV.facts.outlier === hi && list.length >= 3) { let o = -1; fm.forEach((m, i) => { if (i !== hi && (o < 0 || m > fm[o])) o = i; }); DV.facts.outlier = o; }
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
  const n = xy.length, min = n > 20 ? .13 : n > 14 ? .2 : .3;
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
    bdayPrepSoon();
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
      hw: HOW[mode] ? [MODES[mode].title, ...HOW[mode]] : null, hs: SCI[mode] || null,
      guests: list.map(g => ({ k: g.k, n: g.n })),
      // everyone, with or without picks: a phone finds its own name here, or claims one from the pasted list
      roster: [...H.guests.values()].map(g => ({ k: g.k, n: g.n, h: g.src === 'hand' && g.k !== H.hostKey ? 1 : 0, p: g.picks.map(pickLabel) })),
      scores: H.scores,
      round: RD ? { id: RD.id, type: RD.type, open: RD.open, q: RD.q, opts: RD.opts || null, res: RD.res || null } : null,
      ask: RD && RD.open && RD.ask ? RD.ask : null,
      teams: H.teams ? { n: H.teams.n, m: teamMap(), tot: teamTotals() } : null,
      keep: keepsakes(),
      // the finale on the phones: the award the screen shows, and the playlist in the screen's order
      aw: mode === 'awards' ? AW.pub : null,
      pl: mode === 'list' && tourItems.length ? tourItems.map(it => it.p.k === 't' ? [it.p.tt, it.p.an, it.p.tid || 0] : [it.p.an]) : null,
    };
    NET.show.set(s).catch(() => {});
  }, 120);
}
// end of the night: every phone gets its own card. anything missing is left off the card
const KEEPM = new Set(['toast', 'photo', 'list']);
function keepsakes() {
  try {
    if (!(KEEPM.has(mode) || (mode === 'bday' && BD.final))) return null;
    const L = DV.list, f = DV.facts || {}, hi = DV.idx.has(H.hostKey) ? DV.idx.get(H.hostKey) : -1;
    const rows = BD.rows && BD.rows.length ? BD.rows : BDP.rows || [];
    const hops = new Map(rows.map(r => [r.g.k, r.hops]));
    const pts = Object.values(H.scores).filter(v => v > 0);
    const xy = L.map(g => (pos.get(g.k) || [0, 0]).map(v => Math.round(v * 1000) / 1000));
    const c = {};
    const taken = new Set(L.flatMap(g => g.picks.map(p => +p.aid)));
    for (const g of H.guests.values()) {
      if (g.src !== 'p2p') continue;
      const i = DV.idx.has(g.k) ? DV.idx.get(g.k) : -1, pt = H.scores[g.k] || 0;
      const o = { n: g.k === H.hostKey ? 'the birthday baby' : g.n, i, pt, rk: pt > 0 ? 1 + pts.filter(v => v > pt).length : 0 };
      if (g.k === H.hostKey) { const reach = rows.filter(r => r.hops != null).length; if (reach) o.home = reach; }
      else {
        if (i >= 0 && L.length >= 3) { const tj = twinsOf(i).slice(0, 2); if (tj.length) { o.tj = tj; o.tw = andList(tj.map(j => L[j].k === H.hostKey ? 'the birthday baby' : L[j].n)); } }
        if (hops.get(g.k) != null) o.hp = hops.get(g.k);
        if (i >= 0 && i === f.center) o.sp = 'the middle of the room';
        else if (i >= 0 && i === f.outlier) o.sp = 'the wildcard';
      }
      // the goodie bag: a song from the nearest person, and one neighbor nobody brought
      if (i >= 0 && L.length >= 2) {
        let j = twinsOf(i)[0];
        if (j == null) { let m = Infinity; DV.D[i].forEach((d, q) => { if (q !== i && d < m) { m = d; j = q; } }); }
        const tg = j != null && L[j];
        const gp = tg && (tg.picks.find(p => p.tid) || tg.picks[0]);
        if (gp) o.gf = [gp.tid ? gp.tt : gp.an, gp.tid ? gp.an : '', gp.tid || 0, tg.k === H.hostKey ? 'the birthday baby' : tg.n];
        for (const p of g.picks) {
          const nb = (M.mem.rel[p.aid] || []).find(a => !taken.has(+a) && M.artistName(a));
          if (nb) { o.nw = [M.artistName(nb), p.an]; break; }
        }
      }
      // no picks, still a bag: a song from the middle of the room, and the artist that links the most of it
      if (i < 0 && L.length) {
        const cg = L[f.center >= 0 ? f.center : 0], gp = cg && (cg.picks.find(p => p.tid) || cg.picks[0]);
        if (gp) o.gf = [gp.tid ? gp.tt : gp.an, gp.tid ? gp.an : '', gp.tid || 0, cg.k === H.hostKey ? 'the birthday baby' : cg.n];
        if (f.bridge && M.artistName(f.bridge)) o.nw = [M.artistName(f.bridge), ''];
      }
      c[g.k] = o;
    }
    return { xy, h: hi, c };
  } catch (e) { return null; }
}
function openRound(type, q, opts, truth) {
  RD = { id: rid(), type, q, opts, open: true, votes: new Map(), vt: new Map(), res: null, t0: performance.now(), truth, s0: { ...H.scores } };
  publish();
  if (DEMO) fakeVotes(RD);
  renderBoard();
  return RD;
}
function closeRound(res) {
  if (!RD) return;
  RD.open = false; RD.res = res; RD.tc = performance.now();
  publish(); renderBoard(); saveSoon();
}
function addPoints(keys, n = 1) {
  for (const k of keys) H.scores[k] = (H.scores[k] || 0) + n;
}
function onVote(v, ctx) {
  if (!RD || !RD.open || !v || v.r !== RD.id) return;
  RD.votes.set(who(ctx), v.v); RD.vt.set(who(ctx), performance.now() - RD.t0);
  hopRefresh();
}
const phonesNow = () => [...H.guests.values()].filter(g => g.src === 'demo' || (g.src === 'p2p' && H.online.has(g.k))).length;
const allIn = rd => { const n = phonesNow(); return n > 0 && rd.votes.size >= n; };
function roundLine() {
  if (!RD) return '';
  const phones = phonesNow();
  if (!RD.open) return '';
  return phones || RD.votes.size ? `${RD.votes.size} of ${Math.max(phones, RD.votes.size)} in` : 'no phones yet. call it out loud.';
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
      hopRefresh();
    }, 1500 + Math.random() * 9000);
  });
}

// ---------- host: start ----------
// the start link's list is read once per room; a reload or a second open never doubles anyone
async function autoList() {
  if (H.guests.size) return;
  if (!AUTOLIST) { try { const r = await fetch('guests.json', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); for (const box of Array.isArray(j) ? j : [j]) { try { AUTOLIST = (await unseal(K.key, box)).list || ''; break; } catch (e) { /* not this one */ } } } } catch (e) { /* another password, or no list */ } }
  if (!AUTOLIST || H.guests.size) return;
  bulkRead(AUTOLIST).then(() => {
    if (H.guests.size || !BK.people.some(p => p.items.some(i => i.pick && i.s !== 'gp'))) { if (!H.guests.size) $('#bulk').classList.remove('hide'); return; }
    BK.add();
  }).catch(() => { $('#bulk').classList.remove('hide'); });
}
async function hostMain() {
  $('#host').classList.remove('hide');
  setText('#room-tag', DEMO ? 'demo' : 'room ' + K.code);
  player = new Player();
  player.levelOf = M.gainOf;
  window.__party = { player, H, DV, save: saveSoon, M, Gr, get mode() { return mode; }, get RD() { return RD; }, get WK() { return WK; }, get OD() { return OD; }, get ST() { return ST; }, get BD() { return BD; }, get BDP() { return BDP; }, get AW() { return AW; }, get FLY() { return FLY; }, get X() { return { NT, MT, BR, DC, TM }; }, enterMode: m => enterMode(m), go: () => GO[mode] && GO[mode](), savePoster: () => savePoster() };
  if (DEMO) await loadDemo();
  else {
    await restore();
    // the demo's neighborhood doubles as a warm start for common artists
    fetch('seed.json?v=20261121f').then(r => r.ok ? r.json() : null).then(d => { if (d) { M.seed(d); dataChanged(); } }).catch(() => {});
  }
  setupStage();
  setupNav();
  setupJoin();
  setupHand();
  setupBulk();
  setupModes();
  autoList();
  $('#sound').classList.remove('hide');
  const soundOn = async () => {
    if (!(await player.unlock())) { setText('#sound-go', 'tap again for sound'); return; }
    $('#sound').classList.add('hide');
    enterMode(mode, true);
    wakeLock();
  };
  $('#sound-go').addEventListener('click', soundOn);
  document.addEventListener('keydown', e => {
    if ($('#sound').classList.contains('hide') || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    soundOn();
    if (wide()) document.documentElement.requestFullscreen().catch(() => {});
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });
  dataChanged();
  setInterval(footStats, 1000);
  if (!DEMO) startNet();
  else setText('#net-tag', 'nothing is sent');
  // an empty room on a TV shows the big code; the list panel is one key away
  if (!DEMO && !guestList().length && !wide()) toggleJoin(true);
  const start = Q.get('mode');
  if (start && MODES[start]) enterMode(start);
  else enterMode(resumeAt || 'cloud');
}

// the TV must not sleep through a ten-minute jukebox
let wakeL = null;
async function wakeLock() {
  try { if (!wakeL || wakeL.released) wakeL = await navigator.wakeLock.request('screen'); } catch (e) { /* not offered: caffeinate covers it */ }
}
async function startNet() {
  setText('#net-tag', 'connecting');
  if (typeof RTCPeerConnection !== 'function') { setText('#net-tag', 'offline: add people by hand'); return; }
  try {
    const { openRoom } = await import('./sync.js?v=20261121f');
    NET = await openRoom(K.norm, K.roomId);
  } catch (e) {
    setText('#net-tag', 'offline: add people by hand');
    return;
  }
  const t0 = Date.now(), failed = new Map();
  if (NET.onNetError) NET.onNetError(e => { if (e && e.code === 'peer-connect-failed') { failed.set(e.peerId || 'x', Date.now()); setTimeout(refreshOnline, 50); } });
  const refreshOnline = () => {
    const users = NET.room.getUsers();
    H.online = new Set(Object.keys(users).map(u => H.peer.get(u) || u));
    const n = H.online.size;
    const up = NET.relaysUp ? NET.relaysUp() : 1;
    const bad = !navigator.onLine ? 'wifi down · the games still run' : !up && Date.now() - t0 > 8000 && !n ? 'relays down · paste a list or add people by hand' : '';
    const fails = [...failed.values()].filter(t => Date.now() - t < 90000).length;
    const ft = fails ? ` · ${fails} phone${fails === 1 ? '' : 's'} couldn't connect: add by hand` : '';
    setText('#net-tag', bad || (n ? `live · ${n} phone${n === 1 ? '' : 's'}` : 'live · waiting for phones') + ft);
    $('#net-tag').classList.toggle('ok', !bad);
    $('#net-tag').classList.toggle('bad', !!bad);
    renderJoin();
  };
  setInterval(refreshOnline, 15000);
  setTimeout(refreshOnline, 9000);
  addEventListener('online', refreshOnline); addEventListener('offline', refreshOnline);
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
  const [people, seed] = await Promise.all([fetch('demo.json').then(r => r.json()), fetch('seed.json?v=20261121f').then(r => r.ok ? r.json() : null).catch(() => null)]);
  if (seed) M.seed(seed);
  const n = clamp(parseInt(Q.get('demo'), 10) || 14, 2, people.length);
  const byName = new Map(Object.entries(seed && seed.art || {}).map(([id, v]) => [String(v[0]).toLowerCase(), [+id, v[0]]]));
  const sk = [...new Set(people.flatMap(p => p[1]).map(s => byName.get(s.slice(2).split('|').pop().toLowerCase())).filter(Boolean))];
  people.slice(0, n).forEach(([name, specs], i) => {
    const picks = specs.map(s => byName.get(s.slice(2).split('|').pop().toLowerCase())).filter(Boolean).map((p, j) => cleanPick({ k: 'a', aid: p[0], an: p[1], s: j }));
    const k = 'demo-' + i;
    const gs = i % 3 === 2 || !sk.length ? null : { k: 'a', aid: sk[(i * 11 + 5) % sk.length][0], an: sk[(i * 11 + 5) % sk.length][1] };
    H.guests.set(k, { k, n: name, picks, gp: gs ? cleanPick(gs) : null, src: 'demo', t: i });
  });
  H.hostKey = 'demo-0';
  const hg = H.guests.get('demo-0');
  if (hg) { hg.n0 = hg.n; hg.n = HOSTN; }
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
  // the points panel sits under the mode buttons however many rows they wrap to
  const md = $('#modes'), bd = $('#board');
  if (md && bd) new ResizeObserver(() => { for (const e of [bd, $('#p-photo'), $('#p-list')]) e.style.top = innerWidth > 860 ? (md.offsetTop + md.offsetHeight + 16) + 'px' : ''; }).observe(md);
  buildGrid();
  c.addEventListener('mousemove', onStageMove);
  c.addEventListener('mouseleave', () => setText('#pairs-hover', ''));
  requestAnimationFrame(frame);
}
const wide = () => W > 860 && window.innerWidth > 860;
function joinW() { return wide() && !$('#join').classList.contains('hide') ? $('#join').offsetWidth : 0; }
// 5% of the width: TVs that overscan cut the outer band
function pad() { return wide() ? Math.max(52, W * .05) : 16; }
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
function fontPx(base) { return Math.round(clamp(base * Math.min(W / 1920, Hh / 1080) * (wide() ? 1 : 1.5), base * .62, base * 2.1)); }

let lastT = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const gap = frameGap();
  if (gap && t - lastT < gap - 4) return;
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
  for (let i = 0; i < n && !opts.lit && !opts.noLinks; i++) {
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
  const fs = opts.fs || fontPx(26);
  c.font = `500 ${fs}px "Instrument Sans", system-ui, sans-serif`;
  c.textBaseline = 'middle';
  const xmax = opts.rect && !opts.poster ? freeBox().x1 : W - 4;
  // a name keeps clear of every dot and its rings, not just the dot
  const ringR = i => opts.lit && opts.lit.has(list[i].k) ? 19 : opts.lit || opts.off ? 12 : i === f.center ? 27 : i === f.outlier || list[i].k === H.hostKey ? 17 : 12;
  const boxes = P.map(([x, y], i) => { const r = ringR(i); return [x - r, y - r, r * 2, r * 2]; });
  const main = !opts.rect && !opts.poster && !opts.off && mode === 'cloud', flying = main && FLY.cur ? FLY.cur.k : null;
  const waiting = main && FLY.q.length ? new Set(FLY.q.map(f => f.k)) : null;
  const jobs = [];
  list.forEach((g, i) => {
    const [x, y] = P[i];
    const dim = opts.lit && !opts.lit.has(g.k), tint = opts.tint ? opts.tint(g) : null;
    const playing = cloudNow && cloudNow.k === g.k && songRound > 0 && !dim;
    c.globalAlpha = dim ? .3 : 1;
    if (opts.lit && !dim) { c.strokeStyle = COL.mint; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 16 + Math.sin(t * 2) * 1.5, 0, 6.2832); c.stroke(); }
    if (opts.lit || opts.off) { /* no rings on a focused map */ } else if (i === f.center) {
      c.strokeStyle = COL.mint; c.lineWidth = 1.25;
      for (const r of [15, 25]) { c.beginPath(); c.arc(x, y, r + Math.sin(t * 1.3) * 1.5, 0, 6.2832); c.stroke(); }
    }
    if (!opts.lit && !opts.off && i === f.outlier) { c.strokeStyle = COL.ice; c.lineWidth = 1.25; c.setLineDash([3, 4]); c.beginPath(); c.arc(x, y, 15, 0, 6.2832); c.stroke(); c.setLineDash([]); }
    if (!opts.lit && !opts.off && g.k === H.hostKey && i !== f.center) { c.strokeStyle = COL.mint; c.lineWidth = 1.25; c.beginPath(); c.arc(x, y, 15 + Math.sin(t * 1.3) * 1.5, 0, 6.2832); c.stroke(); }
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
    c.globalAlpha = 1;
    const label = opts.nameOf ? opts.nameOf(g) : g.k === H.hostKey ? HOSTN : g.n;
    if (!label) return;
    // a dimmed name stays readable from the couch: grey, not faded
    jobs.push({ g, i, x, y, label, col: dim ? COL.faint : tint || (opts.lit ? COL.mint : i === f.outlier ? COL.ice : i === f.center || g.k === H.hostKey ? COL.mint : playing ? COL.mint : COL.ink), pr: opts.lit && !dim ? 0 : g.k === H.hostKey || i === f.center ? 1 : 2 });
  });
  // names go on after every dot, the ones that matter first: right, left, above, below, then one step further out
  jobs.sort((a, b) => a.pr - b.pr || a.i - b.i);
  // a name over a dot still reads; a name over a name does not
  const hit = b => { let o = 0; boxes.forEach((q, j) => { o += Math.max(0, Math.min(b[0] + b[2], q[0] + q[2]) - Math.max(b[0], q[0])) * Math.max(0, Math.min(b[1] + b[3], q[1] + q[3]) - Math.max(b[1], q[1])) * (j >= n ? 4 : 1); }); return o; };
  const lk = opts.poster ? 'poster' : mode;
  for (const { g, i, x, y, label, col } of jobs) {
    const w = c.measureText(label).width, h = fs;
    const gap = !opts.lit && !opts.off && (i === f.center || i === f.outlier || g.k === H.hostKey) ? 30 : 20;
    const cand = [];
    for (const s of [1, 1.9, 2.8]) {
      const gp = gap * s, dg = gp * .75;
      cand.push([x + gp, y], [x - gp - w, y], [x - w / 2, y - gp - h / 2], [x - w / 2, y + gp + h / 2], [x + dg, y - dg - h / 2], [x + dg, y + dg + h / 2], [x - dg - w, y - dg - h / 2], [x - dg - w, y + dg + h / 2]);
    }
    const raw = cd => { const b = [cd[0], cd[1] - h / 2, w, h]; return hit(b) + (b[0] < 4 || b[0] + w > xmax ? 1e6 : 0); };
    // the spot it had last frame holds while it stays nearly clear, so names do not hop as the dots breathe
    const was = LBC.get(g.k), wj = was && was[0] === lk ? was[1] : -1;
    let bj = 0, bo = Infinity;
    if (wj >= 0 && wj < cand.length && raw(cand[wj]) <= w * h * .1) bj = wj;
    else for (let j = 0; j < cand.length; j++) { const o = raw(cand[j]) + (j >= 16 ? w * h * .2 : j >= 8 ? w * h * .08 : 0); if (o < bo) { bo = o; bj = j; } if (o === 0) break; }
    LBC.set(g.k, [lk, bj]);
    const best = cand[bj];
    boxes.push([best[0], best[1] - h / 2, w, h]);
    if (main) LBL.set(g.k, best);
    if (g.k === flying || (waiting && waiting.has(g.k))) continue;
    if (bj >= 8) {
      const ex = clamp(x, best[0], best[0] + w), ey = clamp(y, best[1] - h / 2, best[1] + h / 2), d = Math.hypot(ex - x, ey - y);
      if (d > 12) { c.strokeStyle = alpha(COL.ice, .45); c.lineWidth = 1; c.beginPath(); c.moveTo(x + (ex - x) * 9 / d, y + (ey - y) * 9 / d); c.lineTo(ex, ey); c.stroke(); }
    }
    c.fillStyle = col;
    c.textAlign = 'left';
    c.fillText(label, best[0], best[1]);
  }
  if (main) drawFly(c, t, P, R, fs);
  return P;
}
// a phone joins: its name flies onto the map and lands on its dot, with one soft note
const FLY = { q: [], cur: null, n: 0 }, LBL = new Map(), LBC = new Map();
function flyIn(k) { if (FLY.q.length < 8 && !FLY.q.some(f => f.k === k)) FLY.q.push({ k, at: performance.now() }); }
function drawFly(c, t, P, R, fs1) {
  if (!FLY.cur) {
    if (!FLY.q.length || !$('#bigjoin').classList.contains('hide') || !$('#lobby').classList.contains('hide')) return;
    const now = performance.now();
    FLY.q = FLY.q.filter(f => now - f.at < 20000);
    // wait until the new dot has drifted to its place, so the name lands where it will stay
    const nx = FLY.q.find(f => { const i = DV.idx.get(f.k), p = pos.get(f.k), q = DV.xy[i]; return i != null && p && q && LBL.has(f.k) && Math.hypot(p[0] - q[0], p[1] - q[1]) < .04; });
    if (!nx) return;
    FLY.q.splice(FLY.q.indexOf(nx), 1);
    FLY.cur = { k: nx.k, t0: t, sp: FLY.q.length ? .6 : 1, rang: false };
  }
  const f = FLY.cur, i = DV.idx.get(f.k), g = H.guests.get(f.k), lb = LBL.get(f.k), e = (t - f.t0) / f.sp;
  if (i == null || !P[i] || !g || !lb || e > 4.4 || e < 0) { FLY.cur = null; return; }
  const [x, y] = P[i], u = clamp((e - .5) / 1.2, 0, 1), ease = u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  if (u >= 1 && !f.rang) { f.rang = true; chime(FLY.n++); }
  c.strokeStyle = COL.mint; c.lineWidth = 1.5;
  for (let k = 0; k < 2; k++) {
    const ph = (e - 1.7 - k * .4) / 1.4;
    if (ph <= 0 || ph >= 1) continue;
    c.globalAlpha = 1 - ph; c.beginPath(); c.arc(x, y, 10 + ph * 80, 0, 6.2832); c.stroke();
  }
  const label = g.k === H.hostKey ? HOSTN : g.n, fs0 = Math.max(fs1 * 3, fontPx(84)), size = fs0 + (fs1 - fs0) * ease;
  c.font = `600 ${fs0}px "Instrument Sans", system-ui, sans-serif`;
  const w0 = c.measureText(label).width;
  const sx = clamp(R.x + R.w / 2 - w0 / 2, 8, Math.max(8, W - w0 - 8)), sy = Math.min(Hh - fs0 * .7, R.y + R.h + fs0 * .2);
  const lx = sx + (lb[0] - sx) * ease, ly = sy + (lb[1] - sy) * ease;
  c.globalAlpha = clamp(e / .25, 0, 1);
  c.font = `${u < 1 ? 600 : 500} ${size}px "Instrument Sans", system-ui, sans-serif`;
  c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillStyle = COL.mint;
  c.fillText(label, lx, ly);
  const p = g.picks.find(q => q.s === 0) || g.picks[0];
  if (p && e > 1.8) {
    c.globalAlpha = clamp((e - 1.8) / .3, 0, 1) * clamp((4.4 - e) / .5, 0, 1);
    c.font = `400 ${fontPx(18)}px "IBM Plex Mono", ui-monospace, monospace`;
    c.fillStyle = COL.dim;
    const sub = 'brought ' + (p.k === 't' ? p.tt : p.an), sw = c.measureText(sub).width;
    c.fillText(sub, clamp(lb[0], 8, Math.max(8, W - sw - 8)), lb[1] + fs1 * .95);
  }
  c.globalAlpha = 1;
}
// D minor pentatonic, one note per arrival, quiet under whatever is playing
const CHIME = [587.33, 698.46, 783.99, 880, 1046.5];
let chimeAt = 0;
function chime(n) {
  if (!player || !player.ready || player.muted || performance.now() - chimeAt < 350) return;
  chimeAt = performance.now();
  try {
    const x = player.ctx, t = x.currentTime, o = x.createOscillator(), g = x.createGain();
    o.type = 'sine'; o.frequency.value = CHIME[n % CHIME.length];
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.07, t + .012); g.gain.exponentialRampToValueAtTime(.0004, t + 1.4);
    o.connect(g); g.connect(player.master); o.start(t); o.stop(t + 1.5);
  } catch (e) { /* no note, no harm */ }
}
function curve(c, a, b, bow) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  c.beginPath(); c.moveTo(a[0], a[1]);
  c.quadraticCurveTo(mx - dy * bow, my + dx * bow, b[0], b[1]);
  c.stroke();
}

// cloud jukebox: one pick after another, the owner's point rings
let cloudNow = null, cloudTok = 0, cloudMiss = 0;
const JUKE = new Set(['cloud', 'pairs', 'twin', 'awards', 'photo']);
async function cloudShuffle() {
  const my = ++cloudTok;
  const pool = shuffle(DV.list.flatMap(g => g.picks.map(p => ({ k: g.k, p }))));
  for (const item of pool) {
    if (my !== cloudTok || !JUKE.has(mode) || !player.ready) return;
    const pv = await M.previewFor(item.p);
    if (my !== cloudTok || !JUKE.has(mode)) return;
    if (!pv) { if (++cloudMiss >= 3) setText('#cloud-now', 'the music service is not answering. check the wifi.'); continue; }
    cloudNow = item;
    const ok = await player.play(pv.url);
    if (!ok) continue;
    cloudMiss = 0;
    $('#cloud-now').innerHTML = '';
    $('#cloud-now').append('now: ', el('b', {}, pv.an), ` · ${pv.tt}${songRound > 0 ? ` · ${nameOf(item.k)}'s pick` : ''}`);
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
    // option names hang about 170px outside the ring, so the ring stays clear of the points list
    // on short screens the footer wraps to two lines and the board runs long: the trail stays clear of both
    const fr = $('#foot').getBoundingClientRect(), ft = fr.height ? fr.top : Hh, bd = $('#board'), bb = bd.offsetHeight ? bd.getBoundingClientRect() : null;
    const b = freeBox(), y = Math.min(Hh * .86, ft - 50 - Hh * .025);
    let tx1 = W - jw - p - 30;
    if (bb && bb.bottom > y - 50) tx1 = Math.min(tx1, bb.left - 40);
    let R = clamp(Math.min(Hh * .25, (b.x1 - b.x0) / 2 - 170), 120, 300);
    // the steer names above the ring stay under the mode buttons, which wrap to four rows on small screens
    const md = $('#modes'), top = md.offsetTop + md.offsetHeight + 12, need = 83 + fontPx(20) * 1.5;
    let cy = Math.max(Hh * .45, top + R + need);
    if (cy + R + 90 > y) { R = Math.max(80, (y - 90 - top - need) / 2); cy = top + R + need; }
    // a long answer in the words column would sit on the first stop's label: the trail starts past the column instead
    const cr = $('#col').getBoundingClientRect(), x0 = cr.height && cr.bottom > y - 30 - fontPx(19) * 1.4 ? Math.max(p + 30, Math.min(cr.right + 30, tx1 - 400)) : p + 30;
    return { cx: (b.x0 + b.x1) / 2, cy, R, x0, x1: tx1, y, amp: Hh * .025 };
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
  // the room's three choices sit spread over the top of the ring, each name above its letter
  const opts = WK.opts || [];
  opts.forEach((o, i) => {
    const a = -Math.PI / 2 + (i - (opts.length - 1) / 2) * .62;
    const x = clamp(cx + Math.cos(a) * R3, 18, W - 18), y = cy + Math.sin(a) * R3;
    c.strokeStyle = COL.ice; c.lineWidth = 1.25;
    c.beginPath(); c.arc(x, y, 13, 0, 6.2832); c.stroke();
    c.font = `500 ${fontPx(20)}px "IBM Plex Mono", monospace`; c.fillStyle = COL.ice;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(o.c, x, y + 1);
    if (wide()) c.fillText(o.l, x, y - 13 - fontPx(20) * .9);
  });
  const optSet = new Set(opts.map(o => o.v));
  nb.filter(v => !optSet.has(v)).forEach((v, k, arr) => {
    const a = k / arr.length * 6.2832 - Math.PI / 2 + .2;
    const x = cx + Math.cos(a) * R3, y = cy + Math.sin(a) * R3;
    const isNext = v === next;
    c.fillStyle = isNext ? COL.mint : alpha(COL.ice, .55);
    c.beginPath(); c.arc(x, y, isNext ? 4 : 2.2, 0, 6.2832); c.fill();
    if (isNext && wide()) {
      c.strokeStyle = alpha(COL.mint, .7); c.lineWidth = 1;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R2 + 36), cy + Math.sin(a) * (R2 + 36)); c.lineTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7); c.stroke();
      c.font = `500 ${fontPx(20)}px "IBM Plex Mono", monospace`; c.fillStyle = COL.mint;
      const nt = 'next: ' + M.artistName(v), nw = c.measureText(nt).width, fb = freeBox();
      const nx = clamp(x + Math.cos(a) * 12 - (Math.cos(a) >= 0 ? 0 : nw), fb.x0 - 40, fb.x1 + 12 - nw);
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(nt, nx, y + Math.sin(a) * 12);
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
  const fs = fontPx(19);
  c.font = `500 ${fs}px "IBM Plex Mono", monospace`;
  c.textAlign = 'center'; c.textBaseline = 'top';
  const crowd = n > 6 || !wide();
  P.forEach((p, i) => {
    const cur = i === WK.i, past = i < WK.i;
    if (cur) { c.strokeStyle = COL.mint; c.lineWidth = 1.5; c.beginPath(); c.arc(p[0], p[1], 11 + Math.sin(t * 2) * 1.5, 0, 6.2832); c.stroke(); }
    c.fillStyle = past || cur ? COL.mint : COL.ink;
    c.beginPath(); c.arc(p[0], p[1], cur ? 5 : 4, 0, 6.2832); c.fill();
  });
  // the current stop names itself first; any other name that would land on one already drawn drops a line, or stays quiet
  const want = P.map((p, i) => i).filter(i => !crowd || i === WK.i || i === 0 || i === n - 1).sort((a, b) => (b === WK.i) - (a === WK.i));
  const drawn = [];
  for (const i of want) {
    const p = P[i], cur = i === WK.i;
    let label = M.artistName(WK.stops[i]);
    if (label.length > 22) label = label.slice(0, 21) + '…';
    const lw = c.measureText(label).width / 2 + 12, x = clamp(p[0], lw, W - lw);
    const ys = [p[1] + 18 + (crowd && i % 2 ? fs * 1.3 : 0), p[1] + 18 + (crowd && i % 2 ? 0 : fs * 1.3)];
    const y = ys.find(y => !drawn.some(d => Math.abs(d[0] - x) < d[2] + lw - 4 && Math.abs(d[1] - y) < fs * 1.2));
    if (y == null) continue;
    drawn.push([x, y, lw]);
    c.fillStyle = cur ? COL.ink : COL.dim;
    c.fillText(label, x, y);
  }
  // the traveler
  const fi = Math.floor(WK.pos), fu = WK.pos - fi;
  if (fi < n - 1 && fu > .01) {
    const a = P[fi], b = P[fi + 1], m = seg(a, b), u = ease(fu);
    const x = (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * m[0] + u * u * b[0], y = (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * m[1] + u * u * b[1];
    c.fillStyle = COL.mint; c.beginPath(); c.arc(x, y, 6, 0, 6.2832); c.fill();
  }
  // endpoints: whose picks
  c.font = `500 ${fontPx(18)}px "IBM Plex Mono", monospace`;
  c.fillStyle = COL.dim; c.textBaseline = 'bottom';
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
  const an = M.artistName(WK.stops[i]) || (pv && pv.an) || '';
  if (extra.big) { setText('#k-name', extra.big); setText('#k-track', pv ? `${an} · ${pv.tt}` : an); return; }
  setText('#k-name', an);
  setText('#k-track', pv ? pv.tt : 'no preview for this one');
}
// walk a path stop by stop with sound
async function walkPath(path, { fromPick, toPick, dwell = 11000, fromLabel = '', toLabel = '', big = '', hopText = null, dwellAt = null } = {}) {
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
    setStop(i, pv, { big, hop: hopText ? hopText(i) : '' });
    if (player.ready) (pv ? player.play(pv.url, { at: 2, fadeIn: dwellAt ? .5 : 1.4 }) : Promise.resolve(false)).then(ok => { if (!ok && tok === WK.tok && WK.i === i) { player.stop(.6); if (!pv) setText('#k-track', 'no clip for this one'); } });
    await waitSkip(dwellAt ? dwellAt(i, path.length) : i === path.length - 1 ? dwell + 3000 : dwell, tok);
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
let songRound = 0, lastSongOwner = '';
async function songStart() {
  const L = DV.list;
  if (L.length < 2) { setText('#k-q', 'needs two people on the map.'); return; }
  const all = L.flatMap(g => g.picks.map(p => ({ g, p, id: p.tid ? 't' + p.tid : 'a' + p.aid })));
  let pool = all.filter(x => !H.played.includes(x.id));
  if (!pool.length) { H.played = []; pool = all; }
  // never the same person twice in a row
  const fresh = pool.filter(x => x.g.k !== lastSongOwner);
  const item = pickOne(fresh.length ? fresh : pool);
  lastSongOwner = item.g.k;
  H.played.push(item.id);
  const ans = [...new Set(all.filter(x => x.p.aid === item.p.aid).map(x => x.g.k))];
  songRound++;
  setText('#k-name', ''); setText('#k-ans', ''); setText('#k-right', ''); setText('#k-track', '');
  setText('#k-q', 'whose song is this?');
  setText('#k-go', 'reveal');
  tallySet('song', 'round');
  const rd = openRound('who', 'whose song is this?', null, { ans, item });
  showNames(L.map(g => g.n));
  setText('#k-hop', `round ${songRound} · ` + roundLine());
  const pv = await M.previewFor(item.p);
  if (RD !== rd || mode !== 'song') return;
  rd.pv = pv;
  if (!pv) { setText('#k-track', 'no sound for this one right now. n for another song.'); return; }
  if (player.ready) player.play(pv.url, { at: 0 });
  autoClose(rd, 26000, songReveal);
}
// every phone in and 10 s gone: no point waiting out the clock
const EARLY = new Set(['who', 'twin', 'hops', 'far', 'guilty', 'sing']);
function autoClose(rd, ms, fn) {
  const t0 = performance.now();
  rd.ms = ms;
  const tick = setInterval(() => {
    if (RD !== rd || !rd.open) { clearInterval(tick); return; }
    const el = performance.now() - t0;
    if (el >= ms || (EARLY.has(rd.type) && el >= 10000 && allIn(rd))) { clearInterval(tick); fn(); }
  }, 250);
}
// the person behind the song gets a different nudge each round
const WHY = ['tell us why.', 'defend this one.', 'the floor is yours.', 'what is the story?', 'when did this one find you?', 'one sentence on why.'];
function songReveal() {
  if (!RD || RD.type !== 'who' || !RD.open) return;
  const { ans, item } = RD.truth;
  // naming your own song is no feat
  const right = [...RD.votes.entries()].filter(([k, v]) => ans.includes(v) && !ans.includes(k)).map(([k]) => k);
  addPoints(right);
  const names = ans.map(nameOf);
  const sl = slotName(item.p).replace(/-/g, '\u2011');
  const text = names.length > 1 ? `${andList(names)} all picked this.` : `it was ${names[0]}'s${sl ? ' ' + sl : ''}.`;
  setText('#k-q', '');
  setText('#k-ans', text);
  const pv = RD.pv;
  setText('#k-track', pv ? `${pv.tt} · ${pv.an}` : pickLabel(item.p));
  // the crowd's favorite wrong answer is the best line of the round
  const wrong = new Map();
  for (const [k, v] of RD.votes) if (!ans.includes(v) && !ans.includes(k)) wrong.set(v, (wrong.get(v) || 0) + 1);
  const top = [...wrong.entries()].sort((a, b) => b[1] - a[1])[0];
  const lines = [`${andList(names)}, ${WHY[(songRound - 1 + WHY.length) % WHY.length]}`];
  if (right.length) lines.push(`got it: ${andList(right.map(nameOf))}.`);
  if (top && top[1] >= 2 && nameOf(top[0])) lines.push(`${top[1]} of you said ${nameOf(top[0])}.`);
  setText('#k-right', lines.join('\n'));
  setText('#k-hop', `round ${songRound}`);
  $('#k-choices').textContent = '';
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
  tallySet('hops', 'round');
  const rd = openRound('hops', `${A.n} to ${B.n}: how many hops?`, opts, { guess: known ? known.length - 1 : 4 });
  rd.pair = [A, B];
  rd.pathP = pathFor(A, B).pr;
  setText('#k-hop', 'bets · ' + roundLine());
  setText('#k-go', 'close bets and walk');
  setText('#k-name', `${A.picks[0].an} → ${B.picks[0].an}`);
  autoClose(rd, 15000, hopsWalk);
  // both ends play while the room bets
  const tok = WK.tok;
  const [pa, pb] = await Promise.all([M.previewFor(A.picks[0]), M.previewFor(B.picks[0])]);
  if (mode !== 'hops') return;
  if (RD !== rd || !rd.open || tok !== WK.tok) return;
  if (pa && player.ready) player.play(pa.url, { at: 3 });
  setText('#k-track', pa ? `now: ${pa.tt}, ${A.n}'s pick` : '');
  await sleep(7000);
  if (RD !== rd || !rd.open || tok !== WK.tok) return;
  if (pb && player.ready) player.play(pb.url, { at: 3 });
  setText('#k-track', pb ? `now: ${pb.tt}, ${B.n}'s pick` : '');
}
async function hopsWalk() {
  const rd = RD;
  if (!rd || rd.type !== 'hops' || !rd.open) return;
  rd.open = false; publish();
  setText('#k-q', ''); setText('#k-go', 'next stop'); setText('#k-name', ''); setText('#k-track', '');
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
  setText('#k-right', right.length ? `best bet: ${andList(right.map(nameOf))}` : '');
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
  tallySet('steer', 'round');
  steerStep();
}
async function steerStep() {
  if (!ST.active || mode !== 'steer') return;
  const tok = WK.tok;
  WK.i = WK.stops.length - 1;
  const pv = await M.previewFor(WK.stops.length === 1 ? pickFor(ST.A, ST.cur) : { aid: ST.cur });
  if (tok !== WK.tok) return;
  setStop(WK.i, pv, { hop: `hop ${ST.steps + 1} · shortest ${ST.best}`, open: true });
  if (pv && player.ready) player.play(pv.url, { at: 2 }); else if (!pv) player.stop(.6);
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
  setText('#k-hop', `hop ${ST.steps + 1} · shortest ${ST.best} · ` + roundLine());
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
    if (pv && player.ready) player.play(pv.url, { at: 2 }); else if (!pv) player.stop(.6);
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
    setText('#k-ans', `the long way round: ${ST.steps} hops.`);
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
  setText('#k-track', 'guess on your phone. the map decides. lines show up after.');
  tallySet('twin', 'round');
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
  const f = DV.facts, L = DV.list;
  const lead = mutual.length ? mutual[0] : f.closest ? `${L[f.closest[0]].n} + ${L[f.closest[1]].n}` : '';
  setText('#k-ans', lead);
  setText('#k-track', mutual.length > 1 ? 'also twins: ' + mutual.slice(1, 6).join(' · ') : mutual.length ? 'twins both ways.' : 'the closest pair in the room.');
  setText('#k-right', right.length ? `found their twin: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody guessed their twin. now you know.' : '');
  setText('#k-go', 'guess again');
  const tw = {};
  DV.list.forEach((g, i) => { const t = twinsOf(i).map(j => DV.list[j].n); if (t.length) tw[g.k] = andList(t.slice(0, 2)); });
  closeRound({ text: lead ? `twins: ${lead}.` : 'lines show each twin', right, tw });
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
  setText('#k-q', 'two of these belong to one person. spot the stranger.');
  tallySet('odd', 'round');
  const rd = openRound('odd', 'which one is the stranger?', [{ v: 0, l: 'one' }, { v: 1, l: 'two' }, { v: 2, l: 'three' }], { odd: OD.odd });
  setText('#k-go', 'reveal');
  const tok = ++WK.tok;
  for (let i = 0; i < 3; i++) {
    if (RD !== rd || tok !== WK.tok) return;
    OD.playing = i;
    setText('#k-hop', `${['one', 'two', 'three'][i]} · ` + roundLine());
    const pv = await M.previewFor(clips[i].p);
    if (RD !== rd || tok !== WK.tok || mode !== 'odd') return;
    if (pv && player.ready) player.play(pv.url, { at: 5 });
    else { player.stop(.6); setText('#k-hop', `${['one', 'two', 'three'][i]} · no sound for this one`); }
    await waitSkip(pv ? 11000 : 3000, tok);
  }
  OD.playing = -1;
  if (RD === rd && rd.open) autoClose(rd, 9000, oddReveal);
}
function oddReveal() {
  if (!RD || RD.type !== 'odd' || !RD.open) return;
  ++WK.tok;
  // the two owners know the answer: no points for them
  const owners = new Set(OD.clips.map(c => c.g.k));
  const right = [...RD.votes.entries()].filter(([k, v]) => v === OD.odd && !owners.has(k)).map(([k]) => k);
  addPoints(right);
  OD.reveal = true;
  setText('#k-hop', '');
  const w = ['one', 'two', 'three'];
  const s = OD.clips[OD.odd], pair = OD.clips.filter((_, i) => i !== OD.odd);
  setText('#k-q', '');
  setText('#k-ans', `the stranger: ${s.g.n}'s ${slotName(s.p).replace(/-/g, '\u2011') || 'pick'}.`);
  setText('#k-track', `${w[OD.odd]} was ${pickLabel(s.p)}. the other two were ${pair[0].g.n}'s: ${pair.map(x => x.p.tt || x.p.an).join(' and ')}.`);
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody got it.' : '');
  setText('#k-go', 'three more');
  closeRound({ text: `${w[OD.odd]} was the stranger`, right });
}

// ---------- the birthday round: six degrees to the birthday baby ----------
const BD = { rows: [], active: false, final: false, prep: false, rush: false };
// the roads home are found in the background as soon as the birthday baby is flagged
const BDP = { sig: '', rows: null, pr: null, i: 0, n: 0 };
function bdaySig() {
  const h = H.hostKey && H.guests.get(H.hostKey);
  if (!h || !h.picks.length) return '';
  return H.hostKey + '|' + DV.list.map(g => g.k + ':' + g.picks.map(p => p.aid).join(',')).join('|');
}
let bdayPrepT = 0;
function bdayPrepSoon() { clearTimeout(bdayPrepT); bdayPrepT = setTimeout(() => { if (!BD.active) bdayPrep(); }, 5000); }
function bdayPrep() {
  const sig = bdaySig();
  if (!sig) return null;
  if (BDP.sig === sig && BDP.pr) return BDP.pr;
  const hostG = H.guests.get(H.hostKey), others = DV.list.filter(g => g.k !== hostG.k);
  BDP.sig = sig; BDP.rows = null; BDP.i = 0; BDP.n = others.length;
  const job = { };
  job.pr = (async () => {
    await 0;
    const rows = [];
    for (const g of others) {
      let res = await pathFor(g, hostG, 160).pr;
      // a long road is fine at a party; a missing one is not
      if (!res.path) res = await Gr.pathLive(g.picks.map(p => p.aid), hostG.picks.map(p => p.aid), { budget: 600, lane: 'lo' });
      rows.push({ g, path: res.path, hops: res.path ? res.path.length - 1 : null });
      if (BDP.pr === job.pr) BDP.i++;
    }
    rows.sort((x, y) => (x.hops ?? 99) - (y.hops ?? 99));
    if (BDP.pr === job.pr) BDP.rows = rows;
    return rows;
  })();
  BDP.pr = job.pr;
  job.pr.catch(() => { if (BDP.pr === job.pr) { BDP.pr = null; BDP.sig = ''; } });
  return job.pr;
}
// names on the screen too, so people without phones can shout an answer
function showNames(names) {
  const box = $('#k-choices');
  box.textContent = '';
  for (const n of names) box.append(el('span', { class: 'chip' }, n));
}
async function bdayStart() {
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  if (!hostG || !hostG.picks.length) { setText('#k-q', 'flag the birthday baby first: open the guest list (g) and tap “birthday baby” next to a name.'); return; }
  const tok = ++WK.tok;
  // her forever song starts now, before anything is looked up
  M.previewFor(hostG.picks[0]).then(pv => { if (tok === WK.tok && mode === 'bday' && pv && player.ready) player.play(pv.url, { at: 0 }); });
  BD.active = true; BD.final = false; BD.rows = []; BD.prep = true; BD.rush = false;
  setText('#k-ans', ''); setText('#k-right', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-q', 'every road leads to the birthday baby.');
  setText('#k-go', '');
  const pr = bdayPrep();
  const tick = setInterval(() => {
    if (tok !== WK.tok || !BD.prep) { clearInterval(tick); return; }
    setText('#k-hop', `finding the roads home · ${Math.min(BDP.i + 1, BDP.n)} of ${BDP.n}`);
  }, 300);
  const rows = await pr;
  BD.prep = false; clearInterval(tick);
  if (tok !== WK.tok || !rows) return;
  BD.rows = rows.slice();
  const reach = BD.rows.filter(r => r.hops != null);
  if (reach.length < 3) { bdayWalk(); return; }
  const low = reach[0].hops;
  const ans = reach.filter(r => r.hops === low).map(r => r.g.k);
  const opts = shuffle(BD.rows.length <= 12 ? [...BD.rows] : [...reach.slice(0, 3), ...shuffle(BD.rows.slice(3)).slice(0, 7)]).map(r => ({ v: r.g.k, l: r.g.n }));
  setText('#k-q', 'who is closest to the birthday baby?');
  setText('#k-go', 'reveal');
  tallySet('bday', 'round');
  const rd = openRound('far', 'who is closest to the birthday baby?', opts, { ans, low });
  rd.hp = 'guess · ';
  hopRefresh();
  showNames(opts.map(o => o.l));
  autoClose(rd, 24000, bdayWalk);
}
async function bdayWalk() {
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  if (!hostG || !BD.active || BD.prep) return;
  let note = '';
  if (RD && RD.type === 'far' && RD.open) {
    const { ans, low } = RD.truth;
    const right = [...RD.votes.entries()].filter(([, v]) => ans.includes(v)).map(([k]) => k);
    addPoints(right, 2);
    const text = `closest: ${andList(ans.map(nameOf))}, ${low} hop${low === 1 ? '' : 's'}.`;
    note = text + (right.length ? ` got it: ${andList(right.map(nameOf))}.` : '');
    closeRound({ text, right });
  }
  $('#k-choices').textContent = '';
  renderBdayList();
  setText('#k-go', 'next stop'); setText('#k-q', ''); setText('#k-right', note);
  footNote('n next stop · e skips to the end');
  // farthest first; after the first road, a walk stops where it joins a road already walked, then flashes home
  const walkOrder = BD.rows.filter(r => r.path).slice().reverse();
  const walked = new Map();
  for (let w = 0; w < walkOrder.length; w++) {
    const r = walkOrder[w], path = r.path, end = path.length - 1;
    let j = -1;
    if (w > 0) for (let i = 1; i < end; i++) if (walked.has(path[i])) { j = i; break; }
    const stops = j > 0 ? [...path.slice(0, j + 1), path[end]] : path.slice();
    const last = w === walkOrder.length - 1;
    const hs = `${r.hops} hop${r.hops === 1 ? '' : 's'}`;
    setText('#m-sub', `${r.g.n} → the birthday baby · ${hs}`);
    const ok = await walkPath(stops, {
      fromPick: pickFor(r.g, path[0]), toPick: pickFor(hostG, path[end]),
      fromLabel: `${r.g.n}'s pick`, toLabel: 'the birthday baby', big: `${r.g.n}'s way home`,
      hopText: i => i === 0 ? `start · ${r.g.n}'s pick` : i === stops.length - 1 ? `home · ${hs}` : i === j ? `joins ${walked.get(path[j])}'s road` : `hop ${i} of ${r.hops}`,
      dwellAt: (i, n) => i === n - 1 ? (last ? 4000 : 2500) : i === j ? 3000 : w === 0 ? 3200 : 2500,
    });
    // e jumps straight to the final card
    if (!ok) { if (BD.rush && BD.active && mode === 'bday') break; return; }
    for (const v of path.slice(0, j > 0 ? j : end)) if (!walked.has(v)) walked.set(v, r.g.n);
  }
  BD.final = true;
  publish();
  const reach = BD.rows.filter(r => r.hops != null);
  const far = Math.max(0, ...reach.map(r => r.hops));
  const miss = BD.rows.length - reach.length;
  setText('#m-sub', 'every road leads to the birthday baby.');
  setText('#k-hop', ''); setText('#k-name', ''); setText('#k-track', '');
  setText('#k-ans', 'happy birthday.');
  setText('#k-go', '');
  setText('#k-right', !reach.length ? '' : miss ? `${reach.length} of you are within ${far} hops of her. ${miss} more took the scenic route.` : `every one of you is within ${far} hop${far === 1 ? '' : 's'} of her.`);
  const hp = await M.previewFor(hostG.picks[0]);
  if (hp && player.ready && mode === 'bday' && BD.final) player.play(hp.url, { at: 0 });
}
function renderBdayList() {
  const ol = $('#board-ol');
  $('#board h3').textContent = 'hops to the birthday baby';
  ol.textContent = '';
  for (const r of BD.rows.slice(0, 12)) ol.append(el('li', {}, el('span', {}, r.g.n), el('span', {}, r.hops == null ? 'scenic' : String(r.hops))));
  $('#board').style.display = 'block';
}
function drawBdayFinal(c, t) {
  const p = pad(), jw = joinW();
  const fb = freeBox();
  // the caption sits under the rings, so the people closest to her never sit under it
  // names hang just outside the rings, so the caption goes below the lowest name it could ever reach
  const capH = fontPx(26) * 1.6, lab = 12 + fontPx(22) * .65;
  const cx = wide() ? (fb.x0 + fb.x1) / 2 : W / 2, cy = wide() ? (fb.y0 + fb.y1 - capH) / 2 : Hh * .5 - capH / 2;
  const rows = BD.rows.filter(r => r.path);
  c.font = `500 ${fontPx(22)}px "Instrument Sans", sans-serif`;
  const lw = Math.max(60, ...rows.map(r => c.measureText(r.g.n).width)) + 20;
  const Rmax = Math.max(40, wide() ? Math.min((fb.y1 - fb.y0 - capH) / 2 - lab, (fb.x1 - fb.x0) / 2 - lw) : Math.min(W / 2 - lw, (Hh - capH) * .42 - lab));
  const R0 = Math.min(44, Rmax * .2);
  const maxH = Math.max(1, ...rows.map(r => r.hops));
  c.strokeStyle = alpha(COL.ice, .2); c.lineWidth = 1;
  for (let h = 1; h <= maxH; h++) { c.beginPath(); c.arc(cx, cy, R0 + (Rmax - R0) * h / maxH, 0, 6.2832); c.stroke(); }
  c.font = `500 ${fontPx(22)}px "Instrument Sans", sans-serif`; c.textBaseline = 'middle';
  rows.forEach((r, k) => {
    const a = k / rows.length * 6.2832 - Math.PI / 2 + t * .02;
    const pts = r.path.map((_, i) => {
      const rem = r.hops - i;
      const rr = rem ? R0 + (Rmax - R0) * rem / maxH : 0;
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
  c.font = `600 ${fontPx(26)}px "Instrument Sans", sans-serif`; c.textAlign = 'center'; c.fillStyle = COL.mint; c.textBaseline = 'middle';
  c.fillText('the birthday baby, in the middle', cx, cy + Rmax + lab + capH * .55);
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
function sideRect() {
  if (!wide()) return { x: 14, y: 14, w: W - 28, h: Hh - 28 };
  // names sit to the right of their dots, so the dots stop short of the points list
  const b = freeBox();
  return { x: b.x0 + 30, y: b.y0 + 40, w: b.x1 - b.x0 - 200, h: b.y1 - b.y0 - 90 };
}

// a short screen leaves the twin map a postage stamp; it takes the free width, and names still stop at the points list
function twinRect() {
  const R = sideRect();
  if (!wide() || Hh > 800) return R;
  const b = freeBox();
  return { ...R, w: Math.max(R.w, b.x1 - b.x0 - 110) };
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
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody got it.' : '');
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
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody got it.' : '');
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
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody got it.' : '');
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
  const apart = pairs.filter(x => x[2] >= 2);
  const [A, B, dAB] = pickOne((apart.length ? apart : pairs).slice(0, 4));
  const tok = ++WK.tok;
  Object.assign(BR, { A, B, cur: null });
  setText('#m-sub', dAB >= 2 ? `${A.n} and ${B.n} are far apart on the map.` : `${A.n} and ${B.n} are already neighbors. an easy one.`);
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
  const need = Math.max(2, Math.floor(n * .4));
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
    off: (g, q) => { const tt = teamOfKey(g.k), sg = tt ? 1 : -1, ce = cen[tt]; return [(ce[0] - q[0]) * .1 * s + dx * sg * .4 * s, (ce[1] - q[1]) * .1 * s + dy * sg * .4 * s]; },
    tint: g => teamOfKey(g.k) ? COL.rose : COL.mint,
  });
  if (!P) return;
  const tot = teamTotals();
  c.font = `600 ${fontPx(30)}px "Instrument Sans", sans-serif`; c.textBaseline = 'bottom';
  const lh = fontPx(38), lab = [0, 1].map(tt => {
    const mem = P.filter((_, i) => teamOfKey(DV.list[i].k) === tt);
    if (!mem.length) return null;
    const text = `${T.n[tt]} · ${tot[tt]}`, w = c.measureText(text).width;
    const x = mem.reduce((a, p) => a + p[0], 0) / mem.length, y = Math.min(...mem.map(p => p[1])) - 44;
    return { tt, text, w, x: clamp(x, w / 2 + 16, (wide() ? W - joinW() - 290 : W) - w / 2 - 16), y: Math.max(wide() ? Hh * .2 + lh : lh, y), lo: Math.max(...mem.map(p => p[1])) + 44 + lh };
  }).filter(Boolean);
  if (lab.length === 2 && Math.abs(lab[0].x - lab[1].x) < (lab[0].w + lab[1].w) / 2 + 24 && Math.abs(lab[0].y - lab[1].y) < lh) {
    const low = lab[0].lo >= lab[1].lo ? lab[0] : lab[1];
    low.y = Math.min(Hh - 12, low.lo);
    if (Math.abs(lab[0].y - lab[1].y) < lh) low.y = (low === lab[0] ? lab[1] : lab[0]).y + lh;
  }
  for (const l of lab) {
    c.fillStyle = l.tt ? COL.rose : COL.mint; c.globalAlpha = s; c.textAlign = 'center';
    c.fillText(l.text, l.x, l.y);
    c.globalAlpha = 1;
  }
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
  setText('#k-right', right.length ? `got it: ${andList(right.map(nameOf))}` : RD && RD.votes && RD.votes.size ? 'nobody got it.' : '');
  setText('#k-go', 'spin again');
  closeRound({ text, right });
  await Promise.race([warmYears(), sleep(8000)]);
  if (RD !== rd) return;
  const near = DV.list.map(g => [g, avgYear(g)]).filter(x => x[1] != null).sort((a, b) => Math.abs(a[1] - year) - Math.abs(b[1] - year)).slice(0, 3);
  DC.lit = new Set(near.map(x => x[0].k));
  if (near.length) setText('#k-right', `${right.length ? `got it: ${andList(right.map(nameOf))}. ` : RD && RD.votes && RD.votes.size ? 'nobody got it. ' : ''}picks closest in years: ${andList(near.map(([g, a]) => `${g.n} (${Math.round(a)})`))}`);
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
// the part of the stage nothing else covers: right of the words, left of the points, under the menu
const BOARD_MODES = new Set(['song', 'hops', 'steer', 'twin', 'odd', 'nth', 'match', 'guilty', 'bridge', 'teams', 'decade']);
function freeBox() {
  if (!wide()) return { x0: 14, x1: W - 14, y0: 14, y1: Hh - 14 };
  const jw = joinW(), bd = $('#board');
  const on = BOARD_MODES.has(mode) || (mode === 'bday' && bd.style.display === 'block');
  const pp = mode === 'photo' ? $('#p-photo').offsetWidth : 0;
  const x1 = W - jw - (on ? bd.offsetWidth + pad() + 28 : pp ? pp + pad() + 36 : pad());
  const md = $('#modes'), col = $('#col');
  const cr = col.offsetWidth ? col.offsetLeft + col.offsetWidth + 24 : (W - jw) * .43;
  return { x0: Math.min(cr, x1 - 280), x1, y0: Math.max(Hh * .05 + 120, md.offsetTop + md.offsetHeight + 24), y1: Hh * .95 - 40 };
}
function playCenter() {
  if (!wide()) return { cx: W / 2, cy: Hh / 2, R: Math.min(W, Hh) * .34 };
  const b = freeBox();
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, R: clamp(Math.min(b.x1 - b.x0, b.y1 - b.y0) / 3, 100, 320) };
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
  const b = freeBox(), span = b.x1 - b.x0;
  const y = wide() ? Hh * .55 : Hh * .5;
  const R = wide() ? Math.min(span / 6.6, Hh * .14) : Math.min(W * .12, Hh * .18);
  const xs = wide() ? [b.x0 + span / 6, b.x0 + span / 2, b.x0 + span * 5 / 6] : [W * .19, W * .5, W * .81];
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
        el('a', { href: M.spotifyLink(q, it.p.tid), target: '_blank', rel: 'noopener noreferrer' }, 'spotify'),
        el('a', { href: M.appleLink(q, it.p.tid), target: '_blank', rel: 'noopener noreferrer' }, 'apple'))));
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
  // the map stops short of the track list, so no name runs into the numbers
  const lx = wide() ? $('#p-list').getBoundingClientRect().left || W : W;
  const R = wide() ? { x: p + 20, y: Hh * .24, w: Math.max(160, Math.min((W - joinW()) * .4, lx - p - 20 - 70)), h: Hh * .6 } : { x: 14, y: 14, w: W - 28, h: Hh - 28 };
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
  const fh = fontPx(15) * 1.2, taken = [];
  DV.list.forEach(g => {
    const b = project(R, pos.get(g.k) || [0, 0]), n = g.k === H.hostKey ? HOSTN : g.n, hw = c.measureText(n).width / 2;
    const fit = x => wide() ? clamp(x, 4 + hw, lx - 16 - hw) : x;
    // below the dot unless a name is already there: then above, right, left
    const cand = [[b[0], b[1] + 24], [b[0], b[1] - 24 - fh], [b[0] + 24 + hw, b[1] - fh / 2], [b[0] - 24 - hw, b[1] - fh / 2]].map(([x, y]) => [fit(x), y]);
    const ov = ([x, y]) => taken.reduce((o, q) => o + Math.max(0, Math.min(x + hw, q[0] + q[2]) - Math.max(x - hw, q[0])) * Math.max(0, Math.min(y + fh, q[1] + q[3]) - Math.max(y, q[1])), 0);
    let best = cand[0], bo = Infinity;
    for (const cd of cand) { const o = ov(cd); if (o < bo) { bo = o; best = cd; } if (!o) break; }
    taken.push([best[0] - hw, best[1], hw * 2, fh]);
    c.fillText(n, best[0], best[1]);
  });
}

// ---------- modes ----------
const DRAW = {
  cloud: (c, t, dt) => drawCloud(c, t, dt),
  walk: drawWalk, hops: drawWalk, steer: drawWalk,
  bday: (c, t, dt) => BD.final ? drawBdayFinal(c, t) : (RD && RD.type === 'far' && RD.open) || BD.prep ? drawSong(c, t) : drawWalk(c, t, dt),
  song: (c, t) => drawSong(c, t), odd: drawOdd,
  nth: (c, t, dt) => NT.reveal ? drawWalk(c, t, dt) : drawNth(c, t), match: drawMatch, guilty: (c, t) => drawSong(c, t), bridge: drawBridge, teams: drawTeams, decade: drawDecade,
  twin: (c, t, dt) => drawCloud(c, t, dt, { twins: true, rect: twinRect(), noLinks: !!(RD && RD.type === 'twin' && RD.open) }),
  pairs: drawPairs, list: drawList,
  awards: (c, t, dt) => { drawCloud(c, t, dt, { rect: sideRect(), lit: AW.lit && AW.lit.size ? AW.lit : null, fs: fontPx(W < 1500 ? 21 : 28), nameOf: g => g.k === H.hostKey ? 'the birthday baby' : g.n }); drawConfetti(c, t, dt); },
  toast: (c, t) => drawSong(c, t, TS.on ? 1.15 : .9),
  photo: (c, t, dt) => drawCloud(c, t, dt, { rect: photoRect(), fs: fontPx(30), nameOf: g => g.k === H.hostKey ? 'the birthday baby' : g.n }),
  sing: (c, t) => drawSong(c, t),
};
// how each game works, in three short lines a first-timer can follow
// one line of the how behind each game, in plain words
const HOP = 'a hop is one \u201crelated artist\u201d link from a music service: the people who play one tend to play the other. it is listening habits, not the sound itself.';
const SCI = {
  cloud: 'two artists are linked when a music service lists them as related: the people who play one tend to play the other. we count the links between your picks and everyone else\u2019s, then lay the room out so fewer links means closer dots. it is listening habits, not the sound itself.',
  walk: HOP + ' the path is the shortest chain of links we could find.',
  steer: HOP, hops: HOP + ' the answer is the shortest chain we could find.',
  bday: HOP + ' closest means the fewest hops.',
  twin: 'your taste twin is the person whose picks are the fewest \u201crelated artist\u201d links from yours.',
  odd: 'the odd song comes from someone on the far half of the map from that person, so your ear has something to go on.',
  awards: 'the middle of the room is the fewest links from everyone else. the wildcard is the most. the bridge is the artist on the most shortest paths between you.',
  pairs: HOP,
};
const HOW = {
  cloud: ['every dot is one of you.', 'your dot sits next to the people whose music is most like yours.', 'a line joins you to your two nearest people.'],
  walk: ['we pick two of you.', 'we hop from one person\u2019s music to the other\u2019s, one similar artist at a time.', 'fewer hops means closer taste. just watch and listen.'],
  song: ['a song that one of you brought starts playing.', 'on your phone, tap who you think brought it.', 'a right guess is a point.'],
  odd: ['three songs play.', 'two were brought by the same person. one was not.', 'on your phone, tap the one that does not belong.'],
  steer: ['we start at one artist and want to reach another.', 'at every step the room votes on which similar artist to hop to.', 'get there in as few hops as you can.'],
  twin: ['somebody here has taste closest to yours.', 'on your phone, guess who.', 'then the map shows the real answer.'],
  hops: ['two picks go up on the screen.', 'on your phone, bet how many hops of similar artists join them.', 'the closest bet wins. then we walk it.'],
  sing: ['the room votes for the one song everybody knows.', 'the winner plays.', 'sing.'],
  awards: ['the map hands out prizes.', 'the middle of the room, the wildcard, most points and more.', 'one at a time. space for the next.'],
  bday: ['every one of you gets a road of similar artists to the birthday baby.', 'on your phone, guess who is closest.', 'then every road lights up.'],
  toast: ['get a glass.', 'we count down together.', 'then: happy birthday.'],
  photo: ['everyone on the map, one last time.', 'look at the screen.', 'your phone now holds your goodie bag.'],
  list: ['every song from tonight, in one order.', 'press play here to hear them.', 'the same list is on your phone, with links.'],
  pairs: ['every two of you get a score.', 'it counts the hops between your picks.', 'fewer hops, higher score.'],
  nth: ['one clip plays from somewhere on a path between two picks.', 'on your phone, say which end it is nearer.', 'a right guess is a point.'],
  match: ['two dots light up with no names.', 'on your phone, guess who they are.', 'a right guess is a point.'],
  guilty: ['one secret song plays.', 'on your phone, guess whose guilty pleasure it is.', 'a right guess is a point.'],
  bridge: ['we pick two of you.', 'together, name one artist that connects your picks.', 'the map checks it.'],
  teams: ['the map pulls the room into two taste camps.', 'find your side.', 'that is your team.'],
  decade: ['a song plays.', 'on your phone, pick the decade it is from.', 'a right guess is a point.'],
};
let howT = 0;
const howSeen = new Set();
function toggleHow(on, m = mode) {
  const box = $('#howcard');
  if (on === undefined) on = box.classList.contains('hide');
  clearTimeout(howT);
  if (!on || !HOW[m]) { box.classList.add('hide'); return; }
  setText('#hw-title', MODES[m].title);
  const ol = $('#hw-steps'); ol.textContent = '';
  HOW[m].forEach(t => ol.append(el('li', {}, t)));
  setText('#hw-sci', SCI[m] ? 'the science: ' + SCI[m] : '');
  box.classList.remove('hide');
  howT = setTimeout(() => box.classList.add('hide'), 22000);
}
const MODES = {
  cloud: { title: 'the cloud', sub: 'everyone here, placed by taste.', go: '' },
  walk: { title: 'the walk', sub: '', go: 'next pair' },
  song: { title: 'whose song', sub: 'whose pick is playing? vote on your phone.', go: 'play a song' },
  pairs: { title: 'pairs', sub: 'every two people, scored by hops between their picks.', go: '' },
  list: { title: 'the playlist', sub: '', go: '' },
  hops: { title: 'how many hops', sub: 'bet on your phone, then we walk it.', go: 'start a bet' },
  steer: { title: 'steer', sub: 'the room picks every hop. find the short way.', go: 'start' },
  twin: { title: 'taste twin', sub: 'who here shares your taste?', go: 'open the guesses' },
  odd: { title: 'odd one out', sub: 'three songs. two belong to one person.', go: 'play three' },
  bday: { title: 'the birthday round', sub: 'every road leads to the birthday baby.', go: 'start the finale' },
  nth: { title: 'name that hop', sub: 'one clip from somewhere on a path. nearer which end?', go: 'start' },
  match: { title: 'matchmaker', sub: 'two dots are lit. who are they?', go: 'light two dots' },
  guilty: { title: 'guilty pleasure', sub: 'one secret song. whose is it?', go: 'play a secret' },
  bridge: { title: 'bridge builder', sub: 'two people name one artist that connects them.', go: 'pick two' },
  teams: { title: 'team split', sub: 'two taste camps, pulled apart.', go: 'split the room' },
  decade: { title: 'decade roulette', sub: 'which decade is this song from?', go: 'spin' },
  awards: { title: 'the awards', sub: 'one at a time.', go: 'first award' },
  toast: { title: 'the toast', sub: 'glasses up.', go: 'count it in' },
  photo: { title: 'happy birthday', sub: '', go: '' },
  sing: { title: 'singalong', sub: 'the room picks the song everyone knows.', go: 'open the vote' },
};
// =====================================================================
// THE END OF THE NIGHT: awards, the toast, the photo, a singalong
// =====================================================================
const AW = { list: [], i: -1, lit: null, tok: 0, pub: null };
function awardList() {
  const f = DV.facts, L = DV.list, D = DV.D, out = [];
  const all = L.map(g => g.k);
  if (L.length >= 2) {
    // the room first: these belong to everyone
    const ds = []; for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (D[i][j] < Gr.FAR) ds.push(D[i][j]);
    if (ds.length) out.push({ k: 'this room, in one number', v: hopsTxt(ds.reduce((x, y) => x + y, 0) / ds.length), s: 'the average distance between any two of you.', lit: all });
    if (f.bridge) out.push({ k: 'the artist holding this room together', v: M.artistName(f.bridge), s: `links ${f.bridgeCount} pairs of you`, lit: all, pick: { k: 'a', aid: f.bridge, an: M.artistName(f.bridge) } });
    const [a, b] = f.closest;
    out.push({ k: 'the twins', v: `${L[a].n} + ${L[b].n}`, s: `${hopsTxt(D[a][b])} apart. basically one playlist.`, lit: [L[a].k, L[b].k] });
    out.push({ k: 'the middle of the room', v: L[f.center].n, s: 'closest to everyone, on average. the glue.', lit: [L[f.center].k] });
    if (L.length >= 3 && f.outlier >= 0) out.push({ k: 'the wildcard', v: L[f.outlier].n, s: 'furthest from the pack, in the best way', lit: [L[f.outlier].k] });
    if (f.widest >= 0) out.push({ k: 'the widest taste', v: L[f.widest].n, s: 'their own picks sit furthest apart', lit: [L[f.widest].k] });
    const fans = L.flatMap(g => g.picks.map(p => ({ g, p, n: M.artistFans(p.aid) }))).filter(x => x.n > 0).sort((x, y) => y.n - x.n);
    if (fans.length >= 4) {
      const top = fans[0], low = fans[fans.length - 1];
      out.push({ k: 'the crowd pleaser', v: top.g.n, s: `brought ${top.p.an}, the biggest name in the room`, lit: [top.g.k], pick: top.p });
      if (low.g.k !== top.g.k) out.push({ k: 'the deep cut', v: low.g.n, s: `brought ${low.p.an}. almost nobody knows it. now we all do.`, lit: [low.g.k], pick: low.p });
    }
  }
  // the artist most roads home pass through
  if (BDP.rows) {
    const cnt = new Map();
    for (const r of BDP.rows) if (r.path) for (const v of r.path.slice(1, -1)) cnt.set(v, (cnt.get(v) || 0) + 1);
    const best = [...cnt.entries()].filter(e => e[0] !== f.bridge).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) out.push({ k: 'the crossroads', v: M.artistName(best[0]), s: `${best[1]} of your roads to the birthday baby go through here`, lit: [], pick: { k: 'a', aid: best[0], an: M.artistName(best[0]) } });
  }
  // points go last
  const rows = Object.entries(H.scores).filter(([k]) => H.guests.has(k)).sort((a, b) => b[1] - a[1]);
  if (rows.length && rows[0][1] > 0) { const top = rows.filter(r => r[1] === rows[0][1]).map(r => r[0]); out.push({ k: 'most points tonight', v: andList(top.map(nameOf)), s: `${rows[0][1]} point${rows[0][1] === 1 ? '' : 's'}`, lit: top }); }
  return out;
}
// crisp confetti in the map's own colors
const CONF = [];
function confetti() {
  const cols = [COL.mint, COL.ice, COL.ink, COL.rose];
  for (let i = 0; i < 140; i++) CONF.push({ x: W * (.08 + .5 * Math.random()), y: -20 - Math.random() * Hh * .3, vx: (Math.random() - .5) * 160, vy: 180 + Math.random() * 320, s: 6 + Math.random() * 10, c: cols[i % cols.length], w: Math.random() * 6.28 });
}
function drawConfetti(c, t, dt) {
  if (!CONF.length) return;
  const d = Math.min(dt || .016, .05);
  for (let i = CONF.length - 1; i >= 0; i--) {
    const p = CONF[i];
    p.x += (p.vx + Math.sin(t * 3 + p.w) * 60) * d; p.y += p.vy * d;
    if (p.y > Hh + 30) { CONF.splice(i, 1); continue; }
    c.fillStyle = p.c; c.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.s), Math.round(p.s * (.5 + .5 * Math.abs(Math.sin(t * 4 + p.w)))));
  }
}
async function awardNext() {
  if (AW.i < 0) AW.list = awardList();
  const tok = ++AW.tok;
  AW.i++;
  if (AW.i >= AW.list.length) {
    AW.lit = null; clearTexts();
    setText('#k-q', AW.list.length ? 'that is every award. you are all on the map.' : 'no awards yet. play a round first.');
    setText('#k-go', 'again'); AW.i = -1;
    if (AW.list.length) confetti();
    AW.pub = { end: AW.list.length ? 'that is every award. you are all on the map.' : 'no awards yet.' }; publish();
    return;
  }
  const a = AW.list[AW.i];
  clearTexts();
  setText('#k-hop', `award ${AW.i + 1} of ${AW.list.length}`);
  setText('#k-q', a.k);
  setText('#k-go', '');
  AW.lit = new Set();
  AW.pub = { i: AW.i + 1, n: AW.list.length, k: a.k }; publish();
  // the drumroll: the room gets a beat to shout a guess
  const wp = a.pick || (a.lit.length && a.lit.length <= 2 && H.guests.get(a.lit[0]) && H.guests.get(a.lit[0]).picks[0]) || null;
  const pr = wp ? M.previewFor(wp).catch(() => null) : Promise.resolve(null);
  if (player.ready) player.stop(.5);
  for (const d of ['and it goes to', 'and it goes to .', 'and it goes to . .', 'and it goes to . . .']) {
    setText('#k-track', d);
    await sleep(650);
    if (tok !== AW.tok || mode !== 'awards') return;
  }
  chime(AW.i); confetti();
  pr.then(pv => { if (tok === AW.tok && mode === 'awards' && pv && player.ready) player.play(pv.url, { at: 0, fadeIn: .3 }); });
  setText('#k-ans', a.v);
  setText('#k-track', a.s);
  AW.lit = new Set(a.lit);
  setText('#k-go', AW.i + 1 < AW.list.length ? 'next award' : 'done');
  AW.pub = { ...AW.pub, v: a.v, s: a.s, lit: a.lit }; publish();
}
const TS = { tok: 0, on: false };
async function toastGo() {
  const tok = ++TS.tok;
  const hostG = H.hostKey && H.guests.get(H.hostKey);
  const pr = hostG && hostG.picks.length ? M.previewFor(hostG.picks[0]) : Promise.resolve(null);
  clearTexts(); setText('#k-go', ''); TS.on = false;
  if (player.ready) player.stop(.6);
  for (const n of ['3', '2', '1']) {
    setText('#k-name', n);
    await sleep(900);
    if (tok !== TS.tok || mode !== 'toast') return;
  }
  setText('#k-name', '');
  setText('#k-ans', 'happy birthday.');
  setText('#k-right', 'to the birthday baby.');
  TS.on = true;
  const pv = await pr;
  if (tok === TS.tok && mode === 'toast' && pv && player.ready) player.play(pv.url, { at: 0, fadeIn: .3 });
  setText('#k-go', 'again');
}
function toastEnter() {
  TS.on = false;
  setText('#k-q', 'raise a glass.');
  setText('#k-track', H.hostKey ? 'her forever song plays on one.' : 'flag the birthday baby (g) and her forever song plays too.');
}
function photoRect() {
  const p = pad();
  if (!wide()) return { x: 14, y: Hh * .16, w: W - 28, h: Hh * .6 };
  const side = $('#p-photo').offsetWidth;
  const md = $('#modes'), y = Math.max(Hh * .2, md.offsetTop + md.offsetHeight + 24), cf = $('#cloud-facts').getBoundingClientRect();
  const yb = cf.height ? Math.min(Hh * .78, cf.top - 50) : Hh * .78;
  return { x: p + 60, y, w: W - p * 2 - 120 - (side ? side + 60 : 0), h: Math.max(160, yb - y) };
}
function photoEnter() {
  const day = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toLowerCase();
  setText('#m-sub', `${day} · ${DV.list.length} of us on the map`);
  renderSide();
}
// the photo: every name with the song they brought, the birthday baby first
const PHOTO_MAX = 14;
function renderPhotoList() {
  const ol = $('#photo-ol');
  if (!ol) return;
  ol.textContent = '';
  const L = DV.list.slice().sort((a, b) => (b.k === H.hostKey) - (a.k === H.hostKey));
  const show = L.length > PHOTO_MAX ? L.slice(0, PHOTO_MAX - 1) : L;
  for (const g of show) {
    const p = g.picks.find(x => x.s === 0) || g.picks[0];
    if (!p) continue;
    const host = g.k === H.hostKey;
    ol.append(el('li', { class: host ? 'host' : '' }, el('b', {}, host ? 'the birthday baby' : g.n), el('span', {}, p.k === 't' ? p.tt : p.an)));
  }
  if (show.length < L.length) ol.append(el('li', { class: 'more' }, el('b', {}, `and ${L.length - show.length} more`), el('span', {}, '')));
  $('#p-photo').classList.toggle('empty', !ol.children.length);
}
const SG = { pv: null };
async function singStart() {
  const picks = [];
  const seen = new Set();
  for (const g of DV.list) for (const p of g.picks) if (p.k === 't' && !seen.has(p.tid)) { seen.add(p.tid); picks.push(p); }
  if (picks.length < 2) { setText('#k-q', 'needs two songs on the map.'); return; }
  // the songs most people are likely to know: the biggest artists
  const pool = picks.sort((a, b) => M.artistFans(b.aid) - M.artistFans(a.aid)).slice(0, 7);
  const four = shuffle(pool).slice(0, 4);
  clearTexts();
  const opts = four.map((p, i) => ({ v: i, l: `${p.tt} · ${p.an}` }));
  setText('#k-q', 'pick the singalong.');
  showNames(opts.map(o => o.l));
  setText('#k-go', 'play the winner');
  tallySet('sing', 'round');
  const rd = openRound('sing', 'pick the singalong', opts, { four });
  rd.hp = '';
  hopRefresh();
  autoClose(rd, 20000, singPlay);
}
async function singPlay() {
  const rd = RD;
  if (!rd || rd.type !== 'sing' || !rd.open) return;
  const n = [0, 0, 0, 0];
  for (const v of rd.votes.values()) if (n[v] !== undefined) n[v]++;
  const top = Math.max(...n);
  const four = rd.truth.four;
  const win = top > 0 ? pickOne(n.map((c, i) => c === top ? i : -1).filter(i => i >= 0)) : 0;
  const p = four[win];
  closeRound({ text: `the singalong: ${p.tt}.`, right: [] });
  clearTexts(); $('#k-choices').textContent = '';
  setText('#k-name', p.tt);
  setText('#k-track', p.an);
  setText('#k-right', top ? `${top} vote${top === 1 ? '' : 's'}. everybody sing.` : 'everybody sing.');
  setText('#k-go', 'another');
  const pv = await M.previewFor(p);
  if (RD === rd && mode === 'sing' && pv && player.ready) player.play(pv.url, { at: 0, fadeIn: .3 });
  if (!pv) setText('#k-right', 'no clip for this one. sing it anyway.');
}

const GO = { walk: () => { ++walkLoopTok; walkLoop(); }, song: () => RD && RD.type === 'who' && RD.open ? songReveal() : songStart(),
  awards: () => awardNext(), toast: () => toastGo(), photo: () => savePoster(),
  sing: () => RD && RD.type === 'sing' && RD.open ? singPlay() : singStart(),
  hops: () => RD && RD.type === 'hops' && RD.open ? hopsWalk() : RD && RD.type === 'hops' && !RD.res ? (WK.skip && WK.skip()) : hopsStart(),
  steer: () => RD && RD.type === 'steer' && RD.open ? steerChoose(null) : (ST.active ? null : steerStart()),
  twin: () => RD && RD.type === 'twin' && RD.open ? twinReveal() : twinStart(),
  odd: () => RD && RD.type === 'odd' && RD.open ? oddReveal() : oddStart(),
  bday: () => RD && RD.type === 'far' && RD.open ? bdayWalk() : BD.prep || BD.final ? null : BD.active ? (WK.skip && WK.skip()) : bdayStart(),
  nth: () => RD && RD.type === 'nth' && RD.open ? nthReveal() : nthStart(),
  match: () => RD && RD.type === 'match' && RD.open ? matchReveal() : matchStart(),
  guilty: () => RD && RD.type === 'guilty' && RD.open ? guiltyReveal() : guiltyStart(),
  bridge: () => RD && RD.type === 'bridge' && RD.open ? bridgeReveal() : bridgeStart(),
  teams: () => H.teams ? mergeTeams() : teamsSplit(),
  decade: () => RD && RD.type === 'decade' && RD.open ? decadeReveal() : decadeStart(),
  list: () => tourTok && tourIdx >= 0 ? stopTour() : playTour(0),
  cloud: () => { if (!player.ready) return; if (cloudNow) { cloudTok++; cloudNow = null; player.stop(); setText('#cloud-now', 'paused. space plays.'); } else cloudShuffle(); },
};
// about 35 minutes, the order on the night's card: warm up, change rhythm, sing, then the ceremony
const SET = [
  { m: 'song', n: 8, l: 'whose song' }, { m: 'odd', n: 3, l: 'odd one out' }, { m: 'steer', n: 1, l: 'steer' },
  { m: 'twin', n: 1, l: 'taste twin' }, { m: 'hops', n: 2, l: 'how many hops' }, { m: 'sing', n: 1, l: 'the singalong' },
  { m: 'awards', n: 1, l: 'the awards' }, { m: 'bday', n: 1, l: 'the birthday round' }, { m: 'toast', n: 1, l: 'the toast' },
  { m: 'photo', n: 1, l: 'the photo' }, { m: 'list', n: 1, l: 'the playlist, to close' },
];
const SETKEY = { song: '2', odd: '3', steer: '4', twin: '5', hops: '6', sing: '7', awards: '8', bday: '9', toast: '0', photo: 'p', list: 'l' };
// each round counts toward one part of the set
const SETN = SET.map(() => 0), SETV = 2;
let setPos = 0, setLast = -1;
function tallySet(m, how) {
  // jumping ahead on the card moves the hint along with you, so it never points back
  const ahead = how === 'enter' ? SET.findIndex((x, j) => j > setPos && x.m === m) : -1;
  if (ahead > setPos) { setPos = ahead; if (savedAt) saveSoon(); }
  if (how === 'round' || ['awards', 'toast', 'photo', 'list'].includes(m)) {
    let i = setLast >= 0 && SET[setLast].m === m ? setLast : SET.findIndex((x, j) => j >= setPos && x.m === m);
    if (i < 0) i = SET.map(x => x.m).lastIndexOf(m);
    if (i >= 0) {
      SETN[i] = how === 'round' ? SETN[i] + 1 : Math.max(SETN[i], 1);
      setLast = i;
      if (i > setPos) setPos = i;
      saveSoon();
    }
  }
  nextUp();
}
function setRestore(s) {
  if (!s || s.v !== SETV || !Array.isArray(s.n) || s.n.length !== SET.length) return;
  s.n.forEach((v, i) => { SETN[i] = Math.max(0, v | 0); });
  setPos = clamp(s.pos | 0, 0, SET.length); setLast = clamp(s.last | 0, -1, SET.length - 1);
}
function nextUp() {
  const b = $('#next-up');
  if (!b) return;
  while (setPos < SET.length && SETN[setPos] >= SET[setPos].n) setPos++;
  const nx = SET[setPos];
  if (!nx) {
    // the card is done: replays are an encore, not a loop back to the end
    const enc = SETKEY[mode] && !['list', 'photo', 'toast', 'awards'].includes(mode);
    b.dataset.m = enc ? mode : mode === 'cloud' ? 'song' : 'cloud';
    b.textContent = enc ? `encore: ${MODES[mode].title} · space` : mode === 'cloud' ? 'that was the night. 2 for an encore.' : 'that was the night. 1 for the cloud.';
    return;
  }
  const more = nx.n - SETN[setPos];
  b.dataset.m = nx.m;
  b.textContent = nx.m === mode
    ? `next: ${nx.l}${more > 1 ? `, ${more} more rounds` : ''} · space`
    : `next up: ${nx.l} · press tab`;
}
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
  if (m === 'awards') { AW.i = -1; AW.lit = null; ++AW.tok; AW.pub = null; }
  if (m === 'toast') { ++TS.tok; toastEnter(); }
  if (m === 'photo') photoEnter();
  tallySet(m, 'enter');
  if (changed && !howSeen.has(m)) { howSeen.add(m); toggleHow(true, m); } else toggleHow(false);
  if (changed && savedAt) saveSoon();
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
  // once a round is revealed, whoever just scored wears a small +n beside their total
  const up = k => RD && !RD.open && RD.s0 ? (H.scores[k] || 0) - (RD.s0[k] || 0) : 0;
  rows.slice(0, 6).forEach(([k, v], i) => ol.append(el('li', { class: v === rows[0][1] && i < 3 ? 'lead' : '', title: 'click: +1 · shift-click: -1', onclick: e => handPoint(k, e.shiftKey ? -1 : 1) }, el('span', {}, nameOf(k)), el('span', {}, up(k) > 0 ? el('i', { class: 'up' + (performance.now() - (RD.tc || 0) > 1500 ? ' still' : '') }, '+' + up(k)) : null, String(v)))));
  if (rows.length > 6) ol.append(el('li', { class: 'more' }, el('span', {}, `and ${rows.length - 6} more`)));
}
// no phones tonight: the host gives points with a click
function handPoint(k, n) {
  H.scores[k] = Math.max(0, (H.scores[k] || 0) + n);
  if (!H.scores[k]) delete H.scores[k];
  renderBoard(); renderJoin(); saveSoon(); publish();
}
const hopsTxt = d => (Math.abs(d - Math.round(d)) < .05 ? String(Math.round(d)) : d.toFixed(1)) + ' hop' + (Math.abs(d - 1) < .05 ? '' : 's');
function renderSide() {
  const f = DV.facts, L = DV.list;
  // an empty room: the code to scan is the whole screen
  const lob = mode === 'cloud' && !L.length && wide() && !DEMO;
  if (lob && $('#lobby').classList.contains('hide')) drawQR();
  $('#lobby').classList.toggle('hide', !lob);
  const box = $('#cloud-facts'), pbox = $('#pairs-facts');
  box.textContent = ''; pbox.textContent = '';
  const fact = (k, v, cls, s) => el('div', { class: 'fact' }, el('div', { class: 'k' }, k), el('div', { class: 'v ' + (cls || '') }, v), s ? el('div', { class: 's' }, s) : null);
  if (L.length < 2) {
    box.append(fact('on the map', String(L.length), '', L.length ? 'one more and the map wakes up.' : wide() ? 'scan the code to get on the map.' : 'open join (j) and scan the code.'));
    return;
  }
  box.append(fact('the middle of the room', L[f.center].n, 'mint'));
  if (L.length >= 3 && f.outlier >= 0) box.append(fact('the wildcard', L[f.outlier].n, 'ice'));
  if (f.bridge) box.append(fact('the bridge', M.artistName(f.bridge), 'ice', `links ${f.bridgeCount} pairs of you`));
  const D = DV.D;
  pbox.append(
    fact('closest pair', `${L[f.closest[0]].n} + ${L[f.closest[1]].n}`, 'mint', `${Gr.score(D[f.closest[0]][f.closest[1]])} · ${hopsTxt(D[f.closest[0]][f.closest[1]])}`),
    fact('farthest pair', `${L[f.farthest[0]].n} + ${L[f.farthest[1]].n}`, 'rose', `${Gr.score(D[f.farthest[0]][f.farthest[1]])} · ${D[f.farthest[0]][f.farthest[1]] >= Gr.FAR ? 'worlds apart' : hopsTxt(D[f.farthest[0]][f.farthest[1]])}`),
    fact('the middle', L[f.center].n, '', `${f.mean[f.center].toFixed(1)} hops from everyone, on average`));
  if (f.widest >= 0) pbox.append(fact('widest taste', L[f.widest].n, '', `own picks ${f.widestHops >= Gr.FAR ? 'worlds apart' : hopsTxt(f.widestHops) + ' apart'}`));
  if (f.bridge) pbox.append(fact('the bridge', M.artistName(f.bridge), 'ice'));
  if (mode === 'walk') fillWalkSelects();
  if (mode === 'photo') renderPhotoList();
}
let vol = 1, footMsg = '', footMsgT = 0;
function footNote(t) { footMsg = t; footMsgT = Date.now(); footStats(); }
function footStats() {
  if (footMsg && Date.now() - footMsgT < 2500) { setText('#foot-stats', footMsg); hopRefresh(); return; }
  const s = Gr.size();
  const pend = M.pending();
  if (mode === 'teams' && H.teams) teamsTexts();
  setText('#foot-stats', `${DV.list.length} on the map · ${s.nodes.toLocaleString()} artists mapped · ${s.links.toLocaleString()} links${pend && !(RD && RD.open) ? ` · ${pend} lookup${pend === 1 ? '' : 's'} waiting` : ''}`);
  hopRefresh();
}
function hopRefresh() {
  if (!RD || !RD.open) return;
  const line = roundLine();
  if (RD.type === 'who') setText('#k-hop', `round ${songRound} · ${line}`);
  else if (RD.type === 'twin') setText('#k-hop', line);
  else if (RD.type === 'hops') setText('#k-hop', 'bets · ' + line);
  else if (RD.type === 'steer') setText('#k-hop', `hop ${ST.steps + 1} · shortest ${ST.best} · ` + line);
  else if (RD.type === 'odd' && OD.playing >= 0) setText('#k-hop', `${['one', 'two', 'three'][OD.playing]} · ` + line);
  else if (RD.type === 'odd') setText('#k-hop', line);
  else if (RD.hp !== undefined) setText('#k-hop', RD.hp + line);
}

// ---------- nav, keys, idle ----------
function setupNav() {
  document.querySelectorAll('#modes button[data-mode]').forEach(b => b.addEventListener('click', () => {
    $('#more').classList.add('hide'); $('#more-btn').setAttribute('aria-expanded', 'false');
    if (b.dataset.mode === 'join') toggleBig(); else if (!(b.dataset.mode === mode && ((RD && RD.open) || (BD.active && !BD.final)))) enterMode(b.dataset.mode);
  }));
  $('#more-btn').addEventListener('click', e => { e.stopPropagation(); const o = $('#more').classList.toggle('hide'); $('#more-btn').setAttribute('aria-expanded', String(!o)); });
  document.addEventListener('click', e => { if (!e.target.closest('#more')) { $('#more').classList.add('hide'); $('#more-btn').setAttribute('aria-expanded', 'false'); } });
  $('#team-merge').addEventListener('click', mergeTeams);
  const keys = { 1: 'cloud', 2: 'song', 3: 'odd', 4: 'steer', 5: 'twin', 6: 'hops', 7: 'sing', 8: 'awards', 9: 'bday', 0: 'toast', p: 'photo', l: 'list', w: 'walk', a: 'awards', t: 'toast', s: 'sing' };
  $('#next-up').addEventListener('click', () => { const m = $('#next-up').dataset.m; if (m) enterMode(m); });
  nextUp();
  document.addEventListener('click', e => { const b = e.target.closest('#host button'); if (b && e.detail) b.blur(); }, true);
  let armed = '', armedT = 0;
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#hand').classList.contains('hide') || !$('#bulk').classList.contains('hide')) return;
    if (e.key === 'Escape') { $('#more').classList.add('hide'); toggleBig(false); toggleHow(false); return; }
    wake();
    if (!$('#bigjoin').classList.contains('hide') && !['m', 'f', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); toggleBig(false); if (e.key === 'g') toggleJoin(true); return; }
    if (!$('#howcard').classList.contains('hide') && !['m', 'f', 'ArrowUp', 'ArrowDown'].includes(e.key) && !keys[e.key]) { e.preventDefault(); toggleHow(false); return; }
    if (e.key === 'h') { toggleHow(); return; }
    if (e.key === 'Tab') { e.preventDefault(); const b = $('#next-up'), m = b && b.dataset.m; if (m && m !== mode) { if (!busy()) enterMode(m); else footNote('finish this round first: space'); } else { const f = GO[mode]; if (f) f(); } return; }
    if (e.key === 'm') { player.muted = !player.muted; if (player.master) player.master.gain.value = player.muted ? 0 : vol; footNote(player.muted ? 'sound off · m turns it on' : 'sound on'); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); vol = clamp(vol + (e.key === 'ArrowUp' ? .1 : -.1), 0, 1); if (player.master && !player.muted) player.master.gain.value = vol; footNote(`volume ${Math.round(vol * 100)}`); return; }
    if (keys[e.key]) {
      e.preventDefault();
      const m = keys[e.key];
      if (m === mode && busy()) return;
      if (busy() && (armed !== e.key || Date.now() - armedT > 1500)) { armed = e.key; armedT = Date.now(); footNote(`press ${e.key} again to leave this round`); return; }
      armed = '';
      enterMode(m);
    }
    else if (e.key === 'j') toggleBig();
    else if (e.key === 'g') toggleJoin();
    else if (e.key === 'K') savePoster();
    else if (e.key === 'k') footNote('shift+k saves the poster');
    else if (e.key === 'e' && mode === 'bday' && BD.active && !BD.final && !BD.prep && !(RD && RD.open)) { BD.rush = true; ++WK.tok; }
    else if (e.key === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (e.key === ' ' || e.key === 'Enter') { if (e.target.closest('button')) return; e.preventDefault(); const f = GO[mode]; if (f) f(); }
    else if (e.key === 'n' || e.key === 'ArrowRight') {
      if (WK.skip) WK.skip();
      else if (mode === 'walk') GO.walk();
      else if (mode === 'song' || mode === 'hops' || mode === 'twin' || mode === 'odd' || mode === 'nth' || mode === 'match' || mode === 'guilty' || mode === 'decade') GO[mode]();
    }
  });
  let idleT = 0;
  const busy = () => !!((RD && RD.open) || (BD.active && !BD.final) || ST.active || (mode === 'hops' && RD && !RD.res));
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
// the code to scan, as big as the TV allows; any key puts the game back
function toggleBig(force) {
  const b = $('#bigjoin');
  const show = force !== undefined ? force : b.classList.contains('hide');
  b.classList.toggle('hide', !show);
  if (show) { drawQR(); bigJoinText(); joinCalm(); }
}
function bigJoinText() {
  if ($('#bigjoin').classList.contains('hide')) return;
  const n = [...H.guests.values()].filter(g => g.src === 'p2p').length;
  const late = JOINS.slice(-3).reverse().map(j => j.n);
  setText('#bj-n', n ? `${n} phone${n === 1 ? '' : 's'} in${late.length ? ` · just in: ${andList(late)}` : ''}` : 'be the first one in');
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
  setText('#join-code', K && !DEMO ? 'room ' + K.code : '');
  setText('#lobby-code', K && !DEMO ? `room ${K.code} · the password is on the card` : '');
  for (const c2 of [$('#qr2'), $('#qr3')]) if (c2) { c2.width = c.width; c2.height = c.height; c2.getContext('2d').drawImage(c, 0, 0); }
  setText('#bj-url', u.host + (u.pathname.length > 1 ? '\n' + u.pathname.replace(/\/$/, '') : ''));
  setText('#bj-code', K && !DEMO ? 'room ' + K.code : '');
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
      el('button', { type: 'button', title: 'give a point by hand', onclick: () => { handPoint(g.k, 1); } }, `+1 · ${H.scores[g.k] || 0}`),
      el('button', { type: 'button', 'aria-pressed': String(H.hostKey === g.k), title: 'flag the birthday baby for the birthday round', onclick: () => { setHost(H.hostKey === g.k ? null : g.k); } }, 'birthday baby'),
      el('button', { type: 'button', 'aria-label': `remove ${g.n}`, onclick: () => { H.guests.delete(g.k); delete H.scores[g.k]; if (H.hostKey === g.k) H.hostKey = null; H.gv++; saveSoon(); dataChanged(); } }, '×')));
  }
}
function setupJoin() {
  $('#bj-list').addEventListener('click', e => { e.stopPropagation(); toggleBig(false); toggleJoin(true); });
  $('#bigjoin').addEventListener('click', e => { if (!e.target.closest('button')) toggleBig(false); });
  try { localStorage.setItem('party.probe', '1'); localStorage.removeItem('party.probe'); } catch (e) { setText('#join-msg', 'this browser is not saving the room. tap “save room file” now and then.'); }
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
// takes "name | song - artist | song - artist | artist", a partiful csv, or answers pasted the way people texted them
const BK = { people: [], busy: false, tok: 0 };
const EMAIL = /\S+@\S+\.\S+/, PHONE = /^[+(]?\d[\d\s().\-]{6,}$/;
const NAMEH = /^(name|guest|guest name|first name|full name|invitee)$/i;
const SKIPH = /^(status|rsvp|e-?mail|phone|mobile|cell|number|date|time|created|updated|timestamp|plus|\+\d|guests|party|count|response|attending|id|notes?|last name|surname)\b|e-?mail|phone|mobile/i;
const junk = v => !v || EMAIL.test(v) || PHONE.test(v) || /^(yes|going|maybe|not going|declined|attending|invited|waitlist|pending|\d{1,2})$/i.test(v) || /^\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/.test(v);
// "idk", "na", "will trust your taste": an empty slot, never a guess
const NOPE = /^(idk|i ?dk|dunno|i ?dont know|dont know|not sure|unsure|n ?a|na|no|nope|none|nothing|nah|pass|skip|tbd|tba|tbc|x|later|anything|any|no idea|cant think|cant decide|hm+|um+|eh)$/;
const NOPE_IN = /trust your taste|you pick|you choose|surprise me|up to you|your call|need to think|let me (think|text|get back)|text you|get back to you|no idea|cant think|can t think|ill think|will think/;
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
const nonAnswer = s => { const n = M.norm(s); return !n || NOPE.test(n) || NOPE_IN.test(n); };
// shorthand people actually type
const ALIAS = { mcr: 'My Chemical Romance', lts: 'Ling tosite sigure', rhcp: 'Red Hot Chili Peppers', fob: 'Fall Out Boy', patd: 'Panic! At The Disco', 'p!atd': 'Panic! At The Disco', nin: 'Nine Inch Nails', bmth: 'Bring Me The Horizon', soad: 'System Of A Down', atl: 'All Time Low', gnr: "Guns N' Roses", ccr: 'Creedence Clearwater Revival', elo: 'Electric Light Orchestra', tswift: 'Taylor Swift', '1d': 'One Direction', '5sos': '5 Seconds of Summer', bsb: 'Backstreet Boys', rhcps: 'Red Hot Chili Peppers', tpab: 'To Pimp a Butterfly', mgmt: 'MGMT' };
const expand = s => s.replace(/[\p{L}\p{N}!]+/gu, w => ALIAS[w.toLowerCase()] || w);
const HOSTNAME = /^(the )?(host|birthday baby|birthday|bday baby|me|myself)$/i;
const SLOTRE = /(?:^|[\s,;.])((?:my\s+)?forever(?:\s+song)?|all[- ]time|(?:me|song)?\s*(?:@|at)\s*16|sixteen|(?:me\s+)?now|right[- ]?now(?:\s+artist)?|lately|currently|guilty(?:\s+pleasure)?)\s*[:=]\s*/gi;
const NUMRE = /(?:^|[\s,;])([1-3])\s*[.)]\s*(?=\D)/g;
const slotOfLabel = l => /forever|all/i.test(l) ? 0 : /16|sixteen/i.test(l) ? 1 : /guilty/i.test(l) ? 'gp' : 2;
const bare = s => (s || '').replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
const tidy = v => (v || '').replace(/[“”„"]/g, '').replace(/[‘’]/g, "'").replace(/^[\s"'*•\-–—]+|[\s"',.;:]+$/g, '').trim();

// one person's answers, in whatever shape they were texted, cut into slots
function splitRaw(raw) {
  const s = tidy(raw);
  if (!s) return { items: [] };
  const cut = (marks, slotOf) => marks.map((m, i) => ({ typed: tidy(s.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : s.length)), s: slotOf(m) }));
  const lab = [...s.matchAll(SLOTRE)];
  if (lab.length) return { items: cut(lab, m => slotOfLabel(m[1])) };
  const num = [...s.matchAll(NUMRE)];
  if (num.length >= 2 || (num.length === 1 && num[0].index === 0)) return { items: cut(num, m => +m[1] - 1) };
  const parts = s.split(/\s*(?:;|\n|\s\/\s)\s*/).map(tidy).filter(Boolean);
  if (parts.length > 1) return { items: parts.map((typed, i) => ({ typed, s: i })) };
  if (s.includes(',')) return { items: s.split(',').map(tidy).filter(Boolean).map(typed => ({ typed })), loose: true };
  return { items: [{ typed: s, s: 0 }] };
}
const cleanName = n => {
  n = tidy((n || '').replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').replace(/^\s*\d{1,2}[.)]\s+/, '').replace(/\?+$/, ''));
  return !n || EMAIL.test(n) || PHONE.test(n) ? '' : n.slice(0, 24);
};
function parseBulk(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const first = lines.find(l => l.trim()) || '';
  const tabs = (first.match(/\t/g) || []).length, commas = (first.match(/,/g) || []).length;
  const d = tabs && tabs >= commas ? '\t' : ',';
  const head = csvRows(first, d)[0] || [];
  const ni = head.findIndex(h => NAMEH.test(h.trim()));
  const out = [];
  if (ni >= 0 && !first.includes('|')) {
    // a spreadsheet export with a header row (partiful, google forms)
    const rows = csvRows(text, d);
    const cols = rows[0].map((h, i) => ({ i, gp: /guilty/i.test(h), slot: /forever/i.test(h) ? 0 : /\b(16|sixteen)\b/i.test(h) ? 1 : /right ?now|lately|recent/i.test(h) ? 2 : -1 }))
      .filter(c => c.i !== ni && (c.gp || !SKIPH.test(rows[0][c.i].trim())));
    const ans = cols.filter(c => !c.gp);
    if (ans.length === 3 && ans.every(c => c.slot < 0)) ans.forEach((c, k) => { c.slot = k; });
    for (const r of rows.slice(1)) {
      const n = cleanName(r[ni]); if (!n) continue;
      const items = []; let loose = false;
      for (const c of cols) {
        const v = (r[c.i] || '').trim();
        if (junk(v)) continue;
        if (c.gp) items.push({ typed: tidy(v), s: 'gp' });
        else if (c.slot >= 0) items.push({ typed: tidy(v), s: c.slot });
        else { const sp = splitRaw(v); loose = loose || sp.loose; items.push(...sp.items); }
      }
      out.push({ n, items, loose });
    }
    return out;
  }
  for (let line of lines) {
    line = line.trim();
    if (!line || /^[-=_#*\s]+$/.test(line)) continue;
    // a line that only carries answers ("2) focus by brandy") belongs to the person above
    if (out.length && (/^[1-3]\s*[.)]/.test(line) || /^(my\s+)?(forever|me\s*@|me\s+at|song\s+at|me\s+now|right[- ]?now|guilty)/i.test(line))) {
      const p = out[out.length - 1];
      p.raw = (p.raw ? p.raw + ' ' : '') + line; continue;
    }
    let name, raw = '', cells = null;
    if (line.includes('|')) cells = line.split('|');
    else if (line.includes('\t')) cells = line.split('\t');
    if (cells) {
      cells = cells.map(c => c.trim());
      name = cells.shift();
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length === 1) raw = cells[0];
      else { out.push({ n: name, cells }); continue; }
    } else {
      const m = /^([^:,]{1,60}?)\s*[:,]\s*(.*)$/.exec(line);
      if (m && !SLOTRE.test(m[1] + ':')) { name = m[1]; raw = m[2]; } else { name = line; raw = ''; }
      SLOTRE.lastIndex = 0;
    }
    out.push({ n: name, raw });
  }
  return out.map(p => {
    const n = cleanName(p.n);
    if (!n) return null;
    let items = [], loose = false;
    if (p.cells) p.cells.slice(0, 4).forEach((c, i) => { const v = tidy(c); items.push({ typed: v, s: i < 3 ? i : 'gp' }); });
    else if (p.raw) { const sp = splitRaw(p.raw); items = sp.items; loose = !!sp.loose; }
    return { n, items, loose };
  }).filter(Boolean);
}

// "title - artist", "title by artist", "artist: title", "title, artist", or loose words; never a cover
async function resolveAnswer(raw, slot) {
  const s = tidy(raw);
  // a note in brackets can say anything ("will trust your taste"); judge only the answer itself
  if (!s || !bare(s) || nonAnswer(bare(s))) return { pick: null, how: 'empty' };
  if (slot === 2 && !/^(https?:\/\/|spotify:)/i.test(s) && !/\s(?:-|–|—|by)\s/i.test(s)) {
    const a = await M.artistByName(expand(s.replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').trim()));
    if (a && a.sim >= .9) return { pick: cleanPick({ k: 'a', aid: a.aid, an: a.an }), how: 'ok' };
  }
  if (/^(https?:\/\/|spotify:)/i.test(s)) {
    const r = await M.resolveLink(s);
    if (r && r.refuse) return { pick: null, how: 'none', note: r.refuse };
    if (r && r.picks) return { pick: cleanPick(r.picks[0]), how: 'ok' };
    if (!r || !r.query) return { pick: null, how: 'none', note: 'could not read that link' };
    const list = await M.search(r.query);
    if (r.kind === 'track') list.sort((a, b) => (b.k === 't') - (a.k === 't'));
    return list[0] ? { pick: cleanPick(list[0]), how: 'close', note: `from the ${r.from} link: ${r.query}` } : { pick: null, how: 'fail' };
  }
  const q = expand(s.replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim());
  const m = /^(.+?)\s+(?:-|–|—|by)\s+(.+)$/i.exec(q) || /^(.+?)\s*[,:]\s+(.+)$/.exec(q);
  let fallback = null;
  if (m) {
    const a = m[1].trim(), b = m[2].trim();
    let r = await M.findSong(a, b);
    if (!(r && r.how === 'song') && !/\sby\s/i.test(q)) { const r2 = await M.findSong(b, a); if (r2 && (r2.how === 'song' || !r)) r = r2; }
    if (r && r.how === 'song') return { pick: cleanPick(r.pick), how: r.artist.sim >= .9 ? 'ok' : 'close' };
    if (r && r.artist.sim >= .9) fallback = { pick: cleanPick(r.pick), how: 'artist', note: `${a} is not on deezer. their top songs play instead.` };
  }
  const look = async text => {
    const list = await M.search(text);
    const top = list[0];
    if (!top) return null;
    const nq = M.norm(text);
    const sure = top.k === 'a' ? M.sim(top.an, text) >= .9 : nq.includes(M.norm(bare(top.tt))) && nq.includes(M.norm(top.an));
    const twins = list.filter(x => x.k === 't' && M.norm(bare(x.tt)) === M.norm(bare(top.tt || '')) && x.aid !== top.aid).length;
    return { pick: cleanPick(top), how: sure ? 'ok' : 'close', note: !sure && top.k === 't' && twins ? 'more than one song has this name. check the artist.' : '', top };
  };
  let r = await look(m ? m[1] + ' ' + m[2] : q);
  // "portraits of tracey and diiv": two answers in one slot, keep the first
  if (!(r && r.how === 'ok') && /\s(and|&|or|\/)\s/i.test(q)) { const r1 = await look(q.split(/\s(?:and|&|or|\/)\s/i)[0]); if (r1 && (!r || r1.how === 'ok')) r = r1; }
  if (fallback && !(r && r.top.k === 't' && M.norm(bare(r.top.tt)) === M.norm(q))) return fallback;
  if (!r) return { pick: null, how: 'none' };
  delete r.top;
  return r;
}
// "venus fly trap brackence, take what you want, post malone": a song and its artist got split by a comma
async function mergeLoose(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i], nx = items[i + 1];
    if (nx && !nonAnswer(bare(it.typed)) && !nonAnswer(bare(nx.typed)) && !/\s-\s|\sby\s/i.test(it.typed)) {
      const a = await M.artistByName(expand(nx.typed));
      if (a && a.sim >= .9) {
        const r = await M.findSong(it.typed, a);
        if (r && r.how === 'song') { out.push({ typed: `${it.typed} - ${nx.typed}`, pre: { pick: cleanPick(r.pick), how: 'ok' } }); i++; continue; }
      }
    }
    out.push(it);
  }
  return out.map((x, i) => ({ ...x, s: i < 3 ? i : undefined })).filter(x => x.s !== undefined);
}
async function readOne(it) {
  it.done = false; it.pick = null; it.how = ''; it.note = ''; renderBulk();
  let r;
  try { r = it.pre || await resolveAnswer(it.typed, it.s); } catch (e) { r = { pick: null, how: 'fail' }; }
  delete it.pre;
  // an artist deezer links to nobody sits alone on the map and never reaches the birthday baby
  if (r.pick && (r.how === 'ok' || r.how === 'close')) {
    const rel = await M.related(r.pick.aid, 'hi').catch(() => null);
    if (rel && !rel.length) r = { ...r, how: 'close', note: `${r.pick.an} has no related artists on deezer, so this pick sits alone on the map. pick another if you can.` };
  }
  it.pick = r.pick; it.how = r.how; it.note = r.note || '';
  if (it.pick && it.s !== 'gp' && it.s !== undefined) it.pick.s = it.s;
  it.done = true;
}
async function bulkRead(text) {
  const tok = ++BK.tok;
  BK.people = parseBulk(text).map(p => ({ n: p.n, host: HOSTNAME.test(p.n), loose: p.loose, items: p.items.filter(it => it.s === 'gp' || it.s === undefined || it.s < 3).map(it => ({ ...it, pick: null, done: false })) }));
  const seenN = {};
  for (const p of BK.people) {
    if (p.host) p.n = HOSTN;
    // two people called sam stay two people
    const low = p.n.toLowerCase();
    seenN[low] = (seenN[low] || 0) + 1;
    if (seenN[low] > 1) p.n = `${p.n.slice(0, 21)} ${seenN[low]}`;
  }
  if (!BK.people.length) { setText('#b-msg', 'nobody found in that. one person per line: name | song - artist | song - artist | artist'); renderBulk(); return; }
  BK.busy = true; BK.f0 = M.stats.fails; renderBulk();
  let done = 0; const total = () => BK.people.reduce((a, p) => a + p.items.length, 0);
  const queue = BK.people.slice();
  const work = async () => {
    for (let p; (p = queue.shift());) {
      if (p.loose) { p.items = await mergeLoose(p.items); p.loose = false; }
      for (const it of p.items) {
        if (tok !== BK.tok) return;
        await readOne(it);
        setText('#b-msg', `looking up ${++done} of ${total()}`);
        renderBulk();
      }
    }
  };
  await Promise.all([work(), work(), work()]);
  if (tok !== BK.tok) return;
  BK.busy = false;
  bulkSummary();
  renderBulk();
}
function bulkSummary() {
  const its = BK.people.flatMap(p => p.items);
  const check = its.filter(i => i.how === 'close' || i.how === 'artist').length, bad = its.filter(i => i.how === 'none' || i.how === 'fail').length;
  const nobody = BK.people.filter(p => !p.items.some(i => i.pick && i.s !== 'gp')).length;
  if (bad && !its.some(i => i.pick) && M.stats.fails > (BK.f0 || 0)) { setText('#b-msg', `${BK.people.length} people, but the music search is not answering, so nothing could be looked up. check the wifi, then read again.`); return; }
  setText('#b-msg', `${BK.people.length} people. ${bad ? `${bad} not found (red). ` : ''}${check ? `${check} to check (yellow): tap fix if it is wrong. ` : ''}${nobody ? `${nobody} with no picks yet: they can join by phone and still play. ` : ''}then add all.`);
}
const HOWTXT = { ok: '', close: 'check', artist: 'artist only', empty: 'left empty', none: 'not found', fail: 'lookup failed' };
function renderBulk() {
  const ul = $('#b-list');
  ul.textContent = '';
  for (const p of BK.people) {
    const pu = el('ul', { class: 'bk-picks' });
    for (const it of p.items) {
      const tag = it.s === 'gp' ? 'guilty · ' : it.s !== undefined ? SLOTS[it.s].n + ' · ' : '';
      const cls = !it.done ? '' : it.how === 'ok' ? 'ok' : it.how === 'close' || it.how === 'artist' ? 'warn' : it.how === 'empty' ? 'empty' : 'no';
      const li = el('li', {},
        el('span', { class: 'ty' }, tag + it.typed),
        el('span', { class: 'mt ' + cls }, !it.done ? 'looking' : it.pick ? pickLabel(it.pick) : HOWTXT[it.how] || 'not found',
          it.done && it.pick && HOWTXT[it.how] ? el('em', {}, ' · ' + HOWTXT[it.how]) : null,
          it.note ? el('small', {}, it.note) : null),
        BK.busy ? null : el('button', { type: 'button', onclick: () => { it.fixing = !it.fixing; renderBulk(); } }, it.how === 'fail' ? 'retry' : 'fix'),
        BK.busy ? null : el('button', { type: 'button', onclick: () => { p.items = p.items.filter(x => x !== it); renderBulk(); } }, 'drop'));
      if (it.fixing) {
        const box = el('div', { class: 'picker' });
        li.append(box);
        const q0 = it.typed && !nonAnswer(bare(it.typed)) ? expand(it.typed.replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').replace(/\s+[-–—]\s+|\s+by\s+|\s*[,:]\s+/gi, ' ').trim()) : '';
        const pk = picker(box, { max: 1, q0, labels: [{ l: 'tap the right one, or search again', h: 'an artist, a song, or a link' }], onChange: () => { const g = pk.get()[0]; if (g) { it.pick = { ...g, s: it.s === 'gp' ? undefined : it.s }; it.how = 'ok'; it.note = ''; it.done = true; it.fixing = false; renderBulk(); } } });
      }
      pu.append(li);
    }
    if (!BK.busy && p.items.filter(i => i.s !== 'gp').length < 3) {
      pu.append(el('li', { class: 'bk-more' }, el('button', { type: 'button', onclick: () => {
        const used = new Set(p.items.map(i => i.s)); const s = [0, 1, 2].find(x => !used.has(x));
        p.items.push({ typed: '', s: s === undefined ? 0 : s, pick: null, done: true, how: 'empty', fixing: true }); p.items.sort((a, b) => (a.s === 'gp') - (b.s === 'gp') || a.s - b.s); renderBulk();
      } }, 'add a pick')));
    }
    ul.append(el('li', { class: 'bk-p' + (p.host ? ' host' : '') },
      el('div', { class: 'bk-h' }, el('input', { type: 'text', value: p.n, maxlength: 24, 'aria-label': 'name', readonly: BK.busy || p.host, oninput: e => { p.n = e.target.value; } }),
        p.host ? el('span', { class: 'bk-tag' }, 'the birthday baby') : null,
        BK.busy ? null : el('button', { type: 'button', onclick: () => { BK.people = BK.people.filter(x => x !== p); renderBulk(); } }, 'drop')),
      pu));
  }
  $('#b-add').disabled = BK.busy || !BK.people.some(p => p.items.some(i => i.pick && i.s !== 'gp'));
}
function setupBulk() {
  const close = () => { BK.tok++; BK.busy = false; $('#bulk').classList.add('hide'); };
  $('#join-bulk').addEventListener('click', () => { $('#bulk').classList.remove('hide'); $('#b-text').focus(); });
  $('#b-close').addEventListener('click', close);
  $('#b-read').addEventListener('click', () => { const t = $('#b-text').value; if (t.trim()) bulkRead(t); });
  $('#b-file').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) bulkRead(await f.text()); });
  $('#b-add').addEventListener('click', BK.add = () => {
    let n = 0; const left = [];
    for (const p of BK.people) {
      const picks = p.items.filter(i => i.pick && i.s !== 'gp').map(i => i.pick).slice(0, 3);
      const sec = p.items.find(i => i.s === 'gp' && i.pick);
      const name = p.n.trim();
      if (!picks.length || !name) { left.push(p); continue; }
      // pasting the list again updates people instead of doubling them
      const same = [...H.guests.values()].find(g => g.src === 'hand' && g.n.toLowerCase() === name.toLowerCase());
      const k = same ? same.k : 'h-' + rid();
      upsertGuest(k, { n: name, picks, gp: sec && sec.pick }, 'hand'); n++;
      if (p.host) H.hostKey = k;
    }
    BK.people = left; renderBulk(); renderJoin(); saveSoon();
    if (left.length) setText('#b-msg', `added ${n}. still listed: ${left.length} with no picks. they can join by phone, or drop them here.`);
    else { setText('#b-msg', `added ${n}.`); setTimeout(close, 900); }
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
  drawCloud(c, 0, 0, { rect: { x: 240, y: 620, w: PW - 480, h: 1750 }, fs: 40, poster: true, nameOf: g => g.k === H.hostKey ? 'the birthday baby' : g.n });
  W = saveW; Hh = saveH;
  c.fillStyle = COL.ink; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.font = '600 150px "Instrument Sans", sans-serif';
  c.fillText('a birthday map', 160, 300);
  c.font = '500 34px "IBM Plex Mono", monospace'; c.fillStyle = COL.dim;
  const s = Gr.size();
  const day = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toLowerCase();
  c.fillText(`${day} · ${DV.list.length} of us · ${s.nodes.toLocaleString()} artists`, 164, 380);
  const f = DV.facts, L = DV.list;
  const lines = [];
  if (L.length >= 2) {
    lines.push(['the middle of the room', L[f.center].n, COL.mint], ['the wildcard', L[f.outlier].n, COL.ice], ['closest pair', `${L[f.closest[0]].n} + ${L[f.closest[1]].n}`, COL.ink]);
    if (f.bridge) lines.push(['the bridge', M.artistName(f.bridge), COL.ice]);
  }
  lines.forEach(([k, v, col], i) => {
    const x = 160 + (i % 2) * 1060, y = 2560 + Math.floor(i / 2) * 170;
    c.font = '500 30px "IBM Plex Mono", monospace'; c.fillStyle = COL.faint; c.fillText(k, x, y);
    c.font = '600 64px "Instrument Sans", sans-serif'; c.fillStyle = col; c.fillText(v, x, y + 74);
  });
  c.font = '400 26px "IBM Plex Mono", monospace'; c.fillStyle = COL.faint;
  c.fillText('made from everyone’s picks. happy birthday.', 160, PH - 90);
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
  // no picks is fine: you still vote in every round
  const upd = () => { $('#g-send').disabled = !$('#g-name').value.trim(); setText('#g-send', pk.get().length ? 'put me on the map' : 'just play along'); dupCheck(); };
  // two people called Sam: the screen will say Sam 2, so say it here first
  const dupCheck = () => {
    const nm = $('#g-name').value.trim().toLowerCase();
    const twin = nm && lastShow && (lastShow.roster || []).find(g => !g.h && g.k !== 'p' + me.id && g.n.toLowerCase() === nm);
    setText('#g-dup', twin ? `someone here is already ${twin.n}. add an initial so the screen can tell you apart.` : '');
  };
  $('#g-name').addEventListener('input', upd);
  const myKey = 'party.me.' + K.roomId;
  let NETg = null, lastShow = null, voted = {};
  window.__party = { get show() { return lastShow; }, get net() { return NETg; } };
  const saveMe = async () => { if (!DEMO) lsSet(myKey, JSON.stringify(await seal(K.key, me))); };
  const raw = !DEMO && lsGet(myKey);
  if (raw) { try { Object.assign(me, await unseal(K.key, JSON.parse(raw))); } catch (e) { /* other password */ } }
  // what this phone typed before retyping the password comes along
  let carry = null;
  try { carry = JSON.parse(sessionStorage.getItem('party.carry') || 'null'); sessionStorage.removeItem('party.carry'); } catch (e) { carry = null; }
  if (carry && !me.name) { me.name = String(carry.name || '').slice(0, 24); me.picks = Array.isArray(carry.picks) ? carry.picks.map(cleanPick).filter(Boolean) : []; me.gp = cleanPick(carry.gp); me.joined = !!carry.joined; $('#g-name').value = me.name; pk.set(me.picks); gpk.set(me.gp ? [me.gp] : []); if (me.joined) saveMe(); }
  $('#g-retype').addEventListener('click', () => {
    try {
      sessionStorage.setItem('party.carry', JSON.stringify({ name: me.name || $('#g-name').value, picks: me.picks.length ? me.picks : pk.get(), gp: me.gp, joined: !!me.joined }));
      sessionStorage.removeItem('party.pw');
    } catch (e) { /* storage blocked: the form starts empty */ }
    location.replace(location.pathname + location.search);
  });
  $('#g-reload').addEventListener('click', () => location.reload());
  let netFail = false;
  const noRTC = !DEMO && typeof RTCPeerConnection !== 'function';
  if (!/^[a-f0-9]{16}$/.test(me.id || '')) me.id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

  let shownSig = '';
  const showRoom = () => {
    $('#g-form').classList.add('hide'); $('#g-room').classList.remove('hide');
    shownSig = '';
    roomText();
    render();
  };
  // what the phone says about you follows the screen: your name there, and picks that came from the host's list
  const roomText = () => {
    const mine = lastShow && (lastShow.roster || []).find(g => g.k === 'p' + me.id);
    const nm = mine ? mine.n : me.name;
    const labels = me.picks.length ? null : mine && mine.p.length ? mine.p : null;
    const listed = DEMO || !!mine;
    const sig = nm + '|' + (labels || []).join('|') + '|' + me.picks.length + '|' + listed;
    if (sig === shownSig) return;
    shownSig = sig;
    const has = me.picks.length || labels;
    // only the screen can say you're on it
    setText('#g-hi', !listed ? 'saved. finding the screen…' : has ? `you're on the map, ${nm}.` : `you're in, ${nm}.`);
    const ul = $('#g-mine'); ul.textContent = '';
    if (nm !== me.name) ul.append(el('li', {}, el('span', {}, `the screen calls you ${nm}.`)));
    for (const p of me.picks) ul.append(el('li', {}, el('b', {}, p.k === 't' ? p.tt : p.an), el('span', {}, (slotName(p) ? slotName(p) + ' · ' : '') + (p.k === 't' ? `song · ${p.an}` : 'artist'))));
    if (labels) for (const l of labels) ul.append(el('li', {}, el('b', {}, l), el('span', {}, 'your pick')));
    if (!has) ul.append(el('li', {}, el('span', {}, 'no picks needed. you vote in every round. add picks any time to get a dot on the map.')));
    if (me.gp) ul.append(el('li', {}, el('b', {}, me.gp.k === 't' ? me.gp.tt : me.gp.an), el('span', {}, 'guilty pleasure · secret until the guilty round')));
    setText('#g-edit', has ? 'change my picks' : 'add picks');
  };
  const sendMe = () => { if (NETg) NETg.guest.set({ id: me.id, n: me.name, picks: me.picks, gp: me.gp, claim: me.claim || undefined, t: Date.now() }).catch(() => {}); };
  $('#g-send').addEventListener('click', async () => {
    wakeLock();
    me.name = $('#g-name').value.trim().slice(0, 24);
    me.picks = pk.get(); me.gp = gpk.get()[0] || null; me.joined = true;
    await saveMe();
    sendMe();
    showRoom();
  });
  const renderClaim = () => {
    const box = $('#g-claim');
    const list = lastShow && !$('#g-form').classList.contains('hide') ? (lastShow.roster || []).filter(g => g.h) : [];
    box.classList.toggle('hide', !list.length);
    const wrap = $('#g-claim-opts'), sig = list.map(g => g.k).join(',');
    if (wrap.dataset.sig === sig) return;
    wrap.dataset.sig = sig; wrap.textContent = '';
    for (const g of list) wrap.append(el('button', { type: 'button', onclick: async () => {
      me.name = g.n; me.claim = g.k; me.picks = []; me.gp = gpk.get()[0] || null; me.joined = true;
      await saveMe(); sendMe(); showRoom();
    } }, g.n));
  };
  $('#g-edit').addEventListener('click', () => {
    $('#g-room').classList.add('hide'); $('#g-form').classList.remove('hide');
    $('#g-name').value = me.name; pk.set(me.picks); gpk.set(me.gp ? [me.gp] : []); upd();
  });

  const modeNames = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.title]));
  function render() {
    const s = lastShow;
    const st = $('#g-status');
    const stuck = !DEMO && !s && (netFail || waited > 14);
    if (DEMO) st.textContent = 'demo: nothing leaves this phone.';
    else if (noRTC) st.textContent = "this browser can't join the game. open the link in Safari or Chrome (tap ••• then 'open in browser').";
    else if (!NETg) st.textContent = 'connecting to the room';
    else if (!s && netFail) st.textContent = "found the room, but this network can't reach the screen. join the house wifi, then tap reload.";
    else if (!s) st.textContent = waited > 14 ? `no screen yet. the screen shows its room code at the top left. if it isn't ${K.code}, retype the password. if it is, join the house wifi and reload.` : 'looking for the screen';
    else st.textContent = `the screen: ${modeNames[s.mode] || s.mode}`;
    { const hb = $('#g-how'), hw = s && s.hw; hb.classList.toggle('hide', !hw); const sig = hw ? hw.join('|') + (s.hs || '') : ''; if (hb.dataset.sig !== sig) { hb.dataset.sig = sig; hb.textContent = ''; if (hw) { hb.append(el('p', { class: 'field-h' }, `how ${hw[0]} works`)); const ol = el('ol', {}); hw.slice(1).forEach(t => ol.append(el('li', {}, String(t)))); hb.append(ol); if (s.hs) { const d = el('details', {}, el('summary', {}, 'the science')); d.append(el('p', {}, String(s.hs))); hb.append(d); } } } }
    $('#g-fix').classList.toggle('hide', !stuck);
    $('#g-bigcode').classList.toggle('hide', !stuck);
    setText('#g-bigcode', stuck ? `your code: ${K.code}` : '');
    renderClaim();
    if (!$('#g-room').classList.contains('hide')) roomText();
    const my = 'p' + me.id;
    const pts = s && s.scores && my ? s.scores[my] || 0 : 0;
    setText('#g-score', s ? `your points: ${pts}` : '');
    const r = s && s.round;
    const box = $('#g-vote');
    const res = $('#g-res');
    const tm = s && s.teams;
    setText('#g-team', tm && tm.m[my] !== undefined ? `you are on ${tm.n[tm.m[my]]}. ${tm.n[0]} ${tm.tot[0]} · ${tm.n[1]} ${tm.tot[1]}` : '');
    try { renderKeep(s, my); } catch (e) { $('#g-keep').classList.add('hide'); $('#g-room').classList.remove('keeping'); }
    try { renderFin(s, my); } catch (e) { $('#g-fin').classList.add('hide'); }
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
      if (!opts) opts = (s.guests || []).filter(g => !((r.type === 'twin' || r.type === 'guilty' || r.type === 'who') && g.k === my)).map(g => ({ v: g.k, l: g.n }));
      const wrap = $('#g-opts');
      const sig = r.id + ':' + opts.map(o => o.v).join(',');
      if (wrap.dataset.sig !== sig) {
        if (!wrap.dataset.sig || wrap.dataset.sig.split(':')[0] !== String(r.id)) setTimeout(() => box.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
        wrap.dataset.sig = sig; wrap.textContent = '';
        for (const o of opts) wrap.append(el('button', { type: 'button', 'data-v': String(o.v), 'aria-pressed': 'false', onclick: () => cast(r, o.v) }, o.l));
      }
      const mine = voted[r.id];
      [...wrap.children].forEach(b => { const on = mine !== undefined && b.dataset.v === String(mine); b.setAttribute('aria-pressed', String(on)); b.disabled = mine !== undefined; });
      setText('#g-vmsg', mine !== undefined ? 'locked in. eyes on the screen.' : '');
    } else {
      box.classList.add('hide');
      if (r.res && !$('#g-room').classList.contains('keeping')) {
        const got = my && (r.res.right || []).includes(my);
        const mine = r.type === 'twin' && r.res.tw && r.res.tw[my];
        res.textContent = (mine ? `the map says your twin is ${mine}. ` : '') + String(r.res.text || '').replace(/[^.!?]$/, '$&.') + (voted[r.id] !== undefined ? (got ? ' you got a point.' : '') : '');
        res.classList.toggle('ok', !!got);
      } else res.textContent = '';
    }
  }
  let keepSig = '';
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  function renderKeep(s, my) {
    const kp = s && s.keep, c = kp && kp.c && kp.c[my];
    $('#g-keep').classList.toggle('hide', !c);
    $('#g-room').classList.toggle('keeping', !!c);
    if (!c) { keepSig = ''; return; }
    const sig = JSON.stringify(c) + '|' + kp.xy.length + '|' + innerWidth;
    if (sig === keepSig) return;
    const first = !keepSig;
    keepSig = sig;
    setText('#gk-name', c.n);
    const ul = $('#gk-facts'); ul.textContent = '';
    const row = (b, t) => ul.append(el('li', {}, el('b', {}, b), el('span', {}, t)));
    if (c.home) row(`${c.home} road${c.home === 1 ? '' : 's'}`, 'led to you tonight');
    if (c.tw) row(c.tw, 'your taste twin');
    if (c.hp != null) row(c.hp === 0 ? 'zero hops' : `${c.hp} hop${c.hp === 1 ? '' : 's'}`, 'from your pick to the birthday baby');
    if (c.sp) row(c.sp, 'your spot on the map');
    if (c.i < 0 && !c.home) row('no dot tonight', 'you played every round anyway. add picks any time to get one.');
    const pts = `${c.pt || 0} point${c.pt === 1 ? '' : 's'}`;
    row(c.rk ? `${pts} · ${ord(c.rk)} place` : pts, 'your night in the game');
    const bag = $('#gk-bag'); bag.textContent = '';
    const lk = (q, tid) => el('span', { class: 'a' }, el('a', { href: M.spotifyLink(q, tid), target: '_blank', rel: 'noopener noreferrer' }, 'spotify'), el('a', { href: M.appleLink(q, tid), target: '_blank', rel: 'noopener noreferrer' }, 'apple'));
    const gift = (h, t, s, q, tid) => bag.append(el('li', {}, el('span', { class: 't' }, el('span', {}, h), el('b', {}, t), s ? el('span', {}, s) : ''), lk(q, tid)));
    if (c.gf) gift(c.i < 0 ? `a song from ${c.gf[3]}, the middle of the room` : `a song from ${c.gf[3]}, the closest to you`, String(c.gf[0]), c.gf[1] ? String(c.gf[1]) : 'artist', [c.gf[0], c.gf[1]].filter(Boolean).join(' '), +c.gf[2] || 0);
    if (c.nw) gift(c.i < 0 ? 'the artist holding this room together' : 'new for you: nobody brought this one', String(c.nw[0]), c.i < 0 ? 'start here' : `next door to ${c.nw[1]}`, String(c.nw[0]), 0);
    bag.classList.toggle('hide', !bag.children.length);
    drawKeep(kp, c);
    if (first) setTimeout(() => { const f = $('#g-fin'); (f.classList.contains('hide') ? $('#g-keep') : f).scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 80);
  }
  // the end of the night on the phone: the award on the screen, the toast, the photo, the playlist with links
  let finSig = '', finMode = '';
  const FINM = new Set(['awards', 'toast', 'photo', 'list']);
  function renderFin(s, my) {
    const box = $('#g-fin'), m = s && FINM.has(s.mode) ? s.mode : '';
    const sig = m && m + '|' + JSON.stringify(m === 'awards' ? s.aw || null : m === 'list' ? s.pl || (s.roster || []).map(g => g.p) : '');
    if (sig === finSig) return;
    finSig = sig;
    box.classList.toggle('hide', !m);
    box.textContent = '';
    if (!m) { finMode = ''; return; }
    const add = (tag, cls, t) => { if (t) box.append(el(tag, cls ? { class: cls } : {}, String(t))); };
    if (m === 'awards') {
      const a = s.aw;
      if (!a) { add('h2', '', 'the awards.'); add('p', 'gf-s', 'one at a time, on the screen.'); }
      else if (a.end) add('h2', '', a.end);
      else {
        add('p', 'field-h', `award ${a.i} of ${a.n}`);
        add('h2', '', a.k);
        if (!a.v) add('p', 'gf-s', 'and it goes to…');
        else { add('p', 'gf-big', a.v); add('p', 'gf-s', a.s); if (Array.isArray(a.lit) && a.lit.includes(my)) add('p', 'gf-you', 'that is you.'); }
      }
    } else if (m === 'toast') { add('h2', '', 'glasses up.'); add('p', 'gf-big', 'happy birthday to the birthday baby.'); }
    else if (m === 'photo') add('h2', '', 'look at the screen.');
    else {
      // the screen sends its order; a screen without it still sent everyone's picks
      let rows = Array.isArray(s.pl) ? s.pl.filter(r => Array.isArray(r) && r[0]) : null;
      if (!rows) {
        const seen = new Set(); rows = [];
        for (const g of s.roster || []) for (const l of g.p || []) { const t = String(l), k = t.toLowerCase(), i = t.indexOf(' · '); if (!seen.has(k)) { seen.add(k); rows.push(i > 0 ? [t.slice(0, i), t.slice(i + 3)] : [t]); } }
      }
      if (!rows.length) add('p', 'gf-s', 'the playlist is on the screen. ask the birthday baby for the link.');
      else {
        add('p', 'field-h', 'the playlist');
        add('h2', '', 'tap a song to hear it.');
        const ol = el('ol', { class: 'gf-list' });
        rows.forEach((r, i) => {
          const q = r.slice(0, 2).filter(Boolean).join(' '), tid = +r[2] || 0;
          ol.append(el('li', {}, el('span', { class: 'i' }, String(i + 1).padStart(2, '0')),
            el('span', { class: 't' }, el('b', {}, String(r[0])), el('span', {}, r[1] ? String(r[1]) : 'artist')),
            el('span', { class: 'a' }, el('a', { href: M.spotifyLink(q, tid), target: '_blank', rel: 'noopener noreferrer' }, 'spotify'), el('a', { href: M.appleLink(q, tid), target: '_blank', rel: 'noopener noreferrer' }, 'apple'))));
        });
        box.append(ol);
      }
    }
    if (finMode !== m) { finMode = m; setTimeout(() => box.scrollIntoView({ block: m === 'awards' ? 'nearest' : 'start', behavior: 'smooth' }), 120); }
  }
  function drawKeep(kp, c) {
    const cv = $('#gk-map'), w = cv.clientWidth || 300, h = 300, dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.style.height = h + 'px'; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue('--' + k).trim();
    const mine = lastShow && (lastShow.roster || []).find(g => g.k === 'p' + me.id);
    const pk = (mine && mine.p.length ? mine.p : me.picks.map(p => p.k === 't' ? p.tt : p.an)).map(s => String(s).split(' · ')[0]).slice(0, 3);
    // you in the middle; what you brought, who you sit next to, and what you take home around you
    const N = pk.map(t => ({ k: 'you brought', t, c: 'ink' }));
    if (c.tw) N.push({ k: 'taste twin', t: c.tw, c: 'ice' });
    if (c.gf) N.push({ k: 'a song for you', t: String(c.gf[0]), c: 'mint' });
    if (c.nw) N.push({ k: c.i < 0 ? 'links this room' : 'new for you', t: String(c.nw[0]), c: 'rose' });
    if (c.hp != null) N.push({ k: c.hp === 0 ? 'zero hops away' : `${c.hp} hop${c.hp === 1 ? '' : 's'} away`, t: 'birthday baby', c: 'mint', ring: 1 });
    if (c.home) N.push({ k: `${c.home} road${c.home === 1 ? '' : 's'}`, t: 'led to you', c: 'mint', ring: 1 });
    // two columns, one row each: a label owns its own band, so nothing can sit on anything else
    const L = Math.ceil(N.length / 2), rows = Math.max(L, 1), rh = 86, hh = rows * rh + 24, cx = w / 2, cy = hh / 2;
    cv.style.height = hh + 'px'; cv.height = Math.round(hh * dpr); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = col('faint');
    for (const p of kp.xy) { const px = cx + p[0] * w * .46, py = cy + p[1] * hh * .46; if (Math.abs(px - cx) < w * .04) x.fillRect(Math.round(px), Math.round(py), 3, 3); }
    N.forEach((o, j) => { const left = j < L, r = left ? j : j - L, cnt = left ? L : N.length - L; o.x = w * (left ? .23 : .77); o.y = 26 + (hh - 24) * (r + .5) / cnt - rh / 2 + 18; });
    x.lineWidth = 1.5;
    // wires run down a rail beside the middle, then straight across to each square, so no wire crosses a label
    for (const o of N) { const bx = Math.round(cx + (o.x < cx ? -1 : 1) * w * .055) + .5, oy = Math.round(o.y) + .5; x.strokeStyle = col(o.c); x.beginPath(); x.moveTo(bx, cy); x.lineTo(bx, oy); x.lineTo(o.x, oy); x.stroke(); }
    for (const o of N) {
      x.fillStyle = col(o.c); x.fillRect(Math.round(o.x - 6), Math.round(o.y - 6), 12, 12);
      if (o.ring) { x.strokeStyle = col(o.c); x.strokeRect(Math.round(o.x - 11) + .5, Math.round(o.y - 11) + .5, 22, 22); }
    }
    x.fillStyle = col('night'); x.fillRect(cx - 19, cy - 19, 38, 38);
    x.strokeStyle = col('mint'); x.strokeRect(Math.round(cx - 17) + .5, Math.round(cy - 17) + .5, 34, 34);
    x.fillStyle = col('ink'); x.fillRect(Math.round(cx - 10), Math.round(cy - 10), 20, 20);
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const put = (t, px, py, font, color) => { x.font = font; x.lineWidth = 5; x.strokeStyle = col('night'); x.strokeText(t, px, py); x.fillStyle = color; x.fillText(t, px, py); };
    put('you', cx, cy + 33, '600 13px "Instrument Sans", system-ui, sans-serif', col('ink'));
    const f1 = '500 11px "IBM Plex Mono", ui-monospace, monospace', f2 = '600 14px "Instrument Sans", system-ui, sans-serif', maxW = w * .41;
    for (const o of N) {
      x.font = f2; let t = o.t;
      while (t.length > 4 && x.measureText(t).width > maxW) t = t.slice(0, -2).trimEnd() + '…';
      x.font = f1; let kk = o.k;
      while (kk.length > 4 && x.measureText(kk).width > maxW) kk = kk.slice(0, -2).trimEnd() + '…';
      put(kk, o.x, o.y + 22, f1, col('dim')); put(t, o.x, o.y + 40, f2, col(o.c));
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
    // a small tick under the thumb where the phone offers one; silent everywhere else
    try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.isActive)) navigator.vibrate(12); } catch (e) { /* no haptics */ }
    render();
  }

  let waited = 0;
  if (noRTC) {
    $('#g-form').classList.add('hide'); $('#g-room').classList.remove('hide'); $('#g-edit').classList.add('hide');
    setText('#g-hi', "this browser can't join."); setText('#g-net', 'no link');
    setText('#g-status', "open the link in Safari or Chrome (tap ••• then 'open in browser')."); return;
  }
  if (me.name && (me.picks.length || me.claim || me.joined)) showRoom();
  upd();
  if (DEMO) { render(); return; }
  setText('#g-net', 'connecting');
  const ticker = setInterval(() => { waited++; render(); if (lastShow) clearInterval(ticker); }, 1000);
  try {
    const { openRoom } = await import('./sync.js?v=20261121f');
    NETg = await openRoom(K.norm, K.roomId);
  } catch (e) { setText('#g-net', 'offline'); render(); return; }
  setText('#g-net', 'live'); $('#g-net').classList.add('ok');
  const chip = () => { let n = 0; try { n = Object.keys(NETg.room.getUsers() || {}).length; } catch (e) { n = 0; } const on = navigator.onLine && n > 0; setText('#g-net', on ? 'live' : !navigator.onLine ? 'offline' : lastShow ? 'reconnecting' : 'connecting'); $('#g-net').classList.toggle('ok', on); };
  setInterval(chip, 4000); addEventListener('online', chip); addEventListener('offline', chip);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { chip(); if (me.joined) wakeLock(); } });
  if (NETg.onNetError) NETg.onNetError(e => { if (e && e.code === 'peer-connect-failed' && !lastShow) { netFail = true; render(); } });
  NETg.show.onChange(v => { lastShow = v; netFail = false; render(); if (!$('#g-form').classList.contains('hide')) dupCheck(); });
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
  if (me.name && (me.picks.length || me.claim || me.joined)) sendMe();
  render();
}

// ---------- go ----------
(async () => {
  K = await gate();
  if (ROLE === 'host') await hostMain(); else await guestMain();
})();
