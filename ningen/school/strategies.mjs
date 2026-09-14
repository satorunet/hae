// What the fly's mushroom body chooses between when it goes for food: ways of using the human body,
// in two decisions, each learned from its own part of the trial -
//   approach  when food lands: how to get to it (how carefully to shift weight and step, how to stand)
//   feeding   when the body has got to it: how to get the mouth down and eat without falling
// Each option is a set of values for the body worker's walking and feeding parameters
// (web/body-worker.js: CRAWL, FEED, STANCE, GAIT and the balance gains); the body gets the two chosen
// options merged ({type:'strategy', params: mergeParams(approach, feeding)}), on top of its base
// settings. Anything an option leaves out keeps the base value.
export const DECISIONS = {
  approach: {
    name: '近づき方', when: '食べ物が落ちたとき',
    options: [
      { id: 'careful', name: 'そろり', note: '重心が十分移るまで待ち、小さく低く運ぶ',
        params: { GAIT: { near: 0.02, shrink: 0.7, maxs: 0.03, swing: 0.4, lift: 0.035, stride: 0.1, speed: 0.2, turn: 0.3 } } },
      { id: 'brisk', name: 'ずんずん', note: '重心が近づいたらすぐ運び、大股で速く',
        params: { GAIT: { near: 0.05, shrink: 0.9, maxs: 0.08, swing: 0.22, lift: 0.06, stride: 0.2, speed: 0.35, turn: 0.6 } } },
      { id: 'wide', name: '手足を広く', note: '手も膝も外へ開いて支えを広く（いつもの構え）',
        params: { STANCE: { hands: 0.22, knees: 0.2 } } },
      { id: 'wider', name: 'さらに広く', note: '手も膝もいっぱいに開いて、低く広く構える',
        params: { STANCE: { hands: 0.32, knees: 0.28 } } },
      { id: 'low', name: '腰を落とす', note: '胴を前へ傾け、重心を低く保つ',
        params: { CRAWL: { pitch: 1.65, nod: 1.3 }, balance: { ang: [80, 16] } } },
    ],
  },
  feeding: {
    name: '食べ方', when: '食べ物に着いたとき',
    options: [
      { id: 'deep', name: '胸から伏せる', note: '胸と腰を大きく落として口を食べ物へ',
        params: { FEED: { pitch: 0.9, nod: -0.1, lumbar: -0.25 }, GAIT: { reach: 0.48 } } },
      { id: 'neck', name: '首だけ下ろす', note: '胸はあまり落とさず、首を曲げて口を下へ',
        params: { FEED: { pitch: 0.3, nod: -1.0, lumbar: -0.1 }, GAIT: { reach: 0.58 } } },
      { id: 'slow', name: 'ゆっくり伏せる', note: '顔を下ろす速さを半分以下にし、傾きをしっかり支える',
        params: { GAIT: { dip: 0.006 }, balance: { ang: [90, 18] } } },
      { id: 'brace', name: '手を広げて伏せる', note: '手を外へ広げて突っ張り、その間に顔を下ろす',
        params: { STANCE: { hands: 0.32 }, FEED: { pitch: 0.6, nod: -0.3 } } },
    ],
  },
  // chosen each time the body goes down during a trial (UP: body-worker.js boostForGetup). Its
  // compartments are made of a few MBONs taken from the others' (chooser.mjs), so what those had
  // learned stays theirs: `take` MBONs each.
  getup: {
    name: '起き上がり方', when: '転倒したとき', take: 4,
    options: [
      { id: 'quick', name: '一気に起きる', note: '倒れたらすぐ、体を強く支えて素早く四つん這いへ', params: { UP: { delay: 0, rise: 1.2, boost: 2.2 } } },
      { id: 'steady', name: 'ふつうに起きる', note: 'いつもの速さと支えで四つん這いへ', params: { UP: { delay: 0, rise: 2.5, boost: 1.5 } } },
      { id: 'settle', name: '落ち着いてから', note: '揺れが収まるまで一瞬待ってから、しっかり支えて起きる', params: { UP: { delay: 0.7, rise: 1.8, boost: 2 } } },
      { id: 'wide', name: '手を広げて起きる', note: '手を外へ広げて突っ張りながら起きる', params: { UP: { delay: 0, rise: 2, boost: 1.8 }, STANCE: { hands: 0.32 } } },
    ],
  },
  // chosen when food lands behind the body (TURN: body-worker.js walk): how to come round to it
  turnaround: {
    name: '後ろへの向き方', when: '食べ物が後ろにあるとき', take: 3,
    options: [
      // (only the way: how fast it turns, how far per step and how fast it backs or creeps are the body's
      // basic control, tuned on the server - ./tune.mjs)
      { id: 'pivot', name: 'その場で回る', note: '前へは進まず、手足を一本ずつ踏みかえて少しずつ向きを変える', params: { TURN: { mode: 'pivot' } } },
      { id: 'reverse', name: 'バックしながら回る', note: '後ずさりしながら向きを変え、体の前を食べ物の方へ回す', params: { TURN: { mode: 'reverse' } } },
      { id: 'arc', name: '大回りする', note: 'ゆっくり前へ進みながら、大きく弧を描いて回り込む', params: { TURN: { mode: 'arc' } } },
    ],
  },
};
// The decisions learned from how the whole trial went, and those learned each time they are made
export const TRIAL_DECISIONS = ['approach', 'feeding', 'turnaround'];
export const DECISION_KEYS = Object.keys(DECISIONS);

/** Two options' params as one (the later one wins where both set the same value). */
export function mergeParams(...sets) {
  const out = {};
  for (const p of sets) for (const [group, values] of Object.entries(p || {})) out[group] = { ...(out[group] || {}), ...values };
  return out;
}

// How each decision learns from how the trial went (dopamine level in the chosen compartment:
// positive makes that option likelier for that smell, negative less likely). A failure is not
// just "no": where it happened says which decision it was about, and eating before a fall still
// counts for something - but the fall counts for more.
export function outcomeLevels({ reached, ate, result }) {
  const failed = result === 'fell' || result === 'out';
  const approach = reached != null ? 1 : failed ? -0.5 : -0.25;
  const turnaround = reached != null ? 1 : failed ? -0.6 : -0.3;             // (only when one was chosen: food behind)
  let feeding = null;
  if (reached != null) {
    if (ate != null) feeding = failed ? -0.3 : 1;                 // ate and kept its feet / ate, then fell
    else feeding = failed ? -0.6 : -0.3;                          // got there, fell before eating / never got its mouth on it
  }
  return { approach, feeding, turnaround };
}

// How a get-up teaches its choice: up within `ok` seconds of going down (the trial goes on) is good, the
// sooner the better; not up by then (the trial is lost) is bad.
export function getupLevel({ ok, t }, okS = 8) {
  if (!ok || !(t <= okS)) return -0.6;
  return +(0.3 + 0.7 * (1 - t / okS)).toFixed(3);
}

// The smell of each food, as the olfactory projection neurons of the glomeruli it would most likely
// drive (a rough choice from what those glomeruli are known to answer, not a measured odour):
//   honey  sweet, fruity and fermented esters and diacetyl - DM1, DM2, DM4, VA2, DL1
//   meat   going off: amines, ammonia, acids - VM1, DP1l, DP1m, DC4, VL2a
//   dung   ammonia, indole and phenols, CO2, and mould (geosmin) - VM1, DL5, VC3, V, DA2
// Meat and dung share VM1 (ammonia), so the fly's first guesses for them are less independent.
export const ODOURS = {
  honey: ['DM1_lPN', 'DM2_lPN', 'DM4_adPN', 'DM4_vPN', 'VA2_adPN', 'DL1_adPN'],
  meat: ['VM1_lPN', 'DP1l_adPN', 'DP1l_vPN', 'DP1m_adPN', 'DP1m_vPN', 'DC4_adPN', 'DC4_vPN', 'VL2a_adPN', 'VL2a_vPN'],
  dung: ['VM1_lPN', 'DL5_adPN', 'VC3_adPN', 'V_ilPN', 'V_l2PN', 'DA2_lPN'],
};
