/**
 * Chat-derived inputs for partner choice (RULING 2026-09-23 ~8:40 PM): reads the
 * LOCAL private chat DB (GRIDIRON_CHAT_DB_PATH, via manager-signals.js#openChatDb)
 * for one league's trusted chat identities and returns raw rows per roster that
 * partners.js#chatLabels turns into labels. Only aggregates are read
 * (manager_chat_profile, negotiation_profiles, manager_player_sentiment); no
 * message text is read or written. Optional: an absent DB or table gives
 * { status: 'unknown', reason } and every label reads 'unknown'.
 *
 * M7-TIMING: with GRIDIRON_M7_TIMING (or preview) on, each roster also gets `need_move`, the
 * number of his own 'need a move'-type messages in the last 7 days (urgency.js#isNeedMove).
 * The message text is matched here, in this process, and only the count is kept.
 */
export async function chatRowsFor(leagueId, { now = Date.now() } = {}) {
  const { m7Timing, isNeedMove, THRESHOLDS } = await import('../../server/services/campaign/urgency.js');
  const m7 = m7Timing();
  const { identityMap } = await import('../../server/services/manager-identity.js');
  const { openChatDb } = await import('../../server/services/manager-signals.js');
  const { negotiationProfilesFor } = await import('../../server/services/counterparty-pricing.js');
  const ids = identityMap(leagueId);
  if (!ids.size) return { status: 'unknown', reason: 'no confirmed chat identities for this league', rows: new Map() };
  const chat = openChatDb();
  if (!chat) return { status: 'unknown', reason: 'chat DB not found (GRIDIRON_CHAT_DB_PATH)', rows: new Map() };
  const rows = new Map();
  const missing = [];
  const tryAll = (sql, ...args) => {
    try { return chat.prepare(sql).all(...args); } catch (e) {
      if (/no such table/.test(String(e?.message))) { missing.push(sql.match(/FROM (\w+)/)?.[1]); return null; }
      throw e;
    }
  };
  try {
    for (const [rosterId, ident] of ids) {
      const profile = tryAll('SELECT * FROM manager_chat_profile WHERE name = ?', ident.chat_name)?.[0] ?? null;
      const sentiment = tryAll('SELECT player, sentiment_mean, n FROM manager_player_sentiment WHERE name = ?', ident.chat_name) ?? [];
      let need_move = null;
      if (m7.on) {
        const since = new Date(now - THRESHOLDS.need_move_days * 864e5).toISOString();
        const msgs = tryAll('SELECT text FROM messages WHERE name = ? AND ts_utc >= ? AND ts_utc <= ?',
          ident.chat_name, since, new Date(now).toISOString());
        need_move = msgs ? msgs.filter(m => isNeedMove(m.text)).length : null;
      }
      rows.set(String(rosterId), { profile, sentiment, negotiation: null, need_move });
    }
  } finally { chat.close(); }
  const neg = negotiationProfilesFor(leagueId);
  if (neg.available) for (const [rid, p] of neg.byRoster) if (rows.has(String(rid))) rows.get(String(rid)).negotiation = p.profile;
  return { status: 'ok', reason: missing.length ? `tables absent: ${[...new Set(missing)].join(', ')}` : null,
    negotiation: neg.available ? 'ok' : neg.reason, rows };
}
