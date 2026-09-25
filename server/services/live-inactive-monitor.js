/**
 * Live gameday inactives from public Bluesky posts (RL-3-2, plan item SS-01). Overlaps nfl_news_signals "out" (nfl-news-signal.js STATUS_RULES); see the tdd doc, section 9 item 9.
 *
 * The only inactive list the app had before this was nflverse's weekly roster
 * snapshot (nfl-event-archive.js:191, `source: 'nflverse_weekly_rosters'`). That file
 * is published after the week, so it serves backtests and cannot warn on a Sunday.
 * This module is the in-week producer. It reads a curated set of public Bluesky
 * accounts (Rotoworld plus beat and national reporters) through Jetstream, keeps only
 * definitive per-player "inactive" / "active" statements, and writes them to
 * `live_inactive_claims` (migration 093). availability-claims.js reads them beside
 * nfl_news_signals (one reader, FIX-184-6), and lineup-brain.js `lineupCall` flags a
 * starter from that one set, both under "Check before kickoff" and on the SS-01
 * dead-starter card (FIX-184-2). The switch is live-inactive-flag.js.
 *
 * Terms (copies in the research lane, fetched 2026-09-23; quoted in
 * docs/tdd/2026-09-23-live-inactive-monitor.tdd.md):
 *   - Jetstream: "No authentication is required for the live tail".
 *   - Bluesky Developer Guidelines: they restrict automated *interactions*. This
 *     module only reads, and has no account or key. It honours deletions as a
 *     retraction.
 *   - Nothing is paid.
 *   - Content: only claim fields and the at:// URI are stored, never the post
 *     text. The page links out.
 *
 * Research basis: rnd/loop/r3-external-live-inactives-bluesky.md.
 *   - The Bluesky set carried a correct pre-kickoff "not playing" for 23 of 38
 *     fantasy-relevant 2026 W1-W2 non-players, vs 9 for the ESPN news feed.
 *   - Raw regex on those posts made 10 wrong-direction claims. So the parser here
 *     works clause by clause, matches full names only, and refuses anything
 *     ambiguous.
 */
import { rows, run, db } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { gameCutoff } from './game-cutoff.js';

export const PARSER_VERSION = 'live-inactive-v1';
export const JETSTREAM_HOST = 'jetstream.us-east.bsky.network';
const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents';
const POST_COLLECTION = 'app.bsky.feed.post';

/**
 * Watched accounts: the research lane's re-verified active list
 * (rnd/loop/data/r3x/active_dids.json, 19 DIDs). Jetstream filters by DID on the
 * server, so only these accounts' posts ever arrive.
 */
export const WATCHED_ACCOUNTS = Object.freeze(new Map([
  ['did:plc:hlvr2omhnmvdmfnvmcuhyevz', 'rapsheet.bsky.social'],
  ['did:plc:wyd67i6kjxrsvw5cs776uhe6', 'tompelissero.bsky.social'],
  ['did:plc:lbe3b7ce6n7oa6cbl5jwoifo', 'rotoworld-fb.bsky.social'],
  ['did:plc:m7tlp67tcwsgcb6hohude736', 'darrenurban.bsky.social'],
  ['did:plc:i2si7mykbsiytkurgvu2jy66', 'salmaiorana.bsky.social'],
  ['did:plc:hthxyokkw7fxqsrln44gryep', 'daringantt.bsky.social'],
  ['did:plc:atgji34mbfn4yifmy2lnp43e', 'kfishbain.bsky.social'],
  ['did:plc:67wqxhsm6tmbsfjucvhakvnt', 'troyrenck.bsky.social'],
  ['did:plc:vxepewu7h32igypmgy76nr7g', 'andyhermannfl.bsky.social'],
  ['did:plc:6gxldxcweqmf3lytxx7ddipp', 'aaronwilsonnfl.bsky.social'],
  ['did:plc:7hygc7jytj5skvqxr25ceguw', 'demetrius.bsky.social'],
  ['did:plc:urmecjxntv66h7vvmygvano7', 'mattderrick.bsky.social'],
  ['did:plc:eg6pz6xjlbl2k4h6l3p3honm', 'jourdanrodrigue.bsky.social'],
  ['did:plc:t26jvrzxztv7jqnzcqce6nzh', 'victafur.bsky.social'],
  ['did:plc:bgdq5f65djok5tnfc6tikptz', 'tashanreed.bsky.social'],
  ['did:plc:kpja25hrau36cr7xvttgbk2x', 'bengoessling.bsky.social'],
  ['did:plc:mjyr52xn3im6qldhgbbkorke', 'mikereiss.bsky.social'],
  ['did:plc:uw574hihkaxbnclfaitevawa', 'nickunderhill.bsky.social'],
  ['did:plc:7xfewi7h5prilx7rax75wypr', 'gregauman.bsky.social']
]));

// ---------------------------------------------------------------------------
// Parsing: one clause at a time, definitive statements only.
// ---------------------------------------------------------------------------

/** "is not active", "won't be active": a negated active is an inactive. */
const NEGATED_ACTIVE_RE = /\b(?:not|n't)\s+(?:be\s+)?active\b/i;
/**
 * "is out" only when it ends the thought or is followed by a game word. So "Kirk
 * Cousins is out on the field early" and "the injury report is out and ..." are not
 * claims. Both were false flags in the 2024 replay before this rule.
 */
const INACTIVE_RE = /\b(?:inactives?|ruled out|will not play|won'?t play|not playing|will sit|healthy scratch|scratched|(?:is|are)\s+(?:officially\s+|both\s+|all\s+)*out(?=\s*(?:[.,;:!)]|$)|\s+(?:for|vs\.?|against|today|tonight|sunday|monday|thursday|saturday|with)\b))/i;
const ACTIVE_RE = /\b(?:actives?|(?:is|are)\s+(?:officially\s+|both\s+|all\s+)*up\b|will play|(?:is|are) playing|expected to play|good to go|will suit up)\b/i;
/** A clause about an earlier game ("was inactive last week") is not a claim about this one. */
const PAST_RE = /\b(?:was|were)\s+(?:\w+\s+)?(?:inactive|out|active)\b|\blast (?:week|sunday|game|season|year)\b|\bprevious(?:ly)?\b/i;
/**
 * A hedge is not a status. "trending towards not playing", "not sure if X will play",
 * "likely out", "expected to play": each reads as a definitive word inside a guess, and
 * the reader keeps the LATEST claim, so a hedged 'active' after a real "ruled out" would
 * silently remove the warning. Refused in both directions. Injury designations
 * (questionable, doubtful) are NOT hedges: "Questionable WR X is inactive" is the very
 * post this monitor exists for.
 */
const HEDGE_RE = /\b(?:trending|expect(?:s|ed|ing)?|(?:un)?likely|probabl[ey]|not sure|unsure|uncertain|unclear|game[- ]time|hop(?:e|es|ed|ing|eful)|might|may|could|possibly|if|whether|should)\b/i;
/** "not expected to play", "isn't good to go": a negated active word is not an active claim. */
const NEGATED_ACTIVE_WORD_RE = /(?:\bnot|\bnever|n't)\s+(?:\w+\s+){0,2}$/i;
/**
 * The mirror (FIX-184-4): "has not been ruled out", "isn't ruled out", "is not inactive",
 * "will not be scratched". A negation in the two words before an INACTIVE phrase refuses
 * the clause. Phrases that carry their own "not" ("will not play", "not playing") match
 * INACTIVE_RE from the "not" itself, so nothing before them is negated and they still
 * claim.
 */
const NEGATED_INACTIVE_WORD_RE = NEGATED_ACTIVE_WORD_RE;
/** "..., as is <player>" carries the previous clause's status over. */
const INHERIT_RE = /^as\s+(?:is|are|was|were)\b/i;

/**
 * Sentences, then clauses.
 *   - Sentence ends need two lower-case letters or digits before the stop, so
 *     "A.J." and "Jr." never split a name.
 *   - Clause breaks are line breaks, semicolons, and a comma followed by
 *     while / but / whereas / as is, so "X is inactive, while Y is up" is two
 *     claims.
 */
function clausesOf(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\n+/)) {
    for (const sentence of line.split(/(?<=[a-z0-9)]{2}[.!?])\s+/)) {
      for (const part of sentence.split(/;\s*|,\s*(?=(?:while|but|whereas|as (?:is|are|was|were))\b)/i)) {
        const clause = part.replace(/^[\s\-–—•*]+/, '').replace(/^(?:while|but|whereas)\s+/i, '').trim();
        if (clause) out.push(clause);
      }
    }
  }
  return out;
}

/**
 * [{clause, status: 'inactive'|'active'|null, at, end}] for a block of post text.
 * `at`/`end` bound the status phrase inside the clause (null when inherited), so the
 * name binding in claimsFromPost can tell which side of the verb a name sits on.
 */
export function parseStatusClauses(text) {
  const out = [];
  let prev = null;
  for (const clause of clausesOf(text)) {
    let status = null, m = null;
    if (PAST_RE.test(clause) || HEDGE_RE.test(clause)) status = null;
    else if ((m = NEGATED_ACTIVE_RE.exec(clause))) status = 'inactive';
    else {
      const mi = INACTIVE_RE.exec(clause);
      // "inactive" never matches ACTIVE_RE (no word boundary inside it), so a clause
      // that matches both genuinely holds both words, as a header like
      // "Actives/inactives:" does. Refused rather than guessed.
      let ma = ACTIVE_RE.exec(clause);
      // A negated active word is refused outright rather than flipped to inactive:
      // "not good to go" is closer to a hedge than to "ruled out".
      if ((ma && NEGATED_ACTIVE_WORD_RE.test(clause.slice(0, ma.index)))
        || (mi && NEGATED_INACTIVE_WORD_RE.test(clause.slice(0, mi.index)))) {
        out.push({ clause, status: null, at: null, end: null }); prev = null; continue;
      }
      if (mi && !ma) { status = 'inactive'; m = mi; }
      else if (ma && !mi) { status = 'active'; m = ma; }
      else if (!mi && !ma && INHERIT_RE.test(clause)) status = prev;
    }
    out.push({ clause, status, at: m ? m.index : null, end: m ? m.index + m[0].length : null });
    prev = status;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name resolution against the player table. Full names only, via the shared
// normalizePlayerName (player-identity.js:27), the same casefold textMentionsFullName
// uses. A name shared by several teamed players needs a team nickname in the post.
// ---------------------------------------------------------------------------

const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

/** {byName: Map(normName -> [player]), nicknames: Map(nickname -> team_id)} from players + nfl_teams. */
export function loadPlayerIndex() {
  const byName = new Map();
  const list = rows(`SELECT p.id, p.name, p.position, p.team_id FROM players p
                      WHERE p.team_id IS NOT NULL AND p.position IN (${FANTASY_POSITIONS.map(() => '?').join(',')})`,
  ...FANTASY_POSITIONS);
  for (const p of list) {
    const key = normalizePlayerName(p.name);
    if (!key.includes(' ')) continue; // no last name to disambiguate on
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }
  const nicknames = new Map();
  for (const t of rows('SELECT id, name FROM nfl_teams')) {
    const nick = normalizePlayerName(String(t.name).split(/\s+/).pop());
    if (nick) nicknames.set(nick, t.id);
  }
  let maxTokens = 2;
  for (const key of byName.keys()) maxTokens = Math.max(maxTokens, key.split(' ').length);
  return { byName, nicknames, maxTokens };
}

/**
 * Players named in one clause. Longest match first, and tokens are consumed, so
 * "Marvin Harrison Jr." never also matches a shorter name inside it.
 */
function playersInClause(clause, index, postTeamIds) {
  const tokens = normalizePlayerName(clause).split(' ').filter(Boolean);
  const clauseTeams = new Set(tokens.map(t => index.nicknames.get(t)).filter(v => v != null));
  const used = new Array(tokens.length).fill(false);
  const found = [];
  for (let n = Math.min(index.maxTokens, tokens.length); n >= 2; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const cands = index.byName.get(tokens.slice(i, i + n).join(' '));
      if (!cands) continue;
      let pick = cands.length === 1 ? cands[0] : null;
      if (!pick) {
        // Clause-level hint first ("Raiders WR Mike Williams"), then post-level.
        for (const hint of [clauseTeams, postTeamIds]) {
          const hit = cands.filter(c => hint.has(c.team_id));
          if (hit.length === 1) { pick = hit[0]; break; }
        }
      }
      for (let k = i; k < i + n; k++) used[k] = true;
      if (pick) found.push(pick); // an unresolved shared name is refused, not guessed
    }
  }
  return found;
}

/**
 * Claims in one post: [{player_id, player_name, status}].
 *   - The post text and its link card's title and description are all read.
 *     Rotoworld headlines carry last names only; the card carries the full name.
 *   - One claim per player per post. If a post says both things about the same
 *     player, it is refused.
 */
export function claimsFromPost({ text, embedTitle = null, embedDescription = null }, index = loadPlayerIndex()) {
  const blocks = [text, embedTitle, embedDescription].filter(Boolean);
  const postTokens = normalizePlayerName(blocks.join(' ')).split(' ');
  const postTeamIds = new Set(postTokens.map(t => index.nicknames.get(t)).filter(v => v != null));
  const byPlayer = new Map();
  for (const block of blocks) {
    for (const { clause, status, at, end } of parseStatusClauses(block)) {
      if (!status) continue;
      // Bind the verb to the names BEFORE it ("A and B are both inactive", "Broncos
      // declared A, B inactive"). Only when none precede it do names after it count
      // ("The Bills ruled out WR A", "Inactives: A, B"). Otherwise "With A ruled out,
      // it'll be up to B" flagged B, a 2024 replay false flag.
      let named = at == null ? playersInClause(clause, index, postTeamIds)
        : playersInClause(clause.slice(0, at), index, postTeamIds);
      if (at != null && !named.length) named = playersInClause(clause.slice(end), index, postTeamIds);
      for (const p of named) {
        const prior = byPlayer.get(p.id);
        if (prior && prior.status !== status) prior.conflict = true;
        else if (!prior) byPlayer.set(p.id, { player_id: p.id, player_name: p.name, status });
      }
    }
  }
  return [...byPlayer.values()].filter(c => !c.conflict).map(({ conflict, ...c }) => c);
}

// ---------------------------------------------------------------------------
// Jetstream events -> rows.
// ---------------------------------------------------------------------------

/** Jetstream v2 wraps the event in `payload`; v1 puts it at top level under `commit`. */
function normaliseEvent(evt) {
  const e = evt?.payload ?? evt;
  if (!e?.did) return null;
  const c = e.commit ?? e;
  const time = e.time ?? (e.time_us ? new Date(Math.floor(e.time_us / 1000)).toISOString() : null);
  return { did: e.did, operation: c.operation, collection: c.collection, rkey: c.rkey, record: c.record ?? null, time };
}

export const postUri = (did, rkey) => `at://${did}/${POST_COLLECTION}/${rkey}`;
/** The public link for a stored URI. The page links out rather than showing post text. */
export function postUrl(uri) {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(String(uri ?? ''));
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

const upsert = () => db.prepare(`INSERT INTO live_inactive_claims
  (source_uri, player_id, player_name, status, season, week, source_handle, source_did, posted_at, first_seen_at, parser_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_uri, player_id) DO UPDATE SET status = excluded.status, parser_version = excluded.parser_version`);

/** Writer for `live_inactive_claims` (migration 093). The only one. */
export function recordClaim(c) {
  upsert().run(c.source_uri, c.player_id, c.player_name, c.status, c.season, c.week,
    c.source_handle, c.source_did, c.posted_at ?? null, c.first_seen_at, PARSER_VERSION);
}

/**
 * One Jetstream event. Returns {recorded, retracted, skipped}.
 *   - `season`/`week` stamp the claim with the week the app is deciding. That is
 *     tradeWeekContext(), the same context lineupCall reads, so writer and reader
 *     agree by construction.
 *   - Unwatched accounts, non-post collections and posts with no definitive claim
 *     are skipped.
 */
export function ingestJetstreamEvent(evt, { season, week, index = null } = {}) {
  const e = normaliseEvent(evt);
  if (!e || e.collection !== POST_COLLECTION) return { recorded: 0, retracted: 0, skipped: 'not a post event' };
  const handle = WATCHED_ACCOUNTS.get(e.did);
  if (!handle) return { recorded: 0, retracted: 0, skipped: 'account not watched' };
  const uri = postUri(e.did, e.rkey);
  if (e.operation === 'delete') {
    const r = run('UPDATE live_inactive_claims SET retracted_at = ? WHERE source_uri = ? AND retracted_at IS NULL',
      e.time ?? new Date().toISOString(), uri);
    return { recorded: 0, retracted: Number(r.changes ?? 0) };
  }
  if (e.operation !== 'create' && e.operation !== 'update') return { recorded: 0, retracted: 0, skipped: `operation ${e.operation}` };
  if (!Number.isFinite(season) || !Number.isFinite(week)) return { recorded: 0, retracted: 0, skipped: 'no current NFL week' };
  const ext = e.record?.embed?.external ?? e.record?.embed?.media?.external ?? null;
  const claims = claimsFromPost({ text: e.record?.text, embedTitle: ext?.title, embedDescription: ext?.description },
    index ?? loadPlayerIndex());
  const firstSeen = e.time ?? new Date().toISOString();
  for (const c of claims) {
    recordClaim({ ...c, source_uri: uri, season, week, source_handle: handle, source_did: e.did,
      posted_at: e.record?.createdAt ?? null, first_seen_at: firstSeen });
  }
  return { recorded: claims.length, retracted: 0 };
}

/**
 * Map(player_id -> latest PRE-KICKOFF live claim, either status) for one week.
 *   - Retracted claims are dropped.
 *   - Ordered by the time the claim reached this system (Jetstream's clock), then by
 *     the author's own timestamp.
 *   - FIX-184-5b: a claim first seen at or after the player's own kickoff
 *     (game-cutoff.js#gameCutoff, from game_lines) is dropped before "latest" is
 *     chosen, so a post-game "was active" cannot cancel a pre-kickoff "inactive", and a
 *     post-kickoff "inactive" is not a warning. No kickoff on file: the claim is kept.
 * `kickoffOf(team_abbr) -> ISO | null` is injectable; the default is gameCutoff.
 */
export function liveClaimsLatest({ season, week, kickoffOf = null }) {
  const kickoffs = new Map();
  const kickoff = abbr => {
    if (!abbr) return null;
    if (!kickoffs.has(abbr)) kickoffs.set(abbr, (kickoffOf ?? (t => gameCutoff(season, week, t)))(abbr));
    return kickoffs.get(abbr);
  };
  const latest = new Map();
  for (const r of rows(`SELECT c.player_id, c.player_name, c.status, c.source_handle, c.source_uri, c.posted_at,
                               c.first_seen_at, t.abbr AS team_abbr
                          FROM live_inactive_claims c
                          LEFT JOIN players p ON p.id = c.player_id
                          LEFT JOIN nfl_teams t ON t.id = p.team_id
                         WHERE c.season = ? AND c.week = ? AND c.retracted_at IS NULL
                         ORDER BY c.first_seen_at, c.posted_at`, season, week)) {
    const k = kickoff(r.team_abbr);
    if (k != null && !(Date.parse(r.first_seen_at) < Date.parse(k))) continue;
    latest.set(r.player_id, { ...r, kickoff: k });
  }
  return latest;
}

/**
 * Reader: Map(player_id -> latest pre-kickoff live claim) for one week, whose status
 * is 'inactive'. A later 'active' claim from any watched account cancels an earlier
 * 'inactive'. Start/Sit reads these through availability-claims.js, which also weighs
 * nfl_news_signals.
 */
export function liveInactiveClaims({ season, week, kickoffOf = null }) {
  const latest = liveClaimsLatest({ season, week, kickoffOf });
  for (const [id, r] of latest) if (r.status !== 'inactive') latest.delete(id);
  return latest;
}

// ---------------------------------------------------------------------------
// The scheduled poll: a short replay-then-close, not a standing socket.
// ---------------------------------------------------------------------------

/** Jetstream v2 subscribe URL for the watched accounts, replaying from `cursorUs` (unix microseconds). */
export function subscribeUrl(cursorUs) {
  const u = new URL(`wss://${JETSTREAM_HOST}${SUBSCRIBE_PATH}`);
  u.searchParams.append('collections', POST_COLLECTION);
  for (const did of WATCHED_ACCOUNTS.keys()) u.searchParams.append('dids', did);
  u.searchParams.set('kinds', 'commit');
  if (cursorUs != null) u.searchParams.set('cursor', String(cursorUs));
  return u.toString();
}

/**
 * Connect, replay the last `lookbackMinutes` of the watched accounts' posts, ingest,
 * and close once the stream has been idle for `idleMs` (or at `timeoutMs`).
 *   - The scheduler runs this every few minutes. Replaying an overlapping window
 *     each time is safe, because rows are keyed on the at:// URI.
 *   - A scheduler gap longer than the lookback loses posts in between. That is a
 *     known defect, stated in the evidence file.
 */
export function pollJetstream({ WebSocketImpl = globalThis.WebSocket, now = Date.now(), lookbackMinutes = 30,
  idleMs = 4000, timeoutMs = 25_000, season, week } = {}) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve({ recorded: 0, events: 0, skipped: 'no WebSocket in this runtime' });
  const cursorUs = (now - lookbackMinutes * 60_000) * 1000;
  const index = loadPlayerIndex();
  return new Promise(resolve => {
    const out = { recorded: 0, retracted: 0, events: 0, errors: 0 };
    let idleTimer = null, done = false;
    const ws = new WebSocketImpl(subscribeUrl(cursorUs), ['xrpc.v1.json']);
    const finish = reason => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer); clearTimeout(hardTimer);
      try { ws.close(); } catch (e) { out.close_error = String(e?.message ?? e); }
      resolve({ ...out, ended: reason });
    };
    const hardTimer = setTimeout(() => finish('timeout'), timeoutMs);
    const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish('idle'), idleMs); };
    ws.addEventListener('open', armIdle);
    ws.addEventListener('message', m => {
      armIdle();
      out.events++;
      let evt;
      try { evt = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); }
      catch (e) { out.errors++; out.last_error = `unparseable frame: ${e.message}`; return; }
      const r = ingestJetstreamEvent(evt, { season, week, index });
      out.recorded += r.recorded; out.retracted += r.retracted ?? 0;
    });
    ws.addEventListener('error', e => { out.errors++; out.last_error = String(e?.message ?? 'socket error'); finish('error'); });
    ws.addEventListener('close', () => finish('closed'));
  });
}
