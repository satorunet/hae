// Run body-worker.js in Node with fake brain outputs and check that the hands reach their goals.
import { readFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.protocol === 'file:') return new Response(await readFile(url));
  return realFetch(u);
};
const frames = [];
let ready;
const readyP = new Promise((r) => (ready = r));
globalThis.self = { postMessage: (msg) => { if (msg.type === 'ready') ready(msg); else if (msg.type === 'frame') frames.push(msg); else if (msg.type === 'error') console.log(msg.message); } };
await import('./body-worker.js');
self.onmessage({ data: { type: 'init' } });
const info = await readyP;
const B = (name) => info.bodies.indexOf(name);
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const pt = (f, b) => [f.xpos[b * 3], f.xpos[b * 3 + 1], f.xpos[b * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function report(label) {
  const f = frames.at(-1);
  const head = pt(f, B('head')), hr = pt(f, B('3proxph_r')), hl = pt(f, B('3proxph_l'));
  const mouth = [head[0], head[1] - 0.09, head[2] - 0.025];
  console.log(`${label.padEnd(14)} t=${f.t.toFixed(2)} realtime x${f.realtime.toFixed(2)} prog=${JSON.stringify(Object.fromEntries(Object.entries(f.prog).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])))}`
    + ` handR-mouth ${dist(hr, mouth).toFixed(3)} handL-mouth ${dist(hl, mouth).toFixed(3)} handR-head ${dist(hr, head).toFixed(3)} handL-head ${dist(hl, head).toFixed(3)}`
    + ` head z ${head[2].toFixed(3)} support ${f.info.rootForce?.toFixed(0)}N unmet ${f.info.unmet?.toFixed(0)} dust ${f.scene.dust.length} in=${JSON.stringify(Object.fromEntries(Object.entries(f.rates).filter(([, v]) => v)))}`);
}
await wait(2); report('idle');
{ const B0 = B('pelvis'); const xs = []; for (let i = 0; i < 8; i++) { await wait(0.5); const f = frames.at(-1); xs.push([f.xpos[B0 * 3].toFixed(2), f.xpos[B0 * 3 + 1].toFixed(2), f.prog.walk ? 'W' : '-'].join(',')); } console.log('walking pelvis x,y:', xs.join(' ')); report('after walk'); }
self.onmessage({ data: { type: 'do', what: 'sugar' } });
self.onmessage({ data: { type: 'brain', out: { MN9: 80 } } });
await wait(3); report('feed 3s');
await wait(2); report('feed 5s');
self.onmessage({ data: { type: 'do', what: 'nosugar' } });
self.onmessage({ data: { type: 'brain', out: {} } });
await wait(2); report('rest');
self.onmessage({ data: { type: 'do', what: 'dust' } });
self.onmessage({ data: { type: 'brain', out: { groomL: 200, groomR: 200 } } });
await wait(3); report('groom 3s');
await wait(3); report('groom 6s');
self.onmessage({ data: { type: 'brain', out: { GFL: 200 } } });
await wait(0.5); report('escape .5s');
self.onmessage({ data: { type: 'brain', out: {} } });
await wait(2.5); report('after escape');
process.exit(0);
