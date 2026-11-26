import { runBacktest } from '../engine/backtest.mjs';
import { data, lastSeason } from './tune.mjs';
const N = Number(process.env.N || 15);
export async function ens(name, params = {}, policy = {}) {
  const tot = [], a = [], b = [];
  for (let seed = 1; seed <= N; seed++) {
    const r = await runBacktest({ data, startGw: 1, params, policy: { noise: 0.1, seed, ...policy }, lastSeason });
    const s = (x, y) => r.weeks.filter(w => w.gw >= x && w.gw <= y).reduce((q, w) => q + w.sim.points, 0);
    tot.push(r.summary.sim.total); a.push(s(1, 7)); b.push(s(8, 11));
  }
  const m = v => v.reduce((x, y) => x + y, 0) / v.length, sd = v => Math.sqrt(m(v.map(x => (x - m(v)) ** 2)));
  const row = { name, mean: +m(tot).toFixed(1), se: +(sd(tot) / Math.sqrt(N)).toFixed(1), min: Math.min(...tot), max: Math.max(...tot), gw1_7: +m(a).toFixed(1), gw8_11: +m(b).toFixed(1) };
  console.log(JSON.stringify(row)); return row;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const tuned = { lsMin: 3000, W: 0.75, realisedW: 0.5, actualW: 0, teamK: 3, homeAdv: 1, priceW: 0.3, priorMin: 540 };
  for (const chips of [false, true]) {
    console.log('--- chips', chips);
    await ens('M0 old model (no last season)', { useLastSeason: false }, { chips });
    await ens('M1 last-season prior', {}, { chips });
    await ens('M2 + stronger prior', { lsMin: 1800 }, { chips });
    await ens('M3 + price prior', { lsMin: 1800, priceW: 0.3 }, { chips });
    await ens('M4 fully tuned', tuned, { chips });
  }
}
