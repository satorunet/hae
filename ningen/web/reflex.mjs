// Using the body, learned in the fly's own synapses.
//
// Some of the brain's descending neurons move the body (body-worker.js): DNp28 and DNb06 of each side
// bend that elbow (ELBOWS), DNa02 of each side turns the body to its side, and DNa03, DNa13, DNa15 and
// DNa16 of each side drive it forward (walk). Here the synapses onto them become plastic - every
// excitatory input to each of those groups is one compartment (flybrain setPlasticity). What changes
// them is dopamine, as in the mushroom body - a synapse whose presynaptic cell was active lately
// weakens with positive dopamine and strengthens with negative - and the dopamine comes from how the
// body fared, every WINDOW s (body-worker.js motorLearn):
//
//   dopamine = -GAIN * (how it went - as usual) * (how much that group was active - as usual)
//
//   how it went, for the elbows: how steady the trunk was just after (less tilting, no fall);
//   for steering and walking: how much stronger the food smelt just after (and a taste of it).
//   Active more and it went well, or less and it went badly: negative, the inputs that were active
//   strengthen and the same situation drives that group more next time; the other way round they weaken.
//
// (The fly has no such dopamine for these neurons that anyone knows of: the rule is the mushroom
// body's, put where the body needs it, and the reward is worked out by the body worker - a stand-in
// for dopamine neurons, not a model of them.)
//
// The same setup in the page's brain worker and in the school's trial bodies, so learned gains fit
// both: exportGains/importGains order follows `pre` and the wiring, which are fixed.
export const REFLEX = {
  // the plastic compartments, in order (dopamine levels come as an array in this order)
  groups: [
    ['elbowL', ['dn:DNp28:L', 'dn:DNb06:L']], ['elbowR', ['dn:DNp28:R', 'dn:DNb06:R']],
    ['steerL', ['dn:DNa02:L']], ['steerR', ['dn:DNa02:R']],
    ['goL', ['dn:DNa03:L', 'dn:DNa13:L', 'dn:DNa15:L', 'dn:DNa16:L', 'dn:DNp32:L']], ['goR', ['dn:DNa03:R', 'dn:DNa13:R', 'dn:DNa15:R', 'dn:DNa16:R', 'dn:DNp32:R']],
  ],
  file: 'motor2',                               // state/<file>-latest.bin.gz, <file>-<level>.bin.gz
  eta: 4e-6, tauTrace: 400, tauDopa: 150, gainMin: 0.2, gainMax: 3,
  WINDOW: 0.3, GAIN: 3, SMELL_GAIN: 0.06, maxDopa: 1,
  maxDelta: 0.05,                              // per gain, from any one trial sent to the school
};

/** Make the synapses onto those neurons plastic. `groups` is groups783.json's. */
export function setupReflex(brain, groups) {
  const x = brain._x, n = brain.n;
  const ip = new Uint32Array(x.memory.buffer, x.fb_ptr_indptr(), n + 1);
  const post = new Uint32Array(x.memory.buffer, x.fb_ptr_post(), ip[n]);
  const w = new Int16Array(x.memory.buffer, x.fb_ptr_w(), ip[n]);
  const posts = REFLEX.groups.map(([, keys]) => keys.flatMap((k) => (groups[k] ? groups[k].idx : [])));
  const target = new Set(posts.flat());
  // excitatory inputs only: for an inhibitory one the same change would push the other way
  const pre = [];
  for (let j = 0; j < n; j++) {
    let exc = false;
    for (let k = ip[j]; k < ip[j + 1]; k++) if (target.has(post[k]) && w[k] > 0) { exc = true; break; }
    if (exc) pre.push(j);
  }
  brain.setPlasticity({ pre, groups: posts.map((cells) => ({ post: cells, modulators: [] })), eta: REFLEX.eta, tauTrace: REFLEX.tauTrace,
    tauDopa: REFLEX.tauDopa, gainMin: REFLEX.gainMin, gainMax: REFLEX.gainMax });
  return { pre, posts };
}
