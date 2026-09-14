// Where does the face look while crawling, for a few neck nod targets? (face = rest -y carried by the head)
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const frames = []; let ready; const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); else if (msg.type === 'error') console.log('ERR', msg.message); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
self.onmessage({ data: { type: 'motion', jerky: false } });
if (process.argv[2]) self.onmessage({ data: { type: 'crawl', pose: JSON.parse(process.argv[2]) } });
const skin = JSON.parse(await readFile('data/skin.json', 'utf8'));
const H = info.bodies.indexOf('head');
const R = ([w, x, y, z]) => [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
const R0 = R(skin.rest.xquat[H]);
const faceL = [-R0[3], -R0[4], -R0[5]];   // R0^T (0,-1,0): minus the second row
await new Promise((r) => setTimeout(r, 3000));
const f = frames.at(-1), q = [0, 1, 2, 3].map((i) => f.xquat[H * 4 + i]), Rh = R(q);
const face = [0, 1, 2].map((r) => Rh[3 * r] * faceL[0] + Rh[3 * r + 1] * faceL[1] + Rh[3 * r + 2] * faceL[2]);
const hz = f.xpos[H * 3 + 2], sz = Math.max(f.xpos[info.bodies.indexOf('humerus_r') * 3 + 2], f.xpos[info.bodies.indexOf('humerus_l') * 3 + 2]);
const hands = ['3proxph_r', '3proxph_l'].map((n) => f.xpos[info.bodies.indexOf(n) * 3 + 2].toFixed(2)).join('/');
console.log(process.argv[2] || '', 'hands z', hands, 'head z', hz.toFixed(2), 'shoulder z', sz.toFixed(2), 'face direction (world)', face.map((v) => v.toFixed(2)).join(','), ' z<0 = looking down; pelvis/walk heading is along', 'unmet', f.info.unmet.toFixed(0));
process.exit(0);
