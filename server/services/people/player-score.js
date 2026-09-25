/**
 * PLAYER-SCORE: the blue-chip score, ONE producer for every player's 0-100 score and label.
 *
 * Nick 9/24: "Chase Brown and Nico are blue chip guys: went high in the draft and played
 * well since"; "Classify every player: some combo of draft position and production"; "a
 * number could help"; "Bucky is a step below". So:
 *
 *   score = W.pick x pick percentile + W.production x production percentile   (0-100)
 *
 *   pick percentile         where THIS league took him in its draft (league_draft_picks
 *                           .overall_pick): 100 x (N - pick) / (N - 1) over N picks; undrafted 0.
 *   production percentile   his rank at his position in the board universe (every rostered
 *                           player plus the top free agents), 100 x (n - rank) / (n - 1).
 *                           Basis: season points per game (ros_basis.season_to_date, the
 *                           engine's own in-season history); EARLY in the season (his NFL
 *                           teams have played fewer than EARLY_GAMES games) the engine's
 *                           rest-of-season rate ros_ppg instead, which already blends the
 *                           games so far with the preseason prior. A player with no game yet
 *                           is ranked on ros_ppg either way.
 *   W                       50/50, PROVISIONAL: no fit exists yet (R&D r51 TIER-VALID was not
 *                           on disk when this was built, ~/gridiron-local/rnd/loop/r51-TIER-VALID.md).
 *
 * hurt (typed): a high pick (pick percentile >= HURT_PICK_PCT) whose production percentile
 * sits at least HURT_GAP points under his pick percentile (low FOR WHERE HE WENT) AND who has
 * missed games (his team has played more games than he has) or is on the injury report / out
 * for the year. (First cut used an absolute production percentile < 50; league 4's A.J. Brown,
 * pick 27, one game of two, production percentile 66, read as not hurt against Nick's "AJ is
 * just hurt", so the bar is relative to the pick. PROVISIONAL, like the weights.) The score is not changed by it; the
 * board says "hurt" next to the label so a low score from missed games is read as such.
 *
 * Labels (score bands): Elite blue chip 90+, Blue chip 80-89, Level below 70-79,
 * Solid starter 60-69, Flex 50-59, Depth 35-49, Bench < 35.
 *
 * Pure: no DB, no network. The adapter (scripts/campaign/league-adapter.mjs) reads the
 * inputs and serves the board; flag GRIDIRON_PLAYER_SCORE (default off; on under
 * preview-mode.js#previewUnconfirmed; =0 vetoes preview).
 */
import { previewUnconfirmed } from '../preview-mode.js';

export const PLAYER_SCORE_ENV = 'GRIDIRON_PLAYER_SCORE';
/** 'on' | 'preview' | 'off'. */
export function playerScoreFlag(env = process.env) {
  if (env[PLAYER_SCORE_ENV] === '1') return 'on';
  if (env[PLAYER_SCORE_ENV] === '0') return 'off';
  return previewUnconfirmed() ? 'preview' : 'off';
}

export const WEIGHTS = Object.freeze({ pick: 0.5, production: 0.5,
  basis: 'provisional 50/50: no fitted weights yet (R&D r51 TIER-VALID not available at build time)' });

export const LABELS = Object.freeze([
  { min: 90, label: 'Elite blue chip' },
  { min: 80, label: 'Blue chip' },
  { min: 70, label: 'Level below' },
  { min: 60, label: 'Solid starter' },
  { min: 50, label: 'Flex' },
  { min: 35, label: 'Depth' },
  { min: -Infinity, label: 'Bench' },
]);
export const LABEL_NAMES = Object.freeze(LABELS.map(l => l.label));
/** Nick's players at or above this score are never given without his approval. */
export const PROTECT_SCORE = 80;
export const EARLY_GAMES = 3;
export const HURT_PICK_PCT = 70;
export const HURT_GAP = 15;

/** Gap thresholds, PROVISIONAL (named, not fitted). */
export const GAP = Object.freeze({
  /** FantasyPros "high": top this many skill players rest of season. */
  fpHigh: 36,
  /** Our value "low" / a mispricing: one rank at least this many times the other. */
  ratio: 2,
  /** Only rank pairs where one side is inside this are compared (deep ranks are noise). */
  relevant: 150,
  /** "Falling": his FantasyPros rank worsened by at least this many places since the earlier scrape. */
  fall: 10,
});
export const GAP_TYPES = Object.freeze(['undervalued_blue_chip', 'fading_blue_chip', 'riser', 'we_value_lower', 'we_value_higher']);

export const labelOf = score => LABELS.find(l => score >= l.min).label;
const fin = v => typeof v === 'number' && Number.isFinite(v);
const pctOf = (rank, n) => (n <= 1 ? 100 : Math.max(0, Math.min(100, (100 * (n - rank)) / (n - 1))));

/** Rank (1 = best) of each id by value, descending; ties share the better rank. */
function rankBy(items, valueOf) {
  const list = items.filter(x => fin(valueOf(x))).sort((a, b) => valueOf(b) - valueOf(a));
  const out = new Map();
  list.forEach((x, i) => {
    const prev = list[i - 1];
    out.set(String(x.id), prev && valueOf(prev) === valueOf(x) ? out.get(String(prev.id)) : i + 1);
  });
  return { ranks: out, n: list.length };
}

/**
 * Production value for one player: { basis, value, games }.
 * early: fewer than EARLY_GAMES team games played this season.
 */
export function productionOf(p, { early }) {
  const games = fin(p.ros_basis?.games) ? p.ros_basis.games : 0;
  if (!early && games > 0 && fin(p.ros_basis?.season_to_date)) return { basis: 'season_ppg', value: p.ros_basis.season_to_date, games };
  return { basis: 'ros_ppg', value: fin(p.ros_ppg) ? p.ros_ppg : null, games };
}

/**
 * Score every player.
 * players: [{ id, name, position, owner (roster id | null for a free agent), espn_id, value, ros_ppg,
 *             ros_basis?: { games, season_to_date }, injury?, available?, team_abbr? }]
 * picks: Map<espn_id string, overall_pick>; nPicks: picks in that draft.
 * Returns Map id -> { score, label, hurt, parts }.
 */
export function scorePlayers(players, { picks = new Map(), nPicks = 0, weights = WEIGHTS } = {}) {
  // Team games so far: the most games any of his NFL team's players has logged.
  const teamGames = new Map();
  for (const p of players) {
    const g = fin(p.ros_basis?.games) ? p.ros_basis.games : 0;
    if (p.team_abbr) teamGames.set(p.team_abbr, Math.max(teamGames.get(p.team_abbr) ?? 0, g));
  }
  const maxGames = Math.max(0, ...teamGames.values());
  const early = maxGames < EARLY_GAMES;
  const prod = new Map(players.map(p => [String(p.id), productionOf(p, { early })]));
  const byPos = new Map();
  for (const p of players) { if (!byPos.has(p.position)) byPos.set(p.position, []); byPos.get(p.position).push(p); }
  const posRank = new Map();
  for (const [pos, list] of byPos) {
    const { ranks, n } = rankBy(list, x => prod.get(String(x.id)).value);
    for (const [id, r] of ranks) posRank.set(id, { rank: r, n, pos });
  }
  const out = new Map();
  for (const p of players) {
    const id = String(p.id);
    const pick = p.espn_id != null ? picks.get(String(p.espn_id)) ?? null : null;
    const pickPct = Number.isInteger(pick) && nPicks > 0 ? pctOf(pick, nPicks) : 0;
    const pr = prod.get(id);
    const rk = posRank.get(id) ?? null;
    const prodPct = rk ? pctOf(rk.rank, rk.n) : 0;
    const score = Math.round(weights.pick * pickPct + weights.production * prodPct);
    const tg = p.team_abbr ? teamGames.get(p.team_abbr) ?? 0 : 0;
    const missed = Math.max(0, tg - pr.games);
    const reported = !!p.injury || p.available === false;
    const hurt = pickPct >= HURT_PICK_PCT && prodPct <= pickPct - HURT_GAP && (missed > 0 || reported);
    out.set(id, { score, label: labelOf(score), hurt,
      parts: { pick, pick_pct: Math.round(pickPct), prod_basis: pr.basis, prod_value: fin(pr.value) ? +pr.value.toFixed(2) : null,
        pos_rank: rk?.rank ?? null, pos_n: rk?.n ?? null, prod_pct: Math.round(prodPct), games: pr.games, team_games: tg, missed } });
  }
  return out;
}

/**
 * Gap flags for one board row. r: { score, model_rank, fp_rank (skill-position rank), fp_prev_rank }.
 * Every threshold is GAP (provisional). A flag needs both numbers it compares; a missing one
 * gives no flag, never a guess.
 */
export function gapFlags(r) {
  const out = [];
  const high = r.score >= PROTECT_SCORE;
  const mid = r.score >= 50 && r.score < PROTECT_SCORE;
  const fp = fin(r.fp_rank) ? r.fp_rank : null, ours = fin(r.model_rank) ? r.model_rank : null;
  if (high && fp != null && fp <= GAP.fpHigh && ours != null && ours >= GAP.ratio * fp) out.push('undervalued_blue_chip');
  if (high && fp != null && fin(r.fp_prev_rank) && fp - r.fp_prev_rank >= GAP.fall) out.push('fading_blue_chip');
  if (mid && fp != null && fp <= GAP.fpHigh) out.push('riser');
  if (fp != null && ours != null && Math.min(fp, ours) <= GAP.relevant) {
    if (ours >= GAP.ratio * fp) out.push('we_value_lower');
    else if (fp >= GAP.ratio * ours) out.push('we_value_higher');
  }
  return out;
}

/**
 * The board. players as scorePlayers, plus the model's value rank universe and the FantasyPros bridge.
 *   allValues: [{ id, position, value }] every priced skill player (the engine's market value);
 *              model_rank is his rank there, the same universe FantasyPros ranks.
 *   fp: { status, reason?, scrape_date?, prev_date?, byId: Map id -> { ecr, pos_rank, prev_ecr } }
 *   me: Nick's roster id; untouchable: Set of ids Nick's notes protect.
 * Returns { rows, protect: Set (Nick's blue chips + his protected), coverage }.
 */
export function buildBoard(players, { picks, nPicks, allValues = [], fp = { status: 'unknown', byId: new Map() }, me, untouchable = new Set(), weights = WEIGHTS } = {}) {
  const scores = scorePlayers(players, { picks, nPicks, weights });
  const { ranks: modelRanks } = rankBy(allValues.filter(x => fin(x.value) && x.value > 0), x => x.value);
  // FantasyPros' overall ECR re-ranked over the players we can join, so both ranks count the same universe.
  const fpList = players.map(p => ({ id: p.id, ecr: fp.byId?.get(String(p.id))?.ecr })).filter(x => fin(x.ecr));
  const fpRanks = new Map([...fpList].sort((a, b) => a.ecr - b.ecr).map((x, i) => [String(x.id), i + 1]));
  const fpPrev = players.map(p => ({ id: p.id, ecr: fp.byId?.get(String(p.id))?.prev_ecr })).filter(x => fin(x.ecr));
  const fpPrevRanks = new Map([...fpPrev].sort((a, b) => a.ecr - b.ecr).map((x, i) => [String(x.id), i + 1]));
  const rows = [];
  const protect = new Set();
  for (const p of players) {
    const id = String(p.id);
    const s = scores.get(id);
    const f = fp.byId?.get(id) ?? null;
    const mine = p.owner != null && String(p.owner) === String(me);
    const model_rank = modelRanks.get(id) ?? null;
    const row = {
      player: id, name: p.name, position: p.position, owner: p.owner == null ? null : String(p.owner), mine,
      score: s.score, label: s.label, hurt: s.hurt, parts: s.parts,
      model_value: fin(p.value) && p.value > 0 ? p.value : null, model_rank,
      fp_ros_rank: f ? f.ecr : null, fp_pos_rank: f?.pos_rank ?? null, fp_rank: fpRanks.get(id) ?? null,
      fp_prev_rank: fpPrevRanks.get(id) ?? null,
    };
    row.gaps = gapFlags(row);
    row.protected = mine && (s.score >= PROTECT_SCORE || untouchable.has(id));
    if (row.protected) protect.add(id);
    rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score || String(a.player).localeCompare(String(b.player)));
  const rostered = rows.filter(r => r.owner != null);
  const share = k => (rostered.length ? rostered.filter(r => r[k] != null).length / rostered.length : 0);
  return { rows, protect, coverage: { rostered: rostered.length, board: rows.length,
    score: share('score'), model_value: share('model_value'), fp_ros_rank: share('fp_ros_rank') } };
}
