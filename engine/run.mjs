// Entry point: node engine/run.mjs  (writes docs/data/*.json for the app)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api as realApi } from './fpl.mjs';
import { buildProjections, aggregateRecent } from './model.mjs';
import { optimise, candidatePool, bestLineup } from './optimize.mjs';
import { analyseTeam, decayWeights, specialWeeks } from './planner.mjs';
import { lastSeasonFromJSON } from './lastseason.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function run({ api = realApi, outDir = path.join(ROOT, 'docs', 'data'), config, now = new Date() } = {}) {
  config ||= JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const envIds = (process.env.FPL_TEAM_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number);
  const teamIds = [...new Set([...(config.teamIds || []), ...envIds])].filter(Boolean);
  const t0 = Date.now();

  const [bootstrap, fixtures] = await Promise.all([api.bootstrap(), api.fixtures()]);
  const events = bootstrap.events;
  const finished = events.filter(e => e.finished).map(e => e.id);
  const lastFinished = finished.length ? Math.max(...finished) : 0;
  const nextEv = events.find(e => e.is_next) || events.find(e => new Date(e.deadline_time) > now);
  if (!nextEv) throw new Error('Season over — no upcoming gameweek');
  const nextGw = nextEv.id;
  const horizon = Math.max(6, Math.min(config.horizon || 8, 10));
  const gws = events.map(e => e.id).filter(g => g >= nextGw).slice(0, horizon);

  const lastGws = finished.slice(-4);
  const lives = await Promise.all(lastGws.map(g => api.live(g).then(l => l && { ...l, gw: g }).catch(() => null)));
  const { recent, teamGames } = aggregateRecent(lives, fixtures, lastGws);
  let lastSeason = null;
  try { lastSeason = lastSeasonFromJSON(JSON.parse(await fs.readFile(path.join(ROOT, 'cache', 'last-season.json'), 'utf8'))); }
  catch { console.log('No cache/last-season.json; running without last-season priors'); }
  const { players, ratings, teamFix } = buildProjections({ bootstrap, fixtures, recent, teamGames, gws, now, params: config.modelParams, lastSeason });
  const byId = new Map(players.map(p => [p.id, p]));

  // fixture counts per GW for doubles/blanks (whole season remaining)
  const fixtureCounts = {};
  for (const e of events) fixtureCounts[e.id] = { n: 0, teams: {}, blanks: [] };
  for (const f of fixtures) {
    if (f.event == null) continue;
    const c = fixtureCounts[f.event]; c.n++;
    c.teams[f.team_h] = (c.teams[f.team_h] || 0) + 1;
    c.teams[f.team_a] = (c.teams[f.team_a] || 0) + 1;
  }
  for (const c of Object.values(fixtureCounts)) c.blanks = bootstrap.teams.map(t => t.id).filter(t => !c.teams[t]);
  const unscheduled = fixtures.filter(f => f.event == null).map(f => ({ h: f.team_h, a: f.team_a }));

  // General (no-team) recommendations
  const H = Math.min(6, gws.length), tgws = gws.slice(0, H), w = decayWeights(H);
  const wcPool = candidatePool(players, tgws, w);
  const wc = await optimise({ players: wcPool, gws: tgws, weights: w, budget: config.wildcardBudget || 100 });
  const fhPool = candidatePool(players, [nextGw], [1]);
  const fh = await optimise({ players: fhPool, gws: [nextGw], weights: [1], budget: config.wildcardBudget || 100, benchWeight: 0, gkBenchWeight: 0 });

  const ticker = bootstrap.teams.map(t => ({
    team: t.id,
    weeks: gws.map(gw => ({
      gw,
      games: (teamFix[gw][t.id] || []).map(f => {
        const me = ratings[t.id], op = ratings[f.opp], L = me.L;
        const gf = (me.att * op.def) / L * (f.home ? 1.1 : 1 / 1.1);
        const ga = (op.att * me.def) / L * (f.home ? 1 / 1.1 : 1.1);
        return { opp: f.opp, home: f.home, xgf: +gf.toFixed(2), xga: +ga.toFixed(2), cs: +Math.exp(-ga).toFixed(2) };
      }),
    })),
  }));

  const general = {
    generatedAt: new Date().toISOString(), nextGw, lastFinished, gws,
    deadline: nextEv.deadline_time,
    events: events.filter(e => e.id >= nextGw).map(e => ({ id: e.id, deadline: e.deadline_time })),
    teams: Object.values(ratings).map(r => ({ id: r.id, name: r.name, short: r.short, att: +r.att.toFixed(2), def: +r.def.toFixed(2) })),
    players: players
      .filter(p => p.status !== 'u' && (p.totalPts > 0 || p.share > 0.05 || gws.some(g => p.pts[g] > 2)))
      .map(p => ({ ...p, pts: Object.fromEntries(Object.entries(p.pts).map(([g, v]) => [g, +v.toFixed(2)])) })),
    wildcard: wc && { ...wc, lineup: bestLineup(wc.squad.map(i => byId.get(i)), nextGw) },
    freeHit: fh && { ...fh, lineup: bestLineup(fh.squad.map(i => byId.get(i)), nextGw) },
    ticker,
    specialWeeks: specialWeeks(fixtureCounts, nextGw),
    unscheduled,
    teamIds,
  };
  // make sure every player referenced by the optimiser output is present
  const listed = new Set(general.players.map(p => p.id));
  const need = new Set([...(wc?.squad || []), ...(fh?.squad || [])]);

  await fs.mkdir(outDir, { recursive: true });
  const teamsOut = [];
  for (const id of teamIds) {
    try {
      const res = await analyseTeam({ api, id, players, byId, gws, nextGw, fixtureCounts, ftOverride: config.freeTransfers?.[id] });
      res.generatedAt = general.generatedAt; res.nextGw = nextGw;
      [...res.squad.map(s => s.id), ...res.transfers.plans.flatMap(p => p.squad), ...(res.chipTeam?.squad || [])].forEach(i => need.add(i));
      await fs.writeFile(path.join(outDir, `team-${id}.json`), JSON.stringify(res));
      teamsOut.push({ id, name: res.name, ok: true });
      console.log(`Team ${id} (${res.name}): FT=${res.freeTransfers}, recommended ${res.transfers.recommended} transfer(s)`);
    } catch (e) {
      console.error(`Team ${id} failed:`, e.message);
      teamsOut.push({ id, ok: false, error: e.message });
    }
  }
  for (const i of need) if (!listed.has(i) && byId.has(i)) general.players.push(byId.get(i));
  general.teamsAnalysed = teamsOut;
  general.runSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  await fs.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(general));
  console.log(`Done GW${nextGw}: ${general.players.length} players, ${general.runSeconds}s`);
  return general;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(e => { console.error(e); process.exit(1); });
}
