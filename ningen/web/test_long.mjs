// 24 s of crawling alone: posture and effort every 1.5 s, and where the body is.
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r)); let lastT = 0;
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') { if (msg.t < lastT - 0.5) console.log('!! reset at', lastT.toFixed(2)); lastT = msg.t; frames.push(msg); } else if (msg.type === 'error') console.log('ERR', msg.message); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
if (process.argv[2]) self.onmessage({ data: { type: 'motion', jerky: process.argv[2] === 'fly' } });
const B = (n) => info.bodies.indexOf(n), P = (f, n) => [0, 1, 2].map((i) => f.xpos[B(n) * 3 + i]);
for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const f = frames.at(-1), z = (n) => P(f, n)[2].toFixed(2), p = P(f, 'pelvis');
  const zz = (n) => P(f, n)[2].toFixed(2);
  console.log(`palmR ${zz('thirdmc_r')} tipR ${zz('distph3_r')} idx ${zz('2proxph_r')} little ${zz('5proxph_r')} | t=${f.t.toFixed(1)} r=${Math.hypot(p[0], p[1]).toFixed(2)} pelvis z ${p[2].toFixed(2)} hands ${z('3proxph_r')}/${z('3proxph_l')} knees ${z('tibia_r')}/${z('tibia_l')} head ${z('head')} support ${f.info.rootForce.toFixed(0)} unmet ${f.info.unmet.toFixed(0)} ${f.prog.walk ? 'walk' : '-'} rub ${(+f.prog.rub).toFixed(1)} worst ${f.info.worst} ${f.dbg?.ik} armRef ${f.dbg?.armRef} armAct ${f.dbg?.armAct} con ${f.dbg?.armCon} actuator ${f.dbg?.armAct_frc} applied ${f.dbg?.armAppl} bias ${f.dbg?.armBias} ncon ${f.dbg?.ncon} trunk ${f.dbg?.trunkRef}/${f.dbg?.trunkAct}`);
}
process.exit(0);
