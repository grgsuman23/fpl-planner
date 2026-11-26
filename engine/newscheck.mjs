// Lightweight watcher: checks FPL injury/suspension flags and gameweek status; reruns the full
// model only when something changed. Keeps a short log of team-news changes for the app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api as realApi } from './fpl.mjs';
import { run } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

export async function check({ api = realApi, DATA = path.join(ROOT, 'docs', 'data'), runFn = run, force = process.env.FORCE === 'true', log = console.log } = {}) {
const bootstrap = await api.bootstrap();
const teams = Object.fromEntries(bootstrap.teams.map(t => [t.id, t.short_name]));
const sig = Object.fromEntries(bootstrap.elements.map(e => [e.id, [e.status, e.chance_of_playing_next_round ?? null, e.news || '']]));
const eventsKey = bootstrap.events.map(e => `${e.id}:${e.finished ? 1 : 0}${e.data_checked ? 1 : 0}`).join(',');

const prev = await readJSON(path.join(DATA, 'news-sig.json'), null);
const now = new Date().toISOString();
const changes = [];
if (prev) {
  for (const e of bootstrap.elements) {
    const a = prev.sig[e.id], b = sig[e.id];
    if (!a) continue; // new player: not news
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
      changes.push({ time: now, id: e.id, name: e.web_name, team: teams[e.team], pos: e.element_type, from: a[0], to: b[0], chance: b[1], news: b[2] });
    }
  }
}
const gwChanged = !prev || prev.eventsKey !== eventsKey;

if (!changes.length && !gwChanged && !force) {
  log('No team-news or gameweek changes; nothing to do.');
  return { ran: false, changes };
}
log(`${changes.length} news change(s)${gwChanged ? ' + gameweek status change' : ''}; running full update…`);
for (const c of changes) log(`  ${c.name} (${c.team}): ${c.from} -> ${c.to} ${c.chance ?? ''} ${c.news}`);

await runFn({ api });
const newsLog = await readJSON(path.join(DATA, "news.json"), { changes: [] });
const weekAgo = Date.now() - 7 * 864e5;
newsLog.changes = [...changes, ...newsLog.changes].filter(c => new Date(c.time) > weekAgo).slice(0, 80);
newsLog.checkedAt = now;
await fs.writeFile(path.join(DATA, 'news.json'), JSON.stringify(newsLog));
await fs.writeFile(path.join(DATA, 'news-sig.json'), JSON.stringify({ savedAt: now, eventsKey, sig }));
return { ran: true, changes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  check().catch(e => { console.error(e); process.exit(1); });
}
