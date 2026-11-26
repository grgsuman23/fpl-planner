import { ens } from './ensemble.mjs';
const pol = { chips: true };
await ens('F1 current', {}, pol);
await ens('+ start model 0.5', { startW: 0.5 }, pol);
await ens('+ start model 1.0', { startW: 1 }, pol);
await ens('+ pens 0.5', { penW: 0.5 }, pol);
await ens('+ pens 1.0', { penW: 1 }, pol);
await ens('+ set pieces 1.0', { setW: 1 }, pol);
