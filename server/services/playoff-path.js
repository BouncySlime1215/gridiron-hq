/**
 * PLAYOFF-SEEDING (plan items 47 + 48): what a playoff spot and each seed are worth,
 * how many wins get a team there, and which remaining weeks are must-win.
 *
 * Not a second simulator. season-sim.js#playSeasons (the one producer of playoff and
 * title odds) hands each run's week results, final records and bracket scorer to the
 * collector below, which replays only the cheap parts of that same run:
 *
 *   - seed value: the run's bracket re-played with the team placed at seed s (the
 *     others keep their order), for every s. Same football, so seed-vs-seed and
 *     bye-vs-no-bye differences are paired.
 *   - must-win: the run's standings re-seeded with one of the team's games forced to
 *     a win and to a loss (everything else in the run unchanged), then its bracket
 *     re-played on the new field. A counterfactual, so a run where the team is simply
 *     strong does not inflate a week's leverage.
 *   - win targets: P(playoffs | final wins = k), read off the runs as they finished.
 *
 * Every probability carries its run-to-run Monte Carlo SE (paired where it is a
 * difference). The pre-registration and pass bar: docs/tdd/PLAYOFF-SEEDING-PREREG.md.
 *
 * GRIDIRON_PLAYOFF_SEEDING: unset / '0' = off (playSeasons is unchanged); 'shadow'
 * (or '1') = computed and written to plans.json _run.inputs.playoff_path, never served.
 * Preview mode does not turn it on.
 */

export const PLAYOFF_PATH_ENV = 'GRIDIRON_PLAYOFF_SEEDING';

/** Must-win rule, fixed in the pre-registration (no sweep). */
export const MUST_WIN_MIN_LEVERAGE = 0.10;
export const MUST_WIN_TOP = 3;
export const MUST_WIN_SE = 2;
/** ...and stand out: at least this multiple of the median remaining week's leverage. */
export const MUST_WIN_VS_MEDIAN = 1.25;
/** A win total counts toward a target only with at least this many runs. */
export const TARGET_MIN_RUNS = 20;

/** 'off' | 'shadow', read per call so a test or a run can flip it. */
export function playoffPathMode(env = process.env) {
  const v = env[PLAYOFF_PATH_ENV];
  return v === 'shadow' || v === '1' ? 'shadow' : 'off';
}

/** Seeds that skip round 1: bracket slots past the field are byes for the top seeds. */
export function byeSeedCount(fieldSize, rounds) {
  return Math.max(0, Math.min(fieldSize, 2 ** rounds - fieldSize));
}

const r4 = x => +x.toFixed(4);
const seOf = (p, n) => (n > 0 ? r4(Math.sqrt(Math.max(0, p * (1 - p)) / n)) : null);

/** Mean and SE of per-run values (sum and sum of squares over n runs). */
function meanSe(sum, sq, n) {
  if (n < 2) return { mean: n ? r4(sum / n) : null, se: null };
  const mean = sum / n;
  const variance = Math.max(0, (sq - n * mean * mean) / (n - 1));
  return { mean: r4(mean), se: r4(Math.sqrt(variance / n)) };
}

/**
 * @param ids         roster ids (strings), every team in the league
 * @param runs        runs playSeasons will play
 * @param weeks       remaining regular-season NFL weeks (the sim's `weeks`)
 * @param sched       Map week -> [[a, b], ...] fixtures
 * @param startingRecords Map id -> { w, pf } carried in before `weeks`
 * @param playoffTeams field size
 * @param rounds      bracket rounds (playoff_weeks.length)
 * @param seed        (standings [{id, w, pf}]) -> ids in seed order (league-rules.js#seedStandings)
 * @param bracket     (field, scoreFor) -> { champion } (season-sim.js#playBracket with the league's format)
 */
export function playoffPathCollector({ ids, runs, weeks, sched, startingRecords, playoffTeams, rounds, seed, bracket }) {
  const byes = byeSeedCount(playoffTeams, rounds);
  const nSeeds = playoffTeams;
  const remaining = new Map(ids.map(id => [id, weeks.filter(w => (sched.get(w) ?? []).some(([a, b]) => a === id || b === id))]));
  const T = new Map(ids.map(id => {
    const wk = remaining.get(id);
    return [id, {
      finish: new Array(nSeeds).fill(0), // runs finishing at seed s
      titleAt: new Array(nSeeds).fill(0), // title count if placed at seed s
      byeDiffSum: 0, byeDiffSq: 0, // per-run (mean title at bye seeds) - (mean at the rest)
      seedGain: Array.from({ length: Math.max(0, nSeeds - 1) }, () => ({ sum: 0, sq: 0 })), // seed s over s+1
      playoffs: 0, titles: 0, titlesIn: 0,
      byWins: new Map(), // wins -> { n, playoffs, bye }
      weeks: new Map(wk.map(w => [w, { opp: null, wins: 0, ties: 0, pWinSum: 0, pLossSum: 0, dP: { sum: 0, sq: 0 }, dT: { sum: 0, sq: 0 }, tWinSum: 0, tLossSum: 0 }])),
      monotoneBreaks: 0, identityBreaks: 0
    }];
  }));
  // The current run's head-to-head results: week -> Map id -> { opp, r } (r: 1 win, 0.5 tie, 0 loss).
  let results = new Map();

  return {
    /** One regular-season week of the current run, after its scores are known. */
    week(week, weekScore) {
      const m = new Map();
      for (const [a, b] of sched.get(week) ?? []) {
        const sa = weekScore.get(a) ?? 0, sb = weekScore.get(b) ?? 0;
        const ra = sa > sb ? 1 : sa < sb ? 0 : 0.5;
        m.set(a, { opp: b, r: ra }); m.set(b, { opp: a, r: 1 - ra });
      }
      results.set(week, m);
    },

    /**
     * The end of the current run's regular season and bracket.
     * record: Map id -> { w, pf } final; field: the served seeded field; champion: the served
     * bracket's winner; scoreFor(id, roundWeeks) -> points (this run's).
     */
    add(record, field, champion, scoreFor) {
      const memo = new Map();
      const champ = f => {
        const key = f.join('|');
        if (!memo.has(key)) memo.set(key, bracket(f, scoreFor).champion ?? null);
        return memo.get(key);
      };
      memo.set(field.join('|'), champion);
      const base = ids.map(id => ({ id, w: record.get(id).w, pf: record.get(id).pf }));
      const order = seed(base);
      const fieldOf = standings => seed(standings).slice(0, playoffTeams);

      for (const id of ids) {
        const t = T.get(id);
        const s = order.indexOf(id); // 0-based finishing seed
        const inField = s < playoffTeams;
        const wins = record.get(id).w;
        const b = t.byWins.get(wins) ?? t.byWins.set(wins, { n: 0, playoffs: 0, bye: 0 }).get(wins);
        b.n++;
        if (inField) { t.playoffs++; t.finish[s]++; b.playoffs++; if (s < byes) b.bye++; }
        if (champion === id) { t.titles++; if (inField) t.titlesIn++; }

        // 47: the bracket with this team placed at every seed.
        const rest = field.filter(x => x !== id);
        const at = new Array(nSeeds);
        for (let k = 0; k < nSeeds; k++) {
          const f = [...rest.slice(0, k), id, ...rest.slice(k)].slice(0, playoffTeams);
          at[k] = champ(f) === id ? 1 : 0;
          t.titleAt[k] += at[k];
        }
        if (inField && at[s] !== (champion === id ? 1 : 0)) t.identityBreaks++;
        if (byes > 0 && byes < nSeeds) {
          let hi = 0, lo = 0;
          for (let k = 0; k < nSeeds; k++) (k < byes ? (hi += at[k]) : (lo += at[k]));
          const d = hi / byes - lo / (nSeeds - byes);
          t.byeDiffSum += d; t.byeDiffSq += d * d;
        }
        for (let k = 0; k + 1 < nSeeds; k++) { const d = at[k] - at[k + 1]; t.seedGain[k].sum += d; t.seedGain[k].sq += d * d; }

        // 48: each remaining game forced to a win and to a loss.
        for (const [w, acc] of t.weeks) {
          const g = results.get(w)?.get(id);
          if (!g) continue;
          acc.opp = g.opp;
          if (g.r === 1) acc.wins++; else if (g.r === 0.5) acc.ties++;
          const forced = r => {
            const st = base.map(x => (x.id === id ? { ...x, w: x.w + (r - g.r) }
              : x.id === g.opp ? { ...x, w: x.w + (g.r - r) } : x));
            const f = fieldOf(st);
            const p = f.includes(id) ? 1 : 0;
            return { p, t: p ? (champ(f) === id ? 1 : 0) : 0 };
          };
          const win = forced(1), loss = forced(0);
          acc.pWinSum += win.p; acc.pLossSum += loss.p; acc.tWinSum += win.t; acc.tLossSum += loss.t;
          const dp = win.p - loss.p, dt = win.t - loss.t;
          if (dp < 0) t.monotoneBreaks++;
          acc.dP.sum += dp; acc.dP.sq += dp * dp; acc.dT.sum += dt; acc.dT.sq += dt * dt;
        }
      }
      results = new Map();
    },

    result() {
      const teams = {};
      for (const id of ids) {
        const t = T.get(id);
        const start = startingRecords.get(id)?.w ?? 0;
        const rem = remaining.get(id).length;
        const seeds = t.finish.map((c, k) => {
          const p = c / runs, q = t.titleAt[k] / runs;
          return { seed: k + 1, bye: k < byes, p_finish: r4(p), p_finish_se: seOf(p, runs), title_if_seed: r4(q), title_if_seed_se: seOf(q, runs) };
        });
        const po = t.playoffs / runs;
        const titleIn = t.playoffs ? t.titlesIn / t.playoffs : null;
        const bye = byes > 0 && byes < nSeeds ? meanSe(t.byeDiffSum, t.byeDiffSq, runs) : null;

        const table = [...t.byWins.entries()].sort((a, b) => a[0] - b[0]).map(([w, b]) => {
          const p = b.playoffs / b.n, q = b.bye / b.n;
          return { wins: w, n: b.n, p_playoffs: r4(p), p_playoffs_se: seOf(p, b.n), ...(byes ? { p_bye: r4(q), p_bye_se: seOf(q, b.n) } : {}) };
        });
        const target = (key, bar) => {
          const row = table.find(r => r.n >= TARGET_MIN_RUNS && r[key] >= bar);
          return row
            ? { wins: row.wins, more_needed: Math.max(0, row.wins - start), p: row[key], se: row[`${key}_se`], n: row.n }
            : { wins: null, reason: `no win total with at least ${TARGET_MIN_RUNS} runs reaches ${bar * 100}%` };
        };
        const p50 = target('p_playoffs', 0.5);

        const weekRows = [...t.weeks.entries()].map(([w, a], j) => {
          const pw = (a.wins + 0.5 * a.ties) / runs;
          const lev = meanSe(a.dP.sum, a.dP.sq, runs), tlev = meanSe(a.dT.sum, a.dT.sq, runs);
          return {
            week: w, opponent: a.opp,
            p_win: r4(pw), p_win_se: seOf(pw, runs),
            playoff_if_win: r4(a.pWinSum / runs), playoff_if_loss: r4(a.pLossSum / runs),
            leverage: lev.mean, leverage_se: lev.se,
            title_if_win: r4(a.tWinSum / runs), title_if_loss: r4(a.tLossSum / runs),
            title_leverage: tlev.mean, title_leverage_se: tlev.se,
            on_pace_wins: p50.wins == null ? null : start + Math.ceil(p50.more_needed * (j + 1) / Math.max(1, rem)),
            // A guess, not a fitted rule: a favourite protects its floor, an underdog needs variance.
            posture: { mode: pw >= 0.5 ? 'protect_floor' : 'chase_ceiling', guess: true }
          };
        });
        const sorted = [...weekRows].sort((a, b) => b.leverage - a.leverage);
        const top = new Set(sorted.slice(0, MUST_WIN_TOP).map(r => r.week));
        const mid = sorted.length ? (sorted[(sorted.length - 1) >> 1].leverage + sorted[sorted.length >> 1].leverage) / 2 : null;
        for (const r of weekRows) {
          r.must_win = top.has(r.week) && r.leverage >= MUST_WIN_MIN_LEVERAGE && r.leverage >= MUST_WIN_VS_MEDIAN * mid
            && r.leverage_se != null && r.leverage - MUST_WIN_SE * r.leverage_se > 0;
        }

        teams[id] = {
          spot: {
            playoff_odds: r4(po), playoff_odds_se: seOf(po, runs),
            title_if_in: titleIn == null ? null : r4(titleIn), title_if_in_se: titleIn == null ? null : seOf(titleIn, t.playoffs)
          },
          seeds,
          bye_value: bye ? { title_gain: bye.mean, se: bye.se } : null,
          seed_gain: t.seedGain.map((g, k) => { const m = meanSe(g.sum, g.sq, runs); return { from_seed: k + 2, to_seed: k + 1, title_gain: m.mean, se: m.se }; }),
          win_targets: {
            current_wins: start, remaining_games: rem,
            playoffs_50: p50, playoffs_90: target('p_playoffs', 0.9),
            ...(byes ? { bye_50: target('p_bye', 0.5) } : {}),
            table
          },
          weeks: weekRows,
          leverage_median: mid == null ? null : r4(mid),
          must_win_weeks: weekRows.filter(r => r.must_win).map(r => r.week),
          checks: { monotone_breaks: t.monotoneBreaks, identity_breaks: t.identityBreaks }
        };
      }
      return {
        flag: 'shadow', runs, playoff_teams: playoffTeams, bye_seeds: byes,
        estimator: 'indicator, counterfactual on the same runs',
        se_basis: 'run-to-run Monte Carlo SE (paired for differences); excludes the shared error of the fixed per-player outcome pools',
        must_win_rule: { min_leverage: MUST_WIN_MIN_LEVERAGE, top: MUST_WIN_TOP, clears_se: MUST_WIN_SE, vs_median: MUST_WIN_VS_MEDIAN },
        teams
      };
    }
  };
}

/** The planner's copy: one team's block plus the run metadata, or null when the world has none. */
export function playoffPathFor(base, me) {
  const pp = base?.playoff_path;
  const team = pp?.teams?.[String(me)];
  if (!team) return null;
  const { teams, ...meta } = pp;
  return { ...meta, me: String(me), ...team };
}
