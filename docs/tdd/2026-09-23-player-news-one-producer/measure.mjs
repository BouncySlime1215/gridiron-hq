// RL-12-3 before/after on a local copy. Usage: GRIDIRON_DB_PATH=<copy> node measure.mjs <worktree>
const WT = process.argv[2];
const { rows } = await import(`${WT}/server/db/index.js`);
const { playerNews, attributeStory, loadAttributionIndex } = await import(`${WT}/server/news/player-news.js`);
const parse = v => { try { return JSON.parse(v || '{}'); } catch (e) { return { players: [], err: e.message }; } };
function newsForOld(player) { // verbatim SQL of routes/players.js:27-37 at 57a9ca1c
  const full = `%${player.name}%`; const last = `%${player.name.split(' ').slice(-1)[0]}%`;
  return rows(`SELECT n.*, t.abbr AS team_abbr FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
    WHERE (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?)
       OR (n.team_id IS NOT NULL AND n.team_id = ? AND (n.headline LIKE ? OR n.ai_analysis LIKE ? OR n.fantasy_impact LIKE ?))
    ORDER BY n.date DESC LIMIT 10`, full, full, full, player.team_id ?? -1, last, last, last);
}
const stories = rows(`SELECT * FROM news_items ORDER BY COALESCE(published_at,date) DESC, id DESC`);
const index = loadAttributionIndex();
const resolvedBy = new Map(), attrBy = new Map(), method = new Map();
for (const s of stories) {
  for (const p of parse(s.entities_json).players ?? []) { const id = Number(p.id); (resolvedBy.get(id) ?? resolvedBy.set(id, []).get(id)).push(s.id); }
  for (const p of attributeStory(s, index)) { (attrBy.get(p.id) ?? attrBy.set(p.id, []).get(p.id)).push(s.id); method.set(`${p.id}:${s.id}`, p.method); }
}
const players = rows(`SELECT id,name,team_id FROM players WHERE fantasy_relevant=1 AND team_id IS NOT NULL AND COALESCE(phase,'')<>'historical'`)
  .filter(p => resolvedBy.has(Number(p.id)) || attrBy.has(Number(p.id)));
const out = { news_rows: stories.length, players: players.length,
  before: { resolved_top10: 0, resolved_top10_missed: 0, shown: 0, shown_not_resolved: 0, shown_suffix_token: 0, empty_card_with_resolved: 0 },
  after: { resolved_top10: 0, resolved_top10_missed: 0, shown: 0, shown_not_resolved: 0, shown_surname_team: 0, empty_card_with_resolved: 0,
    card_vs_newspage_disagreements_all_stories: 0 } };
const fallbackSample = [];
for (const p of players) {
  const id = Number(p.id); const res = resolvedBy.get(id) ?? []; const res10 = res.slice(0, 10); const resSet = new Set(res);
  const old = newsForOld(p).map(s => s.id); const oldSet = new Set(old);
  const B = out.before; B.resolved_top10 += res10.length; B.resolved_top10_missed += res10.filter(x => !oldSet.has(x)).length;
  B.shown += old.length; const wrong = old.filter(x => !resSet.has(x)); B.shown_not_resolved += wrong.length;
  if (/^(jr|sr|ii|iii|iv|v)\.?$/i.test(p.name.split(' ').slice(-1)[0])) B.shown_suffix_token += wrong.length;
  if (res.length && !old.length) B.empty_card_with_resolved++;
  const neu = playerNews(id, { index }).map(s => s.id); const neuSet = new Set(neu);
  const A = out.after; A.resolved_top10 += res10.length; A.resolved_top10_missed += res10.filter(x => !neuSet.has(x)).length;
  A.shown += neu.length; A.shown_not_resolved += neu.filter(x => !resSet.has(x)).length;
  for (const x of neu) if (method.get(`${id}:${x}`) === 'surname_team') { A.shown_surname_team++; fallbackSample.push([p.name, stories.find(s => s.id === x).headline]); }
  if (res.length && !neu.length) A.empty_card_with_resolved++;
  const full = new Set(playerNews(id, { index, limit: 1e9 }).map(s => s.id)); const truth = new Set(attrBy.get(id) ?? []);
  if (full.size !== truth.size || [...full].some(x => !truth.has(x))) A.card_vs_newspage_disagreements_all_stories++;
}
console.log(JSON.stringify(out, null, 1));
if (process.env.SAMPLE) { let seed = Number(process.env.SEED ?? 7); const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const s = [...fallbackSample].sort(() => rnd() - 0.5).slice(0, Number(process.env.SAMPLE));
  for (const [n, h] of s) console.log(`${n} | ${h}`); }
