import { makeMock } from './mock.mjs';
import { run } from '../engine/run.mjs';
import fs from 'node:fs/promises';

const { api, now } = makeMock();
const out = '/tmp/fpl-out';
const g = await run({ api, outDir: out, config: { teamIds: [123], horizon: 8 }, now });
const t = JSON.parse(await fs.readFile(`${out}/team-123.json`, 'utf8'));
const byId = new Map(g.players.map(p => [p.id, p]));
const nm = id => byId.get(id)?.name;
console.log('WC squad', g.wildcard.squad.map(nm).join(', '), 'cost', g.wildcard.cost);
console.log('FT', t.freeTransfers, 'bank', t.bank, 'value', t.squadValue);
for (const p of t.transfers.plans) console.log(`k=${p.k} gain=${p.gain} hits=${p.hits} score=${p.score}`, p.moves.map(m => `${nm(m.out)}->${nm(m.in)}`).join(' '));
console.log('rec', t.transfers.recommended, 'captain', nm(t.lineup.captain), 'xi', t.lineup.xiPts);
console.log('chips', JSON.stringify(t.chips.schedule.map(s => [s.label, s.gw, s.value])));
console.log('values', JSON.stringify(t.chips.values.map(v => [v.gw, v.tc, v.bb, v.fh, v.wc])));
console.log('special', JSON.stringify(g.specialWeeks));
