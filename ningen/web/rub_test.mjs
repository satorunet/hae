// Force a rubbing bout and measure: distance between the hands, how much they slide past each
// other (fore-aft, opposite), and which way the knuckle line points (vertical = palms facing).
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); } };
const mod = await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
self.onmessage({ data: { type: 'motion', jerky: false } });
if (process.argv[2]) self.onmessage({ data: { type: 'rub', rub: JSON.parse(process.argv[2]) } });
const B = (n) => info.bodies.indexOf(n), P = (f, n) => [0, 1, 2].map((i) => f.xpos[B(n) * 3 + i]);
const sub = (a, b) => a.map((v, i) => v - b[i]), len = (a) => Math.hypot(...a);
let gaps = [], rel = [], vert = [], n = 0, pen = [];
for (let i = 0; i < 400 && n < 120; i++) {
  await new Promise((r) => setTimeout(r, 30));
  const f = frames.at(-1);
  if (!(f.prog.rub > 0.8)) continue;
  n++;
  const hr = P(f, 'thirdmc_r'), hl = P(f, 'thirdmc_l');
  gaps.push(len(sub(hr, hl))); rel.push(sub(hr, hl));
  const across = sub(P(f, '5proxph_r'), P(f, '2proxph_r'));
  pen.push(f.realtime);
  vert.push(Math.abs(across[2]) / len(across));
}
if (!n) { console.log('no rubbing bout seen'); process.exit(0); }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// sliding: spread of the hand-to-hand vector along its main horizontal direction
const rx = rel.map((v) => v[0]), ry = rel.map((v) => v[1]);
const spread = Math.max(Math.max(...rx) - Math.min(...rx), Math.max(...ry) - Math.min(...ry));
console.log(`${process.argv[2] || 'default'}: samples ${n} hand gap mean ${mean(gaps).toFixed(3)} min ${Math.min(...gaps).toFixed(3)} m; slide range ${spread.toFixed(3)} m; knuckle line vertical ${mean(vert).toFixed(2)} (1 = palms facing); realtime x${mean(pen).toFixed(2)}`);
process.exit(0);
