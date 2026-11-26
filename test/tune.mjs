// Offline model comparison on the cached season snapshot.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { runBacktest } from '../engine/backtest.mjs';
import { buildLastSeason, prevSeasonName } from '../engine/lastseason.mjs';

const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../cache/season.json.gz', import.meta.url))));
const hist = new Map(Object.entries(d.summaries).map(([k, v]) => [Number(k), v.history]));
export const data = { bootstrap: d.bootstrap, fixtures: d.fixtures, hist };
export const lastSeason = buildLastSeason(d.summaries, prevSeasonName(d.bootstrap));
export const managers = Object.values(d.managers).map(m => ({ name: m.entry.name, pts: m.history.current.map(r => r.points - r.event_transfers_cost) }));

export async function evaluate(name, { params = {}, policy = {}, start = 1, end } = {}) {
  const r = await runBacktest({ data, startGw: start, endGw: end, params, policy, lastSeason });
  const sum = (a, b) => r.weeks.filter(w => w.gw >= a && w.gw <= b).reduce((s, w) => s + w.sim.points, 0);
  const maeIn = r.weeks.filter(w => w.gw <= 7), maeOut = r.weeks.filter(w => w.gw >= 8);
  const m = ws => (ws.reduce((s, w) => s + w.mae.model, 0) / ws.length).toFixed(3);
  const c = ws => (ws.reduce((s, w) => s + w.corr.model, 0) / ws.length).toFixed(3);
  const row = { name, total: r.summary.sim.total, gw1_7: sum(1, 7), gw8_11: sum(8, 11), maeIn: m(maeIn), maeOut: m(maeOut), corrIn: c(maeIn), corrOut: c(maeOut),
    cap: r.summary.captain.model, chips: r.summary.sim.chips.map(u => `${u.chip}@${u.gw}`).join(' '), byGw: r.weeks.map(w => w.sim.points).join(',') };
  console.log(JSON.stringify(row));
  return { row, r };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('avg', d.bootstrap.events.filter(e => e.finished).map(e => e.average_entry_score).join(','), '=', d.bootstrap.events.filter(e => e.finished).reduce((a, e) => a + e.average_entry_score, 0));
  for (const m of managers) console.log(m.name, m.pts.join(','), '=', m.pts.reduce((a, b) => a + b, 0));
  await evaluate('A current model, no chips', { params: { useLastSeason: false }, policy: { chips: false } });
  await evaluate('B + last-season prior, no chips', { policy: { chips: false } });
  await evaluate('C + last-season prior + chips', {});
}
