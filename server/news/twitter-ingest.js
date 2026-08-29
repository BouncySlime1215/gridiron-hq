/**
 * NFL insider tweets, fed through the SAME normalize/typed-extraction
 * pipeline as RSS — not a parallel one.
 *
 * Beat reporters routinely break injury/role news hours before it reaches an
 * official practice report. That is genuinely information a numeric model
 * cannot reach on its own — the whole reason this exists. But a raw tweet is
 * just more prose, and prose alone was the original News-page problem this
 * session already fixed once (generic AI blurbs with no verifiable claim).
 * So a tweet is treated as exactly one more `news_items` row: it goes through
 * `normalizeNewsItem` for entity resolution and dedup, then through the
 * EXISTING typed extractor (`nfl-news-signal.js`) for a verbatim-evidence-span
 * claim — never a sentiment score, never a number derived straight from tweet
 * text. A tweet earns exactly as much trust as an ESPN story with the same
 * words, no more.
 *
 * Source list is curated to accounts with an actual record of breaking real
 * NFL news, not a keyword search of the whole platform — searching "NFL
 * injury" unfiltered would mostly return reactions and jokes, at real cost
 * per read.
 */
import { searchRecentTweets, twitterSpendStatus, hasKey } from '../services/twitterapi-io.js';
import { normalizeNewsItem } from './normalize.js';
import { upsertNormalizedNewsItem } from './store.js';
import { loadIdentity } from './ingest.js';
import { row } from '../db/index.js';
import { watchTweetForLineMove } from '../services/nfl-tweet-line-correlation.js';

/**
 * National insiders — verified live (not from training-data memory) before
 * being wired into a paid pipeline. `AdamCaplan` was dropped: research
 * turned up several candidate handles (@adamcaplan, @caplannfl, @Adcaplan,
 * @AdMasterCaplan) with no single one clearly the real, current account —
 * better to skip a source than pay to ingest the wrong person's tweets.
 * `TomPelissero` and `MikeGarafolo` are kept (handles confirmed live) but
 * flagged: as of the 2026 ESPN/NFL Network consolidation, Pelissero's
 * outlet affiliation is reported to have changed and Garafolo's new deal
 * was unconfirmed at verification time — their reporting may be less
 * central than it was, not their identity.
 *
 * `caplannfl` (not `adamcaplan`, a different unrelated person) confirmed via
 * `verifyHandle()`: real, blue-verified, 182K followers, bio explicitly
 * reads "NFL Insider" with real broadcast credentials (SiriusXM, Fox Sports
 * Radio). The bare-name variant is a lecturer with 1.5K followers and no NFL
 * connection — exactly the kind of mistake ingesting from an unverified
 * guess would have paid to make.
 */
export const NATIONAL_INSIDER_HANDLES = Object.freeze([
  // Verified live against the profile API, not recalled from memory. Four other
  // candidates in the same pass did not exist and four more resolved to
  // accounts with under 200 followers squatting on a reporter's name.
  'AdamSchefter', 'RapSheet', 'TomPelissero', 'MikeGarafolo', 'JayGlazer',
  'FieldYates', 'JosinaAnderson', 'caplannfl',
  'AlbertBreer',        // 740k
  'NFL_DovKleiman',     // 405k
  'Rotoworld_FB',       // 349k — aggregator, fast on inactives
  'FantasyPtsData'      // 47k  — snap and route data, useful for role changes
]);

/**
 * Official team accounts — all 32 verified live. These carry the highest
 * possible confidence for team attribution: an official account's own tweet
 * about its own team needs no entity-resolution guess, unlike inferring team
 * from a reporter's beat.
 */
export const TEAM_HANDLES = Object.freeze({
  ARI: 'AZCardinals', ATL: 'AtlantaFalcons', BAL: 'Ravens', BUF: 'BuffaloBills',
  CAR: 'Panthers', CHI: 'ChicagoBears', CIN: 'Bengals', CLE: 'Browns',
  DAL: 'dallascowboys', DEN: 'Broncos', DET: 'Lions', GB: 'packers',
  HOU: 'HoustonTexans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs',
  LAC: 'Chargers', LAR: 'RamsNFL', LV: 'Raiders', MIA: 'MiamiDolphins',
  MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'nyjets',
  PHI: 'Eagles', PIT: 'steelers', SEA: 'Seahawks', SF: '49ers',
  TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders'
});

/**
 * Beat reporters — verified via `twitterapi-io.js:verifyHandle()` against
 * the live platform, NOT trusted from the aggregator that supplied the
 * candidate list. That verification cost $0.011 total (61 profile reads at
 * $0.00018 each) and caught three real errors an unverified list would have
 * silently shipped:
 *
 *   Kyle_Youmans listed under DAL   -> real account, but bio reads "Voice of
 *                                      the @Ravens" — a Baltimore broadcaster,
 *                                      not a Cowboys beat writer. Dropped.
 *   JohnHCrumpler (HOU)             -> account does not exist. Dropped.
 *   PGutierrezESPN (LV)             -> account does not exist. Dropped.
 *
 * GMbremer (IND) is kept but flagged: exists, but the bio is a generic radio
 * bio ("Woof Boom Radio... Anderson Journal") with no clear Colts beat
 * confirmation — worth a second look before trusting it as highly as the
 * others. Every other entry's bio explicitly named the correct team.
 */
export const BEAT_REPORTER_HANDLES = Object.freeze({
  ARI: ['Cardschatter', 'azbobbymac'], ATL: ['DOrlandoLED', 'Tori_McElhaney'],
  BAL: ['jamisonhensley', 'jeffzrebiec'], BUF: ['SalMaiorana', 'SalSports'],
  CAR: ['JosephPerson', 'DarinGantt'], CHI: ['BradBiggs', 'kfishbain'],
  CIN: ['PaulDehnerJr', 'KelseyLConway'], CLE: ['MaryKayCabot', 'AkronJackson'],
  DAL: ['ClarenceHillJr', 'toddarcher', 'calvinwatkins'],   // Kyle_Youmans dropped — verified as a Ravens broadcaster, not Cowboys
  DEN: ['mikeklis', 'TroyRenck'], DET: ['colton_pouncy', 'ttwentyman'],
  GB: ['AndyHermanNFL', 'mattschneidman'], HOU: ['AaronWilson_NFL', 'DannyVietti'],   // JohnHCrumpler dropped — does not exist
  IND: ['mchappell51', 'GMbremer'],   // GMbremer: exists, bio unconfirmed as Colts-specific
  JAX: ['Demetrius82', '_John_Shipley'], KC: ['mattderrick', 'ByNateTaylor'],
  LAC: ['danielrpopper', 'krisrhim1'], LAR: ['JourdanRodrigue'],
  LV: ['VicTafur', 'TashanReed'],   // PGutierrezESPN dropped — does not exist
  MIA: ['DavidFurones_', 'schadjoe'], MIN: ['alec_lewis', 'BenGoessling'],
  NE: ['MikeReiss', 'ezlazar'], NO: ['nick_underhill', 'MikeTriplett'],
  NYG: ['JordanRaanan', 'NYPost_Schwartz'], NYJ: ['BrianCoz', 'RichCimini'],
  PHI: ['Jeff_McLane', 'EliotShorrParks'], PIT: ['MarkKaboly', 'Alex_Kozora'],
  SEA: ['Gbellseattle', 'bcondotta'], SF: ['LombardiHimself', 'Eric_Branch'],
  TB: ['NFLSTROUD', 'GregAuman'], TEN: ['nicksuss', 'terrymc13'],
  WAS: ['BenStandig', 'John_Keim']
});

/** Back-compat export name; national insiders are the account family actually swept. */
export const INSIDER_HANDLES = NATIONAL_INSIDER_HANDLES;

const MAX_TWEETS_PER_RUN = 5;   // handles per sync call, cost-bounded

const TEAM_HANDLE_LOOKUP = new Map(Object.entries(TEAM_HANDLES).map(([abbr, h]) => [h.toLowerCase(), abbr]));

/**
 * A tweet from a verified official team account needs no entity-resolution
 * guess about which team it concerns — the account IS the team. Tagged with
 * a distinct source_type and the team's real reliability tier (an official
 * statement outranks even a top insider's report of the same fact) so
 * `TEAM_HANDLE_LOOKUP` is queryable output, not dead config.
 */
function tweetToRawNews(tweet) {
  const userName = tweet.author?.userName ?? 'unknown';
  const officialTeam = TEAM_HANDLE_LOOKUP.get(userName.toLowerCase());
  return {
    source: officialTeam ? `${officialTeam} (official)` : `Twitter/${userName}`,
    source_type: officialTeam ? 'team_official' : 'social',
    author: tweet.author?.name ?? userName,
    source_url: tweet.url ?? tweet.twitterUrl,
    canonical_url: tweet.url ?? tweet.twitterUrl,
    headline: tweet.text?.slice(0, 280) ?? '',
    summary: tweet.text ?? null,
    published_at: tweet.createdAt,
    // Real engagement is a weak but real reliability proxy for whether an
    // insider's own audience is treating this as a confirmed report versus a
    // half-formed rumor — not used for anything beyond the reliability cap
    // that already exists for every other news source. An official team
    // account is not a rumor at all, so it gets a materially higher score.
    reliability: officialTeam ? { tier: 'team_official', score: 0.95 } : { tier: 'social_insider', score: 0.75 },
    _officialTeamAbbr: officialTeam ?? null
  };
}

/**
 * Pull recent tweets from the curated insider list, normalize, and store.
 * Budget-checked before every call via `searchRecentTweets`'s own guard, so
 * this degrades to "did nothing" rather than erroring once the spend cap is
 * reached mid-run.
 */
export async function ingestTwitterInsiders({ maxHandles = MAX_TWEETS_PER_RUN } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no TWITTERAPI_IO_KEY configured' };
  const status = twitterSpendStatus();
  if (status.blocked) return { skipped: true, reason: 'spend cap reached', status };

  const identity = loadIdentity();
  const handles = INSIDER_HANDLES.slice(0, maxHandles);
  let stored = 0, skipped = 0, calls = 0;
  const errors = [];

  for (const handle of handles) {
    if (twitterSpendStatus().blocked) break;
    const result = await searchRecentTweets(`from:${handle} (injury OR questionable OR doubtful OR out OR starting OR benched OR practice)`,
      { purpose: 'insider-injury-role-sweep' });
    calls++;
    if (result.skipped) break;
    if (result.error) { errors.push({ handle, error: result.error }); continue; }
    for (const tweet of result.body?.tweets ?? []) {
      try {
        const raw = tweetToRawNews(tweet);
        const normalized = normalizeNewsItem(raw, { identity });
        // Only store tweets that actually name a tracked player — an
        // unresolved tweet is exactly the noise this curation exists to avoid.
        if (!normalized.entities.players.length) { skipped++; continue; }
        // An official account's own team is known with certainty; only fall
        // back to entity-extracted guesswork when the tweet isn't from one.
        const officialAbbr = raw._officialTeamAbbr;
        const teamEntity = officialAbbr
          ? row('SELECT id, abbr FROM nfl_teams WHERE abbr = ?', officialAbbr)
          : normalized.entities.teams[0] ? row('SELECT id, abbr FROM nfl_teams WHERE id = ?', normalized.entities.teams[0].id) : null;
        const { id: newsId } = upsertNormalizedNewsItem(normalized,
          { teamId: teamEntity?.id ?? null, date: normalized.published_at.slice(0, 10) });
        stored++;
        // Link to line movement immediately, using the derived team abbr — no
        // player-only tweet is skipped here just because it lacked a team hashtag.
        const teamAbbr = teamEntity?.abbr ?? (normalized.entities.players[0]?.id
          ? row('SELECT t.abbr FROM players p LEFT JOIN nfl_teams t ON t.id=p.team_id WHERE p.id=?',
            normalized.entities.players[0].id)?.abbr : null);
        if (teamAbbr) watchTweetForLineMove({ id: newsId, team_abbr: teamAbbr,
          headline: normalized.headline, published_at: normalized.published_at });
      } catch (e) { errors.push({ handle, error: e.message }); }
    }
  }
  return { handles_checked: calls, stored, skipped_no_player_match: skipped, errors,
    spend: twitterSpendStatus() };
}
