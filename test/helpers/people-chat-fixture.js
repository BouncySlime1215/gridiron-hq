/**
 * Chat-DB and app-DB fixtures for the people profile reader (PEOPLE-01).
 *
 * The real chat DB is local-only and never read by a test. Every person here is
 * a placeholder label, every profile is invented, and every stamp is fixed so
 * a golden snapshot is byte-stable.
 */
import { DatabaseSync } from 'node:sqlite';

export const LEAGUE = 41;

export function validProfile(overrides = {}) {
  return {
    headline: 'Trades a lot, rarely means no.',
    says_no: { how: 'jokes first', hard_no_looks_like: ['not happening'], soft_no_looks_like: ['eh'],
      does_his_no_hold: 'rarely', evidence: ['label: joke-then-deal'] },
    praise_means: { reading: 'marketing', why: 'praises before selling', hypes_before_selling: true,
      agrees_with_numbers: 'no', evidence: ['label: hype'] },
    techniques: [{ name: 'anchor', how_he_does_it: 'asks high', evidence: ['label: anchor'], how_often: 'often' }],
    calibration: { enthusiasm_scale: 'loud', baseline_tone: 'friendly', inflation: 'heavy' },
    roster_read: { really_untouchable: ['Player A'], quietly_available: ['Player B'], overvalues: [], undervalues: [],
      reasoning: 'talk vs numbers' },
    what_moves_him: ['a win-now piece'],
    what_shuts_him_down: ['lowballs'],
    how_to_approach: 'Lead with a fair offer after a loss.',
    best_bait: 'Player C',
    confidence: 'medium',
    caveats: ['thin corpus'],
    ...overrides,
  };
}

/** The keys the 9/23 rebuild adds. */
export const NEW_KEYS = Object.freeze({
  deal_feelings: { urgency: 'high', face: 'avoids public losses' },
  values_talk: { talks_up: ['Player A'], talks_down: ['Player D'], untouchable: ['Player A'], wants: ['RB'] },
  behaviour_vs_words: 'says he is done dealing, then counters within a day',
  changes_since_0918: ['more urgent after two losses'],
});

/**
 * The chat DB as it stands today on main's shape: no new keys, no notes, no
 * alias map. Consumers' outputs on this fixture are the golden record.
 */
export function buildTodayChat(file) {
  const chat = new DatabaseSync(file);
  chat.exec(`
    CREATE TABLE manager_chat_profile(name TEXT, msgs, group_msgs, tapbacks, night_share, p_trade_talk,
      p_trash_talk, p_non_fantasy, confidence_mean, p_competitive, p_friendly, p_defensive, p_open_to_trade,
      p_reacting_to_loss, p_own_complaining, p_own_untouchable, first_msg, last_msg, computed_at);
    CREATE TABLE manager_player_sentiment(name TEXT, player TEXT, n, sentiment_mean, share_positive,
      share_negative, first_mention, last_mention, computed_at);
    CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT,
      is_from_me INTEGER, ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
    CREATE TABLE jev_chat_signals (msg_id INTEGER NOT NULL, name TEXT, chat_kind TEXT, mentioned_player TEXT,
      question TEXT NOT NULL, probability REAL, evaluated_at TEXT NOT NULL, PRIMARY KEY (msg_id, question));
    CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
      corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
  `);
  const prof = chat.prepare(`INSERT INTO manager_chat_profile VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'2026-09-18 04:00:00')`);
  for (const p of [
    ['ME', 900, 600, 50, 0.2, 0.30, 0.2, 0.3, 2.5, 0.3, 0.5, 0.1, 0.30, 0.05, 0.05, 0.02],
    ['P-Alpha', 400, 300, 20, 0.1, 0.25, 0.3, 0.2, 2.2, 0.4, 0.4, 0.1, 0.34, 0.08, 0.10, 0.05],
    ['P-Bravo', 12, 8, 1, 0.1, 0.10, 0.2, 0.5, 2.0, 0.2, 0.5, 0.1, 0.13, 0.02, 0.03, 0.01],
    ['P-Charlie', 350, 250, 15, 0.3, 0.20, 0.1, 0.4, 2.1, 0.2, 0.6, 0.1, 0.20, 0.04, 0.04, 0.02],
  ]) prof.run(...p, '2026-01-01', '2026-09-17');
  const sent = chat.prepare(`INSERT INTO manager_player_sentiment VALUES (?,?,?,?,?,?,?,?,'2026-09-18 04:00:00')`);
  sent.run('P-Alpha', 'Player A', 6, 3.4, 0.9, 0.0, '2026-08-01', '2026-09-15');
  sent.run('P-Alpha', 'Player D', 4, 1.0, 0.0, 0.8, '2026-08-01', '2026-09-10');
  const msg = chat.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,0,0)`);
  let id = 0;
  for (let d = 1; d <= 8; d++) {
    msg.run(++id, 'group', 'League', 'h1', 'P-Alpha', 0, `2026-09-0${d}T12:00:00Z`, 'label-only fixture line');
    msg.run(++id, 'group', 'League', 'h2', 'P-Charlie', 0, `2026-09-0${d}T12:05:00Z`, 'you there?');
  }
  const np = chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`);
  np.run('P-Alpha', JSON.stringify(validProfile()), 120, 'h1', 'claude-sonnet-5', '2026-09-18 05:00:00');
  np.run('ME', JSON.stringify(validProfile({ headline: 'Sends a lot of offers.' })), 300, 'h2', 'claude-sonnet-5',
    '2026-09-18 05:50:00');
  np.run('P-Bravo', JSON.stringify(validProfile()), 12, 'h3', 'claude-sonnet-5', '2026-09-18 05:10:00');
  np.run('P-Delta', JSON.stringify(validProfile()), 80, 'h5', 'claude-sonnet-5', '2026-09-18 05:30:00');
  // Leaked tool-call markup: the 2026-09-18 failure.
  np.run('P-Charlie', JSON.stringify(validProfile({ says_no: '\n<parameter name="how">He rejects' })), 90, 'h4',
    'claude-sonnet-5', '2026-09-18 05:20:00');
  chat.close();
}

/**
 * The chat DB after the 9/23 rebuild: new keys on every profile, a
 * nick_override, Nick's notes, and an alias map.
 */
export function buildRebuiltChat(file) {
  buildTodayChat(file);
  const chat = new DatabaseSync(file);
  const put = chat.prepare('UPDATE negotiation_profiles SET profile_json = ?, model = ?, built_at = ? WHERE name = ?');
  put.run(JSON.stringify(validProfile({ ...NEW_KEYS,
    nick_override: { how_to_approach: 'Nick: open low, he always counters.', deal_feelings: { urgency: 'low' } } })),
  'claude-code-local', '2026-09-23 22:00:00', 'P-Alpha');
  put.run(JSON.stringify(validProfile({ ...NEW_KEYS })), 'claude-code-local', '2026-09-23 22:05:00', 'ME');
  // Charlie is rebuilt clean, but under the alias the chat uses for him.
  chat.exec(`DELETE FROM negotiation_profiles WHERE name = 'P-Charlie'`);
  chat.prepare(`INSERT INTO negotiation_profiles VALUES (?,?,?,?,?,?)`).run('Charlie-nick',
    JSON.stringify(validProfile({ values_talk: NEW_KEYS.values_talk })), 200, 'h6', 'claude-code-local',
    '2026-09-23 22:10:00');
  chat.exec(`
    CREATE TABLE manager_notes (name TEXT, field TEXT, note TEXT, written_at TEXT);
    CREATE TABLE entity_map (alias TEXT, canonical TEXT, in_league INTEGER);
  `);
  const note = chat.prepare('INSERT INTO manager_notes VALUES (?,?,?,?)');
  note.run('P-Alpha', 'how_to_approach', 'note: be direct', '2026-09-17');
  note.run('P-Alpha', 'best_bait', 'note: a young WR', '2026-09-17');
  note.run('P-Alpha', null, 'note: old roommate', '2026-09-17');
  note.run('Charlie-nick', 'what_moves_him', 'note: rapport', '2026-09-17');
  const alias = chat.prepare('INSERT INTO entity_map VALUES (?,?,?)');
  alias.run('Charlie-nick', 'P-Charlie', 1);
  alias.run('Outsider', 'Outsider Full', 0);
  chat.close();
}

/** League 41: Nick on roster 1, four trusted people, one person only `likely`. */
export function seedLeague(run) {
  const member = (id, first) => ({ id, firstName: first, lastName: 'X', displayName: first });
  const team = (id, owner) => ({ id, name: `Team ${id}`, owners: [owner], currentProjectedRank: id,
    draftDayProjectedRank: id, roster: { entries: [] },
    record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, streakType: 'WIN',
      streakLength: 0 } } });
  const owners = ['{M1}', '{M2}', '{M3}', '{M4}', '{M5}'];
  const payload = { seasonId: 2026, scoringPeriodId: 2, schedule: [],
    members: owners.map((o, i) => member(o, `M${i + 1}`)), teams: owners.map((o, i) => team(i + 1, o)) };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', 'espn-people-41', 2026, 'L41', ?, 5, '1', '[]', 's2', 'swid', 'connected')`,
  LEAGUE, JSON.stringify(payload));
  run(`INSERT INTO league_member_identity (league_id, roster_id, espn_member_id, espn_name, team_name, chat_name,
       match_method, confidence) VALUES
     (41, '1', '{M1}', 'M1', 'Team 1', 'ME', 'confirmed by Nick', 'confirmed'),
     (41, '2', '{M2}', 'M2', 'Team 2', 'P-Alpha', 'confirmed by Nick', 'confirmed'),
     (41, '3', '{M3}', 'M3', 'Team 3', 'P-Bravo', 'confirmed by Nick', 'confirmed'),
     (41, '4', '{M4}', 'M4', 'Team 4', 'P-Charlie', 'confirmed by Nick', 'confirmed'),
     (41, '5', '{M5}', 'M5', 'Team 5', 'P-Delta', 'surname', 'likely')`);
  // A fixed stamp: counterpartyDataKey folds it into the cache key.
  run(`UPDATE league_member_identity SET updated_at = '2026-09-18 03:00:00' WHERE league_id = 41`);
}
