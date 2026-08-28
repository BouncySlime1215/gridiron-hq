/**
 * Trading on your league's information lag.
 *
 * This is the one market in the platform where we hold a genuine structural
 * advantage rather than a hoped-for one. Against a sportsbook we are the slow
 * money — we lose to syndicates with order flow we cannot buy. Against nine
 * other people in a fantasy league we are, by a wide margin, the fastest
 * participant: the app ingests verified beat reporters, the transaction wire
 * and official practice reports on a timer, and types each claim with an
 * evidence span. Your leaguemates read the same news that evening.
 *
 * Until now that pipeline's entire output was a paragraph on a page. This turns
 * it into an action.
 *
 * THE KEY INSIGHT: the tradeable asset is usually NOT the player in the
 * headline. When a starter tears an ACL his own value is already gone and
 * everyone can see it. The value moves to whoever inherits the touches — and
 * that player is sitting on a bench or a waiver wire, priced as though nothing
 * happened, because the depth chart consequence takes longer to propagate than
 * the headline does. We hold the depth chart, so we can name him immediately.
 *
 * WHAT THIS DOES NOT DO: it does not pretend to know when your leaguemates will
 * read the news. There is no countdown, because a countdown would be invented.
 * It reports how long ago the claim was published and lets you judge.
 */
import { rows, row } from '../db/index.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters } from './trade-engine.js';
import { normalizePlayerName } from './player-identity.js';

const HOUR = 3600e3;

// Statuses that remove or restore a player's touches. `role_delta` signals are
// treated separately because a role change is a slower, softer move.
const NEGATIVE = new Set(['out_for_season', 'out', 'doubtful', 'released', 'ir']);
// Only slots that actually score fantasy points can have a meaningful
// "next man up". An earlier pass happily nominated the backup PUNT RETURNER
// as the beneficiary of a receiver's torn ACL, which is true on the depth
// chart and worthless in a lineup.
const SCORING_SLOTS = new Set(['QB', 'RB', 'WR', 'TE']);
const POSITIVE = new Set(['available_positive', 'active', 'returning']);

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/**
 * Who inherits the touches when this player cannot play.
 *
 * Reads the live ESPN depth chart: same team, same slot, next order up, and
 * — critically — skipping anyone already flagged unavailable themselves, since
 * naming a second injured player as the beneficiary is worse than naming none.
 */
function beneficiaryOf(playerName, teamAbbr) {
  const team = row('SELECT id FROM nfl_teams WHERE abbr = ?', teamAbbr);
  if (!team) return null;

  // Match on the normalised name: ESPN writes "Ja'Marr" with a curly
  // apostrophe and other feeds use a straight one, so a raw lower() compare
  // silently misses exactly the players who matter most.
  const wanted = normalizePlayerName(playerName);
  const injured = rows(
    `SELECT name, depth_slot, depth_order FROM roster_players
     WHERE team_id = ? AND depth_slot IS NOT NULL`, team.id)
    .find(p => normalizePlayerName(p.name) === wanted);
  if (!injured || !SCORING_SLOTS.has(injured.depth_slot)) return null;

  // Everyone else at that slot, in depth order, who is not themselves flagged.
  const unavailable = new Set(rows(
    `SELECT player_name FROM nfl_news_signals
     WHERE team = ? AND status IN ('out_for_season','out','ir','released')
       AND published_at >= datetime('now','-45 days')`, teamAbbr)
    .map(x => normalizePlayerName(x.player_name)));

  const next = rows(
    `SELECT name, position, depth_order, espn_id FROM roster_players
     WHERE team_id = ? AND depth_slot = ? AND depth_order > ?
     ORDER BY depth_order`,
    team.id, injured.depth_slot, injured.depth_order)
    .find(p => !unavailable.has(normalizePlayerName(p.name)));

  return next
    ? { name: next.name, position: next.position, depth_order: next.depth_order,
        espn_id: next.espn_id, slot: injured.depth_slot,
        promoted_from: injured.depth_order }
    : null;
}

/**
 * Recent typed signals turned into concrete league actions.
 *
 * @param leagueId  the league whose rosters decide who owns whom
 * @param myTeamId  which roster is "mine"; everything is framed from that seat
 */
export function newsOpportunities(leagueId, { myTeamId = null, hours = 72 } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const signals = rows(
    `SELECT player_name, player_id, team, status, unavailable_probability,
            confidence, published_at, evidence_span, source, source_url
     FROM nfl_news_signals
     WHERE published_at >= datetime('now', ?)
     ORDER BY published_at DESC`, `-${hours} hours`);
  if (!signals.length) {
    return { league: lg.name, signals_considered: 0, opportunities: [],
      note: `No typed signals in the last ${hours} hours.` };
  }

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(myTeamId ?? lg.my_team_id)) ?? teams[0];

  // name -> owning roster, so "who has him" is one lookup rather than a scan.
  const ownerOf = new Map();
  for (const t of teams) {
    for (const p of t.players) ownerOf.set(normalizePlayerName(p.name), { team: t, player: p });
  }
  const owned = name => ownerOf.get(normalizePlayerName(name)) ?? null;
  const valueOf = name => owned(name)?.player?.value ?? null;

  const now = Date.now();
  const opportunities = [];

  for (const s of signals) {
    const negative = NEGATIVE.has(s.status);
    const positive = POSITIVE.has(s.status);
    if (!negative && !positive) continue;

    const ageHours = r2((now - new Date(s.published_at).getTime()) / HOUR);
    const held = owned(s.player_name);
    const mine = held && me && held.team.roster_id === me.roster_id;

    // The headline player. Usually NOT the trade — his price has already moved.
    const subject = {
      name: s.player_name, team: s.team, status: s.status,
      unavailable_probability: s.unavailable_probability,
      owned_by: held ? held.team.owner : 'free agent',
      is_mine: !!mine, market_value: held?.player?.value ?? null
    };

    let action = null;
    if (negative) {
      const ben = beneficiaryOf(s.player_name, s.team);
      if (ben) {
        const benOwned = owned(ben.name);
        const benMine = benOwned && me && benOwned.team.roster_id === me.roster_id;
        action = {
          kind: !benOwned ? 'claim_waiver' : benMine ? 'already_held' : 'buy_beneficiary',
          target: ben.name, target_position: ben.position,
          target_owned_by: benOwned ? benOwned.team.owner : 'free agent',
          target_value: valueOf(ben.name),
          why: !benOwned
            ? `${ben.name} inherits the ${ben.slot} snaps and is unrostered. Claim before the wire clears.`
            : benMine
              ? `You already hold ${ben.name}, who inherits the ${ben.slot} snaps. Nothing to do but start him.`
              : `${ben.name} inherits the ${ben.slot} snaps and is on ${benOwned.team.owner}'s roster, still priced as a backup.`
        };
      } else if (mine) {
        action = { kind: 'hold_or_sell', target: s.player_name,
          why: 'No clear inheritor on the depth chart, so there is no beneficiary to buy. This is a hold-or-sell call on the player himself.' };
      }
    } else if (positive && held && !mine) {
      // A recovery reported before the market re-rates him.
      action = { kind: 'buy_low', target: s.player_name,
        target_owned_by: held.team.owner, target_value: held.player.value,
        why: `Positive availability news on a player ${held.team.owner} may still be discounting.` };
    } else if (positive && !held) {
      action = { kind: 'claim_waiver', target: s.player_name,
        target_owned_by: 'free agent',
        why: 'Positive availability news on an unrostered player.' };
    }

    if (!action) continue;
    opportunities.push({
      subject, action, age_hours: ageHours,
      confidence: s.confidence,
      // The verbatim clause the claim was extracted from. Never paraphrased —
      // acting on a bad extraction is worse than acting late.
      evidence: s.evidence_span, source: s.source, source_url: s.source_url,
      published_at: s.published_at
    });
  }

  // Freshest first: the whole premise is that value decays as the news spreads.
  opportunities.sort((a, b) => a.age_hours - b.age_hours);

  return {
    league: lg.name, my_team: me?.owner ?? null,
    signals_considered: signals.length,
    opportunities,
    note: 'Ranked by how recently the claim was published. There is deliberately no countdown — ' +
      'we cannot know when your leaguemates read the news, only that this pipeline runs on a timer ' +
      'and they do not. Every row carries the verbatim evidence span it was extracted from.'
  };
}
