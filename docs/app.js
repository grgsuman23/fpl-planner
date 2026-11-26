/* FPL Planner — reads data/latest.json and data/team-<id>.json produced by the GitHub Action. */
(() => {
  const CFG = window.APP_CONFIG || {};
  const $ = s => document.querySelector(s);
  const view = $('#view');
  const state = { tab: 'plan', data: null, team: null, teamId: null, gwSel: null, squadMode: 'after', pFilter: { pos: 0, max: 15, q: '', sort: 'next' }, tickMode: 'def' };
  try { state.teamId = localStorage.getItem('fplTeamId'); } catch (e) { /* storage blocked */ }

  const CLUB = {
    ARS: ['#EF0107', '#fff'], AVL: ['#670E36', '#95BFE5'], BOU: ['#DA291C', '#000'], BRE: ['#E30613', '#fff'], BHA: ['#0057B8', '#fff'],
    BUR: ['#6C1D45', '#99D6EA'], CHE: ['#034694', '#fff'], CRY: ['#1B458F', '#C4122E'], EVE: ['#003399', '#fff'], FUL: ['#ffffff', '#000'],
    LEE: ['#FFFFFF', '#1D428A'], LEI: ['#003090', '#FDBE11'], LIV: ['#C8102E', '#fff'], MCI: ['#6CABDD', '#1C2C5B'], MUN: ['#DA291C', '#FBE122'],
    NEW: ['#241F20', '#fff'], NFO: ['#DD0000', '#fff'], SOU: ['#D71920', '#fff'], SUN: ['#EB172B', '#fff'], TOT: ['#FFFFFF', '#132257'],
    WHU: ['#7A263A', '#1BB1E7'], WOL: ['#FDB913', '#231F20'], IPS: ['#0044AA', '#fff'], NOR: ['#FFF200', '#00A650'], WAT: ['#FBEE23', '#ED2127'],
    MID: ['#E21A23', '#fff'], SHU: ['#EE2737', '#000'], COV: ['#59CBE8', '#fff'], HUL: ['#F5A12D', '#000'], STK: ['#E03A3E', '#fff'],
  };
  const POSN = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const CHIP_SHORT = { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' };

  let byId = new Map(), teamsById = new Map();
  const P = id => byId.get(id);
  const pts = (p, gw) => (p && p.pts[gw]) || 0;
  const f1 = v => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
  const money = v => `£${Number(v).toFixed(1)}m`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Same greedy lineup as the engine (optimal under FPL formation rules)
  function bestLineup(ids, gw) {
    const ps = ids.map(P).filter(Boolean);
    const by = pos => ps.filter(p => p.pos === pos).sort((a, b) => pts(b, gw) - pts(a, gw));
    const gks = by(1); const starters = [gks[0]]; const rest = [];
    const min = { 2: 3, 3: 2, 4: 1 }, max = { 2: 5, 3: 5, 4: 3 }, cnt = { 2: 3, 3: 2, 4: 1 };
    for (const pos of [2, 3, 4]) { const l = by(pos); starters.push(...l.slice(0, min[pos])); rest.push(...l.slice(min[pos])); }
    rest.sort((a, b) => pts(b, gw) - pts(a, gw));
    const bench = [];
    for (const p of rest) { if (starters.length < 11 && cnt[p.pos] < max[p.pos]) { starters.push(p); cnt[p.pos]++; } else bench.push(p); }
    const ranked = [...starters].filter(Boolean).sort((a, b) => pts(b, gw) - pts(a, gw));
    const xi = starters.reduce((a, p) => a + pts(p, gw), 0) + pts(ranked[0], gw);
    return { starters: starters.filter(Boolean).map(p => p.id), bench: [gks[1], ...bench].filter(Boolean).map(p => p.id), captain: ranked[0]?.id, vice: ranked[1]?.id, xi, benchPts: [gks[1], ...bench].filter(Boolean).reduce((a, p) => a + pts(p, gw), 0) };
  }

  async function loadJSON(url) {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  async function load() {
    try {
      state.data = await loadJSON('data/latest.json');
    } catch (e) {
      view.innerHTML = `<div class="empty"><h2>No data yet</h2><p>The first update hasn't run. Open the repository's Actions tab and run “Update FPL data”.</p>${repoLink('actions', 'Open Actions')}</div>`;
      $('#deadline').textContent = 'Waiting for the first data update';
      return;
    }
    byId = new Map(state.data.players.map(p => [p.id, p]));
    try { state.news = await loadJSON('data/news.json'); } catch (e) { state.news = null; }
    teamsById = new Map(state.data.teams.map(t => [t.id, t]));
    state.gwSel = state.data.nextGw;
    await loadTeam();
    header(); render();
  }

  async function loadTeam() {
    state.team = null;
    if (!state.teamId) return;
    try { state.team = await loadJSON(`data/team-${state.teamId}.json`); } catch (e) { state.team = null; }
  }

  function header() {
    const d = state.data;
    $('#gwTitle').textContent = `Gameweek ${d.nextGw}`;
    const dl = new Date(d.deadline);
    const diff = dl - Date.now();
    const days = Math.floor(diff / 864e5), hrs = Math.floor((diff % 864e5) / 36e5);
    const when = dl.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const left = diff > 0 ? ` · ${days > 0 ? `${days}d ` : ''}${hrs}h left` : ' · deadline passed';
    const upd = timeAgo(new Date(d.generatedAt));
    $('#deadline').textContent = `Deadline ${when}${left} · updated ${upd}`;
  }
  function timeAgo(t) {
    const m = Math.round((Date.now() - t) / 6e4);
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); if (h < 48) return `${h}h ago`; return `${Math.round(h / 24)}d ago`;
  }
  function repoLink(path, label, cls = 'btn') {
    if (!CFG.repo) return '';
    return `<a class="${cls}" href="https://github.com/${CFG.repo}/${path}" target="_blank" rel="noopener">${label}</a>`;
  }

  // ---------- Tabs ----------
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    render(); window.scrollTo(0, 0);
  }));
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  function render() {
    if (!state.data) return;
    ({ plan: renderPlan, transfers: renderTransfers, chips: renderChips, players: renderPlayers, fixtures: renderFixtures })[state.tab]();
  }

  // ---------- Plan ----------
  function renderPlan() {
    const d = state.data, t = state.team, gw = state.gwSel;
    let html = '';
    if (!t) {
      html += `<section class="block"><h2>Best squad from scratch</h2>
        <p class="sub">A £${d.wildcard?.cost ?? 100}m squad optimised over GW${d.gws[0]}–${d.gws[Math.min(5, d.gws.length - 1)]}. Add your team ID to get transfers and chip timing for your own squad.</p>
        <button class="btn" id="addTeam">Add my team ID</button></section>`;
    } else {
      html += planSummary(t);
    }
    const squad = currentSquadIds();
    const chipWeeks = t ? Object.fromEntries(t.chips.schedule.filter(s => s.gw).map(s => [s.gw, s.chip])) : {};
    html += `<section class="block">
      <div class="seg" role="tablist" aria-label="Gameweek">${d.gws.map(g => `<button class="${g === gw ? 'on' : ''} ${chipWeeks[g] ? 'chipwk' : ''}" data-gw="${g}">GW${g}${chipWeeks[g] ? ` · ${CHIP_SHORT[chipWeeks[g]]}` : ''}</button>`).join('')}</div>`;
    if (t) {
      const modes = [['after', 'After transfers'], ['current', 'Current squad']];
      if (t.chipTeam) modes.push(['chip', `${t.chipTeam.chip === 'wildcard' ? 'Wildcard' : 'Free Hit'} squad`]);
      html += `<div class="seg">${modes.map(([k, l]) => `<button data-mode="${k}" class="${state.squadMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    }
    html += pitch(squad, gw, t ? newIns() : new Set());
    html += `</section>`;
    html += startBench(squad, gw);
    html += teamNews();
    if (!t) html += generalExtras();
    view.innerHTML = html;
    view.querySelectorAll('[data-gw]').forEach(b => b.onclick = () => { state.gwSel = Number(b.dataset.gw); renderPlan(); });
    view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { state.squadMode = b.dataset.mode; renderPlan(); });
    view.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => openPlayer(Number(b.dataset.pid)));
    const add = $('#addTeam'); if (add) add.onclick = openSettings;
  }

  function currentSquadIds() {
    const t = state.team;
    if (!t) return state.data.wildcard?.squad || [];
    if (state.squadMode === 'current') return t.squad.map(s => s.id);
    if (state.squadMode === 'chip' && t.chipTeam) return t.chipTeam.squad;
    const rec = t.transfers.plans.find(p => p.k === t.transfers.recommended);
    return rec ? rec.squad : t.squad.map(s => s.id);
  }
  function newIns() {
    const cur = new Set(state.team.squad.map(s => s.id));
    return new Set(currentSquadIds().filter(i => !cur.has(i)));
  }

  function planSummary(t) {
    const gw = state.data.nextGw;
    const rec = t.transfers.plans.find(p => p.k === t.transfers.recommended);
    const lu = t.chipTeam ? t.chipTeam.lineup : t.lineup;
    const chipNow = t.chips.schedule.find(s => s.playNow);
    const nextChip = t.chips.schedule.filter(s => s.gw && !s.playNow).sort((a, b) => a.gw - b.gw)[0];
    const moves = !rec || rec.k === 0
      ? `<div>Save your transfer — rolling is worth more than any move this week.</div><div class="s muted">${t.freeTransfers} free transfer${t.freeTransfers > 1 ? 's' : ''} → ${Math.min(5, t.freeTransfers + 1)} next week</div>`
      : rec.moves.map(m => `<div class="move"><span class="out">${esc(P(m.out)?.name)}</span><span class="muted">for</span><span class="in">${esc(P(m.in)?.name)}</span><span class="muted">${money(P(m.in)?.price)}</span></div>`).join('')
        + `<div class="muted" style="font-size:13px">+${f1(rec.gain)} pts over 6 GWs${rec.hits ? ` after a −${rec.hits} hit` : ''} · bank after ${money(rec.bankAfter)}</div>`;
    const chipTxt = chipNow
      ? `<span class="pill red">Play ${chipNow.label}</span> <span class="muted">+${f1(chipNow.value)} pts expected</span>`
      : nextChip ? `None this week. Next: ${nextChip.label} in GW${nextChip.gw}` : 'None this week';
    if (chipNow && (chipNow.chip === 'wildcard' || chipNow.chip === 'freehit') && !state.autoChip) { state.autoChip = true; if (t.chipTeam) state.squadMode = 'chip'; }
    return `<section class="block">
      <h2>${esc(t.name)}</h2>
      <p class="sub">${esc(t.manager)} · rank ${Number(t.overallRank || 0).toLocaleString()} · ${money(t.bank)} in the bank · ${t.freeTransfers} FT</p>
      <div class="verdicts">
        <div class="verdict"><div class="k">Transfers</div><div class="v">${chipNow?.chip === 'wildcard' || chipNow?.chip === 'freehit' ? `Use the ${chipNow.label} squad below instead of single transfers.` : moves}</div></div>
        <div class="verdict"><div class="k">Captain</div><div class="v"><b>${esc(P(lu.captain)?.name)}</b> <span class="muted">${f1(pts(P(lu.captain), gw))} xP · vice ${esc(P(lu.vice)?.name)}</span></div></div>
        <div class="verdict"><div class="k">Chip</div><div class="v">${chipTxt}</div></div>
      </div></section>`;
  }

  function pitch(ids, gw, fresh) {
    if (!ids.length) return '<div class="empty">No squad data.</div>';
    const lu = bestLineup(ids, gw);
    const chipWeek = state.team?.chips.schedule.find(s => s.gw === gw)?.chip;
    const tc = chipWeek === '3xc', bb = chipWeek === 'bboost';
    const tok = (id, cap) => {
      const p = P(id); if (!p) return '';
      const [c1, c2] = CLUB[p.teamShort] || ['#0C4DA1', '#fff'];
      const fx = (p.fixtures[gw] || []).map(f => f.endsWith('(H)') ? f.slice(0, 3) : f.slice(0, 3).toLowerCase()).join(' ') || 'No game';
      const x = pts(p, gw);
      return `<button class="tok ${fresh.has(id) ? 'newin' : ''}" data-pid="${id}" aria-label="${esc(p.name)}, ${f1(x)} expected points">
        ${cap ? `<span class="badge ${cap === 'V' ? 'v' : ''}">${cap}</span>` : ''}
        <span class="shirt ${p.pos === 1 ? 'gk' : ''}" style="background:linear-gradient(90deg, ${c1} 0 70%, ${c2} 70% 100%)"></span>
        <span class="nm">${esc(p.name)}</span><span class="xp ${p.fixtures[gw]?.length ? '' : 'blank'}">${f1(x)}</span><span class="fx">${esc(fx)}</span></button>`;
    };
    const rows = [1, 2, 3, 4].map(pos => `<div class="row">${lu.starters.filter(i => P(i).pos === pos).map(i => tok(i, i === lu.captain ? (tc ? '3' : 'C') : i === lu.vice ? 'V' : '')).join('')}</div>`).join('');
    const capX = pts(P(lu.captain), gw) * (tc ? 2 : 1);
    const total = lu.xi - pts(P(lu.captain), gw) + capX + (bb ? lu.benchPts : 0);
    return `<div class="pitch">${rows}
      <div class="bench"><div class="lbl">${bb ? 'Bench (Bench Boost — these score too)' : 'Bench, in order'}</div><div class="row">${lu.bench.map(i => tok(i)).join('')}</div></div></div>
      <div class="pitch-foot"><span>Expected <b class="num" style="font-size:20px">${f1(total)}</b> pts${tc ? ' with Triple Captain' : bb ? ' with Bench Boost' : ''}</span><span class="muted">Lowercase club = away</span></div>`;
  }


  // Explicit start / bench advice for the squad and GW on screen
  function startBench(ids, gw) {
    const lu = bestLineup(ids, gw);
    const x = id => pts(P(id), gw);
    const fx = id => (P(id).fixtures[gw] || []).join(', ') || 'no game';
    const doubt = id => { const p = P(id); return p.status !== 'a' || (p.chance != null && p.chance < 100); };
    const st = lu.starters.map(P), bn = lu.bench.map(P);
    // close calls: a bench outfielder within 0.5 xP of a starter he could legally replace
    const cnt = { 1: 0, 2: 0, 3: 0, 4: 0 }; st.forEach(p => cnt[p.pos]++);
    const min = { 1: 1, 2: 3, 3: 2, 4: 1 };
    const close = [];
    for (const b of bn.filter(p => p.pos !== 1)) {
      const swappable = st.filter(s => s.pos !== 1 && (s.pos === b.pos || cnt[s.pos] > min[s.pos]) && (b.pos === s.pos || cnt[b.pos] < ({ 2: 5, 3: 5, 4: 3 })[b.pos]));
      const weakest = swappable.sort((a, c) => x(a.id) - x(c.id))[0];
      if (weakest && x(weakest.id) - x(b.id) < 0.5) close.push([weakest, b]);
    }
    const gk2 = bn.find(p => p.pos === 1);
    if (gk2 && x(st.find(p => p.pos === 1).id) - x(gk2.id) < 0.5) close.push([st.find(p => p.pos === 1), gk2]);
    const line = (p, i) => `<li data-pid="${p.id}" class="click"><div><div class="t">${i != null ? `${i}. ` : ''}${esc(p.name)}${p.id === lu.captain ? ' <span class="pill red">C</span>' : p.id === lu.vice ? ' <span class="pill">V</span>' : ''}${doubt(p.id) ? ' <span style="color:var(--red)">●</span>' : ''}</div><div class="s">${p.posName} · ${esc(fx(p.id))}${doubt(p.id) && p.news ? ` · ${esc(p.news)}` : ''}</div></div><div class="num" style="font-size:18px">${f1(x(p.id))}</div></li>`;
    const form = `${cnt[2]}-${cnt[3]}-${cnt[4]}`;
    const notes = [];
    const blanks = st.filter(p => !(p.fixtures[gw] || []).length);
    if (blanks.length) notes.push(`${blanks.map(p => esc(p.name)).join(', ')} ${blanks.length > 1 ? 'have' : 'has'} no game: you don't have 11 players with a fixture.`);
    const doubts = st.filter(p => doubt(p.id));
    if (doubts.length) notes.push(`Doubtful starter${doubts.length > 1 ? 's' : ''}: ${doubts.map(p => esc(p.name)).join(', ')}. Check team news before the deadline; your first bench player (${esc(bn.find(p => p.pos !== 1)?.name || '')}) comes on automatically if they don't play.`);
    const byStarter = new Map();
    close.forEach(([a, b]) => byStarter.set(a, [...(byStarter.get(a) || []), b]));
    [...byStarter].slice(0, 2).forEach(([a, bs]) => notes.push(`Close call: ${esc(a.name)} (${f1(x(a.id))}) only just starts ahead of ${bs.map(b => `${esc(b.name)} (${f1(x(b.id))})`).join(' and ')}. Let team news decide.`));
    return `<section class="block"><h2>Start and bench · GW${gw}</h2>
      <p class="sub">Formation ${form}. Expected points shown on the right; tap a player for details.</p>
      ${notes.map(n => `<div class="note ${n.startsWith('Close') ? 'blue' : ''}">${n}</div>`).join('')}
      <h3>Start</h3><ul class="list">${[1, 2, 3, 4].flatMap(pos => st.filter(p => p.pos === pos).sort((a, c) => x(c.id) - x(a.id))).map(p => line(p)).join('')}</ul>
      <h3>Bench, in order</h3><ul class="list">${bn.map((p, i) => line(p, p.pos === 1 ? null : i)).join('')}</ul>
      <p class="sub" style="margin-top:8px">Bench order matters: if a starter doesn't play, FPL brings on the first bench player who keeps the formation legal.</p></section>`;
  }


  // Injury / suspension flag changes picked up by the 30-minute watcher
  function teamNews() {
    const n = state.news; if (!n || !n.changes?.length) return '';
    const cutoff = Date.now() - 48 * 36e5;
    const mine = new Set(state.team ? [...state.team.squad.map(s => s.id), ...currentSquadIds()] : []);
    const list = n.changes.filter(c => new Date(c.time) > cutoff)
      .sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || (new Date(b.time) - new Date(a.time))).slice(0, 15);
    if (!list.length) return '';
    const label = { a: 'Available', d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unavailable', n: 'Not eligible' };
    return `<section class="block"><h2>Team news · last 48 hours</h2>
      <p class="sub">Picked up within about 30 minutes of FPL posting it; advice above already reflects it.</p>
      <ul class="list">${list.map(c => `<li data-pid="${c.id}" class="click"><div><div class="t">${mine.has(c.id) ? '<span style="color:var(--red)">●</span> ' : ''}${esc(c.name)} <span class="muted">${esc(c.team)}</span>${mine.has(c.id) ? ' <span class="pill red">Your squad</span>' : ''}</div>
        <div class="s">${label[c.from] || c.from} → <b>${label[c.to] || c.to}${c.to === 'd' && c.chance != null ? ` (${c.chance}%)` : ''}</b>${c.news ? ` · ${esc(c.news)}` : ''}</div></div><div class="s muted">${timeAgo(new Date(c.time))}</div></li>`).join('')}</ul></section>`;
  }

  function generalExtras() {
    const d = state.data, gw = d.nextGw;
    const caps = [...d.players].sort((a, b) => pts(b, gw) - pts(a, gw)).slice(0, 6);
    return `<section class="block"><h2>Top captain picks · GW${gw}</h2><ul class="list">${caps.map(p => `<li class="click" data-pid="${p.id}"><div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.teamShort)} · ${esc((p.fixtures[gw] || []).join(', '))}</div></div><div class="num" style="font-size:20px">${f1(pts(p, gw))}</div></li>`).join('')}</ul></section>`;
  }

  // ---------- Transfers ----------
  function renderTransfers() {
    const t = state.team;
    if (!t) { view.innerHTML = needTeam('Transfer plans need your squad.'); bindNeedTeam(); return; }
    const gwRange = `GW${state.data.gws[0]}–${state.data.gws[Math.min(5, state.data.gws.length - 1)]}`;
    const plans = t.transfers.plans.map(p => {
      const rec = p.k === t.transfers.recommended;
      const g = p.gain;
      return `<div class="plan ${rec ? 'rec' : ''}">
        <div class="plan-head"><div><b>${p.k === 0 ? 'Roll the transfer' : `${p.k} transfer${p.k > 1 ? 's' : ''}`}</b> ${rec ? '<span class="pill">Recommended</span>' : ''} ${p.hits ? `<span class="pill red">−${p.hits}</span>` : ''}</div>
        <div class="gain ${g > 0 ? 'pos' : g < 0 ? 'neg' : ''}">${g > 0 ? '+' : ''}${f1(g)}</div></div>
        ${p.moves.map(m => `<div class="move"><span class="out">${esc(P(m.out)?.name)}</span><span class="muted">${money(t.squad.find(s => s.id === m.out)?.sell ?? P(m.out)?.price)}</span><span class="muted">for</span><span class="in">${esc(P(m.in)?.name)}</span><span class="muted">${money(P(m.in)?.price)}</span></div>`).join('')}
        <div class="muted" style="font-size:13px">Bank after ${money(p.bankAfter)}</div></div>`;
    }).join('');
    view.innerHTML = `<section class="block"><h2>Transfer plans</h2>
      <p class="sub">Each plan is the best possible squad with exactly that many changes, scored on expected points over ${gwRange} (later weeks count a little less). Gains are net of hits. A free transfer saved is valued at about 1.5 pts.</p>
      ${plans}</section>
      <section class="block"><h2>Your squad's selling prices</h2>
      <p class="sub">Selling price is what you get back: purchase price plus half of any rise, rounded down.</p>
      <ul class="list">${t.squad.map(s => `<li data-pid="${s.id}" class="click"><div><div class="t">${esc(P(s.id)?.name)}</div><div class="s">${POSN[P(s.id)?.pos]} · bought ${money(s.purchase)} · now ${money(s.now)}</div></div><div class="num">${money(s.sell)}</div></li>`).join('')}</ul></section>`;
    view.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => openPlayer(Number(b.dataset.pid)));
  }

  // ---------- Chips ----------
  function renderChips() {
    const d = state.data, t = state.team;
    let html = '';
    if (t) {
      const c = t.chips;
      html += `<section class="block"><h2>Chip plan · ${c.half === 1 ? 'first' : 'second'} set</h2>
        <p class="sub">${c.expiring ? `Unused chips from this set are lost at the GW${c.expiresAfter} deadline, so every chip is scheduled into a week before then (one chip per week).` : 'This set lasts until GW38, so a chip is only scheduled when a week clearly beats a typical use.'}</p>
        ${c.schedule.length ? c.schedule.map(s => `<div class="chip-row ${s.playNow ? 'now' : ''}"><div class="chip-ic">${CHIP_SHORT[s.chip]}</div>
          <div><b>${s.label}</b><div class="s muted" style="font-size:13px">${esc(s.note)}${s.bestWeeks.length ? ` Best weeks: ${s.bestWeeks.map(b => `GW${b.gw} (${f1(b.value)})`).join(', ')}` : ''}</div></div>
          <div class="chip-gw">${s.gw ? `<div class="big">GW${s.gw}</div><div class="muted" style="font-size:12.5px">+${f1(s.value)} pts</div>` : '<span class="pill ghost">Hold</span>'}</div></div>`).join('') : '<p>All chips in this set have been used.</p>'}
        ${c.used.length ? `<p class="sub" style="margin-top:10px">Already played: ${c.used.map(u => `${CHIP_SHORT[u.name]} GW${u.event}`).join(', ')}</p>` : ''}
      </section>`;
      html += `<section class="block"><h2>Chip value by week</h2>
        <p class="sub">TC = your best captain's points (the extra you'd gain). BB = your bench's points. FH = a one-week £${f1(t.transfers.budget)}m squad minus your XI. WC = 60% of the gain from a full rebuild over the next 6 weeks.</p>
        <div class="tbl-wrap"><table><thead><tr><th>GW</th><th class="r">TC</th><th class="r">BB</th><th class="r">FH</th><th class="r">WC</th></tr></thead><tbody>
        ${(() => {
          const keys = ['tc', 'bb', 'fh', 'wc'];
          const best = Object.fromEntries(keys.map(k => [k, Math.max(...c.values.map(v => v[k] ?? -99))]));
          return c.values.map(v => `<tr><td>GW${v.gw}</td>${keys.map(k => `<td class="r">${v[k] == null ? '–' : v[k] === best[k] ? `<span class="best">${f1(v[k])}</span>` : f1(v[k])}</td>`).join('')}</tr>`).join('');
        })()}</tbody></table></div></section>`;
    } else {
      html += needTeam('A personal chip plan needs your team ID. Doubles and blanks are listed below.');
    }
    const sw = d.specialWeeks;
    const tn = id => teamsById.get(id)?.short || id;
    html += `<section class="block"><h2>Double and blank gameweeks</h2>
      <p class="sub">From the current fixture list. Doubles suit Bench Boost and Triple Captain; blanks suit Free Hit.</p>
      ${sw.length ? `<ul class="list">${sw.map(s => `<li><div><div class="t">GW${s.gw} · ${s.fixtures} fixtures</div><div class="s">${s.doubles.length ? `Double: ${s.doubles.map(tn).join(', ')}` : ''}${s.doubles.length && s.blanks.length ? '<br>' : ''}${s.blanks.length ? `Blank: ${s.blanks.map(tn).join(', ')}` : ''}</div></div><div>${s.doubles.length ? '<span class="pill">DGW</span>' : ''} ${s.blanks.length ? '<span class="pill red">BGW</span>' : ''}</div></li>`).join('')}</ul>` : '<p class="muted">No doubles or blanks are scheduled yet.</p>'}
      ${d.unscheduled.length ? `<p class="sub" style="margin-top:8px">Not yet scheduled (likely future doubles): ${d.unscheduled.map(u => `${tn(u.h)} v ${tn(u.a)}`).join(', ')}</p>` : ''}
    </section>`;
    view.innerHTML = html; bindNeedTeam();
  }

  // ---------- Players ----------
  function renderPlayers() {
    const d = state.data, f = state.pFilter, gw = d.nextGw;
    const H = d.gws.slice(0, 6);
    const tot = p => H.reduce((a, g) => a + pts(p, g), 0);
    let list = d.players.filter(p => (!f.pos || p.pos === f.pos) && p.price <= f.max && (!f.q || p.name.toLowerCase().includes(f.q.toLowerCase()) || p.teamShort.toLowerCase() === f.q.toLowerCase()));
    const sorters = { next: (a, b) => pts(b, gw) - pts(a, gw), six: (a, b) => tot(b) - tot(a), value: (a, b) => tot(b) / b.price - tot(a) / a.price, own: (a, b) => b.own - a.own };
    list.sort(sorters[f.sort]); list = list.slice(0, 80);
    const owned = new Set(state.team ? state.team.squad.map(s => s.id) : []);
    view.innerHTML = `<section class="block"><h2>Player projections</h2>
      <div class="filters">
        <input class="full" id="q" placeholder="Search a player or club (e.g. LIV)" value="${esc(f.q)}" aria-label="Search">
        <select id="pos" aria-label="Position"><option value="0">All positions</option>${[1, 2, 3, 4].map(p => `<option value="${p}" ${f.pos === p ? 'selected' : ''}>${POSN[p]}</option>`).join('')}</select>
        <select id="sort" aria-label="Sort by"><option value="next" ${f.sort === 'next' ? 'selected' : ''}>Next GW points</option><option value="six" ${f.sort === 'six' ? 'selected' : ''}>Next 6 GWs</option><option value="value" ${f.sort === 'value' ? 'selected' : ''}>Points per £m</option><option value="own" ${f.sort === 'own' ? 'selected' : ''}>Ownership</option></select>
        <label class="full muted" style="font-size:13px">Max price ${money(f.max)}<input id="max" type="range" min="3.5" max="15" step="0.5" value="${f.max}" style="width:100%"></label>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>Player</th><th class="r">£</th><th class="r">GW${gw}</th><th class="r">6 GW</th><th class="r">Own%</th></tr></thead>
      <tbody>${list.map(p => `<tr class="click" data-pid="${p.id}"><td><span class="pos-tag">${p.posName}</span>${owned.has(p.id) ? '<b>' : ''}${esc(p.name)}${owned.has(p.id) ? '</b>' : ''} <span class="muted">${esc(p.teamShort)}</span>${p.status !== 'a' ? ' <span style="color:var(--red)">●</span>' : ''}</td><td class="r">${p.price.toFixed(1)}</td><td class="r">${f1(pts(p, gw))}</td><td class="r"><b>${f1(tot(p))}</b></td><td class="r">${p.own.toFixed(0)}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub" style="margin-top:8px">Bold names are in your squad. A red dot means an injury, suspension or doubt.</p></section>`;
    const upd = () => { renderPlayers(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); };
    $('#q').oninput = e => { f.q = e.target.value; upd(); };
    $('#pos').onchange = e => { f.pos = Number(e.target.value); renderPlayers(); };
    $('#sort').onchange = e => { f.sort = e.target.value; renderPlayers(); };
    $('#max').oninput = e => { f.max = Number(e.target.value); renderPlayers(); };
    view.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => openPlayer(Number(b.dataset.pid)));
  }

  // ---------- Fixtures ----------
  function renderFixtures() {
    const d = state.data, mode = state.tickMode;
    const metric = g => (mode === 'def' ? g.cs : g.xgf);
    const rows = d.ticker.map(t => ({ t, sum: t.weeks.slice(0, 6).reduce((a, w) => a + w.games.reduce((b, g) => b + metric(g), 0), 0) }))
      .sort((a, b) => b.sum - a.sum);
    const color = v => {
      // mode def: clean-sheet probability 0.1–0.5; att: expected goals 0.8–2.2
      const x = mode === 'def' ? (v - 0.12) / 0.35 : (v - 0.8) / 1.4;
      const c = Math.max(0, Math.min(1, x));
      const lerp = (a, b) => Math.round(a + (b - a) * c);
      return `rgb(${lerp(253, 29)},${lerp(231, 122)},${lerp(232, 70)})`;
    };
    const tn = id => teamsById.get(id)?.short || '';
    view.innerHTML = `<section class="block"><h2>Fixture ticker</h2>
      <div class="seg"><button data-tm="def" class="${mode === 'def' ? 'on' : ''}">For defenders · clean-sheet %</button><button data-tm="att" class="${mode === 'att' ? 'on' : ''}">For attackers · expected goals</button></div>
      <p class="sub">Ratings come from each club's season xG, goals and recent form. Greener is better. Clubs are sorted by the next six weeks.</p>
      <div class="tbl-wrap"><table class="ticker"><thead><tr><th>Club</th>${d.gws.map(g => `<th class="r">GW${g}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(({ t }) => `<tr><td class="team">${tn(t.team)}</td>${t.weeks.map(w => `<td>${w.games.length ? w.games.map(g => `<div class="fdr" style="background:${color(metric(g))}">${tn(g.opp)}${g.home ? '' : ' (a)'}<br><b>${mode === 'def' ? Math.round(g.cs * 100) + '%' : g.xgf.toFixed(1)}</b></div>`).join('<div style="height:2px"></div>') : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div></section>`;
    view.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => { state.tickMode = b.dataset.tm; renderFixtures(); });
  }

  // ---------- Sheets ----------
  function openSheet(html) {
    const s = $('#sheet'); s.innerHTML = `<div class="grab"></div>${html}`; s.hidden = false; $('#backdrop').hidden = false;
    s.scrollTop = 0; s.tabIndex = -1;
    const f = s.querySelector('input'); (f || s).focus({ preventScroll: true });
  }
  function closeSheet() { $('#sheet').hidden = true; $('#backdrop').hidden = true; }

  function openPlayer(id) {
    const p = P(id); if (!p) return;
    const d = state.data;
    const own = state.team?.squad.find(s => s.id === id);
    openSheet(`<h2>${esc(p.full)}</h2><p class="sub">${esc(teamsById.get(p.team)?.name)} · ${p.posName} · ${money(p.price)}${own ? ` · you sell for ${money(own.sell)}` : ''} · ${p.own}% owned</p>
      ${p.news ? `<div class="note">${esc(p.news)}</div>` : ''}
      <div class="stat-grid"><div><span class="num">${p.xg90}</span><small>xG per 90</small></div><div><span class="num">${p.xa90}</span><small>xA per 90</small></div>${p.pos === 1 ? `<div><span class="num">${p.saves90}</span><small>Saves per 90</small></div>` : `<div><span class="num">${p.dc90}</span><small>Def. actions per 90</small></div>`}<div><span class="num">${Math.round(p.share * 100)}%</span><small>Minutes played</small></div></div>
      <table><thead><tr><th>GW</th><th>Opponent</th><th class="r">Expected pts</th></tr></thead><tbody>
      ${d.gws.map(g => `<tr><td>GW${g}</td><td>${esc((p.fixtures[g] || []).join(', ') || 'No game')}</td><td class="r"><b>${f1(pts(p, g))}</b></td></tr>`).join('')}</tbody></table>
      <p class="sub" style="margin-top:10px">Season: ${p.totalPts} pts · form ${p.form}</p>
      <button class="btn alt" id="closeS" style="width:100%;margin-top:6px">Close</button>`);
    $('#closeS').onclick = closeSheet;
  }

  function openSettings() {
    const d = state.data || {};
    const analysed = (d.teamIds || []).map(String);
    const has = state.teamId && analysed.includes(String(state.teamId));
    openSheet(`<h2>Your FPL team</h2>
      <p class="sub">Find your team ID on the FPL website: open Points, and it's the number in the address after /entry/.</p>
      <div class="field"><input id="tid" inputmode="numeric" placeholder="e.g. 1234567" value="${esc(state.teamId || '')}" aria-label="Team ID"><button class="btn" id="saveT">Save</button></div>
      ${state.teamId && !has ? `<div class="note">Team ${esc(state.teamId)} isn't analysed yet. Add it to <b>config.json</b> in your repository (the <code>teamIds</code> list), then run the update. It's ready within about two minutes.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${repoLink('edit/main/config.json', 'Edit config.json')} ${repoLink('actions/workflows/update.yml', 'Run update', 'btn alt')}</div>` : ''}
      ${has ? `<div class="note blue">Team ${esc(state.teamId)} is analysed in every update.</div>` : ''}
      ${(d.teamsAnalysed || []).filter(x => x.ok).length > 1 || ((d.teamsAnalysed || []).some(x => x.ok) && !has) ? `<h3>Switch team</h3>
      <div class="seg" style="flex-wrap:wrap">${(d.teamsAnalysed || []).filter(x => x.ok).map(x => `<button data-switch="${x.id}" class="${String(x.id) === String(state.teamId) ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      <h3>Model track record</h3>
      <p class="sub">How the model would have done this season, replaying each past gameweek with only the data known at the time.</p>
      <button class="btn alt" id="btBtn">See the backtest</button>
      <h3>Data updates</h3>
      <p class="sub">The model reruns automatically several times a day. Run it yourself after the team news drops or after you make transfers.</p>
      ${repoLink('actions/workflows/update.yml', 'Run update now', 'btn alt')}
      <h3>How the picks are made</h3>
      <p class="sub">Each player gets expected points per fixture from expected goals and assists, minutes, clean-sheet odds, saves, defensive contributions, bonus and cards, adjusted for opponent strength and injury news. A solver then picks the highest-scoring legal squad: £ budget, 2-5-5-3 and max 3 per club.</p>`);
    $('#btBtn').onclick = openBacktest;
    document.querySelectorAll('[data-switch]').forEach(b => b.onclick = () => useTeam(b.dataset.switch));
    $('#saveT').onclick = () => useTeam($('#tid').value);
  }
  async function useTeam(raw) {
    {
      const v = String(raw || '').trim().replace(/\D/g, '');
      state.teamId = v || null;
      try { v ? localStorage.setItem('fplTeamId', v) : localStorage.removeItem('fplTeamId'); } catch (e) { /* ignore */ }
      state.squadMode = 'after'; state.autoChip = false;
      await loadTeam(); render(); openSettings();
    };
  }


  async function openBacktest() {
    let b;
    try { b = await loadJSON('data/backtest.json'); } catch (e) {
      openSheet(`<h2>No backtest yet</h2><p class="sub">Run the “Backtest model” workflow on GitHub. It takes about two minutes.</p>${repoLink('actions/workflows/backtest.yml', 'Open workflow')}`); return;
    }
    const s = b.summary, [g0, g1] = s.window;
    const mgr = b.managers || [];
    const beat = s.sim.total - s.average.total;
    const row = (label, v, best) => `<tr><td>${label}</td><td class="r">${best ? `<span class="best">${v}</span>` : v}</td></tr>`;
    const bestMae = Math.min(s.mae.model, s.mae.form, s.mae.ppg), bestCorr = Math.max(s.corr.model, s.corr.form, s.corr.ppg);
    openSheet(`<h2>Backtest · GW${g0}–${g1}</h2>
      <p class="sub">A simulated manager started with £100m in GW${g0} and followed this app's transfers, lineups, captains and chip rule every week, using only what was known before each deadline.</p>
      <div class="stat-grid" style="grid-template-columns:repeat(${2 + mgr.length},1fr)">
        <div><span class="num">${s.ensemble ? s.ensemble.mean : s.sim.total}</span><small>Model, ${s.ensemble ? 'typical' : 'replay'}</small></div>
        <div><span class="num">${s.average.total}</span><small>FPL average</small></div>
        ${mgr.map(m => `<div><span class="num">${m.total}</span><small>${esc(m.name)}</small></div>`).join('')}
      </div>
      ${s.ensemble ? `<p>Across ${s.ensemble.n} replays with small nudges to the projections, the model scored <b>${s.ensemble.mean}</b> on average (range ${s.ensemble.min}–${s.ensemble.max}) against the average manager's ${s.average.total}. The exact replay below scored ${s.sim.total}${(s.sim.chips || []).length ? ` using ${s.sim.chips.map(c => `${({ wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' })[c.chip]} in GW${c.gw}`).join(', ')}` : ''}. One season swings a lot on a few captain picks, so the average is the fairer number.</p>`
        : `<p>${beat >= 0 ? `The model beat the average manager by <b>${beat}</b> pts` : `The model trailed the average manager by <b>${-beat}</b> pts`} over ${s.weeks} gameweeks.</p>`}
      <h3>Prediction accuracy</h3>
      <p class="sub">Compared with two simple methods: recent form (points per game over the last 4 GWs) and season points per game.</p>
      <table><thead><tr><th></th><th class="r">Model</th><th class="r">Form</th><th class="r">Season PPG</th></tr></thead><tbody>
        <tr><td>Avg. error per player (lower is better)</td>${['model', 'form', 'ppg'].map(k => `<td class="r">${s.mae[k] === bestMae ? `<span class="best">${s.mae[k]}</span>` : s.mae[k]}</td>`).join('')}</tr>
        <tr><td>Correlation with actual (higher is better)</td>${['model', 'form', 'ppg'].map(k => `<td class="r">${s.corr[k] === bestCorr ? `<span class="best">${s.corr[k]}</span>` : s.corr[k]}</td>`).join('')}</tr>
        <tr><td>Avg. points of its top 20 picks</td>${['model', 'form', 'ppg'].map(k => `<td class="r">${s.top20[k]}</td>`).join('')}</tr>
        <tr><td>Captain points, total</td><td class="r">${s.captain.model}</td><td class="r">${s.captain.form}</td><td class="r">–</td></tr>
      </tbody></table>
      <h3>Week by week</h3>
      <div class="tbl-wrap"><table><thead><tr><th>GW</th><th class="r">Model</th><th class="r">Avg</th>${mgr.map(m => `<th class="r">${esc(m.name.slice(0, 10))}</th>`).join('')}<th>Captain</th><th>Transfers</th></tr></thead><tbody>
      ${b.weeks.map(w => `<tr><td>GW${w.gw}</td><td class="r"><b>${w.sim.points}</b>${w.sim.hits ? ` <span class="muted">(−${w.sim.hits})</span>` : ''}${w.sim.chip ? ` <span class="pill red">${({ wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' })[w.sim.chip]}</span>` : ''}</td><td class="r">${w.average ?? '–'}</td>${mgr.map(m => `<td class="r">${m.byGw[w.gw] ?? '–'}</td>`).join('')}<td>${esc(w.sim.captain)} ${w.sim.captainPts}</td><td class="muted">${w.sim.chip === 'wildcard' ? 'Wildcard rebuild' : w.sim.transfers.map(t => `${esc(t.out)}→${esc(t.in)}`).join(', ') || '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <h3>Limits of this test</h3>
      <ul class="sub" style="padding-left:18px">${b.caveats.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      <button class="btn alt" id="closeS" style="width:100%;margin-top:6px">Close</button>`);
    $('#closeS').onclick = closeSheet;
  }

  function needTeam(msg) { return `<section class="block"><h2>Add your team</h2><p class="sub">${msg}</p><button class="btn" data-need>Add my team ID</button></section>`; }
  function bindNeedTeam() { view.querySelectorAll('[data-need]').forEach(b => b.onclick = openSettings); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  load();
  setInterval(() => state.data && header(), 60000);
})();
