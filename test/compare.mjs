import { evaluate } from './tune.mjs';
const tuned = { lsMin: 3000, W: 0.75, realisedW: 0.5, actualW: 0, teamK: 3, homeAdv: 1, priceW: 0.3, priorMin: 540 };
for (const chips of [false, true]) {
  console.log(`--- chips ${chips}`);
  await evaluate('M1 last-season prior', { policy: { chips } });
  await evaluate('M2 M1 + stronger prior (lsMin 1800)', { params: { lsMin: 1800 }, policy: { chips } });
  await evaluate('M3 M2 + market price prior', { params: { lsMin: 1800, priceW: 0.3 }, policy: { chips } });
  await evaluate('M4 fully tuned (overfit check)', { params: tuned, policy: { chips } });
}
