// Everyone's hand-written letters and how the fly read them: one card per letter.
// Shared by the reading pages (the latest few) and juku/kiroku.html (all of them, by page).
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (v) => `${Math.round(100 * v)}%`;

export async function fetchDrawings(base, course, limit, offset = 0) {
  const r = await fetch(new URL(`api/drawings?course=${course}&limit=${limit}&offset=${offset}&t=${Date.now()}`, base), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

export function tallyText(T) {
  return T.n
    ? `${T.n.toLocaleString()} 字: 第 1 候補で正解 ${pct(T.first / T.n)}（${T.first}）、第 3 候補までに正解 ${pct(T.top3 / T.n)}（${T.top3}）`
    : 'まだ誰も書いていない。出題の枠に字を書くと、ここに残る。';
}

export function renderCards(box, items) {
  box.innerHTML = items.map((it, i) => {
    const k = it.result === 'giveup' ? 9 : +it.result;
    const marks = it.cands.map((c, j) => (j + 1 < k || k === 9 ? `<s>${esc(c)}</s>` : j + 1 === k ? `<b>${esc(c)}</b>` : '')).filter(Boolean).join('');
    const when = new Date(it.t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="dcard ${k === 9 ? 'gave' : k === 1 ? 'first' : ''}" title="${when}"><canvas data-i="${i}" width="${it.size}" height="${it.size}"></canvas>` +
      `<div class="dmarks">${marks}</div><div class="dres">${k === 9 ? '諦めた' : k === 1 ? '一発で正解' : `${k} 回目で正解`}</div></div>`;
  }).join('');
  box.querySelectorAll('canvas').forEach((cv) => {
    const it = items[+cv.dataset.i], S = it.size, raw = atob(it.img);
    const g = cv.getContext('2d'), im = g.createImageData(S, S);
    for (let j = 0; j < S * S; j++) {
      const v = raw.charCodeAt(j);
      im.data[4 * j] = im.data[4 * j + 1] = im.data[4 * j + 2] = v; im.data[4 * j + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  });
}
