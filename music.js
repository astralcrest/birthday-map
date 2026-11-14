// music lookups: deezer (jsonp, keyless), itunes lookup (cors), spotify + youtube oembed (cors)
const DZ = 'https://api.deezer.com/';
const CACHE_KEY = 'party.music.v1';
const PREVIEW_TTL = 8 * 60e3; // deezer preview links carry a token that expires in about 15 min

export const mem = { art: {}, rel: {}, gen: {}, yr: {} };
const fresh = { top: new Map(), trk: new Map() };
const listeners = new Set();
export const stats = { calls: 0, fails: 0 };

export function onRelated(fn) { listeners.add(fn); }

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    Object.assign(mem.art, d.art || {});
    Object.assign(mem.rel, d.rel || {});
    Object.assign(mem.gen, d.gen || {});
    Object.assign(mem.yr, d.yr || {});
  } catch (e) { /* storage blocked or corrupt: start empty */ }
}
loadCache();

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(mem)); }
    catch (e) {
      try { // over quota: keep only related lists, which are the expensive part
        localStorage.setItem(CACHE_KEY, JSON.stringify({ art: mem.art, rel: mem.rel, gen: {}, yr: mem.yr }));
      } catch (e2) { /* give up quietly */ }
    }
  }, 1500);
}

export function seed(d) {
  if (!d) return;
  for (const [k, v] of Object.entries(d.art || {})) if (!mem.art[k]) mem.art[k] = v;
  for (const [k, v] of Object.entries(d.rel || {})) if (!mem.rel[k]) mem.rel[k] = v;
  for (const [k, v] of Object.entries(d.gen || {})) if (!mem.gen[k]) mem.gen[k] = v;
  for (const [k, v] of Object.entries(d.rel || {})) listeners.forEach(fn => fn(+k, v));
}

// ---- request queue: two lanes, gentle rate (deezer allows about 50 per 5 s) ----
const lanes = { hi: [], mid: [], lo: [] };
let active = 0, lastStart = 0, pumpTimer = 0;
const MAX = 4, GAP = 125;
function pump() {
  clearTimeout(pumpTimer);
  while (active < MAX && (lanes.hi.length || lanes.mid.length || lanes.lo.length)) {
    const wait = GAP - (performance.now() - lastStart);
    if (wait > 0) { pumpTimer = setTimeout(pump, wait); return; }
    lastStart = performance.now();
    const job = lanes.hi.length ? lanes.hi.shift() : lanes.mid.length ? lanes.mid.shift() : lanes.lo.shift();
    active++;
    job.run().then(job.ok, job.no).finally(() => { active--; pump(); });
  }
}
function enqueue(run, lane = 'hi') {
  return new Promise((ok, no) => { lanes[lane].push({ run, ok, no }); pump(); });
}
export function pending() { return lanes.hi.length + lanes.mid.length + lanes.lo.length + active; }

let cbn = 0;
const noop = () => {};
function jsonp(url, ms = 9000) {
  return new Promise((res, rej) => {
    const cb = '__pz' + (++cbn).toString(36);
    const s = document.createElement('script');
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, ms);
    function done() { clearTimeout(t); window[cb] = noop; s.remove(); }
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('network')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.appendChild(s);
  });
}

async function dz(path, params = {}, lane = 'hi') {
  const qs = new URLSearchParams(params).toString();
  const url = DZ + path + (qs ? '?' + qs : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      stats.calls++;
      const d = await enqueue(() => jsonp(url), lane);
      if (d && d.error) {
        if (d.error.code === 4) { await sleep(1500 * (attempt + 1)); continue; }
        return null;
      }
      return d;
    } catch (e) {
      stats.fails++;
      if (attempt === 2) return null;
      await sleep(600);
    }
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function md5Of(u) {
  const m = /\/images\/artist\/([0-9a-f]{32})\//.exec(u || '');
  return m ? m[1] : '';
}
function keepArtist(a) {
  if (!a || !a.id) return;
  const prev = mem.art[a.id];
  mem.art[a.id] = [a.name, md5Of(a.picture_small) || (prev && prev[1]) || '', a.nb_fan || (prev && prev[2]) || 0];
}
export function artistName(aid) { const a = mem.art[aid]; return a ? a[0] : ''; }
export function artistFans(aid) { const a = mem.art[aid]; return a ? (a[2] || 0) : 0; }
export function picUrl(aid, size = 250) {
  const a = mem.art[aid];
  if (!a || !a[1]) return '';
  return `https://cdn-images.dzcdn.net/images/artist/${a[1]}/${size}x${size}-000000-80-0-0.jpg`;
}

// ---- search ----
const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function search(q) {
  q = q.trim();
  if (!q) return [];
  const [ar, tr] = await Promise.all([
    dz('search/artist', { q, limit: 12 }),
    dz('search', { q, limit: 6 }),
  ]);
  const out = [];
  const nq = norm(q);
  // deezer ranks namesakes with six fans above the real artist, so rank by fans
  const cands = [];
  for (const a of (ar && ar.data) || []) {
    keepArtist(a);
    const na = norm(a.name);
    if (na && (na === nq || nq.includes(na) || (na.startsWith(nq) && nq.length >= 3))) cands.push(a);
  }
  cands.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
  for (const a of cands.slice(0, 2)) {
    if (out.length && (a.nb_fan || 0) < (cands[0].nb_fan || 0) / 100) break;
    out.push({ k: 'a', aid: a.id, an: a.name });
  }
  const seen = new Set();
  for (const t of (tr && tr.data) || []) {
    if (!t.artist) continue;
    keepArtist(t.artist);
    const key = norm(t.title_short || t.title) + '|' + t.artist.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ k: 't', tid: t.id, tt: t.title_short || t.title, aid: t.artist.id, an: t.artist.name });
    if (out.length >= 7) break;
  }
  if (!out.length && ar && ar.data && ar.data[0]) {
    const a = ar.data[0];
    out.push({ k: 'a', aid: a.id, an: a.name });
  }
  saveSoon();
  return out;
}

// turns a pasted link into either exact picks or a search query
export async function resolveLink(text) {
  const s = text.trim();
  let u;
  try { u = new URL(s); } catch (e) {
    const m = /^spotify:(track|artist|album):([A-Za-z0-9]+)$/.exec(s);
    if (!m) return null;
    u = new URL(`https://open.spotify.com/${m[1]}/${m[2]}`);
  }
  const host = u.hostname.replace(/^www\./, '');
  try {
    if (host.endsWith('deezer.com') || host === 'deezer.page.link') {
      const m = /\/(track|artist)\/(\d+)/.exec(u.pathname);
      if (m && m[1] === 'track') {
        const t = await dz('track/' + m[2]);
        if (t && t.artist) { keepArtist(t.artist); return { picks: [{ k: 't', tid: t.id, tt: t.title_short || t.title, aid: t.artist.id, an: t.artist.name }] }; }
      }
      if (m && m[1] === 'artist') {
        const a = await dz('artist/' + m[2]);
        if (a && a.id) { keepArtist(a); return { picks: [{ k: 'a', aid: a.id, an: a.name }] }; }
      }
      return null;
    }
    if (host === 'open.spotify.com' || host === 'spotify.link') {
      const m = /\/(track|artist|album|playlist)\/([A-Za-z0-9]+)/.exec(u.pathname);
      if (!m) return null;
      const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(`https://open.spotify.com/${m[1]}/${m[2]}`), { referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) return null;
      const d = await r.json();
      return d.title ? { query: d.title, from: 'spotify', kind: m[1] } : null;
    }
    if (host.endsWith('music.apple.com') || host.endsWith('itunes.apple.com')) {
      const id = u.searchParams.get('i') || (/\/(\d+)(?:\/)?$/.exec(u.pathname) || [])[1] || (/\/id(\d+)/.exec(u.pathname) || [])[1];
      if (!id) return null;
      const r = await fetch('https://itunes.apple.com/lookup?id=' + id, { referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) return null;
      const d = await r.json();
      const x = d.results && d.results[0];
      if (!x) return null;
      if (x.wrapperType === 'artist') return { query: x.artistName, from: 'apple' };
      if (x.trackName) return { query: `${x.artistName} ${x.trackName}`, from: 'apple' };
      return { query: x.artistName, from: 'apple' };
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(s), { referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) return null;
      const d = await r.json();
      let title = (d.title || '').replace(/[(\[][^)\]]*[)\]]/g, ' ').replace(/\b(official|music|lyric|lyrics|video|audio|visualizer|hd|4k|remaster(ed)?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      const topic = / - Topic$/.exec(d.author_name || '');
      if (topic && !title.includes(' - ')) title = d.author_name.replace(/ - Topic$/, '') + ' ' + title;
      title = title.replace(/\s[-|]\s/g, ' ');
      return title ? { query: title, from: 'youtube' } : null;
    }
  } catch (e) { return null; }
  return null;
}

// ---- graph data ----
export async function related(aid, lane = 'lo') {
  if (mem.rel[aid]) return mem.rel[aid];
  const d = await dz(`artist/${aid}/related`, { limit: 20 }, lane);
  if (!d) return null;
  const ids = [];
  for (const a of d.data || []) { keepArtist(a); ids.push(a.id); }
  mem.rel[aid] = ids;
  listeners.forEach(fn => fn(aid, ids));
  saveSoon();
  return ids;
}
export function hasRelated(aid) { return !!mem.rel[aid]; }

export async function top(aid, lane = 'hi') {
  const c = fresh.top.get(aid);
  if (c && Date.now() - c.t < PREVIEW_TTL) return c.v;
  const d = await dz(`artist/${aid}/top`, { limit: 5 }, lane);
  const v = ((d && d.data) || []).filter(t => t.preview).map(t => ({ tid: t.id, tt: t.title_short || t.title, pv: t.preview, aid, an: (t.artist && t.artist.name) || artistName(aid), al: t.album && t.album.id }));
  fresh.top.set(aid, { t: Date.now(), v });
  return v;
}

export async function track(tid) {
  const c = fresh.trk.get(tid);
  if (c && Date.now() - c.t < PREVIEW_TTL) return c.v;
  const t = await dz('track/' + tid);
  if (!t || !t.id) return null;
  if (t.artist) keepArtist(t.artist);
  const v = { tid: t.id, tt: t.title_short || t.title, pv: t.preview || '', aid: t.artist && t.artist.id, an: t.artist && t.artist.name };
  fresh.trk.set(tid, { t: Date.now(), v });
  return v;
}

export async function genre(aid) {
  if (mem.gen[aid] !== undefined) return mem.gen[aid];
  const tops = await top(aid, 'lo');
  const al = tops[0] && tops[0].al;
  if (!al) return '';
  const d = await dz('album/' + al, {}, 'lo');
  const g = (d && d.genres && d.genres.data && d.genres.data[0] && d.genres.data[0].name) || '';
  mem.gen[aid] = g;
  saveSoon();
  return g;
}

// release year of a pick: the track's own date, or the artist's top track for an artist pick (0 = not found)
export async function yearOf(p) {
  const key = p.tid ? 't' + p.tid : 'a' + p.aid;
  if (mem.yr[key] !== undefined) return mem.yr[key];
  let tid = p.tid;
  if (!tid) { const tops = await top(p.aid, 'lo'); tid = tops[0] && tops[0].tid; }
  if (!tid) { mem.yr[key] = 0; return 0; }
  const t = await dz('track/' + tid, {}, 'lo');
  if (!t || !t.id) return 0;
  const m = /^(\d{4})/.exec(t.release_date || '');
  const y = m && +m[1] > 1900 ? +m[1] : 0;
  mem.yr[key] = y; saveSoon();
  return y;
}

// what to play for a pick or an artist stop
export async function previewFor(p, nth = 0) {
  if (p.tid) {
    const t = await track(p.tid);
    if (t && t.pv) return { url: t.pv, tt: t.tt, an: t.an || p.an, aid: p.aid };
  }
  const tops = await top(p.aid);
  const t = tops[Math.min(nth, tops.length - 1)];
  return t ? { url: t.pv, tt: t.tt, an: t.an, aid: p.aid } : null;
}

export function spotifySearch(q) { return 'https://open.spotify.com/search/' + encodeURIComponent(q); }
export function appleSearch(q) { return 'https://music.apple.com/us/search?term=' + encodeURIComponent(q); }
