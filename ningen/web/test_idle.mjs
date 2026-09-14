// Idle posture in both motion modes: pelvis, head and trunk joint angles.
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); else if (msg.type === 'error') console.log(msg.message); } };
await import('./body-worker.js');
const jerky = process.argv[2] === 'fly';
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
self.onmessage({ data: { type: 'motion', jerky } });
if (process.argv[3]) self.onmessage({ data: { type: 'tune', gain: JSON.parse(process.argv[3]) } });
const B = (n) => info.bodies.indexOf(n);
for (const s of [0.3, 0.6, 1, 2]) {
  await new Promise((r) => setTimeout(r, (s - (frames.at(-1)?.t || 0)) * 1000));
  const f = frames.at(-1), z = (n) => f.xpos[B(n) * 3 + 2].toFixed(3), y = (n) => f.xpos[B(n) * 3 + 1].toFixed(3);
  console.log(process.argv[3] || (jerky ? 'fly' : 'smooth'), 't', f.t.toFixed(2), 'pelvis z', z('pelvis'), 'torso z', z('torso'), 'head z', z('head'), 'head y', y('head'), 'tibia_l z', z('tibia_l'), 'unmet', f.info.unmet.toFixed(0), 'support', f.info.rootForce.toFixed(0));
}
process.exit(0);
