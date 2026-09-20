/**
 * Fit the Team Outlook model and store it, so the deployed app can score a
 * league it has no corpus for.
 *
 * Run this where the corpus is (a dev checkout with
 * `data/derived/sleeper_history.sqlite`), never on Fly: the runtime image copies
 * `client/dist`, `server` and `scripts` and never `data/`, which is exactly why
 * the fit has to be persisted instead of computed per request. See
 * `server/services/outlook-fit-store.js`.
 *
 *   node scripts/fit-team-outlook.mjs                      # fit and report, writes nothing
 *   node scripts/fit-team-outlook.mjs --write              # ... and store it as the active fit
 *   node scripts/fit-team-outlook.mjs --through 2025 --write
 *
 * A dry run by default because `--write` touches the application database. The
 * gate below is the reason this is a script and not a scheduled job: every
 * refusal here would otherwise be a fit that scores wrong in production, where
 * nobody reads stderr.
 *
 * This does NOT replace `scripts/audit-team-outlook.mjs`. That one holds the
 * pre-registered gate -- held-out seasons, calibration, the baselines -- and is
 * what says whether the model may be believed at all. This one fits the model
 * the audit already cleared, on every season the corpus has, and stores it.
 */
import { historyStatus, weeklyPanel, varianceComponents } from '../server/services/history-corpus.js';
import { fitOutlook, fitThresholds, signCheck, OUTLOOK_GATE } from '../server/services/team-outlook.js';
import { saveOutlookFit, outlookFitStatus } from '../server/services/outlook-fit-store.js';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const throughArg = argv.indexOf('--through');
const THROUGH = throughArg >= 0 ? Number(argv[throughArg + 1]) : null;

const die = (message, detail = null) => {
  console.error(`\nREFUSED: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
};

const status = historyStatus();
if (!status.available) die('there is no league-history corpus on this machine.', status.reason);

const seasons = status.seasons.map(s => s.season).filter(s => THROUGH == null || s <= THROUGH);
if (!seasons.length) die(`the corpus holds no season at or below ${THROUGH}.`);
const through = Math.max(...seasons);

console.log(`corpus: ${status.leagues} leagues, ${status.team_seasons} team-seasons, `
  + `seasons ${seasons.join(', ')}`);

const panel = weeklyPanel({ seasons });
if (!panel.length) die('the corpus produced no panel rows for those seasons.');

const vc = varianceComponents({ panel });
if (!vc) die('the variance decomposition returned nothing, so there is no k to fit with.');
if (!vc.between_positive || vc.k_capped) {
  // k at its cap is a real finding, not a number to fit with: it says no number of
  // games makes a record informative, so every points feature would shrink to zero.
  die(`k came out at its cap (${vc.k}).`, vc.reason);
}
console.log(`k = ${vc.k} from ${vc.team_seasons} team-seasons (avg ${vc.avg_games} games); `
  + `half weight at ${vc.games_for_half_weight} games`);

const fit = fitOutlook({ panel, k: vc.k, weeks: OUTLOOK_GATE.weeks, l2: OUTLOOK_GATE.l2 });
if (!fit?.weeks?.length) {
  die('no week model could be fitted.', `weeks wanted: ${OUTLOOK_GATE.weeks.join(', ')}; `
    + 'each needs 60 panel rows of its own.');
}

// Gate G4, on the fit that is about to be stored rather than on the audit's split:
// a coefficient whose sign disagrees with the direction of the world is a defect in
// the fit, and a stored defect is one that scores every league from now on.
const signs = fit.weeks.map(week => ({ week, ...signCheck(fit.byWeek[week]) }));
for (const s of signs) {
  console.log(`  week ${s.week}: n = ${fit.byWeek[s.week].n}, signs ${s.pass ? 'ok' : 'WRONG'}`
    + (s.pass ? '' : ` -- ${s.wrong.map(w => `${w.feature} ${w.expected}, got ${w.got}`).join('; ')}`));
}
const failed = signs.filter(s => !s.pass);
if (failed.length) {
  die(`${failed.length} of ${signs.length} week models have a coefficient with the wrong sign.`,
    'Fix the fit; do not store it. See gate G4 in docs/tdd/team-outlook.tdd.md.');
}

const thresholds = fitThresholds({ fit, panel });
if (!thresholds) die('no verdict thresholds could be fitted, so nothing could produce a verdict.');
console.log(`thresholds: watch <= ${thresholds.watch}, act_candidate <= ${thresholds.act_candidate} `
  + `(${thresholds.basis})`);

if (!WRITE) {
  console.log('\nDry run. Nothing was written. Re-run with --write to store this as the active fit.');
  process.exit(0);
}

const id = saveOutlookFit({
  fit, thresholds, through_season: through, l2: OUTLOOK_GATE.l2,
  provenance: {
    seasons, leagues: status.leagues, team_seasons: status.team_seasons,
    panel_rows: panel.length,
    k_basis: { k: vc.k, team_seasons: vc.team_seasons, avg_games: vc.avg_games,
      s2_within: vc.s2_within, s2_between: vc.s2_between },
    weeks: fit.weeks, signs_checked: true,
    fitted_by: 'scripts/fit-team-outlook.mjs',
    gate: 'scripts/audit-team-outlook.mjs holds the pre-registered gate; this stored fit had every week sign-checked'
  }
});

const stored = outlookFitStatus();
console.log(`\nstored fit ${id}, active, through ${stored.through_season}, weeks `
  + `${stored.weeks.join(', ')}, fitted_at ${stored.fitted_at}`);
