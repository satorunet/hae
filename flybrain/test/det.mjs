// Deterministic probe, the wasm side of det_brian.py: sugar GRNs start at -40 mV.
import { writeFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';
const SUGAR = ['720575940624963786','720575940630233916','720575940637568838','720575940638202345','720575940617000768','720575940630797113','720575940632889389','720575940621754367','720575940621502051','720575940640649691','720575940639332736','720575940616885538','720575940639198653','720575940620900446','720575940617937543','720575940632425919','720575940633143833','720575940612670570','720575940628853239','720575940629176663','720575940611875570'];
const brain = await FlyBrain.load();
brain.reset(1);
brain.kick(SUGAR, 12);
const r = brain.run(40);
const out = [...r.idx].map((i, k) => [i, Math.round(r.t[k] * 10)]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
writeFileSync(process.argv[2], JSON.stringify(out));
console.log('spikes', out.length, 'first', JSON.stringify(out.slice(0, 5)), 'last', JSON.stringify(out.slice(-3)));
