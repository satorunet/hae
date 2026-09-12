// wasm side of det2_brian.py: every 3 ms the sugar GRNs are set to -40 mV, 120 ms.
import { writeFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';
const SUGAR = ['720575940624963786','720575940630233916','720575940637568838','720575940638202345','720575940617000768','720575940630797113','720575940632889389','720575940621754367','720575940621502051','720575940640649691','720575940639332736','720575940616885538','720575940639198653','720575940620900446','720575940617937543','720575940632425919','720575940633143833','720575940612670570','720575940628853239','720575940629176663','720575940611875570'];
const brain = await FlyBrain.load();
brain.reset(1);
const out = [];
for (let k = 0; k < 40; k++) {
  brain.setVoltage(SUGAR, -40);
  const r = brain.run(3);
  for (let j = 0; j < r.idx.length; j++) out.push([r.idx[j], Math.round(r.t[j] * 10)]);
}
out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('spikes', out.length);
