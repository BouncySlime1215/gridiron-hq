/**
 * One news-attribution producer: which players a story is about, and so which
 * stories are about a player.
 *
 * The player card (routes/players.js, also the AI Buy/Sell facts) used to run
 * its own substring LIKE on the name while the News desk (routes/news.js) read
 * the ingest's resolved ids, so the two disagreed about the same player. Both
 * now read `attributeStory`, and `playerNews` is defined by it: a story is on a
 * player's card exactly when the News page links that story to him.
 *
 * A story is about a player when
 *  1. the ingest resolved it to his id (`news_items.entities_json.players`,
 *     written by upsertNormalizedNewsItem server/news/store.js:33,
 *     insertArticles server/routes/espn.js:197, backfillNewsEntities
 *     server/routes/espn.js:214), or
 *  2. the headline carries his family name (generational suffix dropped, so
 *     "Pittman Jr." is "Pittman", never "Jr.") as a whole word, the story is
 *     about his team (its team_id, or his team's name in the headline), no
 *     other fantasy-relevant player on that team shares the family name, the
 *     story was not already resolved to a same-surname player, and the word
 *     before the name is not some other first name ("Quinnen Williams").
 * Read-time only: nothing is written, no migration.
 */
import { row, rows } from '../db/index.js';
import { normalizePlayerName } from '../services/player-identity.js';

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
const POSITION_WORDS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'P', 'FB', 'OL', 'OT', 'OG', 'C', 'DL', 'DE', 'DT',
  'EDGE', 'LB', 'ILB', 'OLB', 'CB', 'S', 'DB', 'LS']);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Michael Pittman Jr." -> { first: "Michael", family: "Pittman" }; "Amon-Ra St. Brown" -> family "St. Brown". */
function nameParts(name) {
  const tokens = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && SUFFIX.test(tokens[tokens.length - 1])) tokens.pop();
  return { first: tokens[0] ?? '', family: tokens.length > 1 ? tokens.slice(1).join(' ') : '' };
}

function parseEntities(value) {
  if (!value) return { players: [], teams: [] };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { players: [], teams: [] };
  } catch (error) {
    // A malformed entities_json carries no resolved players; the surname rule still runs.
    return { players: [], teams: [], parse_error: error.message };
  }
}

/** Players and teams the attribution rules need; load once per request. */
export function loadAttributionIndex() {
  const teams = rows('SELECT id, name, abbr FROM nfl_teams');
  const players = rows(`SELECT id, name, team_id FROM players
    WHERE fantasy_relevant = 1 AND team_id IS NOT NULL AND COALESCE(phase, '') <> 'historical'`);
  const teamWords = new Set();
  const teamPatterns = teams.map(team => {
    for (const word of String(team.name ?? '').split(/\s+/)) if (word) teamWords.add(word);
    if (team.abbr) teamWords.add(team.abbr);
    const nickname = String(team.name ?? '').split(/\s+/).pop();
    const parts = [team.name, nickname].filter(Boolean).map(escapeRegex);
    return { id: Number(team.id), pattern: new RegExp(`(^|[^A-Za-z])(${parts.join('|')})(?![A-Za-z])`) };
  });
  const byTeam = new Map();
  const teamOf = new Map(players.map(player => [Number(player.id), Number(player.team_id)]));
  for (const player of players) {
    const { first, family } = nameParts(player.name);
    if (family.replace(/[^A-Za-z]/g, '').length < 3) continue;
    const key = normalizePlayerName(family);
    const team = byTeam.get(Number(player.team_id)) ?? new Map();
    const list = team.get(key) ?? [];
    list.push({ id: Number(player.id), name: player.name, first, family, key });
    team.set(key, list);
    byTeam.set(Number(player.team_id), team);
  }
  return { teamWords, teamPatterns, byTeam, teamOf };
}

function storyTeams(story, index) {
  const ids = new Set();
  if (story.team_id != null) ids.add(Number(story.team_id));
  const headline = String(story.headline ?? '');
  for (const team of index.teamPatterns) if (team.pattern.test(headline)) ids.add(team.id);
  return ids;
}

function precederAllows(headline, at, candidate, index) {
  const before = headline.slice(0, at).trimEnd();
  if (!before) return true;
  if (/[:;,!?"(—–-]$/.test(before)) return true;
  const word = before.split(/\s+/).pop().replace(/['’]s?$/, '');
  if (!word || !/^[A-Z]/.test(word)) return true;
  return POSITION_WORDS.has(word) || index.teamWords.has(word) || word === candidate.first;
}

function surnameMention(headline, candidate, index) {
  const pattern = new RegExp(`(^|[^A-Za-z])(${escapeRegex(candidate.family)})(?:['’]s?)?(?![A-Za-z])`, 'g');
  for (const match of headline.matchAll(pattern)) {
    if (precederAllows(headline, match.index + match[1].length, candidate, index)) return true;
  }
  return false;
}

/**
 * The players a story is about: [{ id, name, confidence, method }], resolved
 * ids first (deduplicated by normalised name, preferring the one on the
 * story's team), then surname matches (method 'surname_team').
 */
export function attributeStory(story, index) {
  const teams = storyTeams(story, index);
  const byName = new Map();
  for (const player of parseEntities(story.entities_json).players ?? []) {
    if (player?.id == null) continue;
    const key = normalizePlayerName(player.name);
    const existing = byName.get(key);
    if (!existing) { byName.set(key, player); continue; }
    const onTeam = candidate => teams.has(index.teamOf.get(Number(candidate.id)));
    if (!onTeam(existing) && onTeam(player)) byName.set(key, player);
  }
  const attributed = [...byName.values()].map(player => ({ ...player, id: Number(player.id) }));
  const taken = new Set(attributed.map(player => player.id));
  const resolvedFamilies = new Set(attributed.map(player => normalizePlayerName(nameParts(player.name).family)).filter(Boolean));
  const headline = String(story.headline ?? '');
  for (const teamId of teams) {
    for (const [key, list] of index.byTeam.get(teamId) ?? []) {
      if (list.length !== 1) continue;
      const [candidate] = list;
      if (taken.has(candidate.id) || resolvedFamilies.has(key)) continue;
      if (!surnameMention(headline, candidate, index)) continue;
      attributed.push({ id: candidate.id, name: candidate.name, confidence: 0.6, method: 'surname_team' });
      taken.add(candidate.id);
    }
  }
  return attributed;
}

/**
 * The stories about one player, newest published first (the News desk's
 * ordering), each exactly a story whose `attributeStory` includes him.
 */
export function playerNews(playerId, { limit = 10, index = loadAttributionIndex() } = {}) {
  const player = row('SELECT id, name, team_id FROM players WHERE id = ?', playerId);
  if (!player) return [];
  const id = Number(player.id);
  const { family } = nameParts(player.name);
  // SQL is only a superset prefilter (his id in the resolved JSON, or his family
  // name anywhere in the headline); attributeStory decides.
  const candidates = rows(`SELECT n.*, t.abbr AS team_abbr FROM news_items n
      LEFT JOIN nfl_teams t ON t.id = n.team_id
      WHERE n.entities_json LIKE ? OR n.entities_json LIKE ? OR (? <> '' AND n.headline LIKE ?)
      ORDER BY COALESCE(n.published_at, n.date) DESC, n.id DESC`,
    `%"id":${id},%`, `%"id":${id}}%`, family, `%${family}%`);
  return candidates.filter(story => attributeStory(story, index).some(p => p.id === id)).slice(0, limit);
}
