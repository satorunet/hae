// While grooming: the closest either hand gets to any dust speck, every 0.5 s.
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
self.onmessage({ data: { type: 'motion', jerky: false } });
self.onmessage({ data: { type: 'do', what: 'dust' } });
self.onmessage({ data: { type: 'brain', out: { groomL: 200, groomR: 200 } } });
const B = (n) => info.bodies.indexOf(n), P = (f, n) => [0, 1, 2].map((i) => f.xpos[B(n) * 3 + i]);
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const f = frames.at(-1), hands = [P(f, '3proxph_r'), P(f, '3proxph_l'), P(f, 'distph3_r'), P(f, 'distph3_l')];
  let best = 9;
  for (const dpos of f.scene.dust) for (const h of hands) best = Math.min(best, Math.hypot(h[0] - dpos[0], h[1] - dpos[1], h[2] - dpos[2]));
  const head = P(f, 'head');
  console.log(`t=${f.t.toFixed(1)} dust ${f.scene.dust.length} closest hand-dust ${best.toFixed(2)} m, hand R z ${hands[0][2].toFixed(2)} head z ${head[2].toFixed(2)} dust0 z ${f.scene.dust[0]?.[2].toFixed(2)} groom ${(+f.prog.groomL).toFixed(1)}`);
}
process.exit(0);
