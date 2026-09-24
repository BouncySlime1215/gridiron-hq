/**
 * COUNTERPART-01 inputs for the campaign producer (flag GRIDIRON_COUNTERPART=1).
 * Reads the PEOPLE-01 profiles (server/services/people/profile-reader.js, the
 * one reader of the chat DB profiles) and the league's trade rows, and builds
 * the counterpart model per manager. Off the web server, like the producer.
 */
export const flagOn = (env = process.env) => env.GRIDIRON_COUNTERPART === '1';

/** adapter: scripts/campaign/league-adapter.mjs#buildAdapter result. */
export async function counterpartsFor(svc, leagueId, adapter, { now = Date.now() } = {}) {
  const { profilesFor } = await import('../../server/services/people/profile-reader.js');
  const { buildCounterparts, tradeEvents } = await import('../../server/services/people/counterpart.js');
  const profiles = await profilesFor(leagueId, { asOf: now });
  const toMs = v => svc.tactics.toTime(v);
  const tx = svc.db.rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
                          FROM league_transactions_raw WHERE league_id = ? AND season = ?`, leagueId, adapter.league.season);
  const events = tradeEvents(tx, toMs);
  const counterparts = buildCounterparts({ profiles: profiles.byRoster, players: adapter.players, events, now,
    teams: [...adapter.managers.keys()] });
  const summary = { status: profiles.status, reason: profiles.reason, reader: profiles.version, tables: profiles.tables,
    managers: profiles.byRoster.size, known: [...counterparts.values()].filter(c => c.status === 'ok').length,
    trade_events: events.length };
  return { counterparts, summary };
}

/** One printable line per league: partner order (team ids) and top 3 targets (player names), no manager names. */
export function counterpartReport(entry, res) {
  if (!res?.partners) return `[counterpart] league ${entry.league}: no plan (${entry.error ?? 'no partners'})`;
  const names = entry.names ?? {};
  const order = res.partners.map(p => `${p.team}(${Number.isFinite(p.p_responds_before_counterpart) ? `${p.p_responds_before_counterpart.toFixed(2)}->` : ''}${p.p_responds.toFixed(2)}${p.reason_chain?.length ? `:${p.reason_chain.map(f => f.feature).join('+')}` : ''})`).join(' > ');
  const top = (res.suggestions ?? []).slice(0, 3).map(t => `${names[String(t.player)] ?? t.player} from ${t.owner}${t.reason_chain?.length ? ` [${t.reason_chain.map(f => `${f.feature}:${f.effect}`).join(',')}]` : ''}`);
  const models = (res.counterpart?.models ?? []).map(m => `${m.team}:${m.status}${m.override.status === 'ok' ? `/override(${['exclude', 'deprioritize', 'toughen'].filter(k => m.override[k]).join('+')})` : ''}`
    + `/wants=${m.wants.length}/untouchable=${m.untouchable.length}@${m.credibility.untouchable?.value?.toFixed(2) ?? '-'}/shop=${m.shopping.length}@${m.credibility.shop?.value?.toFixed(2) ?? '-'}/unresolved=${m.unresolved_names}`);
  return `[counterpart] league ${entry.league} models: ${models.join(' ')}\n[counterpart] league ${entry.league} partners: ${order}\n[counterpart] league ${entry.league} top 3 targets: ${top.join(' | ') || 'none'}`;
}
