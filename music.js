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
let active = 0, lastStart = 0, pumpTimer = 0, coolUntil = 0, strikes = 0;
const MAX = 4, GAP = 125;
let calmUntil = 0;
// background lookups yield while phones are joining; a finishing request pumps again
export function calm(ms) { calmUntil = Math.max(calmUntil, performance.now() + ms); }
function pump() {
  clearTimeout(pumpTimer);
  while (active < MAX && (lanes.hi.length || lanes.mid.length || lanes.lo.length)) {
    const quiet = !lanes.hi.length && !lanes.mid.length && performance.now() < calmUntil;
    if (quiet && active) return;
    // one quota error pauses the whole queue, not just the one request
    const wait = Math.max((quiet ? 600 : GAP) - (performance.now() - lastStart), coolUntil - performance.now());
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
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      stats.calls++;
      const d = await enqueue(() => jsonp(url), lane);
      if (d && d.error) {
        if (d.error.code === 4) { strikes++; coolUntil = Math.max(coolUntil, performance.now() + Math.min(8000, 1200 * 2 ** Math.min(strikes, 3))); stats.busy = Date.now(); continue; }
        return null;
      }
      strikes = 0;
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
// letters of every script survive, so 아이유 or 宋冬野 still compare
export const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\$/g, 's').replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const noParens = s => (s || '').replace(/\s*[(\[][^)\]]*[)\]]/g, ' ').trim();
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// 1 = same name; spaces ignored so "j calm" meets "J'calm"
export function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = a.replace(/ /g, ''), y = b.replace(/ /g, '');
  if (x === y) return .97;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
}
// the query names this artist, allowing a typo ("brackence", "gracie abrahams")
function named(nq, name) {
  const na = norm(name);
  if (!na) return false;
  if ((' ' + nq + ' ').includes(' ' + na + ' ')) return true;
  if (na.replace(/ /g, '').length < 5) return false;
  const qw = nq.split(' '), k = na.split(' ').length;
  for (let n = Math.max(1, k - 1); n <= k + 1; n++) for (let i = 0; i + n <= qw.length; i++) if (sim(qw.slice(i, i + n).join(' '), na) >= .8) return true;
  return false;
}
// karaoke, tribute bands, string quartets and "made famous by" uploads crowd the real song out of deezer's search
const COVER = /karaoke|made famous|[(\[]piano|tabata|hardstyle|lo-?fi version|acoustic cover|in the style of|originally (performed|by)|tribute|\bcover(ed)?\b|string quartet|vitamin string|string orchestra|symphony orchestra|piano (version|cover|tribute|superstar|guys)|lullaby|rockabye|\b(8|16)[- ]?bit\b|chiptune|instrumental|backing track|workout|music box|\bmidi|kidz bop|sitar|jazz lounge|sing ?along|as made famous|cover band|all-?stars|\((by|from) [^)]*\)/i;
const ODD = /[(\[][^)\]]*(demo|live|remaster|version|mix|edit|instrumental|acoustic|writing|session|take|karaoke|sped|slowed|reverb)/i;
export const coverish = t => COVER.test((t.title || t.tt || '')) || COVER.test((t.artist && t.artist.name) || t.an || '');

// the artist a typed name most likely means: close spelling first, then the one people actually listen to
export async function artistByName(name) {
  const nn = norm(name);
  if (!nn) return null;
  const d = await dz('search/artist', { q: name, limit: 10 });
  let best = null, bv = 0, bs = 0;
  for (const a of (d && d.data) || []) {
    keepArtist(a);
    const na = norm(a.name);
    const s = Math.max(sim(a.name, name), nn.length >= 3 && na.startsWith(nn + ' ') ? .78 : 0);
    if (s < .75) continue;
    const v = s * 10 + Math.log10((a.nb_fan || 0) + 10);
    if (!best || v > bv) { best = a; bv = v; bs = s; }
  }
  return best ? { aid: best.id, an: best.name, fans: best.nb_fan || 0, sim: bs } : null;
}

// one song by one named artist. never a cover: if deezer lacks the original, the artist stands in
export async function findSong(title, artist) {
  const a = artist && artist.aid ? artist : await artistByName(artist);
  if (!a) return null;
  const nt = norm(noParens(title));
  const cjk = /[^\u0000-ɏ\s\p{P}\p{N}]/u.test(title);
  const tsim = t => {
    const x = norm(noParens(t.title_short || t.title));
    if (!x || !nt) return 0;
    if (x === nt) return 1;
    if (x.startsWith(nt + ' ') || nt.startsWith(x + ' ')) return .9;
    return sim(x, nt);
  };
  const mine = t => t && t.artist && (t.artist.id === a.aid || norm(t.artist.name) === norm(a.an));
  const take = t => { keepArtist(t.artist); saveSoon(); return { pick: { k: 't', tid: t.id, tt: t.title_short || t.title, aid: t.artist.id, an: t.artist.name }, how: 'song', artist: a }; };
  const best = (list, loose) => {
    let b = null, bs = 0;
    for (const t of list || []) {
      if (!mine(t)) continue;
      // the plain studio version over demos, live takes and remixes, then the popular one
      const odd = ODD.test(t.title || '') ? .08 : 0;
      const s = tsim(t) - (t.preview ? 0 : .2) - odd + (t.rank || 0) / 2e7;
      if (s > bs) { b = t; bs = s; }
    }
    if (b && bs >= .72) return b;
    return loose ? (list || []).find(t => mine(t) && t.preview) : null;
  };
  let d = await dz('search', { q: `${a.an} ${noParens(title)}`, limit: 25 });
  let hit = best(d && d.data, cjk);
  if (!hit) { d = await dz('search', { q: `track:"${noParens(title).replace(/"/g, '')}"`, limit: 50 }); hit = best(d && d.data); }
  if (!hit) { d = await dz(`artist/${a.aid}/top`, { limit: 100 }); hit = best(d && d.data); }
  if (hit) return take(hit);
  saveSoon();
  return { pick: { k: 'a', aid: a.aid, an: a.an }, how: 'artist', artist: a };
}

export async function search(q) {
  q = q.trim();
  if (!q) return [];
  const [ar, tr] = await Promise.all([
    dz('search/artist', { q, limit: 12 }),
    dz('search', { q, limit: 15 }),
  ]);
  const nq = norm(q);
  // deezer ranks namesakes with six fans above the real artist, so rank by fans
  const cands = [];
  for (const a of (ar && ar.data) || []) {
    keepArtist(a);
    const na = norm(a.name);
    if (!na) continue;
    if (na === nq || (' ' + nq + ' ').includes(' ' + na + ' ') || (na.startsWith(nq) && nq.length >= 3) || sim(na, nq) >= .8) cands.push(a);
  }
  cands.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
  const arts = [];
  for (const a of cands.slice(0, 2)) {
    if (arts.length && (a.nb_fan || 0) < (cands[0].nb_fan || 0) / 100) break;
    arts.push({ k: 'a', aid: a.id, an: a.name, fans: a.nb_fan || 0 });
  }
  const seen = new Set(), tracks = [];
  for (const t of (tr && tr.data) || []) {
    if (!t.artist) continue;
    keepArtist(t.artist);
    const key = norm(t.title_short || t.title) + '|' + t.artist.id;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ p: { k: 't', tid: t.id, tt: t.title_short || t.title, aid: t.artist.id, an: t.artist.name }, cover: coverish(t), named: named(nq, t.artist.name), exact: norm(noParens(t.title_short || t.title)) === nq, inq: named(nq, noParens(t.title_short || t.title)), odd: ODD.test(t.title || ''), rk: t.rank || 0 });
  }
  // "title artist" where deezer only surfaced covers: find the artist the leftover words name, then the song in their catalog
  let found = null;
  if (!tracks.some(x => x.named && !x.cover) && !arts.some(a => norm(a.an) === nq && (a.fans >= 50000 || !tracks.some(x => x.exact && !x.cover)))) {
    const base = nq.includes(' ') && (tracks.find(x => !x.cover) || tracks[0]);
    if (base) {
      const tw = new Set(norm(noParens(base.p.tt)).split(' '));
      const words = nq.split(' ');
      const left = words.filter(w => !tw.has(w)).join(' ');
      if (left.length >= 3 && left !== nq) {
        const r = await findSong(base.p.tt, left);
        if (r && r.artist.sim >= .8) found = r;
      }
    }
    // a bare title ("call me maybe"): deezer's search buries the famous original, the itunes charts do not
    if (!found && !arts.some(a => sim(a.an, q) >= .9 && a.fans >= 50000)) {
      const it = await itunesSong(q);
      if (it && (named(nq, noParens(it.tt)) || sim(noParens(it.tt), q) >= .8)) {
        const r = await findSong(it.tt, it.an.split(/\s(?:&|feat\.?|ft\.?|x|with)\s|,\s/i)[0]);
        if (r && r.how === 'song') found = { ...r, title: true };
      }
    }
  }
  const rank = x => (x.named && !x.cover ? 0 : x.cover ? 2 : 1);
  // same class: exact titles first, the most played first
  tracks.sort((a, b) => rank(a) - rank(b) || (b.inq - a.inq) || (a.odd - b.odd) || (a.inq && b.inq ? b.rk - a.rk : 0));
  const out = [];
  const artistFirst = found && found.title && arts.length && (arts[0].fans || 0) >= 100000;
  if (artistFirst) for (const a of arts) out.push({ k: 'a', aid: a.aid, an: a.an });
  if (found) {
    out.push(found.pick);
    if (found.how === 'song' && !found.title) out.push({ k: 'a', aid: found.artist.aid, an: found.artist.an });
  }
  // a small namesake band loses to a famous song with exactly the typed title ("my house")
  const songFirst = arts.length && !arts.some(a => (a.fans || 0) >= 50000) && tracks.some(x => x.exact && !x.cover);
  if (songFirst && !found) { const i = tracks.findIndex(x => x.exact && !x.cover); out.push(tracks[i].p); tracks.splice(i, 1); }
  for (const a of arts) out.push({ k: 'a', aid: a.aid, an: a.an });
  for (const x of tracks) out.push(x.p);
  const uniq = [], keys = new Set();
  for (const p of out) { const k = p.k + (p.tid || p.aid); if (!keys.has(k)) { keys.add(k); uniq.push(p); } }
  if (!uniq.length && ar && ar.data && ar.data[0]) uniq.push({ k: 'a', aid: ar.data[0].id, an: ar.data[0].name });
  saveSoon();
  return uniq.slice(0, 7);
}

async function itunesSong(q) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch('https://itunes.apple.com/search?' + new URLSearchParams({ term: q, entity: 'song', limit: '6' }), { referrerPolicy: 'no-referrer', credentials: 'omit', signal: ac.signal });
    if (!r.ok) return null;
    const d = await r.json();
    const x = (d.results || []).find(x => x.trackName && x.artistName && !coverish({ title: x.trackName, artist: { name: x.artistName } }));
    return x ? { tt: x.trackName, an: x.artistName } : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// turns a pasted link into either exact picks or a search query
const PLAYLIST = { refuse: 'that is a playlist. send one song: share, then copy the song link.' };
export async function resolveLink(text) {
  // share text often wraps the link in words: take the first link anywhere
  const hit = /(https?:\/\/[^\s<>"]+|spotify:[a-z]+:[A-Za-z0-9]+)/i.exec(text || '');
  const s = hit ? hit[1].replace(/[),.;!?]+$/, '') : (text || '').trim();
  let u;
  const su = /^spotify:(track|artist|album|playlist):([A-Za-z0-9]+)/i.exec(s);
  try { u = new URL(su ? `https://open.spotify.com/${su[1].toLowerCase()}/${su[2]}` : s); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (/^(spotify\.link|deezer\.page\.link|link\.deezer\.com)$/.test(host) || (host === 'spotify.app.link')) return { refuse: 'that is a short link. open it first, then share and copy the link to the song.' };
  if (/\/playlist\//.test(u.pathname) || (/youtube\.com$/.test(host) && u.searchParams.get('list') && !u.searchParams.get('v'))) return PLAYLIST;
  try {
    if (host.endsWith('deezer.com') || host === 'deezer.page.link') {
      const m = /\/(track|artist|album)\/(\d+)/.exec(u.pathname);
      if (m && m[1] === 'album') {
        const al = await dz('album/' + m[2]);
        if (al && al.artist) { keepArtist(al.artist); return { picks: [{ k: 'a', aid: al.artist.id, an: al.artist.name }] }; }
      }
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
      if (!d.title) return null;
      // an album: the artist of the deezer album with exactly that title, else a plain search
      if (m[1] === 'album') {
        const sa = await dz('search/album', { q: d.title, limit: 10 });
        const al = ((sa && sa.data) || []).find(x => norm(x.title) === norm(d.title) && x.artist && !coverish({ title: x.title, artist: x.artist }));
        if (al) { keepArtist(al.artist); return { picks: [{ k: 'a', aid: al.artist.id, an: al.artist.name }] }; }
      }
      return { query: d.title, from: 'spotify', kind: m[1] };
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
      let title = (d.title || '').replace(/[(\[][^)\]]*[)\]]/g, ' ').replace(/\bM\/V\b|\bMV\b/g, ' ').replace(/\b(official|music|lyric|lyrics|video|audio|visualizer|hd|4k|remaster(ed)?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
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

// deezer's loudness figure per preview url: the player trims each clip toward one level
const gains = new Map();
export function gainOf(url) { return gains.has(url) ? gains.get(url) : null; }
export async function track(tid) {
  const c = fresh.trk.get(tid);
  if (c && Date.now() - c.t < PREVIEW_TTL) return c.v;
  const t = await dz('track/' + tid);
  if (!t || !t.id) return null;
  if (t.artist) keepArtist(t.artist);
  const v = { tid: t.id, tt: t.title_short || t.title, pv: t.preview || '', aid: t.artist && t.artist.id, an: t.artist && t.artist.name, gain: typeof t.gain === 'number' ? t.gain : null };
  if (v.pv && v.gain !== null) gains.set(v.pv, v.gain);
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

// release year of a pick: the earliest date either store has for that exact song, so a remaster does not move the decade (0 = not found)
const yn = x => String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9]+/g, '');
async function itunesYear(an, tt) {
  const A = yn(an), T = yn(tt);
  if (!A || !T) return 0;
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch('https://itunes.apple.com/search?' + new URLSearchParams({ term: an + ' ' + tt, entity: 'song', limit: '25' }), { referrerPolicy: 'no-referrer', credentials: 'omit', signal: ac.signal });
    if (!r.ok) return 0;
    const d = await r.json();
    let y = 0;
    for (const x of d.results || []) {
      if (yn(x.trackName) !== T) continue;
      const xa = yn(x.artistName);
      if (xa !== A && !xa.includes(A) && !A.includes(xa)) continue;
      const m = /^(\d{4})/.exec(x.releaseDate || ''), v = m ? +m[1] : 0;
      if (v > 1900 && (!y || v < y)) y = v;
    }
    return y;
  } catch (e) { return 0; } finally { clearTimeout(t); }
}
export async function yearOf(p) {
  const key = 'y2' + (p.tid ? 't' + p.tid : 'a' + p.aid);
  if (mem.yr[key] !== undefined) return mem.yr[key];
  let tid = p.tid;
  if (!tid) { const tops = await top(p.aid, 'lo'); tid = tops[0] && tops[0].tid; }
  if (!tid) { mem.yr[key] = 0; return 0; }
  const t = await dz('track/' + tid, {}, 'lo');
  if (!t || !t.id) return 0;
  const m = /^(\d{4})/.exec(t.release_date || '');
  let y = m && +m[1] > 1900 ? +m[1] : 0;
  const iy = await itunesYear((t.artist && t.artist.name) || p.an, t.title || p.tt);
  if (iy && (!y || iy < y)) y = iy;
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
  if (t && !gains.has(t.pv)) track(t.tid).then(x => { if (x && x.gain !== null) gains.set(t.pv, x.gain); }).catch(() => {});
  return t ? { url: t.pv, tt: t.tt, an: t.an, aid: p.aid } : null;
}

export function spotifySearch(q) { return 'https://open.spotify.com/search/' + encodeURIComponent(q); }
const via = (tid, to) => 'https://song.link/redirect?url=' + encodeURIComponent('https://www.deezer.com/track/' + tid) + '&to=' + to;
export function spotifyLink(q, tid) { return tid ? via(tid, 'spotify') : spotifySearch(q); }
export function appleLink(q, tid) { return tid ? via(tid, 'appleMusic') : appleSearch(q); }
export function appleSearch(q) { return 'https://music.apple.com/us/search?term=' + encodeURIComponent(q); }
