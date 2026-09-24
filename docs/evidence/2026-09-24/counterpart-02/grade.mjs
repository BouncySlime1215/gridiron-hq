// COUNTERPART-02 metric (c): walk-forward log loss of the simulated reply vs the league's decided offers.
// usage: node grade.mjs <db copy> [leagueId=4]
import { DatabaseSync } from 'node:sqlite';
const WT = process.env.CP02_TREE ?? process.cwd(); // a checkout with counterpart-02-impl.patch applied
const M = await import(`${WT}/server/services/campaign/opponent-model.js`);
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const lid = Number(process.argv[3] ?? 4);
const leagues = lid === 0 ? db.prepare('SELECT id FROM leagues').all().map(r => r.id) : [lid];
const rowsAll = [];
for (const L of leagues) {
  const rows = db.prepare(`SELECT tx_id,type,status,execution_type,team_id,member_id,related_tx_id,items_json,raw_json FROM league_transactions_raw
    WHERE league_id=? AND season=2026 AND type LIKE 'TRADE%'`).all(L);
  const offers = M.classifyOffers(rows).map(o => ({ ...o, league: L }));
  rowsAll.push({ L, offers });
}
const ll = (p, y) => -(y ? Math.log(Math.max(p, 1e-6)) : Math.log(Math.max(1 - p, 1e-6)));
const graded = [];
for (const { L, offers } of rowsAll) {
  const dec = offers.filter(o => o.decided != null);
  for (const o of dec) {
    const rm = M.replyModel(offers, o.T);            // only offers resolved before this one was sent
    const own = rm.byTeam.get(o.receiver)?.reply ?? rm.league;
    const flat = M.pYesDecided(M.REPLY_PRIOR);
    const known = M.knownBefore(offers, o.T).filter(x => x.decided != null);
    const base = (known.filter(x => x.decided === 1).length + 1) / (known.length + 2); // walk-forward league rate, Beta(1,1)
    graded.push({ L, id: o.offer_id, recv: o.receiver, week: Math.floor(o.T / (7 * 864e5)), y: o.decided,
      model: M.pYesDecided(own), league_only: M.pYesDecided(rm.league), flat, base });
  }
}
const n = graded.length, yes = graded.filter(g => g.y).length;
const mean = (a, f) => a.reduce((s, g) => s + f(g), 0) / a.length;
const arms = ['model', 'league_only', 'flat', 'base'];
const LL = Object.fromEntries(arms.map(a => [a, mean(graded, g => ll(g[a], g.y))]));
// clustered bootstrap (by receiver) of LL(model) - LL(arm)
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const clusters = [...new Set(graded.map(g => `${g.L}:${g.recv}`))];
const byC = new Map(clusters.map(c => [c, graded.filter(g => `${g.L}:${g.recv}` === c)]));
const ci = arm => {
  const d = [];
  for (let b = 0; b < 4000; b++) {
    const s = [];
    for (let i = 0; i < clusters.length; i++) s.push(...byC.get(clusters[Math.floor(rnd() * clusters.length)]));
    d.push(mean(s, g => ll(g.model, g.y) - ll(g[arm], g.y)));
  }
  d.sort((a, b) => a - b);
  return [d[Math.floor(0.05 * d.length)], d[Math.floor(0.95 * d.length)]];
};
const out = { leagues, n, yes, clusters: clusters.length, log_loss: LL,
  delta_model_minus: Object.fromEntries(['flat', 'base', 'league_only'].map(a => [a, { point: LL.model - LL[a], ci90: ci(a) }])),
  replies: Object.fromEntries(M.REPLY_KINDS.map(k => [k, rowsAll.flatMap(r => r.offers).filter(o => o.reply === k).length])),
  undecided_or_open: rowsAll.flatMap(r => r.offers).filter(o => !o.reply).length };
console.log(JSON.stringify(out, null, 1));
