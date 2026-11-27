// Expected-points model for FPL 2026/27 scoring.
// Per player, per fixture: appearance + goals + assists + clean sheet + goals conceded
// + saves + defensive contribution (DEFCON) + bonus - cards, scaled by expected minutes,
// availability (injury news) and opponent strength. Doubles sum both fixtures; blanks score 0.

const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const GOAL_PTS = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
const DEFCON_THRESHOLD = { 2: 10, 3: 12, 4: 12 }; // DEF: CBIT>=10, MID/FWD: CBIRT>=12 -> 2 pts
const HOME_ADV = 1.1;
const LEAGUE_GOALS = 1.35;

// Priors per 90 by position (used to shrink small samples)
const PRIOR = {
  1: { xg: 0, xa: 0.005, bonus: 0.15, saves: 2.8, dc: 0, yc: 0.05 },
  2: { xg: 0.04, xa: 0.05, bonus: 0.2, saves: 0, dc: 8, yc: 0.15 },
  3: { xg: 0.12, xa: 0.12, bonus: 0.25, saves: 0, dc: 6, yc: 0.15 },
  4: { xg: 0.3, xa: 0.1, bonus: 0.35, saves: 0, dc: 3, yc: 0.12 },
};
const PRIOR_MINUTES = 270;

export const DEFAULT_PARAMS = {
  W: 1.5,            // extra weight on the last 4 GWs
  priorMin: 270,     // strength (minutes) of the position-average prior
  useLastSeason: true,
  lsMin: 1800,       // max strength (minutes) of last season's rates as prior
  actualW: 0.3,      // weight of actual goals/assists vs xG/xA
  realisedW: 0.3,    // weight of realised FPL points per 90
  epW: 0,            // weight of FPL's ep_next. Off: it is pure recent form, untestable historically, and form lost to the model in backtests
  shareRecent: 0.6,  // minutes share: weight of last 4 GWs
  shareG0: 3,        // games-equivalent weight of last season's minutes share
  lsShareScale: 1.1, // last season minutes understate a fit starter's share (injuries)
  newShare: 0.35,    // prior minutes share for players new to the league
  homeAdv: 'auto',   // 'auto' = learned from this season's results, shrunk to the long-run PL level
  teamK: 6,          // games-equivalent weight of the club strength prior
  priceW: 0.3,       // weight of the price-implied points (market prior)
  startW: 0,         // weight of the start-based minutes model (0 = minutes-share model only)
  stLast: 0.35, stRecent: 0.35, stSeason: 0.3, // start-probability weights: last match / last 4 / season
  subP: 0.3,         // chance a non-starter comes off the bench
  penW: 0,           // extra goal threat for the designated penalty taker (x team pens per game)
  setW: 0,           // extra assist threat for the main corner/indirect free-kick taker
};

const num = v => (v == null || v === '' ? 0 : Number(v)) || 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function poisPmf(k, m) {
  let p = Math.exp(-m);
  for (let i = 1; i <= k; i++) p *= m / i;
  return p;
}
function poisAtLeast(t, m) {
  if (m <= 0) return 0;
  let c = 0;
  for (let k = 0; k < t; k++) c += poisPmf(k, m);
  return clamp(1 - c, 0, 1);
}
// E[floor(X / d)] for X ~ Poisson(m)
function expFloorDiv(m, d) {
  if (m <= 0) return 0;
  let e = 0;
  for (let k = d; k <= 25; k++) e += Math.floor(k / d) * poisPmf(k, m);
  return e;
}
// DEFCON counts are over-dispersed vs Poisson; widen by mixing means.
function defconProb(t, m) {
  return (poisAtLeast(t, m * 0.75) + poisAtLeast(t, m) + poisAtLeast(t, m * 1.25)) / 3;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Hamstring injury - Expected back 06 Dec" / "Suspended until 13 Dec"
function parseReturnDate(news, now) {
  if (!news) return null;
  const m = news.match(/(?:expected back|until)\s+(\d{1,2})\s+([A-Za-z]{3})/i);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon == null) return null;
  let d = new Date(Date.UTC(now.getUTCFullYear(), mon, Number(m[1])));
  if (d < new Date(now.getTime() - 60 * 864e5)) d = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, Number(m[1])));
  return d;
}

function availability(el, k, deadline, now) {
  if (el.status === 'u' || el.status === 'n') return 0; // left club / not eligible (loan)
  const chance = el.chance_of_playing_next_round == null ? (el.status === 'a' ? 100 : 0) : num(el.chance_of_playing_next_round);
  if (chance >= 100) return 1;
  const back = parseReturnDate(el.news, now);
  if (back) return deadline && new Date(deadline) >= back ? 0.85 : 0;
  if (k === 0) return chance / 100;
  // Recovery curve when no return date is given
  const recover = [chance / 100, 0.3, 0.5, 0.65, 0.75, 0.8];
  return Math.max(chance / 100, recover[Math.min(k, recover.length - 1)]);
}

export function teamRatings(bootstrap, fixtures, P = DEFAULT_PARAMS) {
  const teams = bootstrap.teams;
  const els = bootstrap.elements;
  const stats = {};
  for (const t of teams) stats[t.id] = { n: 0, gf: 0, ga: 0, xg: 0, gkXgc: 0, gkMin: 0 };
  for (const f of fixtures) {
    if (!f.finished || f.team_h_score == null) continue;
    stats[f.team_h].n++; stats[f.team_a].n++;
    stats[f.team_h].gf += f.team_h_score; stats[f.team_h].ga += f.team_a_score;
    stats[f.team_a].gf += f.team_a_score; stats[f.team_a].ga += f.team_h_score;
  }
  for (const e of els) {
    const s = stats[e.team]; if (!s) continue;
    s.xg += num(e.expected_goals);
    if (e.element_type === 1) { s.gkXgc += num(e.expected_goals_conceded); s.gkMin += num(e.minutes); }
  }
  const meanSA = teams.reduce((a, t) => a + (num(t.strength_attack_home) + num(t.strength_attack_away)) / 2, 0) / teams.length || 1;
  const meanSD = teams.reduce((a, t) => a + (num(t.strength_defence_home) + num(t.strength_defence_away)) / 2, 0) / teams.length || 1;
  const K = P.teamK;
  const out = {};
  for (const t of teams) {
    const s = stats[t.id];
    const sa = (num(t.strength_attack_home) + num(t.strength_attack_away)) / 2 || meanSA;
    const sd = (num(t.strength_defence_home) + num(t.strength_defence_away)) / 2 || meanSD;
    const priorAtt = LEAGUE_GOALS * Math.pow(sa / meanSA, 2);
    const priorDef = LEAGUE_GOALS * Math.pow(meanSD / sd, 2);
    const xgPg = s.n ? s.xg / s.n : priorAtt;
    const xgaPg = s.gkMin > 0 ? s.gkXgc / (s.gkMin / 90) : priorDef;
    const gfPg = s.n ? s.gf / s.n : priorAtt;
    const gaPg = s.n ? s.ga / s.n : priorDef;
    const attObs = 0.65 * xgPg + 0.35 * gfPg;
    const defObs = 0.65 * xgaPg + 0.35 * gaPg;
    out[t.id] = {
      id: t.id, name: t.name, short: t.short_name, games: s.n,
      att: (attObs * s.n + priorAtt * K) / (s.n + K),
      def: (defObs * s.n + priorDef * K) / (s.n + K),
    };
  }
  const L = Object.values(out).reduce((a, t) => a + t.att, 0) / teams.length;
  // Home advantage: home/away goals ratio this season, shrunk toward the long-run PL ratio (~1.25)
  let hg = 0, ag = 0, n = 0;
  for (const f of fixtures) if (f.finished && f.team_h_score != null) { hg += f.team_h_score; ag += f.team_a_score; n++; }
  const obs = ag > 0 ? hg / ag : 1.25, prior = 100;
  const ratio = (obs * n + 1.25 * prior) / (n + prior);
  const homeAdv = typeof P.homeAdv === 'number' ? P.homeAdv : Math.sqrt(ratio);
  for (const t of Object.values(out)) { t.L = L; t.homeAdv = homeAdv; }
  return out;
}

// recent: Map elementId -> {minutes, xg, xa, bonus, saves, dc, games}
export function buildProjections({ bootstrap, fixtures, recent, teamGames, gws, now = new Date(), params, lastSeason }) {
  const ratings = teamRatings(bootstrap, fixtures, { ...DEFAULT_PARAMS, ...(params || {}) });
  const L = Object.values(ratings)[0].L;
  const events = Object.fromEntries(bootstrap.events.map(e => [e.id, e]));
  const byGw = {};
  for (const f of fixtures) {
    if (f.event == null || !gws.includes(f.event)) continue;
    (byGw[f.event] ||= []).push(f);
  }
  const teamFix = {}; // teamFix[gw][teamId] = [{opp, home}]
  for (const gw of gws) {
    teamFix[gw] = {};
    for (const f of byGw[gw] || []) {
      (teamFix[gw][f.team_h] ||= []).push({ opp: f.team_a, home: true });
      (teamFix[gw][f.team_a] ||= []).push({ opp: f.team_h, home: false });
    }
  }

  const P = { ...DEFAULT_PARAMS, ...(params || {}) };
  const lastPlayed = {};
  for (const f of fixtures) if (f.finished && f.event != null) {
    lastPlayed[f.team_h] = Math.max(lastPlayed[f.team_h] || 0, f.event); lastPlayed[f.team_a] = Math.max(lastPlayed[f.team_a] || 0, f.event);
  }
  // Market prior: last season's points-per-90 vs end-of-season price, fitted per position
  const priceFit = {};
  if (P.priceW > 0 && lastSeason) {
    for (const pos of [1, 2, 3, 4]) {
      const xs = [], ys = [];
      const posOf = new Map(bootstrap.elements.map(e => [e.id, e.element_type]));
      for (const [id, l] of lastSeason) if (posOf.get(id) === pos && l.minutes >= 900 && l.endCost > 0) { xs.push(l.endCost); ys.push(l.pts / (l.minutes / 90)); }
      if (xs.length < 8) continue;
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
      const b = sxx ? sxy / sxx : 0; priceFit[pos] = { a: my - b * mx, b };
    }
  }
  const players = [];
  for (const el of bootstrap.elements) {
    const pos = el.element_type;
    if (!POS[pos]) continue; // skip managers or unknown types
    const team = ratings[el.team];
    const r = recent.get(el.id) || { minutes: 0, xg: 0, xa: 0, bonus: 0, saves: 0, dc: 0, goals: 0, assists: 0 };
    const ls = P.useLastSeason ? lastSeason?.get(el.id) : null;
    const lsOk = ls && ls.minutes >= 270;
    const W = P.W; // extra weight on last-4-GW form
    const pr = PRIOR[pos];
    // Prior per-90 rate: last season (itself shrunk to the position prior) or the position prior alone
    const priorW = lsOk ? Math.min(ls.minutes, P.lsMin) : P.priorMin;
    const lsRate = (stat, prior) => (lsOk ? (num(ls[stat]) + prior * P.priorMin / 90) / ((ls.minutes + P.priorMin) / 90) : prior);
    const mins = num(el.minutes) + W * r.minutes + priorW;
    const rate = (season, rec, prior, stat) => (num(season) + W * rec + lsRate(stat, prior) * priorW / 90) / (mins / 90);
    const xg90 = rate(el.expected_goals, r.xg, pr.xg, 'xg');
    const xa90 = rate(el.expected_assists, r.xa, pr.xa, 'xa');
    // Finishing/creativity skill: blend in actual output so persistent over-performers aren't flattened
    const g90 = (1 - P.actualW) * xg90 + P.actualW * rate(el.goals_scored, r.goals, pr.xg, 'goals');
    const a90 = (1 - P.actualW) * xa90 + P.actualW * rate(el.assists, r.assists, pr.xa, 'assists');
    const bonus90 = rate(el.bonus, r.bonus, pr.bonus, 'bonus');
    const saves90 = rate(el.saves, r.saves, pr.saves, 'saves');
    const dc90 = rate(el.defensive_contribution, r.dc, pr.dc, 'dc');
    const yc90 = rate(el.yellow_cards, 0, pr.yc, 'yc');
    const rc90 = num(el.red_cards) / Math.max(num(el.minutes) / 90, 10);
    // Realised FPL points per 90 (captures bonus/finishing the components miss)
    const ppPrior = lsOk ? (num(ls.pts) + 3.5 * P.priorMin / 90) / ((ls.minutes + P.priorMin) / 90) : 3.5;
    const pp90 = (num(el.total_points) + ppPrior * priorW / 90) / ((num(el.minutes) + priorW) / 90);

    // Minutes share: this season (+ last-4 form), with last season as a prior early on
    const G0 = lsOk ? P.shareG0 : 1;
    const priorShare = lsOk ? clamp(ls.minutes / (38 * 90) * P.lsShareScale, 0.05, 1) : P.newShare;
    const seasonShare = (num(el.minutes) + priorShare * 90 * G0) / (90 * (team.games + G0));
    const rGames = teamGames?.[el.team] || 0;
    const recentShare = rGames ? r.minutes / (90 * rGames) : seasonShare;
    const share = clamp(rGames ? P.shareRecent * recentShare + (1 - P.shareRecent) * seasonShare : seasonShare, 0, 1);
    let p60 = clamp(1.15 * share - 0.1, 0, 0.95);
    let pApp = clamp(share * 1.5 + 0.05, p60, 0.98);
    let minsIfPlay = pApp > 0 ? clamp((90 * share) / pApp, 10, 90) : 0;

    // Start-based rotation model: P(start) from the last match, last 4 and season (+ last season prior)
    if (P.startW > 0) {
      const lsStartRate = lsOk ? clamp(num(ls.starts) / 38 * P.lsShareScale, 0, 1) : P.newShare;
      const seasonStart = (num(el.starts) + lsStartRate * G0) / (team.games + G0);
      const recentStart = rGames ? clamp((r.starts || 0) / rGames, 0, 1) : seasonStart;
      const lp = lastPlayed[el.team];
      const lastStart = lp && r.startsByGw ? ((r.startsByGw[lp] || 0) > 0 ? 1 : 0) : recentStart;
      const startRate = clamp(P.stLast * lastStart + P.stRecent * recentStart + P.stSeason * seasonStart, 0, 0.98);
      const starts = num(el.starts) + (lsOk ? num(ls.starts) * 0.25 : 0);
      const mins = num(el.minutes) + (lsOk ? ls.minutes * 0.25 : 0);
      const mps = starts > 0 ? clamp(mins / starts, 45, 90) : 80; // minutes per start (incl. a little sub time)
      const f60 = clamp((mps - 45) / 45, 0.3, 0.97);
      const sp60 = startRate * f60;
      const spApp = clamp(startRate + (1 - startRate) * P.subP, sp60, 0.99);
      const sMins = spApp > 0 ? clamp((startRate * mps + (1 - startRate) * P.subP * 20) / spApp, 10, 90) : 0;
      p60 = (1 - P.startW) * p60 + P.startW * sp60;
      pApp = (1 - P.startW) * pApp + P.startW * spApp;
      minsIfPlay = (1 - P.startW) * minsIfPlay + P.startW * sMins;
    }
    // Set pieces (today's designated takers)
    const penShare = el.penalties_order === 1 ? 1 : el.penalties_order === 2 ? 0.15 : 0;
    const setShare = el.corners_and_indirect_freekicks_order === 1 ? 1 : el.corners_and_indirect_freekicks_order === 2 ? 0.3 : 0;

    const pts = {}, fixturesOut = {};
    gws.forEach((gw, k) => {
      const fx = teamFix[gw][el.team] || [];
      const avail = availability(el, k, events[gw]?.deadline_time, now);
      let total = 0;
      fixturesOut[gw] = fx.map(f => `${ratings[f.opp].short}${f.home ? '(H)' : '(A)'}`);
      for (const f of fx) {
        const opp = ratings[f.opp];
        const rot = fx.length > 1 ? 0.93 : 1; // rotation risk in doubles
        const a = avail * rot;
        const HA = team.homeAdv;
        const lamFor = (team.att * opp.def) / L * (f.home ? HA : 1 / HA);
        const lamAg = (opp.att * team.def) / L * (f.home ? 1 / HA : HA);
        const fAtt = lamFor / team.att;
        const expMins = a * pApp * minsIfPlay;
        let p = a * (p60 * 2 + (pApp - p60) * 1);
        p += g90 * fAtt * expMins / 90 * GOAL_PTS[pos];
        p += a90 * fAtt * expMins / 90 * 3;
        if (penShare && P.penW) p += P.penW * penShare * 0.11 * 0.78 * fAtt * (expMins / 90) * GOAL_PTS[pos];
        if (setShare && P.setW) p += P.setW * setShare * 0.06 * fAtt * (expMins / 90) * 3;
        p += CS_PTS[pos] * a * p60 * Math.exp(-lamAg);
        if (pos <= 2) p -= a * p60 * expFloorDiv(lamAg, 2);
        if (pos === 1) p += a * p60 * expFloorDiv(saves90 * (lamAg / team.def), 3);
        if (pos >= 2) p += 2 * a * p60 * defconProb(DEFCON_THRESHOLD[pos], dc90 * minsIfPlay / 90);
        const bonusAdj = pos <= 2 ? Math.exp(-lamAg) / Math.exp(-team.def) : fAtt;
        p += bonus90 * expMins / 90 * clamp(0.5 + 0.5 * bonusAdj, 0.6, 1.6);
        p -= (yc90 + 3 * rc90) * expMins / 90;
        const fixAdj = clamp(0.5 + 0.5 * (pos <= 2 ? Math.exp(-lamAg) / Math.exp(-team.def) : fAtt), 0.6, 1.5);
        const realised = pp90 * (expMins / 90) * fixAdj;
        let blended = (1 - P.realisedW) * p + P.realisedW * realised;
        const pf = priceFit[pos];
        if (pf) blended = (1 - P.priceW) * blended + P.priceW * Math.max(0, pf.a + pf.b * num(el.now_cost) / 10) * (expMins / 90) * fixAdj;
        total += blended;
      }
      // light blend with FPL's own next-GW expectation
      if (k === 0 && el.ep_next != null && fx.length) total = (1 - P.epW) * total + P.epW * num(el.ep_next);
      pts[gw] = Math.round(total * 100) / 100;
    });

    players.push({
      id: el.id, name: el.web_name, full: `${el.first_name} ${el.second_name}`,
      team: el.team, teamShort: team.short, pos, posName: POS[pos],
      price: num(el.now_cost) / 10, status: el.status, news: el.news || '',
      chance: el.chance_of_playing_next_round, own: num(el.selected_by_percent),
      form: num(el.form), totalPts: num(el.total_points),
      xg90: +xg90.toFixed(2), xa90: +xa90.toFixed(2), dc90: +dc90.toFixed(1), saves90: +saves90.toFixed(1), share: +share.toFixed(2),
      pts, fixtures: fixturesOut,
    });
  }
  return { players, ratings, teamFix };
}

// Aggregates last-N finished GW live data into per-player recent totals.
export function aggregateRecent(lives, fixtures, lastGws) {
  const teamGames = {};
  for (const f of fixtures) {
    if (!f.finished || !lastGws.includes(f.event)) continue;
    teamGames[f.team_h] = (teamGames[f.team_h] || 0) + 1;
    teamGames[f.team_a] = (teamGames[f.team_a] || 0) + 1;
  }
  const m = new Map();
  for (const live of lives) {
    if (!live) continue;
    for (const e of live.elements) {
      const s = e.stats || {};
      const cur = m.get(e.id) || { minutes: 0, xg: 0, xa: 0, bonus: 0, saves: 0, dc: 0, goals: 0, assists: 0, starts: 0, startsByGw: {} };
      cur.goals += num(s.goals_scored); cur.assists += num(s.assists);
      cur.starts += num(s.starts); cur.startsByGw[live.gw] = (cur.startsByGw[live.gw] || 0) + num(s.starts);
      cur.minutes += num(s.minutes); cur.xg += num(s.expected_goals); cur.xa += num(s.expected_assists);
      cur.bonus += num(s.bonus); cur.saves += num(s.saves); cur.dc += num(s.defensive_contribution);
      m.set(e.id, cur);
    }
  }
  return { recent: m, teamGames };
}

export const constants = { POS, GOAL_PTS, CS_PTS };
