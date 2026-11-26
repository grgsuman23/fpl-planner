// Walk-forward backtest: for each finished GW t, rebuild the world as it looked at the GW t deadline
// (stats from rounds < t only), project, then score against what actually happened in round t.
//  1) Projection accuracy vs two baselines (last-4 form, season points-per-game)
//  2) Captain pick accuracy
//  3) A simulated "model manager" (£100m, 1 FT/week, the app's own transfer/lineup/captain logic)
//     compared with the FPL average manager and optional real teams.
// Simplifications (stated in the output): no chips, selling price = current price, no injury news
// (status unknown historically), team strength ratings are today's.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api as realApi } from './fpl.mjs';
import { buildProjections } from './model.mjs';
import { optimise, candidatePool, bestLineup } from './optimize.mjs';
import { decayWeights } from './planner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUM_KEYS = ['minutes', 'goals_scored', 'assists', 'expected_goals', 'expected_assists', 'expected_goals_conceded',
  'saves', 'bonus', 'defensive_contribution', 'yellow_cards', 'red_cards', 'total_points', 'starts'];
const num = v => Number(v) || 0;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function snapshot(bootstrap, fixtures, hist, t) {
  // elements as they were at the GW t deadline
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
    const r = { minutes: 0, xg: 0, xa: 0, bonus: 0, saves: 0, dc: 0, goals: 0, assists: 0 };
    for (const row of rows) if (lastGws.includes(row.round)) {
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

const actual = (hist, id, t) => (hist.get(id) || []).filter(r => r.round === t);
const actPts = (hist, id, t) => actual(hist, id, t).reduce((a, r) => a + num(r.total_points), 0);
const actMin = (hist, id, t) => actual(hist, id, t).reduce((a, r) => a + num(r.minutes), 0);

// FPL autosubs + vice captain, returns actual points for a picked lineup
function scoreLineup(lu, byId, hist, t) {
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
  return starters.reduce((a, i) => a + actPts(hist, i, t), 0) + (cap ? actPts(hist, cap, t) : 0);
}

function corr(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const rnd = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export async function backtest({ api = realApi, outDir = path.join(ROOT, 'docs', 'data'), startGw = 4, teamIds = [], log = console.log } = {}) {
  const [bootstrap, fixtures] = await Promise.all([api.bootstrap(), api.fixtures()]);
  const finished = bootstrap.events.filter(e => e.finished).map(e => e.id);
  const lastGw = Math.max(...finished);
  if (lastGw < startGw) throw new Error(`Need at least GW${startGw} finished`);
  log(`Fetching history for ${bootstrap.elements.length} players…`);
  const summaries = await pool(bootstrap.elements, 8, async el => {
    try { return (await api.elementSummary(el.id))?.history || []; } catch { return []; }
  });
  const hist = new Map(bootstrap.elements.map((el, i) => [el.id, summaries[i]]));

  const weeks = [];
  const sim = { squad: null, ft: 1, total: 0, bank: 0 };
  for (let t = startGw; t <= lastGw; t++) {
    const snap = snapshot(bootstrap, fixtures, hist, t);
    const { recent, teamGames } = recentFrom(hist, snap.fixtures, t);
    const gws = snap.bootstrap.events.map(e => e.id).filter(g => g >= t).slice(0, 6);
    const now = new Date(new Date(bootstrap.events.find(e => e.id === t).deadline_time).getTime() - 3600e3);
    const { players } = buildProjections({ bootstrap: snap.bootstrap, fixtures: snap.fixtures, recent, teamGames, gws, now });
    const byId = new Map(players.map(p => [p.id, p]));

    // ---- 1) projection accuracy on "relevant" players (played in the previous 4 GWs) ----
    const rel = players.filter(p => (recent.get(p.id)?.minutes || 0) > 0);
    const pred = rel.map(p => p.pts[t] || 0), act = rel.map(p => actPts(hist, p.id, t));
    const last4 = rel.map(p => {
      const rows = (hist.get(p.id) || []).filter(r => r.round >= t - 4 && r.round < t);
      const games = new Set(rows.map(r => r.round)).size || 1;
      const nowGames = (snap.fixtures.filter(f => f.event === t && (f.team_h === p.team || f.team_a === p.team))).length;
      return rows.reduce((a, r) => a + num(r.total_points), 0) / games * nowGames;
    });
    const ppg = rel.map(p => {
      const rows = (hist.get(p.id) || []).filter(r => r.round < t);
      const games = new Set(rows.map(r => r.round)).size || 1;
      const nowGames = (snap.fixtures.filter(f => f.event === t && (f.team_h === p.team || f.team_a === p.team))).length;
      return rows.reduce((a, r) => a + num(r.total_points), 0) / games * nowGames;
    });
    const mae = xs => xs.reduce((a, x, i) => a + Math.abs(x - act[i]), 0) / xs.length;
    const topN = (xs, n = 20) => xs.map((x, i) => [x, act[i]]).sort((a, b) => b[0] - a[0]).slice(0, n).reduce((a, r) => a + r[1], 0) / n;

    // ---- 2) captain: best projected player overall vs best by form ----
    const capModel = rel[pred.indexOf(Math.max(...pred))];
    const capForm = rel[last4.indexOf(Math.max(...last4))];
    const bestActual = Math.max(...act);

    // ---- 3) simulated manager ----
    const H = gws.length, w = decayWeights(H);
    let moves = [], hits = 0;
    if (!sim.squad) {
      const r = await optimise({ players: candidatePool(players, gws, w), gws, weights: w, budget: 100 });
      sim.squad = r.squad; sim.bank = rnd(100 - r.cost, 1);
    } else {
      const current = new Map(sim.squad.filter(id => byId.has(id)).map(id => [id, byId.get(id).price]));
      const budget = sim.bank + [...current.values()].reduce((a, b) => a + b, 0);
      const cands = candidatePool(players, gws, w, new Set(current.keys()));
      const plans = [];
      for (let k = 0; k <= Math.min(5, sim.ft + 1); k++) {
        const r = await optimise({ players: cands, gws, weights: w, budget, current, exactTransfers: k });
        if (!r) continue;
        const h = 4 * Math.max(0, k - sim.ft), roll = sim.ft < 5 ? 1.5 * Math.min(k, sim.ft) : 0;
        plans.push({ k, r, hits: h, score: r.objective - h - roll });
      }
      const best = plans.reduce((a, b) => (b.score > a.score + (b.hits > a.hits ? 2 * (b.hits - a.hits) / 4 : 0.25) ? b : a), plans[0]);
      moves = best.r.transfersOut.map((o, i) => [o, best.r.transfersIn[i]]);
      hits = best.hits;
      sim.ft = Math.min(5, Math.max(0, sim.ft - best.k) + 1);
      sim.squad = best.r.squad; sim.bank = rnd(budget - best.r.cost, 1);
    }
    const lu = bestLineup(sim.squad.map(i => byId.get(i)), t);
    const gross = scoreLineup(lu, byId, hist, t);
    const net = gross - hits;
    sim.total += net;
    const ev = bootstrap.events.find(e => e.id === t);

    weeks.push({
      gw: t,
      players: rel.length,
      mae: { model: rnd(mae(pred)), form: rnd(mae(last4)), ppg: rnd(mae(ppg)) },
      corr: { model: rnd(corr(pred, act)), form: rnd(corr(last4, act)), ppg: rnd(corr(ppg, act)) },
      top20: { model: rnd(topN(pred)), form: rnd(topN(last4)), ppg: rnd(topN(ppg)) },
      captain: {
        model: { id: capModel.id, name: capModel.name, pred: rnd(capModel.pts[t]), actual: actPts(hist, capModel.id, t) },
        form: { id: capForm.id, name: capForm.name, actual: actPts(hist, capForm.id, t) },
        bestActual,
      },
      sim: {
        points: net, hits, transfers: moves.map(([o, i]) => ({ out: byId.get(o)?.name, in: byId.get(i)?.name })),
        captain: byId.get(lu.captain).name, captainPts: actPts(hist, lu.captain, t), predicted: rnd(lu.xiPts, 1),
      },
      average: ev.average_entry_score ?? null, highest: ev.highest_score ?? null,
    });
    log(`GW${t}: model MAE ${rnd(mae(pred))} vs form ${rnd(mae(last4))} | sim ${net} vs avg ${ev.average_entry_score}`);
  }

  // Real teams over the same window
  const managers = [];
  for (const id of teamIds) {
    try {
      const [entry, h] = await Promise.all([api.entry(id), api.history(id)]);
      const rows = (h.current || []).filter(r => r.event >= startGw && r.event <= lastGw);
      managers.push({ id, name: entry.name, total: rows.reduce((a, r) => a + r.points - r.event_transfers_cost, 0), byGw: Object.fromEntries(rows.map(r => [r.event, r.points - r.event_transfers_cost])) });
    } catch (e) { log(`team ${id}: ${e.message}`); }
  }

  const avg = (k, sub) => rnd(weeks.reduce((a, w) => a + w[k][sub], 0) / weeks.length);
  const summary = {
    window: [startGw, lastGw], weeks: weeks.length,
    mae: { model: avg('mae', 'model'), form: avg('mae', 'form'), ppg: avg('mae', 'ppg') },
    corr: { model: avg('corr', 'model'), form: avg('corr', 'form'), ppg: avg('corr', 'ppg') },
    top20: { model: avg('top20', 'model'), form: avg('top20', 'form'), ppg: avg('top20', 'ppg') },
    captain: {
      model: weeks.reduce((a, w) => a + w.captain.model.actual, 0),
      form: weeks.reduce((a, w) => a + w.captain.form.actual, 0),
    },
    sim: { total: sim.total, perGw: rnd(sim.total / weeks.length, 1) },
    average: { total: weeks.reduce((a, w) => a + (w.average || 0), 0) },
    managers: managers.map(m => ({ id: m.id, name: m.name, total: m.total })),
  };
  const out = {
    generatedAt: new Date().toISOString(), summary, weeks, managers,
    caveats: [
      'Each week uses only data available before that deadline.',
      'Injury and suspension news is not available historically, so every player is treated as fit; the live model also uses news.',
      'The simulated manager plays no chips and sells at current price (no 50% sell-on rule).',
      'Club strength ratings are today\'s values, a small look-ahead.',
      `Starts at GW${startGw}: earlier weeks have too little data for a fair test.`,
    ],
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'backtest.json'), JSON.stringify(out));
  log(`Backtest GW${startGw}-${lastGw}: sim ${sim.total} vs avg ${summary.average.total}; MAE model ${summary.mae.model} form ${summary.mae.form} ppg ${summary.mae.ppg}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  backtest({ teamIds: cfg.teamIds || [], startGw: cfg.backtestStartGw || 4 }).catch(e => { console.error(e); process.exit(1); });
}
