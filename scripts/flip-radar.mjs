#!/usr/bin/env node
/**
 * FLIP-01: run the flip radar once and print a summary safe to post publicly:
 * counts, timings, team ids, positions and numbers only (no player, manager or
 * league names). Writes one flip_map_snapshots row like the nightly job does.
 *
 * Usage (on a DB copy):
 *   <preview-mode.js PREVIEW_ENV>=1 SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy> \
 *     node scripts/flip-radar.mjs [--league 4] [--tick]
 * --tick runs the scheduler's decision (nightly / news / skip) instead of forcing a run.
 */
process.env.SCHEDULER_DISABLED = '1';
const argv = process.argv.slice(2);
const at = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const leagueId = Number(at('--league') ?? 4);

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const radar = await import('../server/services/flip-radar/flip-radar.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const t0 = Date.now();
const out = argv.includes('--tick')
  ? await radar.flipRadarTick({ leagueId })
  : await radar.runFlipRadar({ leagueId, trigger: 'manual' });
console.log(JSON.stringify({ league: leagueId, ...out, wall_ms: Date.now() - t0 }));

const snap = radar.latestFlipMap(leagueId);
if (snap) {
  const { flip_map, names } = radar.flipMapEntry(leagueId);
  // Every other section 'unknown': only flip_map is this producer's.
  const { SECTIONS } = await import('../server/services/campaign/plans-schema.js');
  const entry = { league: leagueId, me: 'me', names,
    ...Object.fromEntries(Object.keys(SECTIONS).map(k => [k, { status: 'unknown', reason: 'not this producer', source: 'campaign.plan' }])),
    flip_map };
  const v = validateLeague(entry);
  console.log(`contract: ${v.ok ? 'valid' : `INVALID ${JSON.stringify(v.errors.slice(0, 5))}`}`);
  const pos = id => /\(([A-Z]+)\)$/.exec(names[id] ?? '')?.[1] ?? '?';
  const pct = f => (f?.status === 'ok' ? `${(f.value * 100).toFixed(2)}%` : 'n/a');
  const p = f => (f?.status === 'ok' ? f.value.toFixed(2) : 'n/a');
  console.log(`snapshot ${snap.id} ${snap.trigger} pairs=${snap.pairs_n} flips=${snap.flips_n} days_to_deadline=${snap.days_to_deadline ?? 'unknown'} rescores=${snap.rescores} runtime_ms=${snap.runtime_ms}`);
  for (const f of (snap.section.value ?? []).slice(0, 5)) {
    console.log(`  ${pos(f.player)} team ${f.buy_from} -> team ${f.sell_to}: spread ${pct(f.spread)} (se ${f.spread.se != null ? (f.spread.se * 100).toFixed(2) + '%' : 'n/a'}, clears ${f.spread.clears_2se ?? 'n/a'})`
      + (f.legs ? ` | legs ${pos(f.legs.give_a)}->A, ${pos(f.legs.get_b)}<-B, p1 ${p(f.legs.p1)} p2 ${p(f.legs.p2)} p_both ${p(f.legs.p_both)} nick_after ${pct(f.legs.nick_after)}`
        : ` | ${f.legs_why_not}`));
  }
  const mgr = Object.entries(snap.managers).map(([t, list]) => `team ${t}: ${list.length} players, mean clone mult ${(list.reduce((s, x) => s + x.mult, 0) / (list.length || 1)).toFixed(3)}`);
  console.log(mgr.join('\n'));
} else {
  const last = radar.lastSnapshot(leagueId);
  console.log(`no good snapshot; last error: ${last?.error ?? 'none'}`);
}
