/**
 * Canonical game answer from the many-headed Gridiron Engine.
 *
 * The ensemble decides the target means; the play model supplies the joint,
 * discrete shape. Minimum-KL reconciliation moves the simulated distribution
 * to those means without replacing football scores with an independent normal
 * curve. News is attached only after source verification and has zero direct
 * numeric authority.
 */
import crypto from 'node:crypto';
import { rows } from '../db/index.js';
import { ensembleLine } from './nfl-ensemble.js';
import { simulateMatchup } from './nfl-drive-sim.js';
import { nflEngineStatus, nflEngineVersionFor } from './nfl-engine-registry.js';
import { teamNewsSignals } from './nfl-news-signal.js';
import { nflKickoffDate } from './date-util.js';
import { ask } from './gridiron-model.js';
import { expertCouncilGame } from './nfl-expert-council.js';
import { gameInjuryCarryover } from './nfl-postgame-truth.js';

function deterministicSeed(value) {
  return crypto.createHash('sha256').update(value).digest().readUInt32BE(0);
}

function gameRow(season, week, home) {
  return rows(`SELECT gameday,gametime,neutral_site FROM game_lines
    WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, season, week, home)[0] ?? null;
}

function gameCutoff(season, week, home) {
  const game = gameRow(season, week, home);
  const kickoff = game?.gameday ? nflKickoffDate(game.gameday, game.gametime || '23:59') : null;
  return kickoff?.toISOString() ?? new Date().toISOString();
}

export function unifiedGameProjection({ season, week, home, away, trials = 8000,
  spread = null, total = null, sampleDrives = false } = {}) {
  const h = String(home ?? '').toUpperCase(), a = String(away ?? '').toUpperCase();
  if (!Number.isInteger(Number(season)) || !Number.isInteger(Number(week)) || !h || !a) {
    return { error: 'season, week, home and away are required' };
  }
  const line = ensembleLine(Number(season), Number(week), h, a,
    { blendMode: 'market_residual', includeEvidence: true });
  if (line.error) return line;
  const postedSpread = Number.isFinite(spread) ? spread : line.ensemble.market_spread;
  const postedTotal = Number.isFinite(total) ? total : line.ensemble.market_total;
  const engineVersion = nflEngineVersionFor(Number(season), Number(week));
  // No home field at a neutral site: the simulator's default 1.6-point bonus is
  // a 23% chance of a free touchdown for the nominal home team.
  const neutral = Boolean(gameRow(Number(season), Number(week), h)?.neutral_site);
  const simulation = simulateMatchup({
    home: h, away: a, season: Number(season), week: Number(week),
    trials: Math.min(20000, Math.max(500, Number(trials) || 8000)),
    spread: postedSpread, total: postedTotal, sampleDrives,
    homeFieldPoints: neutral ? 0 : 1.6,
    targetMargin: line.ensemble.projected_margin,
    targetTotal: line.ensemble.projected_total,
    seed: deterministicSeed(`${engineVersion}|${season}|${week}|${h}|${a}`)
  });
  if (simulation.error) return simulation;
  const cutoff = gameCutoff(Number(season), Number(week), h);
  const homeNews = teamNewsSignals(h, { before: cutoff });
  const awayNews = teamNewsSignals(a, { before: cutoff });
  const spreadAuthority = ask('betting.model_spread', { purpose: 'inform' });
  const simulationAuthority = ask('betting.simulator', { purpose: 'inform' });
  return {
    engine: { name: 'Gridiron Engine', version: engineVersion,
      learning_epoch: nflEngineStatus(Number(season), Number(week)).learning_epoch },
    game: { season: Number(season), week: Number(week), home: h, away: a, evidence_cutoff: cutoff },
    answer: {
      projected_score: simulation.projection,
      moneyline: simulation.moneyline,
      spread: simulation.spread,
      total: simulation.total,
      distribution: simulation.distribution,
      key_numbers: simulation.key_numbers
    },
    heads: {
      team_spread_total: line.ensemble,
      roster_availability: line.ensemble.player_availability,
      injury_carryover: gameInjuryCarryover(Number(season), Number(week), h, a),
      verified_news: { home: homeNews, away: awayNews, numeric_authority: 0 },
      play_by_play_shape: simulation.play_model,
      reconciliation: simulation.reconciliation,
      expert_council: expertCouncilGame(Number(season), Number(week), h)
    },
    authority: {
      spread: { ...spreadAuthority,
        operational_status: spreadAuthority.authority === 'retired' ? 'restricted_research' : spreadAuthority.authority,
        still_used: true, direct_betting_authority: spreadAuthority.authority === 'authoritative' },
      simulation: { ...simulationAuthority,
        operational_status: simulationAuthority.authority === 'retired' ? 'restricted_research' : simulationAuthority.authority,
        still_used: true, direct_betting_authority: simulationAuthority.authority === 'authoritative' },
      staking: 'No simulation percentage may size a bet unless its capability authority passes a sealed forward audit.'
    },
    example_drives: simulation.example_drives,
    methodology: 'One frozen engine version and cutoff. Forecast heads set means; one joint play-by-play distribution produces every percentage; verified news remains shadow-only.'
  };
}
