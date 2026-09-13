// The one bit of the reading flies that takes input from visitors: letters people
// wrote for the fly, how the fly read them and how the writer marked it. It is a
// public record only - nothing here is used to train the flies.
//
//   node juku/api.mjs          (pm2: hae-juku-api, behind nginx at /juku/api/)
//
//   POST /drawing   { course, img: base64 of size*size bytes, cands: [label...], result }
//   GET  /drawings?course=hiragana&limit=30&offset=0   (newest first)
//
// Records are appended to juku/state/<course>/drawings.jsonl.
import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { COURSES } from './reader.mjs';

const PORT = +process.env.JUKU_API_PORT || 3020;
const STATE = new URL('state/', import.meta.url);
const KEEP = 50000;                         // records held in memory per course (a few hundred bytes each)
const RESULTS = new Set(['1', '2', '3', 'giveup']);   // right at the 1st/2nd/3rd choice, or none
const recent = {};
const hits = new Map();                    // ip -> [timestamps] for a simple rate limit

for (const course of Object.keys(COURSES)) {
  recent[course] = [];
  await mkdir(new URL(`${course}/`, STATE), { recursive: true });
  try {
    const lines = (await readFile(new URL(`${course}/drawings.jsonl`, STATE), 'utf8')).trim().split('\n');
    for (const l of lines.slice(-KEEP)) if (l) recent[course].push(JSON.parse(l));
  } catch (e) { if (e.code !== 'ENOENT') console.error(e); }
}

function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 60e3);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;                 // 30 letters a minute is plenty for a person
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/drawings') {
      const course = url.searchParams.get('course');
      if (!recent[course]) return send(res, 400, { error: 'course' });
      const limit = Math.max(1, Math.min(200, +url.searchParams.get('limit') || 60));
      const offset = Math.max(0, Math.floor(+url.searchParams.get('offset') || 0));   // from the newest
      const list = recent[course];
      const tally = { n: list.length, first: 0, top3: 0 };
      for (const r of list) { if (r.result === '1') tally.first++; if (r.result !== 'giveup') tally.top3++; }
      const end = Math.max(0, list.length - offset);
      return send(res, 200, { course, tally, offset, limit, items: list.slice(Math.max(0, end - limit), end).reverse() });
    }
    if (req.method === 'POST' && url.pathname === '/drawing') {
      const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
      if (limited(ip)) return send(res, 429, { error: 'slow down' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 4000) return send(res, 413, { error: 'too big' }); }
      const b = JSON.parse(raw);
      const C = COURSES[b.course];
      if (!C) return send(res, 400, { error: 'course' });
      const px = Buffer.from(String(b.img || ''), 'base64');
      if (px.length !== C.size * C.size) return send(res, 400, { error: 'img' });
      const cands = Array.isArray(b.cands) ? b.cands.slice(0, 3).map(String) : [];
      if (!cands.length || cands.some((c) => !C.labels.includes(c))) return send(res, 400, { error: 'cands' });
      const result = String(b.result);
      if (!RESULTS.has(result) || (result !== 'giveup' && +result > cands.length)) return send(res, 400, { error: 'result' });
      const rec = { t: Date.now(), size: C.size, img: px.toString('base64'), cands, result };
      recent[b.course].push(rec);
      if (recent[b.course].length > KEEP) recent[b.course].shift();
      await appendFile(new URL(`${b.course}/drawings.jsonl`, STATE), JSON.stringify(rec) + '\n');
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, '127.0.0.1', () => console.log('juku api on', PORT));
