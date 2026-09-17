// The wires the experimenter has into the brain.
//
// Everything the calculator does is driven from outside by pulses on real sensory populations - a
// clock the fly hears and sees, not one it makes. Each line needs cells that answer *its* population
// and no other, or a tick would look like a tock; this measures that and hands back the clean ones.
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;

/** 'vpn:LC11:L+vpn:LC11:R' -> the model indices, deduplicated. */
export const G = (k) => [...new Set(k.split('+').flatMap((x) => {
  if (!groups[x]) throw new Error(`no such group: ${x}`);
  return groups[x].idx;
}))];

/**
 * For each named population: the `take` cells that fire most on their own input and not at all on any
 * other. `plain` is a brain to measure in, `ms` the pulse, `hz` its rate.
 */
export function drivers(plain, IN, { take = 24, ms = 200, hz = 150, seeds = 3, quiet = false } = {}) {
  const names = Object.keys(IN);
  const mean = (cells) => {
    const m = new Float64Array(plain.n);
    for (let s = 0; s < seeds; s++) {
      plain.clearStimuli(); plain.reset(10 + s); plain.stimulate(cells, hz, { byIndex: true }); plain.run(ms);
      const c = plain.counts();
      for (let i = 0; i < plain.n; i++) m[i] += c[i] / seeds;
    }
    return m;
  };
  const M = Object.fromEntries(names.map((k) => [k, mean(IN[k])]));
  const out = {};
  for (const k of names) {
    const others = names.filter((o) => o !== k).map((o) => M[o]);
    const own = new Set(IN[k]);
    out[k] = [...M[k].keys()]
      .filter((i) => own.has(i) && M[k][i] >= 2 && others.every((o) => o[i] === 0))
      .sort((x, y) => M[k][y] - M[k][x]).slice(0, take);
    if (out[k].length < take) throw new Error(`${k}: only ${out[k].length} clean drivers`);
    if (!quiet) {
      const rate = (out[k].reduce((s, i) => s + M[k][i], 0) / out[k].length).toFixed(1);
      const cross = Math.max(0, ...others.map((o) => out[k].reduce((s, i) => s + o[i], 0) / out[k].length)).toFixed(2);
      console.log(`  ${k.padEnd(6)} ${out[k].length} cells: ${rate} spikes on its own pulse, ${cross} on any other`);
    }
  }
  return out;
}
