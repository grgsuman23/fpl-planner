import { runBacktest } from '../engine/backtest.mjs';
import { data, lastSeason } from './tune.mjs';
const base = JSON.parse(process.argv[2] || '{}');
async function score(params) {
  const r = await runBacktest({ data, startGw: 1, params, policy: { simulate: false }, lastSeason });
  const f = (a, b, k) => { const ws = r.weeks.filter(w => w.gw >= a && w.gw <= b); return ws.reduce((s, w) => s + (k === 'top50' ? w.top50 : w[k].model), 0) / ws.length; };
  return { cIn: f(1, 7, 'corr'), cOut: f(8, 11, 'corr'), tIn: f(1, 7, 'top20'), tOut: f(8, 11, 'top20'), t50In: f(1, 7, 'top50'), t50Out: f(8, 11, 'top50') };
}
const grid = {
  lsMin: [450, 900, 1800, 3000], W: [0, 0.75, 1.5, 3], realisedW: [0, 0.15, 0.3, 0.5], actualW: [0, 0.3, 0.5],
  shareRecent: [0.4, 0.6, 0.8], shareG0: [1, 3, 6], homeAdv: [1, 1.1, 1.2], teamK: [3, 6, 12], priceW: [0, 0.15, 0.3, 0.5], priorMin: [180, 270, 540],
};
let cur = { ...base };
const b0 = await score(cur);
console.log('base', JSON.stringify(cur), JSON.stringify(Object.fromEntries(Object.entries(b0).map(([k, v]) => [k, +v.toFixed(3)]))));
const obj = s => s.cIn + 0.05 * s.t50In; // in-sample objective only
for (let pass = 0; pass < 2; pass++) {
  for (const [k, vals] of Object.entries(grid)) {
    let best = null;
    for (const v of vals) {
      const s = await score({ ...cur, [k]: v });
      if (!best || obj(s) > obj(best.s) + 1e-4) best = { v, s };
    }
    cur[k] = best.v;
    console.log(`pass${pass} ${k}=${best.v}`, JSON.stringify(Object.fromEntries(Object.entries(best.s).map(([a, b]) => [a, +b.toFixed(3)]))));
  }
}
console.log('FINAL', JSON.stringify(cur));
