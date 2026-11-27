import fs from 'node:fs/promises';
import { makeMock } from './mock.mjs';
import { run } from '../engine/run.mjs';
const { api, now } = makeMock();
const b = await api.bootstrap();
const base = await run({ api, outDir: '/tmp/lk0', config: { teamIds: [123], horizon: 8 }, now, });
const t0 = JSON.parse(await fs.readFile('/tmp/lk0/team-123.json', 'utf8'));
const rec0 = t0.transfers.plans.find(p => p.k === t0.transfers.recommended);
const owned = t0.squad.map(s => s.id);
const name = id => b.elements.find(e => e.id === id).web_name;
// include a mid-priced forward not owned and not in the default plan; exclude an owned player kept by default
const inc = b.elements.filter(e => e.element_type === 4 && e.now_cost <= 60 && e.minutes > 600 && !owned.includes(e.id) && !rec0.squad.includes(e.id))[0];
const exc = rec0.squad.find(id => owned.includes(id));
await run({ api, outDir: '/tmp/lk', config: { teamIds: [123], horizon: 8, locks: { 123: { include: [inc.web_name], exclude: [name(exc), 'NoSuchPlayer'] } } }, now });
const t = JSON.parse(await fs.readFile('/tmp/lk/team-123.json', 'utf8'));
const rec = t.transfers.plans.find(p => p.k === t.transfers.recommended);
console.log('include', inc.web_name, '-> in plan:', rec.squad.includes(inc.id), '| exclude', name(exc), '-> gone:', !rec.squad.includes(exc), '| unresolved', t.locks.unresolved, '| rec k', rec.k, 'hits', rec.hits, '| plans', t.transfers.plans.map(p => p.k).join(','));
const fhwc = t.chipTeam?.squad; if (fhwc) console.log('chip squad honours locks:', fhwc.includes(inc.id), !fhwc.includes(exc));
