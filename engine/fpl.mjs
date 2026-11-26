// Thin client for the public FPL API (runs inside GitHub Actions, so no CORS issues).
const BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (fpl-planner)', Accept: 'application/json' };

async function get(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

export const api = {
  bootstrap: () => get('/bootstrap-static/'),
  fixtures: () => get('/fixtures/'),
  live: gw => get(`/event/${gw}/live/`),
  entry: id => get(`/entry/${id}/`),
  history: id => get(`/entry/${id}/history/`),
  transfers: id => get(`/entry/${id}/transfers/`),
  picks: (id, gw) => get(`/entry/${id}/event/${gw}/picks/`),
  elementSummary: id => get(`/element-summary/${id}/`),
};
