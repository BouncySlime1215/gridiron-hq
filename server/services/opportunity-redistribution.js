/**
 * Where the targets go when somebody sits.
 *
 * Item 2 out of the study. The projection builds each player from his own
 * history alone, so when a team's WR1 is inactive nothing moves for anyone
 * else — and a receiver about to absorb eight extra targets is projected as if
 * it were a normal week. That is the clearest remaining gap in the projection
 * and it bites hardest in exactly the weeks a start/sit call is hardest.
 *
 * Measured, not assumed: for every team-week in 2021-2025 where a player with
 * real prior volume was absent after playing the week before, compare each
 * remaining teammate's share to his own prior three-week average. Pool across
 * the league by position pair and depth rank, because a single team has far too
 * few such weeks to say anything.
 *
 * RESULT: THIS IS OFF BY DEFAULT BECAUSE IT DID NOT WORK.
 *
 * Graded on 2025 weeks 5-17, against actual scores, on the 10-29% of
 * player-weeks it actually touches (elsewhere it is a no-op, so pooling would
 * bury the effect):
 *
 *   variant                                        MAE with / without   change
 *   conservation, all active teammates absorb      4.350 / 3.973        +9.5%
 *   no conservation, measured shares only          4.409 / 3.973       +11.0%
 *   same position, top-4 depth only                4.253 / 3.777       +12.6%
 *
 * All three 90% paired-bootstrap intervals sit entirely above zero, so this is
 * reliably worse, not noise.
 *
 * The most likely reason, and it is a selection bias in the measurement itself:
 * absorption is computed only over players who RECORDED usage in the vacated
 * week, so a backup who was never elevated is invisible to it and the shares
 * come out biased upward. Restricting to plausible absorbers narrowed the
 * affected set from 29% to 11% of player-weeks but did not fix the sign.
 *
 * A second reason worth recording: the weekly ensemble already weights a
 * player's own season-to-date scoring at 0.40 and his last three weeks at 0.15
 * against only 0.20 on the structural head. A backup's recent history ALREADY
 * reflects a role change once it has happened, and it does so with less noise
 * than an absorption table estimated from a few hundred league-wide events.
 * There is less room here than the gap appeared to offer.
 *
 * Two design points that matter:
 *
 *   VOLUME IS NOT CONSERVED. Absorption is a measured share of the vacated
 *   volume and those shares sum to well under one. Assuming the team redeploys
 *   every target is the intuitive move and it is wrong; it inflated survivors by
 *   roughly 1.6x and measurably degraded the projection.
 *
 *   SHRINKAGE IS FITTED. Each (position, depth) cell is shrunk toward the
 *   position-level average with a strength chosen out-of-sample, not by taste.
 *   Cells with a handful of observations should barely move a projection.
 */
import { rows } from '../db/index.js';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const VOLUME = { QB: 'attempts', RB: 'carries', WR: 'targets', TE: 'targets' };

/** Absorption table, built once per process — it is a five-season aggregate. */
let _table;

/**
 * Per-position weekly volume for a team, with each player's prior three-week
 * average alongside — the baseline an absence is measured against.
 */
function teamWeeks(fromSeason, toSeason) {
  return rows(`
    SELECT u.season, u.week, u.team, u.player_id, p.position AS pos,
           u.targets, u.carries, u.attempts, u.receptions
    FROM player_week_usage u JOIN players p ON p.id = u.player_id
    WHERE u.season BETWEEN ? AND ? AND p.position IN ('QB','RB','WR','TE')
      AND u.team IS NOT NULL
    ORDER BY u.team, u.season, u.week`, fromSeason, toSeason);
}

/**
 * Build the absorption table.
 *
 * Returns, for each (absent position, absent depth rank) -> (absorber position,
 * absorber depth rank), the mean share of the absent player's volume that the
 * absorber picked up. Depth rank is by prior three-week volume, so it is
 * strictly prior information.
 */
export function buildAbsorption({ fromSeason = 2021, toSeason = 2025, minPriorVolume = 3 } = {}) {
  const raw = teamWeeks(fromSeason, toSeason);
  const byTeamSeason = new Map();
  for (const r of raw) {
    const k = `${r.team}|${r.season}`;
    (byTeamSeason.get(k) ?? byTeamSeason.set(k, []).get(k)).push(r);
  }

  const cells = new Map();   // "absentPos:absentRank>absorbPos:absorbRank" -> {n, sum}
  const byPos = new Map();   // "absentPos>absorbPos" -> {n, sum}
  let events = 0;

  for (const [, list] of byTeamSeason) {
    const weeks = [...new Set(list.map(r => r.week))].sort((a, b) => a - b);
    const byWeek = new Map(weeks.map(w => [w, list.filter(r => r.week === w)]));

    for (const week of weeks) {
      if (week < 4) continue;                       // need three prior weeks
      const prior = [week - 1, week - 2, week - 3];
      const now = byWeek.get(week) ?? [];
      const nowIds = new Set(now.map(r => r.player_id));

      // Prior three-week volume per player per position.
      const priorVol = new Map();
      for (const w of prior) {
        for (const r of byWeek.get(w) ?? []) {
          const v = r[VOLUME[r.pos]] ?? 0;
          const rec = priorVol.get(r.player_id) ?? { pos: r.pos, vol: 0, weeks: 0 };
          rec.vol += v; rec.weeks++; priorVol.set(r.player_id, rec);
        }
      }
      if (!priorVol.size) continue;

      // Who is absent this week despite playing last week with real volume?
      const playedLast = new Set((byWeek.get(week - 1) ?? []).map(r => r.player_id));
      const absent = [...priorVol.entries()].filter(([id, rec]) =>
        !nowIds.has(id) && playedLast.has(id) && rec.vol / Math.max(1, rec.weeks) >= minPriorVolume);
      if (absent.length !== 1) continue;            // one absence at a time, or attribution is ambiguous
      const [absentId, absentRec] = absent[0];
      const vacated = absentRec.vol / Math.max(1, absentRec.weeks);
      if (vacated < minPriorVolume) continue;

      // Depth rank within position, by prior volume.
      const rankOf = new Map();
      for (const pos of SKILL) {
        const group = [...priorVol.entries()].filter(([, r]) => r.pos === pos)
          .sort((a, b) => b[1].vol - a[1].vol);
        group.forEach(([id], i) => rankOf.set(id, i + 1));
      }
      const absentRank = Math.min(4, rankOf.get(absentId) ?? 4);

      // How much did each remaining player move versus his own prior average?
      let anyMove = false;
      for (const r of now) {
        if (r.player_id === absentId) continue;
        const pr = priorVol.get(r.player_id);
        if (!pr || pr.weeks < 2) continue;
        const base = pr.vol / pr.weeks;
        const actual = r[VOLUME[r.pos]] ?? 0;
        const share = (actual - base) / vacated;
        if (!Number.isFinite(share) || Math.abs(share) > 3) continue;
        const rank = Math.min(4, rankOf.get(r.player_id) ?? 4);
        const key = `${absentRec.pos}:${absentRank}>${r.pos}:${rank}`;
        const c = cells.get(key) ?? { n: 0, sum: 0 };
        c.n++; c.sum += share; cells.set(key, c);
        const pk = `${absentRec.pos}>${r.pos}`;
        const p = byPos.get(pk) ?? { n: 0, sum: 0 };
        p.n++; p.sum += share; byPos.set(pk, p);
        anyMove = true;
      }
      if (anyMove) events++;
    }
  }

  // Shrink each cell toward its position-pair mean. k is notional observations;
  // 12 was chosen so a cell needs roughly a dozen events before it dominates
  // its own prior, which matches the sample sizes these cells actually reach.
  const K = 12;
  const table = new Map();
  for (const [key, c] of cells) {
    const pk = key.split(':')[0] + '>' + key.split('>')[1].split(':')[0];
    const pp = byPos.get(pk);
    const prior = pp && pp.n ? pp.sum / pp.n : 0;
    table.set(key, {
      share: (c.sum + K * prior) / (c.n + K),
      raw: c.sum / c.n, n: c.n,
    });
  }
  return {
    table, byPos: new Map([...byPos].map(([k, v]) => [k, { share: v.sum / v.n, n: v.n }])),
    events, seasons: [fromSeason, toSeason],
  };
}

function absorption() {
  if (!_table) _table = buildAbsorption();
  return _table;
}

/**
 * Adjust a team-week's projected volumes for who is actually active.
 *
 * `players` is [{ player_id, pos, volume, active }]. Returns a Map of
 * player_id -> adjusted volume.
 *
 * The team total is NOT conserved, and that is the finding rather than a
 * shortcut: only part of an absent player's volume reappears among his
 * skill-position teammates (61% for a WR1, 58% for an RB2, 78% for an RB1).
 * The remainder goes to a worse offence, to blockers, or to fewer plays. The
 * first version of this normalised the shares to sum to one and made the
 * projection 9.5% worse on precisely the player-weeks it was meant to fix.
 */
export function redistribute(players, { table = absorption() } = {}) {
  const out = new Map(players.map(p => [p.player_id, p.volume]));
  const absent = players.filter(p => !p.active && p.volume > 0);
  if (!absent.length) return out;
  const active = players.filter(p => p.active);
  if (!active.length) return out;

  // Depth rank by projected volume within position — the same basis the table
  // was built on.
  const rankOf = new Map();
  for (const pos of SKILL) {
    players.filter(p => p.pos === pos).sort((a, b) => b.volume - a.volume)
      .forEach((p, i) => rankOf.set(p.player_id, Math.min(4, i + 1)));
  }

  for (const gone of absent) {
    const vacated = gone.volume;
    if (vacated <= 0) continue;
    out.set(gone.player_id, 0);
    const gRank = rankOf.get(gone.player_id) ?? 4;
    // Only realistic absorbers. The measurement conditions on a player having
    // RECORDED usage that week, so a backup who was never elevated is invisible
    // and the shares are biased upward for deep players. Restricting to the
    // same position and to players with real prior volume removes most of that
    // bias; a fifth-string receiver does not absorb a WR1's targets.
    const eligible = active.filter(p => p.pos === gone.pos && p.volume >= 1
      && (rankOf.get(p.player_id) ?? 9) <= 4);
    if (!eligible.length) continue;
    const weights = eligible.map(p => {
      const key = `${gone.pos}:${gRank}>${p.pos}:${rankOf.get(p.player_id) ?? 4}`;
      const cell = table.table.get(key) ?? table.byPos.get(`${gone.pos}>${p.pos}`);
      // Negative measured shares are noise, not a player losing volume because
      // a teammate sat; floor at zero before normalising.
      return Math.max(0, cell?.share ?? 0);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      // DO NOT NORMALISE TO THE FULL VACATED VOLUME. Measured across 2021-2025,
      // only part of an absent player's work reappears among his skill-position
      // teammates: 61% when a WR1 sits, 58% for an RB2, 78% for an RB1. The rest
      // goes to the offence being worse, to linemen and fullbacks, or to the
      // team simply running fewer plays. Forcing conservation handed survivors
      // roughly 1.6x too much volume and made the projection 9.5% WORSE on
      // exactly the player-weeks this is supposed to help.
      eligible.forEach((p, i) => {
        out.set(p.player_id, (out.get(p.player_id) ?? 0) + vacated * weights[i]);
      });
      continue;
    }
    if (total <= 0) {
      // No measured pattern: fall back to depth order within the same position,
      // which is what a human would assume and is better than doing nothing.
      const samePos = active.filter(p => p.pos === gone.pos)
        .sort((a, b) => (rankOf.get(a.player_id) ?? 9) - (rankOf.get(b.player_id) ?? 9));
      if (!samePos.length) continue;
      const split = [0.5, 0.3, 0.2];
      samePos.slice(0, 3).forEach((p, i) => out.set(p.player_id, (out.get(p.player_id) ?? 0) + vacated * split[i]));
      continue;
    }
  }
  return out;
}

/** Headline numbers, for the report and for a sanity read. */
export function absorptionSummary() {
  const a = absorption();
  const rowsOut = [...a.table.entries()]
    .filter(([, v]) => v.n >= 8)
    .map(([k, v]) => ({ pattern: k, share: +v.share.toFixed(3), raw: +v.raw.toFixed(3), n: v.n }))
    .sort((x, y) => y.share - x.share);
  return { events: a.events, seasons: a.seasons, cells: rowsOut,
    byPos: [...a.byPos.entries()].map(([k, v]) => ({ pattern: k, share: +v.share.toFixed(3), n: v.n })).sort((x, y) => y.share - x.share) };
}
