import { ens } from './ensemble.mjs';
const M3 = { lsMin: 1800, priceW: 0.3 };
const variants = [
  ['base (6 GW, decay .9)', {}],
  ['horizon 3', { horizon: 3 }],
  ['horizon 8', { horizon: 8 }],
  ['decay 0.8', { decay: 0.8 }],
  ['decay 1.0', { decay: 1.0 }],
  ['hits easier (margin 0.5)', { hitMargin: 0.5, maxExtra: 2 }],
  ['no hits', { maxExtra: 0 }],
  ['bench weight 0.05', { benchWeight: 0.05 }],
  ['bench weight 0.25', { benchWeight: 0.25 }],
  ['roll value 0.5', { rollValue: 0.5 }],
  ['roll value 3', { rollValue: 3 }],
  ['chip bars lower', { thrTC: 6, thrBB: 9, thrFH: 9, thrWC: 7 }],
  ['chip bars higher', { thrTC: 10, thrBB: 15, thrFH: 15, thrWC: 14 }],
];
for (const [n, pol] of variants) await ens(n, M3, { chips: true, ...pol });
