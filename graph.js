// the related-artist map: undirected links (a link means one of the two lists the other as related)
import * as M from './music.js?v=20261121a';

export const CAP = 6;          // hop cap for paths
export const FAR = CAP + 1;    // distance used for "not within reach"
const adj = new Map();
const ingested = new Set();
let version = 0;

function link(a, b) {
  if (a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b); adj.get(b).add(a);
}
function ingest(aid, ids) {
  aid = +aid;
  if (ingested.has(aid)) return;
  ingested.add(aid);
  for (const b of ids) link(aid, +b);
  version++;
}
export function sync() {
  if (ingested.size === Object.keys(M.mem.rel).length) return;
  for (const [k, v] of Object.entries(M.mem.rel)) ingest(k, v);
}
M.onRelated(ingest);
export function ver() { sync(); return version; }
export function nbrs(a) { return adj.get(+a) || new Set(); }
export function size() { sync(); let e = 0; for (const s of adj.values()) e += s.size; return { nodes: adj.size, links: e / 2 }; }

// plain bfs on what is already known
export function bfs(sources, cap = CAP) {
  sync();
  const dist = new Map(), par = new Map();
  let front = [];
  for (const s of sources) { if (!dist.has(+s)) { dist.set(+s, 0); front.push(+s); } }
  for (let d = 1; d <= cap && front.length; d++) {
    const next = [];
    for (const u of front) for (const v of nbrs(u)) {
      if (!dist.has(v)) { dist.set(v, d); par.set(v, u); next.push(v); }
    }
    front = next;
  }
  return { dist, par };
}

function trace(par, x) { const out = [x]; while (par.has(x)) { x = par.get(x); out.push(x); } return out; }

export function pathKnown(src, dst, cap = CAP) {
  const S = new Set(src.map(Number)), T = new Set(dst.map(Number));
  for (const s of S) if (T.has(s)) return [s];
  const { dist, par } = bfs(S, cap);
  let best = null, bd = Infinity;
  for (const t of T) { const d = dist.get(t); if (d !== undefined && d < bd) { bd = d; best = t; } }
  return best === null ? null : trace(par, best).reverse();
}

// bidirectional search that fetches related lists as it goes; bounded by hops and by fetches
export async function pathLive(src, dst, { cap = CAP, budget = 240, beam = 28, lane = 'mid', onStep } = {}) {
  sync();
  const quick = pathKnown(src, dst, cap);
  if (quick) return { path: quick, checked: 0 };
  const side = [
    { dist: new Map(), par: new Map(), front: [] },
    { dist: new Map(), par: new Map(), front: [] },
  ];
  for (const s of src) { side[0].dist.set(+s, 0); side[0].front.push(+s); }
  for (const t of dst) { side[1].dist.set(+t, 0); side[1].front.push(+t); }
  let checked = 0, depth = [0, 0];
  const meet = () => {
    let best = null, bd = Infinity;
    for (const [n, d] of side[0].dist) {
      const e = side[1].dist.get(n);
      if (e !== undefined && d + e < bd) { bd = d + e; best = n; }
    }
    return best;
  };
  while (depth[0] + depth[1] < cap) {
    const i = side[0].front.length <= side[1].front.length ? 0 : 1;
    const S = side[i];
    if (!S.front.length) break;
    const need = S.front.filter(n => !M.hasRelated(n)).sort((a, b) => M.artistFans(b) - M.artistFans(a));
    const take = need.slice(0, Math.max(0, Math.min(beam, budget - checked)));
    checked += take.length;
    if (onStep) onStep({ checked, depth: depth[0] + depth[1] + 1 });
    await Promise.all(take.map(n => M.related(n, lane)));
    sync();
    const next = [];
    for (const u of S.front) for (const v of nbrs(u)) {
      if (!S.dist.has(v)) { S.dist.set(v, depth[i] + 1); S.par.set(v, u); next.push(v); }
    }
    S.front = next;
    depth[i]++;
    const m = meet();
    if (m !== null) {
      const a = trace(side[0].par, m).reverse();
      const b = trace(side[1].par, m).slice(1);
      const p = a.concat(b);
      // the known map may now hold an even shorter route
      const k = pathKnown(src, dst, cap);
      return { path: k && k.length < p.length ? k : p, checked };
    }
    if (checked >= budget) break;
  }
  return { path: null, checked };
}

// per-pick distances on the known map, then guest-to-guest distance
export function guestMatrix(guests) {
  sync();
  const seeds = [...new Set(guests.flatMap(g => g.picks.map(p => +p.aid)))];
  const sd = new Map();
  for (const s of seeds) sd.set(s, bfs([s], CAP).dist);
  const pd = (a, b) => { const d = sd.get(+a).get(+b); return d === undefined ? FAR : d; };
  const n = guests.length;
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = guests[i].picks.map(p => +p.aid), B = guests[j].picks.map(p => +p.aid);
    if (!A.length || !B.length) { D[i][j] = D[j][i] = FAR; continue; }
    const ab = A.reduce((s, a) => s + Math.min(...B.map(b => pd(a, b))), 0) / A.length;
    const ba = B.reduce((s, b) => s + Math.min(...A.map(a => pd(a, b))), 0) / B.length;
    D[i][j] = D[j][i] = (ab + ba) / 2;
  }
  return { D, pd };
}
export const score = d => Math.round(100 * (1 - Math.min(d, FAR) / FAR));

// classical mds to two dimensions
export function mds(D) {
  const n = D.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];
  if (n === 2) return [[-D[0][1] / 2, 0], [D[0][1] / 2, 0]];
  const B = Array.from({ length: n }, () => new Float64Array(n));
  const r = new Float64Array(n); let t = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = D[i][j] * D[i][j]; r[i] += v / n; t += v / (n * n); }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) B[i][j] = -0.5 * (D[i][j] * D[i][j] - r[i] - r[j] + t);
  const vecs = [];
  for (let k = 0; k < 2; k++) {
    let v = new Float64Array(n).map((_, i) => Math.sin(i * 1.7 + k * 3.1) + 0.5);
    let lam = 0;
    for (let it = 0; it < 200; it++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += B[i][j] * v[j]; w[i] = s; }
      for (const u of vecs) { let dot = 0; for (let i = 0; i < n; i++) dot += w[i] * u.v[i]; for (let i = 0; i < n; i++) w[i] -= dot * u.v[i]; }
      let nm = 0; for (let i = 0; i < n; i++) nm += w[i] * w[i]; nm = Math.sqrt(nm) || 1;
      lam = nm; v = w.map(x => x / nm);
    }
    vecs.push({ v, lam });
  }
  return Array.from({ length: n }, (_, i) => [vecs[0].v[i] * Math.sqrt(Math.max(vecs[0].lam, 1e-9)), vecs[1].v[i] * Math.sqrt(Math.max(vecs[1].lam, 1e-9))]);
}

// the party in numbers
export function facts(guests, D) {
  const n = guests.length;
  const out = {};
  if (n < 2) return out;
  const mean = D.map((row, i) => row.reduce((s, v, j) => s + (i === j ? 0 : v), 0) / (n - 1));
  let c = 0, o = 0;
  mean.forEach((m, i) => { if (m < mean[c]) c = i; if (m > mean[o]) o = i; });
  out.center = c; out.outlier = o; out.mean = mean;
  let close = [0, 1], far = [0, 1];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (D[i][j] < D[close[0]][close[1]]) close = [i, j];
    if (D[i][j] > D[far[0]][far[1]]) far = [i, j];
  }
  out.closest = close; out.farthest = far;
  // widest taste: own picks furthest apart
  let wi = -1, wv = -1;
  guests.forEach((g, i) => {
    const a = g.picks.map(p => +p.aid);
    if (a.length < 2) return;
    let s = 0, k = 0;
    for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) { s += pdOwn(a[x], a[y]); k++; }
    if (s / k > wv) { wv = s / k; wi = i; }
  });
  out.widest = wi; out.widestHops = wv;
  // the bridge: the artist sitting on the most guest-to-guest shortest paths
  const count = new Map();
  const trees = guests.map(g => bfs(g.picks.map(p => +p.aid), CAP));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const { dist, par } = trees[i];
    let best = null, bd = Infinity;
    for (const p of guests[j].picks) { const d = dist.get(+p.aid); if (d !== undefined && d < bd) { bd = d; best = +p.aid; } }
    if (best === null || bd < 2) continue;
    let x = par.get(best);
    while (x !== undefined && par.has(x)) { count.set(x, (count.get(x) || 0) + 1); x = par.get(x); }
  }
  let bridge = null, bc = 0;
  // ties go to the better-known artist, so the answer does not depend on who joined first
  for (const [k, v] of count) if (v > bc || (v === bc && M.artistFans(k) > M.artistFans(bridge))) { bc = v; bridge = k; }
  out.bridge = bridge; out.bridgeCount = bc;
  return out;
}
function pdOwn(a, b) { const d = bfs([a], CAP).dist.get(b); return d === undefined ? FAR : d; }

// a short tour: nearest neighbor, then 2-opt on hops
export function tour(items, dist) {
  const n = items.length;
  if (n < 3) return items.map((_, i) => i);
  const used = new Array(n).fill(false);
  const order = [0]; used[0] = true;
  for (let k = 1; k < n; k++) {
    const last = order[order.length - 1];
    let best = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!used[j]) { const d = dist(last, j); if (d < bd) { bd = d; best = j; } }
    order.push(best); used[best] = true;
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 40) {
    improved = false;
    for (let i = 0; i < n - 2; i++) for (let k = i + 1; k < n - 1; k++) {
      const a = order[i], b = order[i + 1], c = order[k], d = order[k + 1];
      if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 1e-9) {
        order.splice(i + 1, k - i, ...order.slice(i + 1, k + 1).reverse());
        improved = true;
      }
    }
  }
  return order;
}

// fetch the neighborhood around the picks: ring one for every pick, then the most shared ring-two artists
let warming = false, again = null;
export async function warm(guests, onProgress) {
  if (warming) { again = [guests, onProgress]; return null; }
  warming = true;
  try {
    const owner = new Map();
    guests.forEach((g, gi) => g.picks.forEach(p => { if (!owner.has(+p.aid)) owner.set(+p.aid, new Set()); owner.get(+p.aid).add(gi); }));
    const seeds = [...owner.keys()];
    await Promise.all(seeds.map(s => M.related(s, 'hi')));
    sync();
    if (onProgress) onProgress();
    const reach = new Map();
    for (const s of seeds) for (const v of nbrs(s)) reach.set(v, (reach.get(v) || 0) + owner.get(s).size + M.artistFans(v) / 1e8);
    const budget = Math.min(600, Math.max(120, 25 * guests.length));
    const todo = [...reach.entries()].filter(([v]) => !M.hasRelated(v)).sort((a, b) => b[1] - a[1]).slice(0, budget).map(x => x[0]);
    for (let i = 0; i < todo.length; i += 12) {
      await Promise.all(todo.slice(i, i + 12).map(v => M.related(v, 'lo')));
      if (onProgress) onProgress();
    }
    seeds.forEach(s => M.genre(s));
  } finally {
    warming = false;
    if (again) { const a = again; again = null; warm(...a); }
  }
}
