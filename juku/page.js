// What /suji/ and /hiragana/ share: the server's record, a copy of the
// server's fly answering questions in the browser, and a drawing pad.
import { FlagFly } from '../suji/flag.js?v=16';
import { RecordChart, COLORS } from './chart.js?v=3';
import { normalise } from '../hiragana/kana.mjs?v=2';

const $ = (s) => document.querySelector(s);
const pct = (v, d = 0) => (v == null ? '–' : `${(100 * v).toFixed(d)}%`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @param {object} o
 * @param {'suji'|'hiragana'} o.course
 * @param {string[]} o.rows         the letters, row by row (a level unlocks a row)
 * @param {(lv:number)=>string} [o.levelName]
 * @param {number} o.padInk          ink the pad's picture is normalised to (see normalise)
 * @param {number} o.pen             pen width as a fraction of the 48 px drawing
 */
export function runPage(o) {
  const worker = new Worker(new URL('./worker.js?v=2', import.meta.url), { type: 'module' });
  const letters = o.rows.join('');
  let labels = [...letters], status = null, meta = null, kcXY = null;
  let busy = true, auto = true, quizTimer = null, flyWaits = 0;
  let asked = 0, right = 0; const hist = [];
  let lastDrive = null, lastAnswer = null, lastSlots = null, lastAllowed = null;
  let fly = null;
  new FlagFly($('#fly')).load().then((f) => { fly = f; window.__fly = f; })
    .catch((e) => { $('#flynote').textContent = '（3D の蠅を読み込めなかった: ' + e.message + '）'; });
  const chart = new RecordChart($('#chart'), $('#charttip'), { levelName: o.levelName });

  const unlocked = () => (status ? o.rows.slice(0, status.level || 1).join('').length : letters.length);

  // ------------------------------------------------------------ the record
  function drawStatus() {
    if (!status) return;
    const s = status;
    if (o.levelName) {
      $('#lv').textContent = `Lv ${s.level}`;
      $('#lvsub').textContent = s.level >= s.of
        ? `全 ${s.of} 段。46 文字すべてを練習中`
        : `${o.levelName(s.level)}まで（${unlocked()} 文字）。未見フォントで ${pct(s.levelUp)} 取れたら次の段`;
    }
    $('#practised').textContent = s.practised.toLocaleString();
    $('#running').textContent = pct(s.running, 1);
    $('#runsub').textContent = s.window ? `直近 ${s.window} 問` : 'レベルが上がったばかり';
    $('#testpct').textContent = s.lastTest ? pct(s.lastTest.test, 1) : '–';
    $('#testsub').textContent = s.lastTest
      ? `${s.lastTest.size} 問・${new Date(s.lastTest.t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
      : '最初のテスト待ち';
    const days = (Date.now() - s.started) / 864e5;
    $('#since').textContent = `学習開始から ${days < 1 ? `${(days * 24).toFixed(1)} 時間` : `${days.toFixed(1)} 日`}`;
    chart.set(s.history);
    drawGrid();
  }
  function drawGrid() {
    const per = status?.lastTest?.perLetter || [];
    const n = unlocked();
    let k = 0;
    $('#grid').innerHTML = o.rows.map((row) => `<div class="grow">${[...row].map((ch) => {
      const i = k++, on = i < n, v = per[i];
      // lightness steps with the score: one hue, dark (low) to light (high)
      const bg = !on ? '' : v == null ? 'background:#1d2630' :
        `background:hsl(206 ${40 + 30 * v}% ${16 + 30 * v}%)`;
      return `<span class="gl${on ? '' : ' off'}" style="${bg}" title="${on ? `${ch}: ${v == null ? '未テスト' : pct(v)}` : `${ch}: まだ習っていない`}">` +
        `${ch}<small>${on && v != null ? Math.round(100 * v) : ''}</small></span>`;
    }).join('')}</div>`).join('');
  }

  // the server's fly practising right now
  async function pollLive() {
    try {
      const r = await fetch(`../juku/state/${o.course}/live.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const L = await r.json();
        $('#practised').textContent = L.practised.toLocaleString();
        $('#running').textContent = pct(L.running, 1);
        $('#runsub').textContent = L.window ? `直近 ${L.window} 問` : 'レベルが上がったばかり';
        const age = (Date.now() - L.t) / 1000;
        $('#livestate').textContent = age < 30 ? '● 練習中' : `停止中（${Math.round(age / 60)} 分前が最後）`;
        $('#livestate').className = age < 30 ? 'live on' : 'live';
        $('#feed').innerHTML = L.feed.slice().reverse().map(([t, a]) => t === a
          ? `<span class="fc ok" title="正解">${esc(labels[t])}</span>`
          : `<span class="fc no" title="${esc(labels[t])} を ${esc(labels[a])} と読んだ">${esc(labels[t])}<small>${esc(labels[a])}</small></span>`).join('');
        if (status && L.practised - status.practised > 400 && !busy) worker.postMessage({ type: 'refresh' });
      }
    } catch { /* offline for a moment */ }
    setTimeout(pollLive, 3000);
  }

  // ------------------------------------------------------------ the quiz
  function drawPixels(canvas, img) {
    const S = meta.size;
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d'), d = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = Math.round(255 * (img ? img[i] : 0));
      d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = v; d.data[4 * i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
  }
  function drawTally() {
    $('#tallypct').textContent = asked ? pct(right / asked) : '–';
    $('#tallysub').textContent = asked ? `このページで ${right} / ${asked} 問正解` : 'まだ出題していない';
    $('#hist').innerHTML = hist.slice(-72).map((v) => `<i class="${v ? 'ok' : 'no'}"></i>`).join('');
  }
  function setAuto(on) {
    if (on && hand) {
      hand = false; clearTimeout(backTimer); qpad?.classList.remove('on');
      showJudge(false); handCands = [];
      if (fly && fly.hold) fly.release(false);
      strokes = []; redrawPad();
      if (o.course === 'suji') $('#qsrc').hidden = true;
    }
    auto = on;
    $('#autobtn').textContent = on ? '止める' : '自動でまわす';
    if (!on && quizTimer) { clearTimeout(quizTimer); quizTimer = null; }
    if (on && !busy) nextQuestion(300);
  }
  let lastRefresh = Date.now();
  function nextQuestion(delay = 0, awaitFly = false) {
    if (quizTimer) clearTimeout(quizTimer);
    quizTimer = setTimeout(() => {
      quizTimer = null;
      if (busy) { nextQuestion(400, awaitFly); return; }
      if (awaitFly && fly && fly.isBusy() && ++flyWaits < 120) { nextQuestion(250, true); return; }
      flyWaits = 0;
      busy = true;
      if (Date.now() - lastRefresh > 60e3) {        // pick up the server's newer brain now and then
        lastRefresh = Date.now();
        worker.postMessage({ type: 'refresh' });
      }
      $('#status').textContent = '出題中…';
      worker.postMessage({ type: 'ask' });
    }, delay);
  }

  // ------------------------------------------------------------ panels
  function drawBars() {
    const tb = $('#bars tbody');
    if (!lastDrive) { tb.innerHTML = '<tr><td class="note">まだ何も読ませていない。</td></tr>'; return; }
    const cand = lastAllowed.map((c) => [lastDrive[c], c]).sort((a, b) => a[0] - b[0]).slice(0, 9);
    const lo = cand[0][0], hi = Math.max(...lastAllowed.map((c) => lastDrive[c])), span = (hi - lo) || 1;
    tb.innerHTML = cand.map(([v, c]) => `<tr><td class="nm">${esc(labels[c])}</td>
      <td class="sub2" title="${esc(meta.groups[c].name)}">MBON ${meta.groups[c].cells} 個</td>
      <td><div class="bar"><span class="${c === lastAnswer ? 'win' : ''}" style="left:0;width:${(100 * (hi - v) / span).toFixed(1)}%"></span></div></td>
      <td class="num">${(100 * v).toFixed(1)}</td></tr>`).join('');
  }
  function drawKC() {
    const c = $('#kc'), dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth || 720, h = Math.round(w * 0.36);
    c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px';
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    if (!kcXY) return;
    const n = kcXY.length / 2, p2 = 10, r = Math.max(0.9, Math.min(2.2, w / 420));
    const on = new Uint8Array(n);
    if (lastSlots) for (const k of lastSlots) on[k] = 1;
    for (const pass of [0, 1]) {
      x.fillStyle = pass ? '#59b7ff' : '#2a323b';
      x.beginPath();
      for (let k = 0; k < n; k++) {
        if (on[k] !== pass) continue;
        const px = p2 + kcXY[2 * k] * (w - 2 * p2), py = p2 + kcXY[2 * k + 1] * (h - 2 * p2);
        x.moveTo(px + r, py); x.arc(px, py, r, 0, 6.2832);
      }
      x.fill();
    }
    $('#pct').textContent = lastSlots ? (100 * lastSlots.length / n).toFixed(1) + '%' : '–';
  }

  // ------------------------------------------------------------ drawing pad
  // Two surfaces share one drawing: the pad further down, and the question box
  // at the top (a transparent canvas over the question, so the question box is
  // also where you can write your own).
  const pad = $('#pad'), qpad = $('#qpad');
  let drawing = false, strokes = [];
  function paint(cv, clear) {
    const w = cv.width, h = cv.height, c = cv.getContext('2d');
    c.clearRect(0, 0, w, h);
    if (clear) return;
    c.fillStyle = '#07090c'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#e6edf3'; c.fillStyle = '#e6edf3'; c.lineWidth = w / 16;
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const s of strokes) {
      c.beginPath();
      if (s.length === 1) { c.arc(s[0].x * w, s[0].y * h, c.lineWidth / 2, 0, 6.2832); c.fill(); continue; }
      s.forEach((p, i) => (i ? c.lineTo(p.x * w, p.y * h) : c.moveTo(p.x * w, p.y * h)));
      c.stroke();
    }
  }
  function redrawPad() {
    paint(pad, false);
    if (qpad) paint(qpad, !hand);
    if (meta) drawPixels($('#prev'), padImage());
  }
  // Hand mode: the moment someone starts drawing, the quiz stops and the fly
  // reads the drawing instead - again after every stroke - holding up its
  // answer where the questions were. A while after the last stroke the quiz
  // comes back by itself (if it was running).
  let hand = false, handWasAuto = false, readTimer = null, backTimer = null;
  // Marking the fly's reading of your own writing - kept on this page only,
  // never sent anywhere. The fly holds its flag up until you answer; × moves
  // it on to its second and then third choice; ○ feeds it, and once it has
  // eaten the quiz carries on by itself.
  let handCands = [], handK = 0, handSure = 1;
  const hstat = { n: 0, first: 0, top3: 0 };
  function showJudge(on) {
    $('#judge').hidden = !on;
    if (on) {
      $('#judgeok').disabled = false; $('#judgeno').disabled = false;
      $('#judgeq').textContent = handK === 0 ? '蠅の読みは合ってる？'
        : `第 ${handK + 1} 候補「${labels[handCands[handK]]}」は合ってる？`;
    }
  }
  function drawHandTally() {
    $('#judgetally').textContent = hstat.n
      ? `手書きの答え合わせ ${hstat.n} 字: 第 1 候補で正解 ${hstat.first}、第 3 候補までに正解 ${hstat.top3}（このページだけの記録。サーバの学習には使わない）`
      : '';
  }
  function holdCandidate() {
    const c = handCands[handK];
    $('#qans').textContent = labels[c];
    $('#guess').firstChild.textContent = labels[c];
    if (fly) fly.show(labels[c], handK === 0 ? handSure : 0.25, false, true);
    showJudge(true);
  }
  function finishHand(msg) {
    showJudge(false); handCands = [];
    clearTimeout(readTimer);
    strokes = []; redrawPad();                     // a clean page for the next one
    $('#status').textContent = msg;
  }
  function judge(ok) {
    if (!handCands.length || $('#judgeok').disabled) return;
    $('#judgeok').disabled = true; $('#judgeno').disabled = true;
    const v = $('#verdict'); v.textContent = ok ? '○' : '×'; v.className = 'verdict ' + (ok ? 'ok' : 'no');
    if (ok) {
      hstat.n++; hstat.top3++; if (handK === 0) hstat.first++;
      drawHandTally();
      if (fly) fly.release(true);
      finishHand(`○ 第 ${handK + 1} 候補の「${labels[handCands[handK]]}」で正解 — 餌を食べ終わったら出題に戻る。`);
      backToQuiz();
      return;
    }
    if (fly) fly.puzzle(handK + 1 < handCands.length ? 1.6 : 2.4);   // "hmm, not that one?"
    if (handK + 1 < handCands.length) {
      handK++;
      $('#status').textContent = `× では第 ${handK + 1} 候補の「${labels[handCands[handK]]}」？`;
      holdCandidate();
      return;
    }
    hstat.n++;
    drawHandTally();
    if (fly) fly.release(false);
    finishHand(`× 第 ${handCands.length} 候補まで全部はずれ（${handCands.map((c) => labels[c]).join('・')}）。出題に戻る。`);
    backToQuiz();
  }
  // once marked, straight back to the quiz - after the flag is down (and the food eaten)
  function backToQuiz() {
    clearTimeout(backTimer);
    const back = (tries = 0) => {
      if (!hand || strokes.length) return;         // they started writing another one
      if (fly && fly.isBusy() && tries < 160) { backTimer = setTimeout(() => back(tries + 1), 250); return; }
      handWasAuto = true; leaveHand();
    };
    backTimer = setTimeout(back, 400);
  }
  $('#judgeok').addEventListener('click', () => judge(true));
  $('#judgeno').addEventListener('click', () => judge(false));
  function enterHand() {
    clearTimeout(backTimer);
    if (hand) return;
    hand = true; handWasAuto = auto;
    if (auto) setAuto(false);
    $('#qtruth').textContent = '✍';
    $('#qsrc').hidden = false;
    $('#qsrc').textContent = 'あなたの字';
    $('#qans').textContent = '…';
    $('#verdict').textContent = '?'; $('#verdict').className = 'verdict';
    $('#status').textContent = '手書きモード: 1 画書くごとに蠅が読む。';
    qpad?.classList.add('on');
  }
  function leaveHand() {
    if (!hand) return;
    hand = false;
    qpad?.classList.remove('on');
    showJudge(false); handCands = [];
    if (fly && fly.hold) fly.release(false);
    strokes = []; redrawPad();
    if (o.course === 'suji') $('#qsrc').hidden = true;
    if (handWasAuto) setAuto(true);
  }
  const HAND_IDLE = 40e3;
  const at = (cv, e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  const strokeDone = () => {
    if (!drawing) return;
    drawing = false;
    clearTimeout(readTimer);
    readTimer = setTimeout(readDrawing, 450);        // a pause after a stroke = read it
    clearTimeout(backTimer);
    if (!handCands.length) backTimer = setTimeout(leaveHand, HAND_IDLE);   // not while a reading waits for ○/×
  };
  for (const cv of [pad, qpad]) {
    if (!cv) continue;
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cv.setPointerCapture(e.pointerId); drawing = true; clearTimeout(readTimer);
      if (!hand) strokes = [];                       // a fresh page for a fresh go
      enterHand();
      showJudge(false); handCands = [];              // the reading is about to change
      clearTimeout(backTimer);
      strokes.push([at(cv, e)]); redrawPad();
    });
    cv.addEventListener('pointermove', (e) => { if (drawing) { strokes[strokes.length - 1].push(at(cv, e)); redrawPad(); } });
    cv.addEventListener('pointerup', strokeDone);
    cv.addEventListener('pointercancel', strokeDone);
  }
  function readDrawing() {
    if (!meta || !status || !strokes.length) return;
    if (busy || drawing) { readTimer = setTimeout(readDrawing, 200); return; }
    busy = true;
    $('#guesssub').textContent = '読んでいます…';
    worker.postMessage({ type: 'read', img: padImage() });
  }
  // the strokes at 48 x 48 with a pen about as thick as a font's, then the
  // same centring, scaling and ink normalisation the training pictures get
  function padImage() {
    const M = 48, big = document.createElement('canvas');
    big.width = big.height = M;
    const g = big.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, M, M);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = M * o.pen; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of strokes) {
      g.beginPath();
      if (s.length === 1) { g.arc(s[0].x * M, s[0].y * M, g.lineWidth / 2, 0, 6.2832); g.fill(); continue; }
      s.forEach((p, i) => (i ? g.lineTo(p.x * M, p.y * M) : g.moveTo(p.x * M, p.y * M)));
      g.stroke();
    }
    const src = g.getImageData(0, 0, M, M).data, img = new Float32Array(M * M);
    for (let i = 0; i < M * M; i++) img[i] = src[4 * i] / 255;
    return normalise(img, M, meta.size, o.padInk);
  }

  // ------------------------------------------------------------ controls
  $('#autobtn').addEventListener('click', () => setAuto(!auto));
  $('#askbtn').addEventListener('click', () => { if (auto) setAuto(false); nextQuestion(0); });
  const clearDrawing = () => {
    strokes = []; redrawPad(); clearTimeout(readTimer);
    if (hand) {
      $('#qans').textContent = '…'; showJudge(false); handCands = [];
      if (fly && fly.hold) fly.release(false);
      $('#verdict').textContent = '?'; $('#verdict').className = 'verdict';
      $('#guess').firstChild.textContent = '–';
      $('#status').textContent = '消した。もう一度どうぞ。';
      clearTimeout(backTimer); backTimer = setTimeout(leaveHand, HAND_IDLE);
    }
  };
  $('#clearbtn').addEventListener('click', clearDrawing);
  $('#qclear')?.addEventListener('click', clearDrawing);
  $('#readbtn')?.addEventListener('click', () => { if (strokes.length) { enterHand(); readDrawing(); } });
  $('#backbtn').addEventListener('click', () => {
    clearTimeout(backTimer); clearTimeout(readTimer);
    strokes = []; redrawPad();
    handWasAuto = true;
    if (hand) leaveHand(); else setAuto(true);
  });

  // ------------------------------------------------------------ worker
  worker.onerror = (e) => { $('#status').textContent = '脳を読み込めなかった: ' + (e.message || e.type); };
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      $('#status').textContent = m.phase === 'material' ? '問題の素材を読み込んでいます…'
        : m.total ? `脳を読み込んでいます… ${(100 * m.loaded / m.total).toFixed(0)}%` : '脳を展開しています…';
    } else if (m.type === 'error') {
      $('#status').textContent = `エラー（${m.during}）: ${m.message}`;
      busy = false;
    } else if (m.type === 'status') {
      if (!m.status) {                 // nothing from the server yet: ask again shortly
        $('#status').textContent = 'サーバの蠅の最初の記録を待っています（起動して数分）…';
        setTimeout(() => worker.postMessage({ type: 'refresh' }), 20e3);
        return;
      }
      const first = !status;
      status = m.status;
      drawStatus();
      if (first && meta) { busy = false; setAuto(auto); }
      if (m.loaded) $('#brainnote').textContent = `このページの蠅 = サーバの蠅の、練習 ${m.status.practised.toLocaleString()} 枚時点のコピー`;
    } else if (m.type === 'ready') {
      meta = m; labels = m.labels;
      kcXY = await kcPositions(m.kc);
      drawKC(); drawBars(); redrawPad(); drawTally();
      pollLive();
      if (!status) return;             // the quiz starts when the first record arrives
      busy = false;
      $('#status').textContent = '準備完了。';
      setAuto(true);
    } else if (m.type === 'answered') {
      if (hand) { busy = false; return; }          // a question that was already on its way
      lastDrive = m.drive; lastAnswer = m.answer; lastSlots = m.slots;
      lastAllowed = [...Array(unlocked()).keys()];
      drawPixels($('#q'), m.img);
      $('#qtruth').textContent = labels[m.truth];
      $('#qsrc').textContent = m.source;
      const ok = m.answer === m.truth;
      asked++; if (ok) right++; hist.push(ok); drawTally();
      $('#qans').textContent = labels[m.answer];
      const v = $('#verdict'); v.textContent = ok ? '○' : '×'; v.className = 'verdict ' + (ok ? 'ok' : 'no');
      if (fly) fly.show(labels[m.answer], Math.min(1, m.margin / 0.03), ok);
      drawBars(); drawKC();
      busy = false;
      $('#status').textContent = (ok ? '正解。餌が出る。' : `不正解 — 本当は「${labels[m.truth]}」。`) +
        `次の候補は「${labels[m.second]}」`;
      if (auto) nextQuestion(600, true);
    } else if (m.type === 'readout') {
      lastDrive = m.drive; lastAnswer = m.answer; lastSlots = m.slots;
      lastAllowed = [...Array(unlocked()).keys()];
      $('#guess').firstChild.textContent = labels[m.answer];
      $('#guesssub').textContent = `次の候補は「${labels[m.second]}」` +
        (o.levelName && unlocked() < letters.length ? `（いま読めるのは習った ${unlocked()} 文字の中からだけ）` : '');
      if (hand && strokes.length && !drawing) {    // answer where the questions are, and wait for ○/×
        handCands = lastAllowed.slice().sort((a, b) => m.drive[a] - m.drive[b]).slice(0, 3);
        handK = 0; handSure = Math.min(1, m.margin / 0.03);
        $('#verdict').textContent = '?'; $('#verdict').className = 'verdict';
        clearTimeout(backTimer);
        holdCandidate();
        $('#status').textContent = `蠅の答えは「${labels[m.answer]}」。合っていたら ○、ちがったら ×（次の候補を出す）。`;
      } else if (!hand && fly) fly.show(labels[m.answer], Math.min(1, m.margin / 0.03), false);
      drawBars(); drawKC();
      busy = false;
    }
  };

  async function kcPositions(kcIdx) {
    const res = await fetch(new URL('../flybrain/data/pos783.bin.gz?v=1', import.meta.url));
    const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const dv = new DataView(buf);
    const n = dv.getUint32(4, true);
    const xs = new Uint16Array(buf, 8, n), ys = new Uint16Array(buf, 8 + 2 * n, n);
    const out = new Float32Array(2 * kcIdx.length);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of kcIdx) {
      if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
    }
    const sx = x1 - x0 || 1, sy = y1 - y0 || 1, aim = 0.36;
    const k = Math.min(1 / sx, aim / sy), ox = (1 - sx * k) / 2, oy = (aim - sy * k) / 2;
    kcIdx.forEach((i, j) => { out[2 * j] = ox + (xs[i] - x0) * k; out[2 * j + 1] = (oy + (ys[i] - y0) * k) / aim; });
    return out;
  }

  addEventListener('resize', () => { drawKC(); if (fly) fly.resize(); });
  window.__hand = () => ({ hand, strokes: strokes.length, cands: handCands.map((c) => labels[c]), k: handK, auto, busy });
  $('#legend-test').style.background = COLORS.test;
  $('#legend-run').style.background = COLORS.run;
  redrawPad();
  worker.postMessage({ type: 'init', course: o.course });
  setInterval(() => { if (!busy && !auto) worker.postMessage({ type: 'refresh' }); }, 60e3);
}
