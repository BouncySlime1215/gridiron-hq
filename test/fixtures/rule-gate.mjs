/**
 * RULES-EVERYWHERE fixture: FantasyCalc values (player_metrics source 'fc_value') for a made-up league,
 * so a test about something else is not emptied by Nick's rule gate (campaign/never-give.js#ruleGate).
 *
 * The gate fails closed on a player with no fc_value and drops any idea where Nick gives more
 * FantasyCalc value than he gets. A fixture that is not about the rules prices Nick's players low
 * and everyone else high, so every idea it builds passes the value rules; the rules themselves are
 * covered by test/rules-everywhere.test.js. Made-up values only.
 *
 * db: the app's DatabaseSync handle (server/db/index.js `db`). Foreign keys are switched off for the
 * insert because a made-up league's ids need not be rows of `players`.
 */
export function priceForRules(db, { mine = [], theirs = [], mineValue = 1, theirValue = 1000 } = {}) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const put = db.prepare(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)
                            ON CONFLICT(player_id, source) DO UPDATE SET value = excluded.value`);
    for (const id of theirs) put.run(Number(id), theirValue);
    for (const id of mine) put.run(Number(id), mineValue);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Price a whole ESPN-payload league: the players on the league's own team (my_team_id), matched by
 * name as the fixtures build them, low; every other player in `players` high.
 */
export function priceLeagueForRules(db, lg) {
  const payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload;
  const team = (payload?.teams ?? []).find(t => String(t.id) === String(lg.my_team_id));
  const names = (team?.roster?.entries ?? []).map(e => e?.playerPoolEntry?.player?.fullName).filter(Boolean);
  const byName = db.prepare('SELECT id FROM players WHERE name = ?');
  const mine = names.flatMap(n => byName.all(n).map(r => r.id));
  const theirs = db.prepare('SELECT id FROM players').all().map(r => r.id).filter(id => !mine.includes(id));
  priceForRules(db, { mine, theirs });
}
