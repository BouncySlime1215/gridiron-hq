/**
 * Chat-derived inputs for partner choice (RULING 2026-09-23 ~8:40 PM): reads the
 * LOCAL private chat DB (GRIDIRON_CHAT_DB_PATH, via manager-signals.js#openChatDb)
 * for one league's trusted chat identities and returns raw rows per roster that
 * partners.js#chatLabels turns into labels. Only aggregates are read
 * (manager_chat_profile, negotiation_profiles, manager_player_sentiment); no
 * message text is read or written. Optional: an absent DB or table gives
 * { status: 'unknown', reason } and every label reads 'unknown'.
 *
 * FIX-02c: each roster's row also carries `nick`, Nick's own read (nick_override +
 * manager_notes, server/services/people/nick-block.js). partners.js applies it over
 * every chat-derived label; `nick_status` says whether it could be read.
 */
export async function chatRowsFor(leagueId) {
  const { identityMap } = await import('../../server/services/manager-identity.js');
  const { openChatDb } = await import('../../server/services/manager-signals.js');
  const { negotiationProfilesFor } = await import('../../server/services/counterparty-pricing.js');
  const { nickBlocksFrom } = await import('../../server/services/people/nick-block.js');
  const ids = identityMap(leagueId);
  if (!ids.size) return { status: 'unknown', reason: 'no confirmed chat identities for this league', rows: new Map() };
  const chat = openChatDb();
  if (!chat) return { status: 'unknown', reason: 'chat DB not found (GRIDIRON_CHAT_DB_PATH)', rows: new Map() };
  const rows = new Map();
  const missing = [];
  let nick;
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
      rows.set(String(rosterId), { profile, sentiment, negotiation: null, nick: null });
    }
    nick = nickBlocksFrom(chat, ids);
    for (const [rid, block] of nick.byRoster) if (rows.has(rid)) rows.get(rid).nick = block;
  } finally { chat.close(); }
  const neg = negotiationProfilesFor(leagueId);
  if (neg.available) for (const [rid, p] of neg.byRoster) if (rows.has(String(rid))) rows.get(String(rid)).negotiation = p.profile;
  return { status: 'ok', reason: missing.length ? `tables absent: ${[...new Set(missing)].join(', ')}` : null,
    negotiation: neg.available ? 'ok' : neg.reason,
    nick_status: nick.status, nick_reason: nick.reason, nick_rosters: nick.byRoster.size, rows };
}
