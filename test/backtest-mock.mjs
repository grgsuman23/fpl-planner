import { makeMock } from './mock.mjs';
import { backtest } from '../engine/backtest.mjs';
const { api } = makeMock({ nextGw: 13 });
const b = await api.bootstrap(); const fx = await api.fixtures();
let s = 7; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
b.events.forEach(e => { if (e.finished) { e.average_entry_score = 50; e.highest_score = 110; } });
const hist = new Map(b.elements.map(e => {
  const rows = [];
  for (let gw = 1; gw <= 12; gw++) for (const f of fx.filter(f => f.event === gw && (f.team_h === e.team || f.team_a === e.team))) {
    const per = e.minutes / 12; const mins = r() < 0.9 ? Math.round(per) : 0;
    const xg = num(e.expected_goals) / 12, g = r() < xg ? 1 : 0;
    rows.push({ round: gw, minutes: mins, expected_goals: xg, expected_assists: num(e.expected_assists) / 12, goals_scored: g, assists: 0,
      bonus: g ? 2 : 0, saves: 0, defensive_contribution: num(e.defensive_contribution) / 12, total_points: mins ? (mins >= 60 ? 2 : 1) + g * 5 + (r() < 0.3 ? 1 : 0) : 0,
      value: e.now_cost, starts: mins >= 60 ? 1 : 0, expected_goals_conceded: num(e.expected_goals_conceded) / 12, yellow_cards: 0, red_cards: 0 });
  }
  return [e.id, rows];
}));
function num(v) { return Number(v) || 0; }
api.bootstrap = async () => b;
api.elementSummary = async id => ({ history: hist.get(id) });
const out = await backtest({ api, outDir: '/tmp/bt', startGw: 4, teamIds: [123] });
console.log(JSON.stringify(out.summary, null, 1));
console.log(JSON.stringify(out.weeks[2], null, 1).slice(0, 900));
