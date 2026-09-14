// Pelvis and torso tilt over the first seconds of crawling (smooth mode).
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
self.onmessage({ data: { type: 'motion', jerky: false } });
const skin = JSON.parse(await readFile('data/skin.json', 'utf8'));
const R = ([w, x, y, z]) => [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
const tilt = (f, name) => {
  const i = info.bodies.indexOf(name), q = [0, 1, 2, 3].map((k) => f.xquat[4 * i + k]), Rn = R(q), R0 = R(skin.rest.xquat[i]);
  // up since rest: Rn R0^T (0,0,1) -> z component = row 2 of Rn times column 2 of R0
  const col = [R0[6], R0[7], R0[8]];
  return Math.round(Math.acos(Math.max(-1, Math.min(1, Rn[6] * col[0] + Rn[7] * col[1] + Rn[8] * col[2]))) * 180 / Math.PI);
};
for (const s of [0.05, 0.3, 0.6, 1, 2, 3]) {
  while (!frames.length || frames.at(-1).t < s) await new Promise((r) => setTimeout(r, 20));
  const f = frames.at(-1);
  console.log(`t=${f.t.toFixed(2)} pelvis ${tilt(f, 'pelvis')} torso ${tilt(f, 'torso')} thigh ${tilt(f, 'femur_l')} support ${f.info.rootForce?.toFixed(0)} torque? unmet ${f.info.unmet?.toFixed(0)} rootTorque ${f.info.rootTorque?.toFixed(0)}`, JSON.stringify(f.dbg));
}
process.exit(0);
