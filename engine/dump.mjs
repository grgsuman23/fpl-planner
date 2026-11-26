// Snapshot of everything the backtest needs, so models can be tuned offline.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { api } from './fpl.mjs';

const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
const [bootstrap, fixtures] = await Promise.all([api.bootstrap(), api.fixtures()]);
const ids = bootstrap.elements.map(e => e.id);
const summaries = {};
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < ids.length) {
    const id = ids[i++];
    try { const s = await api.elementSummary(id); summaries[id] = { history: s?.history || [], history_past: s?.history_past || [] }; }
    catch { summaries[id] = { history: [], history_past: [] }; }
  }
}));
const managers = {};
for (const id of cfg.teamIds || []) {
  try { managers[id] = { entry: await api.entry(id), history: await api.history(id) }; } catch (e) { console.log(id, e.message); }
}
const out = { savedAt: new Date().toISOString(), bootstrap, fixtures, summaries, managers };
await fs.mkdir('cache', { recursive: true });
await fs.writeFile('cache/season.json.gz', zlib.gzipSync(JSON.stringify(out)));
console.log(`Saved ${ids.length} players`);
