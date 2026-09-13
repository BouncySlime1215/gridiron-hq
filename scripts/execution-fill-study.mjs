#!/usr/bin/env node
/**
 * What a stake really fills at, and what a cheap Kalshi leg really costs.
 *
 * Two sections, and the difference between them is the point:
 *
 *   MEASURED   — `fillStudy()` over whatever order books the database at
 *                GRIDIRON_DB_PATH actually holds. On a scratch database this
 *                reports that there are none, which is the correct answer and
 *                is printed as such rather than substituted for.
 *
 *   ARITHMETIC — closed-form tables. These are not simulations and not
 *                measurements: given a touch price, a depth and a stake, the
 *                fill and the surviving edge are determined, and the tables
 *                just evaluate that. They say what the answer WOULD be at each
 *                depth; which depths Polymarket actually quotes is precisely
 *                the part that needs the real books.
 *
 *   GRIDIRON_DB_PATH=/tmp/fresh.sqlite SCHEDULER_DISABLED=1 \
 *     NODE_OPTIONS='--import ./test/offline-guard.mjs' \
 *     node scripts/execution-fill-study.mjs
 *
 * Calls no network. Reads only the database it is pointed at.
 */
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
if (!process.env.GRIDIRON_DB_PATH) {
  console.error('Refusing to run without GRIDIRON_DB_PATH.');
  process.exit(1);
}

const { fromStoredQuote, fillShortfall, POLYMARKET_LADDER_NOTE } =
  await import(path.join(root, 'server/services/execution-fill.js'));
const kalshi = await import(path.join(root, 'server/services/kalshi-adverse-selection.js'));

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const line = n => console.log('='.repeat(n));

/* ------------------------------------------------------------------ measured */

line(96);
console.log('SECTION 1 — MEASURED, on the order books this database actually holds');
line(96);
try {
  await (await import(path.join(root, 'server/db/migrate.js'))).runMigrations();
  const pm = await import(path.join(root, 'server/services/polymarket.js'));
  const study = pm.fillStudy({ stake: 500, edge: 0.03, naiveAtMid: true });
  if (study.error) {
    console.log(`no measurement available: ${study.error}`);
    console.log(`hint: ${study.hint ?? '-'}`);
    console.log(`\n${study.ladder_note ?? POLYMARKET_LADDER_NOTE}`);
  } else {
    console.log(`markets ${study.markets}  (full ladder ${study.full_ladder_markets}, ` +
      `touch-only ${study.touch_only_markets})   stake $${study.stake}, assumed edge ${study.assumed_edge}`);
    for (const [label, block] of [['full ladder (exact)', study.exact],
      ['touch-only (BEST CASE)', study.best_case_from_touch_only_books]]) {
      if (!block) { console.log(`  ${label}: none`); continue; }
      console.log(`  ${pad(label, 26)} markets ${padL(block.markets, 4)}  ` +
        `mean fill ${padL(block.mean_fill_ratio, 7)}  fully filled ${padL(block.markets_fully_filled, 4)}  ` +
        `mean edge surviving ${padL(block.mean_profit_realised, 8)}  ` +
        `naive $${block.naive_total_profit} -> real $${block.real_total_profit}`);
    }
    console.log('\n  worst markets by surviving edge:');
    for (const w of study.worst.slice(0, 10)) {
      console.log(`    ${pad(w.question, 56)} fill ${padL(w.fill_ratio, 7)} ` +
        `avg ${padL(w.avg_price, 7)} keeps ${padL(w.profit_realised_fraction, 8)} ${w.bound}`);
    }
  }
} catch (error) {
  console.log(`no measurement available: ${error.message}`);
}

/* ---------------------------------------------------------------- arithmetic */

console.log();
line(96);
console.log('SECTION 2 — ARITHMETIC: surviving edge as a function of depth, for a touch-only book');
line(96);
console.log('A 0.50 contract, a 3-point claimed edge, priced naively at the mid as live-edge.js does.');
console.log('"keeps" is the share of the claimed edge a fill would actually pay. Depth is level-one');
console.log('size in contracts, which is the only depth number stored history has.\n');

const TOUCH = 0.50, BID = 0.49, EDGE = 0.03;
const DEPTHS = [15, 50, 100, 250, 500, 1000, 2000, 5000];
const STAKES = [50, 100, 250, 500, 1000, 2500];

console.log(pad('depth', 9) + STAKES.map(s => padL(`$${s}`, 11)).join(''));
console.log('-'.repeat(9 + STAKES.length * 11));
for (const depth of DEPTHS) {
  const book = fromStoredQuote({ best_bid: BID, best_ask: TOUCH, bid_size: depth, ask_size: depth });
  const cells = STAKES.map(stake => {
    const r = fillShortfall({ book, side: 'buy', shares: stake / TOUCH,
      fairValue: TOUCH + EDGE, naivePrice: (BID + TOUCH) / 2 });
    return padL(r.profit_realised_fraction, 11);
  });
  console.log(pad(depth, 9) + cells.join(''));
}
// Every number in the commentary below is computed, not asserted.
const deepBook = fromStoredQuote({ best_bid: BID, best_ask: TOUCH, bid_size: 1e9, ask_size: 1e9 });
const ceiling = fillShortfall({ book: deepBook, side: 'buy', shares: 100,
  fairValue: TOUCH + EDGE, naivePrice: (BID + TOUCH) / 2 }).profit_realised_fraction;
const thin = fromStoredQuote({ best_bid: BID, best_ask: TOUCH, bid_size: 15, ask_size: 15 });
const at500 = fillShortfall({ book: thin, side: 'buy', shares: 500 / TOUCH,
  fairValue: TOUCH + EDGE, naivePrice: (BID + TOUCH) / 2 });

console.log('\nTwo things this table is saying, neither of which needs a measurement to be true:');
console.log(`  - Above the diagonal the whole stake sits inside the touch and the only cost left is`);
console.log(`    the half-spread, which caps the surviving edge at ${ceiling} here however deep the`);
console.log(`    book is. ${((1 - ceiling) * 100).toFixed(1)}% of this edge is gone before depth costs anything at all, and no`);
console.log('    amount of depth recovers it — that part is the spread, and the two are separable.');
console.log('  - Below it the fill is capped and the shortfall is linear in depth/stake. At 15');
console.log('    contracts — the size the cited research finds most combinatorial arbitrage episodes');
console.log(`    capped at — a $500 stake fills ${(at500.fill_ratio * 100).toFixed(1)}% of itself and keeps ${at500.profit_realised_fraction} of its`);
console.log('    claimed edge, i.e. the screen figure is overstated by about ' +
  `${Math.round(1 / at500.profit_realised_fraction)}x.`);

console.log('\n' + '-'.repeat(96));
console.log('The same arithmetic for a multi-leg package: size is the MINIMUM across legs.');
console.log('-'.repeat(96));
console.log('legs      thinnest leg 15    thinnest leg 100   thinnest leg 1000');
for (const legs of [2, 3, 4, 6]) {
  const cells = [15, 100, 1000].map(minDepth => {
    const want = 1000;                     // contracts per leg the screen claims
    return padL(`${((Math.min(minDepth, want) / want) * 100).toFixed(1)}%`, 19);
  });
  console.log(pad(legs, 10) + cells.join(''));
}
console.log('\nThe leg count does not appear in the answer, which is the whole point: a package of any');
console.log('width is capped by its single thinnest leg, so adding legs to a structure adds risk and');
console.log('fee without adding size. A four-leg arbitrage quoting $4,000 of edge against one 15-lot');
console.log('leg is a $60 trade.');

/* ------------------------------------------------------------------ kalshi */

console.log();
line(96);
console.log('SECTION 3 — ARITHMETIC: the Kalshi long-shot haircut against the fee that is already priced');
line(96);
const sens = kalshi.haircutSensitivity();
console.log(`anchor: ${sens.anchor.source}`);
console.log(`measured in this repository: ${sens.anchor.is_measured_here}   default exponent: ${sens.default_exponent}\n`);
console.log(pad('price', 9) + pad('h (c=1)', 11) + pad('h (c=3)', 11) + pad('h (c=5)', 11) +
  pad('fee/contract', 15) + pad('adverse $/contract', 20) + 'all-in cost as % of stake');
console.log('-'.repeat(105));
for (const r of sens.rows) {
  const leg = kalshi.applyKalshiHaircut({ price: r.price, contracts: 100 });
  console.log(pad(r.price, 9) + pad(r.c1, 11) + pad(r.c3, 11) + pad(r.c5, 11) +
    pad(leg.fee_per_contract, 15) + pad(leg.adverse_selection_cost_per_contract, 20) +
    `${(leg.all_in_cost_fraction * 100).toFixed(1)}%`);
}
console.log('\nBOOKS for reference (from venueCostComparison): lowvig 3.09%, DraftKings 4.59%,');
console.log('BetRivers 5.54%, Kalshi fee-only all-in 4.15%.\n');
console.log('The two costs have opposite shapes. The fee peaks at even money, where the haircut is');
console.log('zero; the haircut peaks at the extremes, where the fee rounds to almost nothing. A venue');
console.log('comparison that prices only the fee therefore rates a five-cent contract as the cheapest');
console.log('thing on the board when it is the dearest by an order of magnitude.');
console.log('\nThe spread across the c columns at a given price is the part of this curve that is a');
console.log('modelling choice rather than a measurement, and at 20 cents it is 6% versus 34%.');
