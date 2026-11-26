import fs from 'node:fs/promises';
const g = JSON.parse(await fs.readFile('/tmp/fpl-out/latest.json','utf8'));
const t = JSON.parse(await fs.readFile('/tmp/fpl-out/team-123.json','utf8'));
const byId = new Map(g.players.map(p=>[p.id,p]));
const sell = new Map(t.squad.map(s=>[s.id,s.sell]));
function check(label, ids, budget, useSell){
  const ps = ids.map(i=>byId.get(i));
  const pos={1:0,2:0,3:0,4:0}, club={}; let cost=0;
  for(const p of ps){pos[p.pos]++; club[p.team]=(club[p.team]||0)+1; cost+= useSell&&sell.has(p.id)?sell.get(p.id):p.price;}
  const ok = ids.length===15 && pos[1]===2&&pos[2]===5&&pos[3]===5&&pos[4]===3 && Math.max(...Object.values(club))<=3 && cost<=budget+1e-6;
  console.log(ok?'OK ':'BAD', label, JSON.stringify(pos), 'maxClub', Math.max(...Object.values(club)), 'cost', cost.toFixed(1), '/', budget);
}
check('wildcard', g.wildcard.squad, 100);
check('freehit', g.freeHit.squad, 100);
for(const p of t.transfers.plans) check('plan k='+p.k, p.squad, t.transfers.budget, true);
const lu=t.lineup; const st=lu.starters.map(i=>byId.get(i));
const c={1:0,2:0,3:0,4:0}; st.forEach(p=>c[p.pos]++); console.log('lineup', st.length, JSON.stringify(c), 'bench', lu.bench.map(i=>byId.get(i).posName).join(','));
