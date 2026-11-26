// Integer-programming squad optimiser (GLPK). One model handles:
//  - transfers from your current squad (exact k transfers, hits applied)
//  - wildcard (free rebuild over a horizon)
//  - free hit (one-week rebuild)
import GLPKFactory from 'glpk.js';

let glpk;
async function solver() { return (glpk ||= await GLPKFactory()); }

const SQUAD = { 1: 2, 2: 5, 3: 5, 4: 3 };
const MIN_START = { 1: 1, 2: 3, 3: 2, 4: 1 };
const MAX_START = { 1: 1, 2: 5, 3: 5, 4: 3 };

// Keep the model small: best players per position by horizon points and by value, plus anyone forced/owned.
export function candidatePool(players, gws, weights, keepIds = new Set(), sizes = { 1: 14, 2: 40, 3: 45, 4: 28 }) {
  const score = p => gws.reduce((a, g, i) => a + (p.pts[g] || 0) * weights[i], 0);
  const out = new Map();
  for (const pos of [1, 2, 3, 4]) {
    const ps = players.filter(p => p.pos === pos && p.status !== 'u');
    const byPts = [...ps].sort((a, b) => score(b) - score(a)).slice(0, sizes[pos]);
    const byVal = [...ps].filter(p => score(p) > 0).sort((a, b) => score(b) / b.price - score(a) / a.price).slice(0, Math.ceil(sizes[pos] / 3));
    const cheap = [...ps].filter(p => score(p) > 0).sort((a, b) => a.price - b.price || score(b) - score(a)).slice(0, 4);
    for (const p of [...byPts, ...byVal, ...cheap]) out.set(p.id, p);
  }
  for (const p of players) if (keepIds.has(p.id)) out.set(p.id, p);
  return [...out.values()];
}

/**
 * opts: {
 *   players, gws, weights, budget,
 *   current: Map(id -> sellPrice) | null, ft, exactTransfers (number|null),
 *   benchWeight, hitCost, forceIn:[], forceOut:[], timeLimit
 * }
 */
export async function optimise(opts) {
  const G = await solver();
  const {
    players, gws, weights, budget, current = null, ft = 1, exactTransfers = null,
    benchWeight = 0.12, gkBenchWeight = 0.03, hitCost = 4, forceIn = [], forceOut = [], timeLimit = 20,
  } = opts;
  const price = p => (current && current.has(p.id) ? current.get(p.id) : p.price);
  const vars = [], cons = [], binaries = [], generals = [];
  const T = gws.length;

  for (const p of players) {
    const x = `x${p.id}`;
    binaries.push(x);
    for (let t = 0; t < T; t++) {
      const v = p.pts[gws[t]] || 0, w = weights[t];
      const bw = p.pos === 1 ? gkBenchWeight : benchWeight;
      // bench value: (x - s) * bw * v  -> x coef bw*v, s coef (1-bw)*v
      vars.push({ name: x, coef: w * bw * v });
      vars.push({ name: `s${p.id}_${t}`, coef: w * (1 - bw) * v });
      vars.push({ name: `c${p.id}_${t}`, coef: w * v });
      binaries.push(`s${p.id}_${t}`, `c${p.id}_${t}`);
      cons.push({ name: `sx${p.id}_${t}`, vars: [{ name: `s${p.id}_${t}`, coef: 1 }, { name: x, coef: -1 }], bnds: { type: G.GLP_UP, ub: 0, lb: 0 } });
      cons.push({ name: `cs${p.id}_${t}`, vars: [{ name: `c${p.id}_${t}`, coef: 1 }, { name: `s${p.id}_${t}`, coef: -1 }], bnds: { type: G.GLP_UP, ub: 0, lb: 0 } });
    }
  }
  const fx = (name, terms, v) => cons.push({ name, vars: terms, bnds: { type: G.GLP_FX, lb: v, ub: v } });
  const up = (name, terms, v) => cons.push({ name, vars: terms, bnds: { type: G.GLP_UP, lb: 0, ub: v } });
  const lo = (name, terms, v) => cons.push({ name, vars: terms, bnds: { type: G.GLP_LO, lb: v, ub: 0 } });

  for (const pos of [1, 2, 3, 4]) fx(`sq${pos}`, players.filter(p => p.pos === pos).map(p => ({ name: `x${p.id}`, coef: 1 })), SQUAD[pos]);
  const teams = [...new Set(players.map(p => p.team))];
  for (const tm of teams) up(`club${tm}`, players.filter(p => p.team === tm).map(p => ({ name: `x${p.id}`, coef: 1 })), 3);
  up('budget', players.map(p => ({ name: `x${p.id}`, coef: Math.round(price(p) * 10) })), Math.round(budget * 10 + 1e-6));

  for (let t = 0; t < T; t++) {
    fx(`xi${t}`, players.map(p => ({ name: `s${p.id}_${t}`, coef: 1 })), 11);
    fx(`cap${t}`, players.map(p => ({ name: `c${p.id}_${t}`, coef: 1 })), 1);
    for (const pos of [1, 2, 3, 4]) {
      const terms = players.filter(p => p.pos === pos).map(p => ({ name: `s${p.id}_${t}`, coef: 1 }));
      lo(`mn${pos}_${t}`, terms, MIN_START[pos]);
      up(`mx${pos}_${t}`, terms, MAX_START[pos]);
    }
  }
  for (const id of forceIn) fx(`in${id}`, [{ name: `x${id}`, coef: 1 }], 1);
  for (const id of forceOut) fx(`out${id}`, [{ name: `x${id}`, coef: 1 }], 0);

  if (current) {
    const keep = players.filter(p => current.has(p.id)).map(p => ({ name: `x${p.id}`, coef: 1 }));
    if (exactTransfers != null) {
      fx('ntr', keep, 15 - exactTransfers);
    } else {
      // hits h >= (15 - kept) - ft  ->  h + kept >= 15 - ft
      generals.push('h');
      vars.push({ name: 'h', coef: -hitCost });
      lo('hits', [...keep, { name: 'h', coef: 1 }], 15 - ft);
    }
  }

  const lp = {
    name: 'fpl', objective: { direction: G.GLP_MAX, name: 'obj', vars },
    subjectTo: cons, binaries, generals,
  };
  const res = await G.solve(lp, { msglev: G.GLP_MSG_OFF, presol: true, tmlim: timeLimit, mipgap: 0.002 });
  const st = res.result.status;
  if (st !== G.GLP_OPT && st !== G.GLP_FEAS) return null;
  const v = res.result.vars;
  const squad = players.filter(p => v[`x${p.id}`] > 0.5);
  const lineups = gws.map((gw, t) => ({
    gw,
    starters: squad.filter(p => v[`s${p.id}_${t}`] > 0.5).map(p => p.id),
    captain: squad.find(p => v[`c${p.id}_${t}`] > 0.5)?.id,
  }));
  const out = current ? [...current.keys()].filter(id => !squad.some(p => p.id === id)) : [];
  const inn = current ? squad.filter(p => !current.has(p.id)).map(p => p.id) : squad.map(p => p.id);
  const cost = squad.reduce((a, p) => a + price(p), 0);
  return { objective: res.result.z, squad: squad.map(p => p.id), lineups, transfersIn: inn, transfersOut: out, cost: +cost.toFixed(1), time: res.time };
}

// Best XI for one GW from a fixed 15 (greedy is optimal for FPL formation rules).
export function bestLineup(squadPlayers, gw) {
  const pts = p => p.pts[gw] || 0;
  const by = pos => squadPlayers.filter(p => p.pos === pos).sort((a, b) => pts(b) - pts(a));
  const gks = by(1);
  const starters = [gks[0]];
  const rest = [];
  for (const pos of [2, 3, 4]) {
    const list = by(pos);
    starters.push(...list.slice(0, MIN_START[pos]));
    rest.push(...list.slice(MIN_START[pos]));
  }
  rest.sort((a, b) => pts(b) - pts(a));
  const counts = { 2: 3, 3: 2, 4: 1 };
  const bench = [];
  for (const p of rest) {
    if (starters.length < 11 && counts[p.pos] < MAX_START[p.pos]) { starters.push(p); counts[p.pos]++; }
    else bench.push(p);
  }
  const ranked = [...starters].sort((a, b) => pts(b) - pts(a));
  const captain = ranked[0], vice = ranked[1];
  const xiPts = starters.reduce((a, p) => a + pts(p), 0) + pts(captain);
  const benchPts = bench.reduce((a, p) => a + pts(p), 0) + (gks[1] ? pts(gks[1]) : 0);
  return {
    gw, starters: starters.map(p => p.id), bench: [gks[1], ...bench].filter(Boolean).map(p => p.id),
    captain: captain?.id, vice: vice?.id, xiPts: +xiPts.toFixed(2), benchPts: +benchPts.toFixed(2), capPts: +pts(captain).toFixed(2),
  };
}

export function evalSquad(squadPlayers, gws, weights) {
  return gws.reduce((a, gw, i) => a + bestLineup(squadPlayers, gw).xiPts * weights[i], 0);
}
