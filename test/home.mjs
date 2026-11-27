import { ens } from './ensemble.mjs';
for (const h of [1.0, 1.1, 1.2, 1.3]) await ens(`homeAdv ${h}`, { homeAdv: h }, { chips: true });
