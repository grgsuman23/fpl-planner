// Synthetic FPL API (same JSON shape as the real endpoints) for offline testing.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = a => a[Math.floor(rnd() * a.length)];

export function makeMock({ nextGw = 13 } = {}) {
  const names = ['ARS','AVL','BOU','BRE','BHA','CHE','CRY','EVE','FUL','LEE','LIV','MCI','MUN','NEW','NFO','SUN','TOT','WHU','WOL','BUR'];
  const teams = names.map((s, i) => {
    const q = 1 - i / 25 + (rnd() - 0.5) * 0.2;
    return { id: i + 1, name: s + ' FC', short_name: s, q,
      strength_attack_home: Math.round(1000 + 350 * q), strength_attack_away: Math.round(980 + 350 * q),
      strength_defence_home: Math.round(1000 + 350 * q), strength_defence_away: Math.round(980 + 350 * q) };
  });
  // double round robin
  const ids = teams.map(t => t.id), rounds = [];
  const arr = [...ids];
  for (let r = 0; r < 19; r++) {
    const pairs = [];
    for (let i = 0; i < 10; i++) pairs.push(r % 2 ? [arr[i], arr[19 - i]] : [arr[19 - i], arr[i]]);
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  const all = [...rounds, ...rounds.map(r => r.map(([h, a]) => [a, h]))];
  let fid = 1;
  const fixtures = [];
  all.forEach((pairs, gi) => pairs.forEach(([h, a]) => fixtures.push({ id: fid++, event: gi + 1, team_h: h, team_a: a, finished: false, team_h_score: null, team_a_score: null })));
  // blank GW16 for two fixtures, moved into GW18 (double)
  fixtures.filter(f => f.event === 16).slice(0, 2).forEach(f => (f.event = 18));
  fixtures.filter(f => f.event === 30).slice(0, 1).forEach(f => (f.event = null));
  for (const f of fixtures) if (f.event && f.event < nextGw) {
    const qh = teams[f.team_h - 1].q, qa = teams[f.team_a - 1].q;
    f.finished = true; f.team_h_score = Math.round(rnd() * 3 * qh + 0.4); f.team_a_score = Math.round(rnd() * 2.5 * qa + 0.2);
  }
  const now = new Date('2026-11-26T12:00:00Z');
  const events = Array.from({ length: 38 }, (_, i) => {
    const d = new Date(now.getTime() + (i + 1 - nextGw) * 7 * 864e5 + 864e5);
    return { id: i + 1, deadline_time: d.toISOString(), finished: i + 1 < nextGw, is_current: i + 1 === nextGw - 1, is_next: i + 1 === nextGw };
  });
  const elements = [];
  let eid = 1;
  const played = nextGw - 1;
  for (const t of teams) {
    for (const [pos, n] of [[1, 3], [2, 9], [3, 10], [4, 5]]) {
      for (let j = 0; j < n; j++) {
        const starter = pos === 1 ? j === 0 : j < (pos === 2 ? 5 : pos === 3 ? 5 : 2);
        const star = rnd();
        const mins = starter ? Math.round(played * (70 + rnd() * 20)) : Math.round(played * rnd() * 25);
        const m90 = mins / 90;
        const xg = m90 * (pos === 4 ? 0.25 + star * 0.4 : pos === 3 ? 0.05 + star * 0.35 : pos === 2 ? 0.02 + star * 0.08 : 0) * (0.7 + t.q * 0.5);
        const xa = m90 * (pos >= 3 ? 0.05 + star * 0.25 : pos === 2 ? 0.03 + star * 0.12 : 0) * (0.7 + t.q * 0.5);
        const price = Math.round((pos === 1 ? 40 : pos === 2 ? 40 : 45) + star * (pos === 1 ? 15 : pos === 2 ? 25 : 90) * (starter ? 1 : 0.3) * (0.6 + t.q * 0.5));
        const inj = rnd() < 0.04;
        elements.push({
          id: eid, web_name: `${t.short_name}_${['G','D','M','F'][pos - 1]}${j + 1}`, first_name: 'P', second_name: String(eid),
          team: t.id, element_type: pos, now_cost: price, status: inj ? 'i' : 'a',
          chance_of_playing_next_round: inj ? 0 : null, news: inj ? 'Hamstring injury - Expected back 13 Dec' : '',
          minutes: mins, starts: starter ? played : 0, goals_scored: Math.round(xg), assists: Math.round(xa),
          expected_goals: xg.toFixed(2), expected_assists: xa.toFixed(2),
          expected_goals_conceded: pos === 1 && starter ? (m90 * (1.9 - t.q)).toFixed(2) : '0.00',
          saves: pos === 1 && starter ? Math.round(m90 * 3) : 0, bonus: Math.round(m90 * star * 0.4),
          defensive_contribution: pos === 2 ? Math.round(m90 * (7 + star * 6)) : pos === 3 ? Math.round(m90 * (3 + star * 9)) : Math.round(m90 * 2),
          yellow_cards: Math.round(m90 * 0.15), red_cards: 0, total_points: Math.round(m90 * (2 + star * 4)),
          form: (rnd() * 8).toFixed(1), ep_next: (starter ? 2 + star * 5 : 0.5).toFixed(1), selected_by_percent: (rnd() * 40).toFixed(1),
        });
        eid++;
      }
    }
  }
  const live = gw => ({ elements: elements.map(e => ({ id: e.id, stats: {
    minutes: Math.round(e.minutes / played), expected_goals: (e.expected_goals / played).toFixed(2), expected_assists: (e.expected_assists / played).toFixed(2),
    bonus: rnd() < 0.1 ? 2 : 0, saves: Math.round(e.saves / played), defensive_contribution: Math.round(e.defensive_contribution / played) } })) });

  // a manager: pick a valid squad
  const squad = [];
  const used = {};
  for (const [pos, n] of [[1, 2], [2, 5], [3, 5], [4, 3]]) {
    const pool = elements.filter(e => e.element_type === pos && e.minutes > 300).sort((a, b) => a.now_cost - b.now_cost);
    let c = 0;
    for (const e of pool) { if (c >= n) break; if ((used[e.team] || 0) >= 3) continue; if (rnd() < 0.5) continue; squad.push(e); used[e.team] = (used[e.team] || 0) + 1; c++; }
  }
  const history = { current: Array.from({ length: played }, (_, i) => ({ event: i + 1, points: 50, bank: 5, value: 1000, event_transfers: i === 5 ? 2 : i % 3 === 0 ? 1 : 0, event_transfers_cost: 0 })),
    chips: [{ name: '3xc', event: 4, time: '' }] };
  const entry = { id: 123, name: 'Test XI', player_first_name: 'Suman', player_last_name: 'G', summary_overall_rank: 250000, summary_overall_points: 700, current_event: played, started_event: 1 };
  const picks = { active_chip: null, entry_history: { bank: 15 }, picks: squad.map((e, i) => ({ element: e.id, position: i + 1, multiplier: 1, is_captain: i === 10 })) };
  const transfers = [{ element_in: squad[3].id, element_in_cost: squad[3].now_cost - 2, element_out: 999, event: 5, time: '2026-09-20T10:00:00Z' }];
  return {
    api: {
      bootstrap: async () => ({ events, teams, elements, element_types: [] }),
      fixtures: async () => fixtures,
      live: async gw => live(gw),
      entry: async id => (id === 123 ? entry : null),
      history: async () => history,
      transfers: async () => transfers,
      picks: async () => picks,
      elementSummary: async id => ({ history: [{ round: 1, value: elements[id - 1].now_cost - 1 }] }),
    },
    now,
  };
}
