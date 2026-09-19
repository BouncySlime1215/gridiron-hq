/**
 * TEST 6 -- Jev as an adversarial research auditor.
 *
 * Every recorded finding in EDGE-TEST-REGISTRY.md plus the empirical and code-defect findings in
 * the F-series docs is rendered as STATE (claim + the method that produced the recorded verdict)
 * and scored on five methodological guardrails plus an ordered soundness score.
 *
 * Three replicates per finding, so Jev's own self-consistency is measured rather than assumed.
 *
 * Usage: set -a; . ./.env.local; set +a; npx tsx scripts/model-lab/jev_research_auditor.mts
 */
import { experimental_evaluate as evaluate } from 'ai';
import { FINDINGS } from './audit_corpus.js';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, 'jev_audit_results.json');
const CONCURRENCY = 8;
const REPLICATES = 3;
const MAX_USD = Number(process.env.JEV_MAX_USD ?? 1.0);

const PREAMBLE =
  'You are auditing the METHOD of a quantitative sports-betting research finding, not the ' +
  'conclusion. Judge only what the description actually states was done. Absence of evidence ' +
  'that a control was run counts as the control not having been run.';

const QUESTIONS = {
  has_placebo: {
    type: 'boolean' as const,
    instructions:
      'Did this work run a PLACEBO or null control -- shuffling the labels, randomising the ' +
      'signal direction, permuting the timestamps, or matching each real event to a fake event ' +
      'at a comparable time -- and compare the real result against that null distribution? ' +
      'Reporting an expected count of false positives under a pure null also counts. Merely ' +
      'splitting the data, reporting a t statistic, or testing a second parameter setting does NOT.',
  },
  is_price_aware: {
    type: 'boolean' as const,
    instructions:
      'Was the result computed from REAL POSTED PRICES actually available at the moment of the ' +
      'bet -- the book\'s own juice, a real bid-ask crossed, an exchange fee schedule applied, ' +
      'or a measured overround? Answer no if the expected value used a flat assumed price such ' +
      'as -110, if the metric is closing-line value measured on LINES ONLY with no price term, ' +
      'if a price column was fetched but not used, or if the price the strategy needs is not ' +
      'held in the data at all.',
  },
  game_clustered: {
    type: 'boolean' as const,
    instructions:
      'Were the standard errors, confidence intervals or effective sample size adjusted for the ' +
      'fact that many bets, quotes or minutes come from the SAME GAME and are not independent? ' +
      'Clustering by game, bootstrapping by game, collapsing to one bet per game, or explicitly ' +
      'treating the game count rather than the row count as the effective n all count. Merely ' +
      'reporting how many games are in the sample does NOT count.',
  },
  has_baseline_control: {
    type: 'boolean' as const,
    instructions:
      'Does the work include a REFERENCE ARM that should return a known value, against which the ' +
      'headline number is read? Examples: a bet-everything baseline that must return roughly ' +
      'minus the vig, a random-selection arm, a base rate the result is compared against, an ' +
      'a-priori arithmetic prediction of what the strategy should return, or a control cut that ' +
      'was confirmed unchanged after a fix. A break-even threshold quoted alone does NOT count.',
  },
  multiplicity_corrected: {
    type: 'boolean' as const,
    instructions:
      'Does the work account for how many things were tried? A Bonferroni, Sidak, ' +
      'Benjamini-Hochberg or other corrected threshold; a preregistered and fully enumerated ' +
      'family where every test is reported; an explicit running count of prior hypotheses folded ' +
      'into the bar; or an explicit statement that the result fails such a corrected bar. ' +
      'Reporting several parameter settings without adjusting the threshold does NOT count.',
  },
  methodological_soundness: {
    type: 'score' as const,
    instructions:
      'Overall, how sound is the method that produced this recorded verdict -- judged against ' +
      'what THIS KIND of claim requires? A code-logic claim needs exact cited lines and a ' +
      're-runnable check, not a placebo. A market backtest needs real prices, a null control, ' +
      'non-independence handled and the search burden accounted for. A kill needs to be at ' +
      'least as rigorous as the claim it is killing.',
    criteria: [
      'Fatally flawed: the stated method cannot support the stated claim. A load-bearing quantity is assumed, hardcoded, unused, or known to be wrong, or the result is an artifact of the selection rule itself.',
      'Serious gaps: the claim may be true but several controls essential to it are missing, the sample is too small to carry the conclusion, or the key number is unquantified.',
      'Adequate: the main quantity is measured honestly and the main limitation is stated, but at least one important control is absent or unreported.',
      'Rigorous: real prices or a directly checkable quantity, dependence handled, a control arm or null present, and the limits stated precisely.',
      'Exemplary: multiple independent attacks, a reference arm that reproduces a known value, stated limits, and the result reconciled against other measurements or explained by a mechanism.',
    ],
  },
  finding_kind: {
    type: 'choice' as const,
    instructions: 'What kind of claim is being audited here?',
    criteria: {
      market_backtest: 'A historical or forward measurement of whether a betting strategy makes or loses money, or of a market property measured from price data.',
      refutation: 'A kill, refutation, withdrawal or qualification of a previously recorded betting claim.',
      code_defect: 'A defect in source code, identified by reading the code rather than by measuring data.',
      other: 'Anything else, including literature arguments, design proposals and label spot-checks.',
    },
  },
};

const SOUND = ['fatally_flawed', 'serious_gaps', 'adequate', 'rigorous', 'exemplary'];

type Row = {
  id: string; rep: number;
  has_placebo: number; is_price_aware: number; game_clustered: number;
  has_baseline_control: number; multiplicity_corrected: number;
  sound_mean: number; sound_probs: Record<string, number>;
  kind: string; kind_probs: Record<string, number>;
  tokens: number;
};

const jobs: { f: typeof FINDINGS[number]; rep: number }[] = [];
for (const f of FINDINGS) for (let r = 0; r < REPLICATES; r++) jobs.push({ f, rep: r });
console.log(`${FINDINGS.length} findings x ${REPLICATES} replicates = ${jobs.length} evaluations`);

const rows: Row[] = [];
let cursor = 0, tokens = 0, failed = 0, stop = false;

async function worker() {
  while (!stop) {
    const i = cursor++;
    if (i >= jobs.length) return;
    const { f, rep } = jobs[i];
    try {
      const res: any = await evaluate({
        model: 'typesafe-ai/jev',
        state: `${PREAMBLE}\n\nFINDING: ${f.title}\n\n${f.state}`,
        questions: QUESTIONS,
      });
      const a = res.answers as Record<string, any>;
      const sp: Record<string, number> = {};
      for (const [k, v] of Object.entries((a.methodological_soundness?.probabilities ?? {}) as Record<string, number>)) {
        sp[SOUND[Number(k)] ?? k] = v;
      }
      rows.push({
        id: f.id, rep,
        has_placebo: a.has_placebo?.probability ?? NaN,
        is_price_aware: a.is_price_aware?.probability ?? NaN,
        game_clustered: a.game_clustered?.probability ?? NaN,
        has_baseline_control: a.has_baseline_control?.probability ?? NaN,
        multiplicity_corrected: a.multiplicity_corrected?.probability ?? NaN,
        sound_mean: a.methodological_soundness?.score ?? NaN,
        sound_probs: sp,
        kind: a.finding_kind?.choice ?? '',
        kind_probs: (a.finding_kind?.probabilities ?? {}) as Record<string, number>,
        tokens: res.usage?.inputTokens ?? 0,
      });
      tokens += res.usage?.inputTokens ?? 0;
      if (rows.length % 25 === 0) {
        console.log(`  ${rows.length}/${jobs.length}  ${tokens.toLocaleString()} tok (~$${((tokens / 1e6) * 0.042).toFixed(4)})`);
        if ((tokens / 1e6) * 0.042 > MAX_USD) { console.log('budget reached'); stop = true; return; }
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      failed++;
      console.log(`  FAIL ${f.id} rep${rep}: ${msg.slice(0, 140)}`);
      if (/authentication|not have access|free tier/i.test(msg)) { stop = true; return; }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
fs.writeFileSync(OUT, JSON.stringify({ rows, tokens, failed }, null, 1));
console.log(`done: ${rows.length} evaluations, ${failed} failed, ${tokens.toLocaleString()} input tokens (~$${((tokens / 1e6) * 0.042).toFixed(4)})`);
console.log(`wrote ${OUT}`);
