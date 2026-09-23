// Trade Lab 'Recent news' (old playerOutlook SQL) vs the card's top 5, local copy.
// Usage: SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> node tradelab.mjs <worktree>
const WT = process.argv[2];
const { rows } = await import(`${WT}/server/db/index.js`);
const { playerNews, loadAttributionIndex } = await import(`${WT}/server/news/player-news.js`);
const index = loadAttributionIndex();
const players = rows(`SELECT id, name FROM players WHERE fantasy_relevant = 1`);
let universe = 0, differ = 0, orderOnly = 0, cardMissing = 0, tradeExtra = 0;
for (const p of players) {
  const card = playerNews(p.id, { limit: 5, index }).map(n => n.id);
  const old = rows(`SELECT id FROM news_items WHERE headline LIKE ? OR body LIKE ? ORDER BY date DESC LIMIT 5`,
    `%${p.name}%`, `%${p.name}%`).map(n => n.id);
  if (!card.length && !old.length) continue;
  universe++;
  const miss = card.filter(id => !old.includes(id)).length, extra = old.filter(id => !card.includes(id)).length;
  if (miss || extra) differ++; else if (card.join() !== old.join()) orderOnly++;
  cardMissing += miss; tradeExtra += extra;
}
console.log(JSON.stringify({ universe, before_players_set_differ: differ, before_players_order_only_differ: orderOnly, before_card_top5_missing_from_tradelab: cardMissing,
  before_tradelab_rows_not_in_card_top5: tradeExtra, after_players_differ: 'by construction 0 (playerOutlook calls playerNews; contract test 7)' }, null, 1));
