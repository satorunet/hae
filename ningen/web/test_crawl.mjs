// Run the crawling body worker in Node with scripted brain outputs and report the posture.
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
let lastT = 0;
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') { if (msg.t < lastT - 0.5) console.log('!! simulation reset at', lastT.toFixed(2)); lastT = msg.t; frames.push(msg); } else if (msg.type === 'error') console.log('ERR', msg.message); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
const B = (n) => info.bodies.indexOf(n);
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const P = (f, n) => [0, 1, 2].map((i) => f.xpos[B(n) * 3 + i]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function faceZ(f) {
  const q = [0, 1, 2, 3].map((i) => f.xquat[B('head') * 4 + i]);   // w x y z
  // rest face = world -y; rest head orientation came out as (x-axis -> -y); rotate local face by q
  const [w, x, y, z] = q, Rm = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const faceL = restFaceL;
  return Rm[6] * faceL[0] + Rm[7] * faceL[1] + Rm[8] * faceL[2];
}
let restFaceL;
function report(label) {
  const f = frames.at(-1);
  const z = (n) => P(f, n)[2].toFixed(2);
  const head = P(f, 'head');
  console.log(`${label.padEnd(12)} t=${f.t.toFixed(1)} x${f.realtime.toFixed(2)} pelvis(${P(f, 'pelvis').map((v) => v.toFixed(2)).join(',')}) hands z ${z('3proxph_r')}/${z('3proxph_l')} knees z ${z('tibia_r')}/${z('tibia_l')} head z ${z('head')} face ${faceZ(f).toFixed(2)}`
    + ` handR-head ${dist(P(f, '3proxph_r'), head).toFixed(2)} support ${f.info.rootForce.toFixed(0)}N unmet ${f.info.unmet.toFixed(0)} prog ${Object.entries(f.prog).filter(([, v]) => v === true || v > 0.3).map(([k]) => k).join(',')}`
    + (f.scene.sugar ? ` sugar-mouth? amount ${f.scene.sugar.amount.toFixed(2)}` : '') + (f.scene.dust.length ? ` dust ${f.scene.dust.length}` : '') + ` in=${JSON.stringify(Object.fromEntries(Object.entries(f.rates).filter(([, v]) => v)))}`);
}
// the head's rest frame maps world -y to local: take it from the first frame at rest is not possible (already crawling); use MuJoCo rest: head x-axis = world -y, so local face = +x
restFaceL = [1, 0, 0];
await wait(1); report('start');
await wait(3); report('crawl 3s');
await wait(3); report('crawl 6s');
self.onmessage({ data: { type: 'do', what: 'sugar' } });
self.onmessage({ data: { type: 'brain', out: { MN9: 90 } } });
await wait(3); report('feed');
self.onmessage({ data: { type: 'do', what: 'nosugar' } });
self.onmessage({ data: { type: 'brain', out: {} } });
await wait(1.5);
self.onmessage({ data: { type: 'do', what: 'dust' } });
self.onmessage({ data: { type: 'brain', out: { groomL: 200, groomR: 200 } } });
await wait(3); report('groom 3s');
await wait(3); report('groom 6s');
self.onmessage({ data: { type: 'brain', out: { GFL: 200 } } });
await wait(0.5); report('escape .5');
self.onmessage({ data: { type: 'brain', out: {} } });
await wait(1.0); report('landed 1s');
await wait(2.0); report('after 3s');
process.exit(0);
