const WT = process.argv[2];
const express = (await import(`${WT}/node_modules/express/index.js`)).default;
const { Readable, PassThrough } = await import('node:stream'); const { ServerResponse } = await import('node:http');
const { row } = await import(`${WT}/server/db/index.js`);
const { default: players } = await import(`${WT}/server/routes/players.js`);
const app = express(); app.use('/api/players', players);
const get = url => new Promise((resolve, reject) => { const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = 'GET'; req.headers = {}; req.socket = new PassThrough(); req.connection = req.socket;
  const res = new ServerResponse(req); const c = []; res.write = x => { c.push(Buffer.from(x)); return true; };
  res.end = x => { if (x) c.push(Buffer.from(x)); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString()) }); }; app.handle(req, res, reject); });
for (const name of ['Jonathon Brooks', 'Michael Pittman Jr.']) {
  const p = row(`SELECT id FROM players WHERE name = ? AND fantasy_relevant = 1 AND COALESCE(phase,'')<>'historical'`, name);
  const r = await get(`/api/players/${p.id}`);
  console.log(name, r.status, r.body.news.slice(0, 4).map(n => `${n.published_at?.slice(0, 10)} ${n.headline.slice(0, 70)}`));
}
