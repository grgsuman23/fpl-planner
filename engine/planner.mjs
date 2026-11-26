// Team analysis: squad + selling prices + free transfers + chips, transfer plans, lineup, chip calendar.
import { optimise, candidatePool, bestLineup, evalSquad } from './optimize.mjs';

export const CHIP_NAMES = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };
const HALF_END = 19; // first chip set must be played by the GW19 deadline (2026/27 rules)
const half = gw => (gw <= HALF_END ? 1 : 2);

export function decayWeights(n, d = 0.9) { return Array.from({ length: n }, (_, i) => +Math.pow(d, i).toFixed(4)); }

export function sellPrice(purchase, now) {
  if (now <= purchase) return now;
  return +(purchase + Math.floor(Math.round((now - purchase) * 10) / 2) / 10).toFixed(1);
}

export function freeTransfers(history, chips, startedEvent, lastEvent) {
  const chipAt = Object.fromEntries((chips || []).map(c => [c.event, c.name]));
  let ft = 1;
  const rows = (history || []).filter(h => h.event > startedEvent && h.event <= lastEvent).sort((a, b) => a.event - b.event);
  for (const h of rows) {
    const chip = chipAt[h.event];
    if (chip !== 'wildcard' && chip !== 'freehit') ft = Math.max(0, ft - (h.event_transfers || 0));
    ft = Math.min(5, ft + 1);
  }
  return ft;
}

export function chipsAvailable(chips, nextGw) {
  const used = (chips || []).map(c => ({ name: c.name, half: half(c.event), event: c.event }));
  const h = half(nextGw);
  const avail = Object.keys(CHIP_NAMES).filter(n => !used.some(u => u.name === n && u.half === h));
  return { half: h, available: avail, used };
}

// Fetches everything needed for one manager and builds squad with selling prices.
export async function loadTeam(api, id, byId) {
  const [entry, history, transfers] = await Promise.all([api.entry(id), api.history(id), api.transfers(id)]);
  if (!entry) throw new Error(`Team ${id} not found`);
  const lastEvent = entry.current_event;
  let picks = await api.picks(id, lastEvent);
  if (picks?.active_chip === 'freehit' && lastEvent > 1) picks = await api.picks(id, lastEvent - 1); // FH squad reverts
  const fhEvents = new Set((history.chips || []).filter(c => c.name === 'freehit').map(c => c.event));
  const purchase = {};
  for (const t of [...(transfers || [])].sort((a, b) => new Date(a.time) - new Date(b.time))) {
    if (fhEvents.has(t.event)) continue;
    purchase[t.element_in] = t.element_in_cost / 10;
  }
  const squadIds = picks.picks.map(p => p.element);
  const missing = squadIds.filter(e => purchase[e] == null);
  const summaries = await Promise.all(missing.map(e => api.elementSummary(e).catch(() => null)));
  missing.forEach((e, i) => {
    const hist = summaries[i]?.history || [];
    const row = hist.find(h => h.round >= entry.started_event) || hist[0];
    purchase[e] = row ? row.value / 10 : byId.get(e)?.price;
  });
  const squad = squadIds.map(e => {
    const p = byId.get(e);
    return { id: e, purchase: purchase[e], now: p?.price, sell: sellPrice(purchase[e] ?? p?.price, p?.price) };
  });
  return {
    id, name: entry.name, manager: `${entry.player_first_name} ${entry.player_last_name}`,
    overallRank: entry.summary_overall_rank, overallPoints: entry.summary_overall_points,
    lastEvent, startedEvent: entry.started_event,
    bank: (picks.entry_history?.bank ?? 0) / 10,
    squad, history: history.current, chips: history.chips || [],
    lastPicks: picks.picks,
  };
}

async function transferPlans({ players, byId, team, gws, weights, ft }) {
  const current = new Map(team.squad.map(s => [s.id, s.sell]));
  const budget = team.bank + team.squad.reduce((a, s) => a + s.sell, 0);
  const pool = candidatePool(players, gws, weights, new Set(current.keys()));
  const maxK = Math.min(5, ft + 2);
  const plans = [];
  for (let k = 0; k <= maxK; k++) {
    const r = await optimise({ players: pool, gws, weights, budget, current, exactTransfers: k });
    if (!r) continue;
    const hits = 4 * Math.max(0, k - ft);
    const rollCost = ft < 5 ? 1.5 * Math.min(k, ft) : 0; // value of banking a free transfer
    plans.push({
      k, hits, objective: +r.objective.toFixed(2), net: +(r.objective - hits).toFixed(2),
      score: +(r.objective - hits - rollCost).toFixed(2),
      in: r.transfersIn, out: r.transfersOut, squad: r.squad, bankAfter: +(budget - r.cost).toFixed(1),
    });
  }
  const base = plans.find(p => p.k === 0)?.net ?? 0;
  for (const p of plans) p.gain = +(p.net - base).toFixed(2);
  // Extra transfers must clearly pay: +0.25 margin for free moves, +2 per extra hit taken (projection noise)
  const best = plans.reduce((a, b) => (b.score > a.score + (b.hits > a.hits ? 2 * (b.hits - a.hits) / 4 : 0.25) ? b : a), plans[0]);
  // pair outs with ins by position for display
  for (const p of plans) {
    const outs = p.out.map(id => byId.get(id)), ins = p.in.map(id => byId.get(id));
    p.moves = [];
    for (const o of outs) {
      const i = ins.findIndex(x => x && x.pos === o.pos);
      p.moves.push({ out: o.id, in: i >= 0 ? ins.splice(i, 1)[0].id : null });
    }
  }
  return { plans, recommended: best?.k ?? 0, budget: +budget.toFixed(1) };
}

// Values each chip for each GW in the window, then schedules them.
export async function chipPlan({ players, byId, squadIds, budget, gws, chipState, nextGw, fixtureCounts }) {
  const squadP = squadIds.map(id => byId.get(id));
  const windowGws = gws.filter(g => half(g) === chipState.half);
  const values = {};
  for (const gw of windowGws) {
    const lu = bestLineup(squadP, gw);
    const v = { gw, tc: lu.capPts, bb: lu.benchPts, fh: null, wc: null, captain: lu.captain };
    if (chipState.available.includes('freehit') && gw > 1) {
      const pool = candidatePool(players, [gw], [1]);
      const r = await optimise({ players: pool, gws: [gw], weights: [1], budget, benchWeight: 0, gkBenchWeight: 0 });
      if (r) { v.fh = +(r.objective - lu.xiPts).toFixed(2); v.fhSquad = r.squad; }
    }
    if (chipState.available.includes('wildcard')) {
      const idx = gws.indexOf(gw);
      const wgws = gws.slice(idx, idx + 6), ww = decayWeights(wgws.length);
      const pool = candidatePool(players, wgws, ww);
      const r = await optimise({ players: pool, gws: wgws, weights: ww, budget });
      if (r) {
        const gain = evalSquad(r.squad.map(id => byId.get(id)), wgws, ww) - evalSquad(squadP, wgws, ww);
        v.wc = +(gain * 0.6).toFixed(2); // ~40% of the gap you'd close anyway with normal free transfers
        v.wcSquad = r.squad;
      }
    }
    values[gw] = v;
  }

  // Baselines: an "average" chip use is worth roughly this much
  const baseline = { tc: 6, bb: 10, fh: 10, wc: 12 };
  const key = { '3xc': 'tc', bboost: 'bb', freehit: 'fh', wildcard: 'wc' };
  const chips = chipState.available.filter(c => windowGws.some(g => values[g][key[c]] != null));
  const expiring = chipState.half === 1;

  // exhaustive assignment: each chip to a distinct GW (or held), maximise total value
  let best = { total: -Infinity, assign: {} };
  const rec = (i, used, total, assign) => {
    if (i === chips.length) { if (total > best.total) best = { total, assign: { ...assign } }; return; }
    const c = chips[i], k = key[c];
    if (!expiring) rec(i + 1, used, total, assign); // second half: allowed to hold
    for (const g of windowGws) {
      if (used.has(g) || values[g][k] == null) continue;
      const val = values[g][k] - (expiring ? 0 : baseline[k]);
      used.add(g); assign[c] = g;
      rec(i + 1, used, total + val, assign);
      used.delete(g); delete assign[c];
    }
    if (expiring && windowGws.length < chips.length) rec(i + 1, used, total, assign);
  };
  rec(0, new Set(), 0, {});

  const schedule = chips.map(c => {
    const k = key[c];
    const ranked = windowGws.filter(g => values[g][k] != null).map(g => ({ gw: g, value: values[g][k] })).sort((a, b) => b.value - a.value);
    const gw = best.assign[c] ?? null;
    return {
      chip: c, label: CHIP_NAMES[c], gw, playNow: gw === nextGw,
      value: gw ? values[gw][k] : null, bestWeeks: ranked.slice(0, 3),
      note: gw == null
        ? 'Hold — no week in the projection window beats a typical use. Watch for doubles/blanks.'
        : gw === nextGw ? `Play it this week (GW${gw}).` : `Pencil in GW${gw}.`,
    };
  });

  return {
    half: chipState.half, expiresAfter: chipState.half === 1 ? HALF_END : 38, expiring,
    available: chipState.available, used: chipState.used, values: windowGws.map(g => values[g]), schedule,
    specialWeeks: specialWeeks(fixtureCounts, nextGw),
  };
}

// Doubles/blanks from the fixture list (all remaining GWs, including second half)
export function specialWeeks(fixtureCounts, nextGw) {
  const out = [];
  for (const [gw, counts] of Object.entries(fixtureCounts)) {
    const g = Number(gw);
    if (g < nextGw) continue;
    const doubles = Object.entries(counts.teams).filter(([, n]) => n >= 2).map(([t]) => Number(t));
    const blanks = counts.blanks;
    if (doubles.length || blanks.length) out.push({ gw: g, doubles, blanks, fixtures: counts.n });
  }
  return out;
}

export async function analyseTeam({ api, id, players, byId, gws, nextGw, fixtureCounts, ftOverride }) {
  const team = await loadTeam(api, id, byId);
  const ft = ftOverride ?? freeTransfers(team.history, team.chips, team.startedEvent, team.lastEvent);
  const H = Math.min(6, gws.length), tgws = gws.slice(0, H), weights = decayWeights(H);
  const tp = await transferPlans({ players, byId, team, gws: tgws, weights, ft });
  const rec = tp.plans.find(p => p.k === tp.recommended);
  const squadIds = rec?.squad || team.squad.map(s => s.id);
  const lineup = bestLineup(squadIds.map(i => byId.get(i)), nextGw);
  const captainOptions = squadIds.map(i => byId.get(i)).sort((a, b) => (b.pts[nextGw] || 0) - (a.pts[nextGw] || 0)).slice(0, 5).map(p => p.id);
  const chipState = chipsAvailable(team.chips, nextGw);
  const budget = tp.budget;
  const chips = await chipPlan({ players, byId, squadIds, budget, gws, chipState, nextGw, fixtureCounts });

  // If a WC/FH is scheduled for this week, swap the headline team to the chip squad
  let chipTeam = null;
  const now = chips.schedule.find(s => s.playNow && (s.chip === 'wildcard' || s.chip === 'freehit'));
  if (now) {
    const v = chips.values.find(x => x.gw === nextGw);
    const sq = now.chip === 'wildcard' ? v.wcSquad : v.fhSquad;
    if (sq) chipTeam = { chip: now.chip, squad: sq, lineup: bestLineup(sq.map(i => byId.get(i)), nextGw) };
  }
  for (const v of chips.values) { delete v.wcSquad; delete v.fhSquad; }

  return {
    id, name: team.name, manager: team.manager, overallRank: team.overallRank, overallPoints: team.overallPoints,
    lastEvent: team.lastEvent, bank: team.bank, freeTransfers: ft,
    squad: team.squad, squadValue: +(team.squad.reduce((a, s) => a + s.sell, 0)).toFixed(1),
    transfers: tp, lineup, captainOptions, chips, chipTeam,
  };
}
