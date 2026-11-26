// Builds a per-player map of last season's Premier League totals from element-summary history_past.
export function prevSeasonName(bootstrap) {
  const first = bootstrap.events?.[0]?.deadline_time;
  const y = first ? new Date(first).getUTCFullYear() : new Date().getUTCFullYear();
  return `${y - 1}/${String(y).slice(2)}`;
}

export function buildLastSeason(summaries, season) {
  const m = new Map();
  for (const [id, s] of Object.entries(summaries || {})) {
    const row = (s.history_past || []).find(h => h.season_name === season);
    if (!row) continue;
    m.set(Number(id), {
      minutes: +row.minutes || 0, starts: +row.starts || 0,
      xg: +row.expected_goals || 0, xa: +row.expected_assists || 0,
      goals: +row.goals_scored || 0, assists: +row.assists || 0,
      bonus: +row.bonus || 0, saves: +row.saves || 0, dc: +row.defensive_contribution || 0,
      pts: +row.total_points || 0, yc: +row.yellow_cards || 0, endCost: (+row.end_cost || 0) / 10,
    });
  }
  return m;
}

export const lastSeasonToJSON = m => Object.fromEntries(m);
export const lastSeasonFromJSON = o => new Map(Object.entries(o || {}).map(([k, v]) => [Number(k), v]));
