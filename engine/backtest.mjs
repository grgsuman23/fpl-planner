// Walk-forward backtest: for each finished GW t, rebuild the world as it looked at the GW t deadline
// (stats from rounds < t only), project, decide, then score against what actually happened in round t.
//  1) Projection accuracy vs two baselines (last-4 form, season points-per-game)
//  2) Captain pick accuracy
//  3) A simulated "model manager" (£100m, the app's own transfer/lineup/captain logic, optional chips)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api as realApi } from './fpl.mjs';
import { buildProjections, DEFAULT_PARAMS } from './model.mjs';
import { optimise, candidatePool, bestLineup, evalSquad } from './optimize.mjs';
import { decayWeights } from './planner.mjs';
import { buildLastSeason, prevSeasonName, lastSeasonFromJSON } from './lastseason.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUM_KEYS = ['minutes', 'goals_scored', 'assists', 'expected_goals', 'expected_assists', 'expected_goals_conceded',
  'saves', 'bonus', 'defensive_contribution', 'yellow_cards', 'red_cards', 'total_points', 'starts'];
const num = v => Number(v) || 0;
const rnd = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export const DEFAULT_POLICY = {
  horizon: 6, decay: 0.9, benchWeight: 0.12, rollValue: 1.5, hitMargin: 2, freeMargin: 0.25, maxExtra: 1,
  chips: true, thrTC: 6, thrBB: 9, thrFH: 9, thrWC: 7, halfEnd: 19,
};

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function snapshot(bootstrap, fixtures, hist, t) {
  const elements = bootstrap.elements.map(el => {
    const rows = hist.get(el.id) || [];
    const past = rows.filter(r => r.round < t);
    const e = { ...el, status: 'a', chance_of_playing_next_round: null, news: '', ep_next: null };
    for (const k of SUM_KEYS) e[k] = past.reduce((a, r) => a + num(r[k]), 0);
    const priceRow = rows.find(r => r.round === t) || [...past].reverse()[0];
    if (priceRow) e.now_cost = priceRow.value;
    return e;
  });
  const fx = fixtures.map(f => (f.event != null && f.event < t ? f : { ...f, finished: false, team_h_score: null, team_a_score: null }));
  const events = bootstrap.events.map(ev => ({ ...ev, finished: ev.id < t, is_next: ev.id === t, is_current: ev.id === t - 1 }));
  return { bootstrap: { ...bootstrap, elements, events }, fixtures: fx };
}

function recentFrom(hist, fixtures, t) {
  const lastGws = [t - 4, t - 3, t - 2, t - 1].filter(g => g >= 1);
  const m = new Map();
  for (const [id, rows] of hist) {
    const r = { minutes: 0, xg: 0, xa: 0, bonus: 0, saves: 0, dc: 0, goals: 0, assists: 0, starts: 0, startsByGw: {} };
    for (const row of rows) if (lastGws.includes(row.round)) {
      r.starts += num(row.starts); r.startsByGw[row.round] = (r.startsByGw[row.round] || 0) + num(row.starts);
      r.minutes += num(row.minutes); r.xg += num(row.expected_goals); r.xa += num(row.expected_assists);
      r.bonus += num(row.bonus); r.saves += num(row.saves); r.dc += num(row.defensive_contribution);
      r.goals += num(row.goals_scored); r.assists += num(row.assists);
    }
    m.set(id, r);
  }
  const teamGames = {};
  for (const f of fixtures) if (f.event != null && lastGws.includes(f.event) && f.finished) {
    teamGames[f.team_h] = (teamGames[f.team_h] || 0) + 1; teamGames[f.team_a] = (teamGames[f.team_a] || 0) + 1;
  }
  return { recent: m, teamGames };
}

const rowsAt = (hist, id, t) => (hist.get(id) || []).filter(r => r.round === t);
const actPts = (hist, id, t) => rowsAt(hist, id, t).reduce((a, r) => a + num(r.total_points), 0);
const actMin = (hist, id, t) => rowsAt(hist, id, t).reduce((a, r) => a + num(r.minutes), 0);

// FPL autosubs + vice captain; returns actual points
function scoreLineup(lu, byId, hist, t, { tc = false, bb = false } = {}) {
  if (bb) {
    const all = [...lu.starters, ...lu.bench];
    const cap = actMin(hist, lu.captain, t) > 0 ? lu.captain : (actMin(hist, lu.vice, t) > 0 ? lu.vice : null);
    return all.reduce((a, i) => a + actPts(hist, i, t), 0) + (cap ? actPts(hist, cap, t) * (tc ? 2 : 1) : 0);
  }
  const starters = [...lu.starters], bench = [...lu.bench];
  const posCount = () => { const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; starters.forEach(i => c[byId.get(i).pos]++); return c; };
  for (const s of [...starters]) {
    if (actMin(hist, s, t) > 0) continue;
    const sp = byId.get(s).pos;
    for (let b = 0; b < bench.length; b++) {
      const bp = byId.get(bench[b]).pos;
      if (actMin(hist, bench[b], t) === 0) continue;
      if ((sp === 1) !== (bp === 1)) continue;
      const c = posCount(); c[sp]--; c[bp]++;
      if (c[2] < 3 || c[3] < 2 || c[4] < 1) continue;
      starters[starters.indexOf(s)] = bench[b]; bench.splice(b, 1); break;
    }
  }
  const cap = actMin(hist, lu.captain, t) > 0 ? lu.captain : (actMin(hist, lu.vice, t) > 0 ? lu.vice : null);
  return starters.reduce((a, i) => a + actPts(hist, i, t), 0) + (cap ? actPts(hist, cap, t) * (tc ? 2 : 1) : 0);
}

function corr(xs, ys) {
  const n = xs.length; if (!n) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Core replay. data = { bootstrap, fixtures, hist: Map(id -> rows) } */
export async function runBacktest({ data, startGw = 1, endGw, params = {}, policy = {}, lastSeason = null, log = () => {} }) {
  const { bootstrap, fixtures, hist } = data;
  const P = { ...DEFAULT_PARAMS, ...params }, Q = { ...DEFAULT_POLICY, ...policy };
  const lastGw = endGw ?? Math.max(...bootstrap.events.filter(e => e.finished).map(e => e.id));
  const weeks = [];
  const sim = { squad: null, ft: 1, total: 0, bank: 0, used: [] };

  for (let t = startGw; t <= lastGw; t++) {
    const snap = snapshot(bootstrap, fixtures, hist, t);
    const { recent, teamGames } = recentFrom(hist, snap.fixtures, t);
    const gws = snap.bootstrap.events.map(e => e.id).filter(g => g >= t).slice(0, Math.max(Q.horizon, 6));
    const now = new Date(new Date(bootstrap.events.find(e => e.id === t).deadline_time).getTime() - 3600e3);
    const { players } = buildProjections({ bootstrap: snap.bootstrap, fixtures: snap.fixtures, recent, teamGames, gws, now, params: P, lastSeason });
    if (Q.noise > 0) { // seeded perturbation for ensemble robustness tests
      let sd = (Q.seed || 1) * 7919 + t * 104729;
      const u = () => ((sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (const p of players) { const z = Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u()); const f = Math.max(0.5, 1 + Q.noise * z); for (const g of Object.keys(p.pts)) p.pts[g] *= f; }
    }
    const byId = new Map(players.map(p => [p.id, p]));

    // ---- 1) projection accuracy: players with recent minutes, last-season minutes, or price >= £5m ----
    const rel = players.filter(p => (recent.get(p.id)?.minutes || 0) > 0 || (lastSeason?.get(p.id)?.minutes || 0) >= 900 || p.price >= 5);
    const pred = rel.map(p => p.pts[t] || 0), act = rel.map(p => actPts(hist, p.id, t));
    const gamesNow = p => snap.fixtures.filter(f => f.event === t && (f.team_h === p.team || f.team_a === p.team)).length;
    const baseline = (p, from) => {
      const rows = (hist.get(p.id) || []).filter(r => r.round >= from && r.round < t);
      const games = new Set(rows.map(r => r.round)).size;
      if (!games) { const ls = lastSeason?.get(p.id); return ls ? ls.pts / 38 * gamesNow(p) : 1; }
      return rows.reduce((a, r) => a + num(r.total_points), 0) / games * gamesNow(p);
    };
    const form = rel.map(p => baseline(p, t - 4)), ppg = rel.map(p => baseline(p, 1));
    const mae = xs => xs.reduce((a, x, i) => a + Math.abs(x - act[i]), 0) / xs.length;
    const topN = (xs, n = 20) => xs.map((x, i) => [x, act[i]]).sort((a, b) => b[0] - a[0]).slice(0, n).reduce((a, r) => a + r[1], 0) / n;
    const capModel = rel[pred.indexOf(Math.max(...pred))], capForm = rel[form.indexOf(Math.max(...form))];

    if (Q.simulate === false) {
      weeks.push({ gw: t, players: rel.length, mae: { model: rnd(mae(pred)), form: rnd(mae(form)), ppg: rnd(mae(ppg)) }, corr: { model: rnd(corr(pred, act)), form: rnd(corr(form, act)), ppg: rnd(corr(ppg, act)) }, top20: { model: rnd(topN(pred)), form: rnd(topN(form)), ppg: rnd(topN(ppg)) }, top50: rnd(topN(pred, 50)), captain: { model: { actual: actPts(hist, capModel.id, t) }, form: { actual: 0 } }, sim: { points: 0 } });
      continue;
    }
    // ---- 2) simulated manager ----
    const H = Q.horizon, tg = gws.slice(0, H), w = decayWeights(tg.length, Q.decay);
    let moves = [], hits = 0, chip = null, fhSquad = null;
    const half = t <= Q.halfEnd ? 1 : 2;
    const avail = ['wildcard', 'freehit', 'bboost', '3xc'].filter(c => !sim.used.some(u => u.chip === c && u.half === half));

    if (!sim.squad) {
      const r = await optimise({ players: candidatePool(players, tg, w), gws: tg, weights: w, budget: 100, benchWeight: Q.benchWeight });
      sim.squad = r.squad; sim.bank = rnd(100 - r.cost, 1);
    } else {
      const current = new Map(sim.squad.filter(id => byId.has(id)).map(id => [id, byId.get(id).price]));
      const budget = sim.bank + [...current.values()].reduce((a, b) => a + b, 0);
      const squadP = sim.squad.map(i => byId.get(i));

      // chips (online rule: this week is the best upcoming week for the chip and clears a bar, or we're out of time)
      if (Q.chips && avail.length) {
        const weeksLeft = (half === 1 ? Q.halfEnd : 38) - t + 1;
        const forced = weeksLeft <= avail.length;
        const cand = [];
        const lus = tg.map(g => bestLineup(squadP, g));
        if (avail.includes('3xc')) { const v = lus.map(l => l.capPts); cand.push({ chip: '3xc', v: v[0], ok: v[0] >= Q.thrTC && v[0] >= Math.max(...v) - 0.01, thr: Q.thrTC }); }
        if (avail.includes('bboost')) { const v = lus.map(l => l.benchPts); cand.push({ chip: 'bboost', v: v[0], ok: v[0] >= Q.thrBB && v[0] >= Math.max(...v) - 0.01, thr: Q.thrBB }); }
        if (avail.includes('freehit') && t > 1) {
          const r = await optimise({ players: candidatePool(players, [t], [1]), gws: [t], weights: [1], budget, benchWeight: 0, gkBenchWeight: 0 });
          if (r) { const v = r.objective - lus[0].xiPts; cand.push({ chip: 'freehit', v, ok: v >= Q.thrFH, thr: Q.thrFH, squad: r.squad }); }
        }
        if (avail.includes('wildcard') && t > 1) {
          const r = await optimise({ players: candidatePool(players, tg, w), gws: tg, weights: w, budget, benchWeight: Q.benchWeight });
          if (r) { const v = 0.6 * (evalSquad(r.squad.map(i => byId.get(i)), tg, w) - evalSquad(squadP, tg, w)); cand.push({ chip: 'wildcard', v, ok: v >= Q.thrWC, thr: Q.thrWC, squad: r.squad, cost: r.cost }); }
        }
        const pickFrom = cand.filter(c => c.ok || forced).sort((a, b) => b.v / b.thr - a.v / a.thr);
        if (pickFrom.length) {
          const c = pickFrom[0]; chip = c.chip; sim.used.push({ chip, half, gw: t });
          if (chip === 'wildcard') { moves = c.squad.filter(i => !current.has(i)).map(i => [null, i]); sim.squad = c.squad; sim.bank = rnd(budget - c.cost, 1); }
          if (chip === 'freehit') fhSquad = c.squad;
        }
      }

      if (chip !== 'wildcard' && chip !== 'freehit') {
        const cands = candidatePool(players, tg, w, new Set(current.keys()));
        const plans = [];
        for (let k = 0; k <= Math.min(5, sim.ft + Q.maxExtra); k++) {
          const r = await optimise({ players: cands, gws: tg, weights: w, budget, current, exactTransfers: k, benchWeight: Q.benchWeight });
          if (!r) continue;
          const h = 4 * Math.max(0, k - sim.ft), roll = sim.ft < 5 ? Q.rollValue * Math.min(k, sim.ft) : 0;
          plans.push({ k, r, hits: h, score: r.objective - h - roll });
        }
        const best = plans.reduce((a, b) => (b.score > a.score + (b.hits > a.hits ? Q.hitMargin * (b.hits - a.hits) / 4 : Q.freeMargin) ? b : a), plans[0]);
        moves = best.r.transfersOut.map((o, i) => [o, best.r.transfersIn[i]]);
        hits = best.hits;
        sim.ft = Math.min(5, Math.max(0, sim.ft - best.k) + 1);
        sim.squad = best.r.squad; sim.bank = rnd(budget - best.r.cost, 1);
      } else {
        sim.ft = Math.min(5, sim.ft + 1); // WC/FH keep banked transfers
      }
    }
    const playSquad = fhSquad || sim.squad;
    const lu = bestLineup(playSquad.map(i => byId.get(i)), t);
    const gross = scoreLineup(lu, byId, hist, t, { tc: chip === '3xc', bb: chip === 'bboost' });
    const net = gross - hits;
    sim.total += net;
    const ev = bootstrap.events.find(e => e.id === t);

    weeks.push({
      gw: t, players: rel.length,
      mae: { model: rnd(mae(pred)), form: rnd(mae(form)), ppg: rnd(mae(ppg)) },
      corr: { model: rnd(corr(pred, act)), form: rnd(corr(form, act)), ppg: rnd(corr(ppg, act)) },
      top20: { model: rnd(topN(pred)), form: rnd(topN(form)), ppg: rnd(topN(ppg)) },
      captain: {
        model: { id: capModel.id, name: capModel.name, pred: rnd(capModel.pts[t]), actual: actPts(hist, capModel.id, t) },
        form: { id: capForm.id, name: capForm.name, actual: actPts(hist, capForm.id, t) },
        bestActual: Math.max(...act),
      },
      sim: {
        points: net, hits, chip, transfers: moves.map(([o, i]) => ({ out: o ? byId.get(o)?.name : null, in: byId.get(i)?.name })),
        captain: byId.get(lu.captain).name, captainPts: actPts(hist, lu.captain, t), predicted: rnd(lu.xiPts, 1),
      },
      average: ev.average_entry_score ?? null, highest: ev.highest_score ?? null,
    });
    log(`GW${t}: MAE ${rnd(mae(pred))} (form ${rnd(mae(form))}) | sim ${net}${chip ? ` [${chip}]` : ''} vs avg ${ev.average_entry_score}`);
  }
  const avg = (k, sub, ws = weeks) => rnd(ws.reduce((a, w) => a + w[k][sub], 0) / ws.length);
  return {
    weeks,
    summary: {
      window: [startGw, lastGw], weeks: weeks.length,
      mae: { model: avg('mae', 'model'), form: avg('mae', 'form'), ppg: avg('mae', 'ppg') },
      corr: { model: avg('corr', 'model'), form: avg('corr', 'form'), ppg: avg('corr', 'ppg') },
      top20: { model: avg('top20', 'model'), form: avg('top20', 'form'), ppg: avg('top20', 'ppg') },
      captain: { model: weeks.reduce((a, w) => a + w.captain.model.actual, 0), form: weeks.reduce((a, w) => a + w.captain.form.actual, 0) },
      sim: { total: sim.total, perGw: rnd(sim.total / weeks.length, 1), chips: sim.used },
      average: { total: weeks.reduce((a, w) => a + (w.average || 0), 0) },
    },
  };
}

export async function loadLive(api, log) {
  const [bootstrap, fixtures] = await Promise.all([api.bootstrap(), api.fixtures()]);
  log(`Fetching history for ${bootstrap.elements.length} players…`);
  const summaries = await pool(bootstrap.elements, 8, async el => {
    try { return await api.elementSummary(el.id); } catch { return null; }
  });
  const hist = new Map(bootstrap.elements.map((el, i) => [el.id, summaries[i]?.history || []]));
  const sumObj = Object.fromEntries(bootstrap.elements.map((el, i) => [el.id, { history_past: summaries[i]?.history_past || [] }]));
  return { data: { bootstrap, fixtures, hist }, lastSeason: buildLastSeason(sumObj, prevSeasonName(bootstrap)) };
}

export async function backtest({ api = realApi, outDir = path.join(ROOT, 'docs', 'data'), startGw = 1, teamIds = [], params, policy, ensembleN = 10, log = console.log } = {}) {
  const { data, lastSeason } = await loadLive(api, log);
  const res = await runBacktest({ data, startGw, params, policy, lastSeason, log });
  // Ensemble: replay N times with small seeded nudges to projections -> typical result, not one lucky path
  const runs = [];
  for (let seed = 1; seed <= ensembleN; seed++) {
    const r = await runBacktest({ data, startGw, params, policy: { ...(policy || {}), noise: 0.1, seed }, lastSeason });
    runs.push(r.summary.sim.total);
  }
  runs.sort((a, b) => a - b);
  res.summary.ensemble = runs.length ? { n: runs.length, mean: rnd(runs.reduce((a, b) => a + b, 0) / runs.length, 0), min: runs[0], max: runs[runs.length - 1], median: runs[Math.floor(runs.length / 2)] } : null;
  const [, lastGw] = res.summary.window;
  const managers = [];
  for (const id of teamIds) {
    try {
      const [entry, h] = await Promise.all([api.entry(id), api.history(id)]);
      const rows = (h.current || []).filter(r => r.event >= startGw && r.event <= lastGw);
      managers.push({ id, name: entry.name, total: rows.reduce((a, r) => a + r.points - r.event_transfers_cost, 0), chips: (h.chips || []).length, byGw: Object.fromEntries(rows.map(r => [r.event, r.points - r.event_transfers_cost])) });
    } catch (e) { log(`team ${id}: ${e.message}`); }
  }
  res.summary.managers = managers.map(m => ({ id: m.id, name: m.name, total: m.total }));
  const Q = { ...DEFAULT_POLICY, ...(policy || {}) };
  const out = {
    generatedAt: new Date().toISOString(), summary: res.summary, weeks: res.weeks, managers,
    caveats: [
      'Each week uses only data available before that deadline (plus last season\'s stats).',
      'One season is mostly luck: a single different captain changes the whole path. The typical result averages several replays with small nudges to the projections.',
      'Injury and suspension news is not available historically, so every player is treated as fit; the live model also uses news.',
      Q.chips ? 'Chips are played by a simple rule using only what was known that week.' : 'The simulated manager plays no chips.',
      'Selling price is the current price (the 50% sell-on rule is ignored).',
      'Club strength ratings are today\'s values, a small look-ahead.',
    ],
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'backtest.json'), JSON.stringify(out));
  log(`Backtest GW${startGw}-${lastGw}: sim ${res.summary.sim.total} vs avg ${res.summary.average.total}; MAE model ${res.summary.mae.model}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  backtest({ teamIds: cfg.teamIds || [], startGw: cfg.backtestStartGw || 1, params: cfg.modelParams, policy: cfg.policy, ensembleN: cfg.backtestRuns ?? 10 })
    .catch(e => { console.error(e); process.exit(1); });
}
export { lastSeasonFromJSON };
