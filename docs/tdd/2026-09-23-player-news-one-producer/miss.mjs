const WT = process.argv[2];
const { rows } = await import(`${WT}/server/db/index.js`);
const { playerNews, loadAttributionIndex } = await import(`${WT}/server/news/player-news.js`);
const index = loadAttributionIndex();
const stories = rows(`SELECT id, entities_json FROM news_items ORDER BY COALESCE(published_at,date) DESC, id DESC`);
const res = new Map(); for (const s of stories) { let e; try { e = JSON.parse(s.entities_json || '{}'); } catch (err) { continue; }
  for (const p of e.players ?? []) (res.get(Number(p.id)) ?? res.set(Number(p.id), []).get(Number(p.id))).push(s.id); }
let displaced = 0, dropped = 0; const ex = [];
for (const [id, list] of res) { const top = list.slice(0, 10); const card = new Set(playerNews(id, { index }).map(s => s.id));
  const all = new Set(playerNews(id, { index, limit: 1e9 }).map(s => s.id));
  for (const x of top) if (!card.has(x)) { if (all.has(x)) displaced++; else { dropped++; ex.push([id, x]); } } }
console.log({ resolved_players_all: res.size, displaced_by_newer_surname_rows: displaced, dropped_entirely: dropped, examples: ex.slice(0, 5) });
