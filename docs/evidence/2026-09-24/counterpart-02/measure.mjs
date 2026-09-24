// COUNTERPART-02 metrics (a) and (b) on a produced plans file (league 4). Roster ids only.
// usage: node measure.mjs <plans.json> <db copy> <chat copy>
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const WT = process.env.CP02_TREE ?? process.cwd(); // a checkout with counterpart-02-impl.patch applied
const { validatePlans } = await import(`${WT}/server/services/campaign/plans-schema.js`);
const { readOverride } = await import(`${WT}/server/services/campaign/opponent-model.js`);
const [file, dbp, chatp] = process.argv.slice(2);
const plans = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = new DatabaseSync(dbp, { readOnly: true });
db.exec(`ATTACH '${chatp}' AS c`);
const ov = new Map(db.prepare(`SELECT i.roster_id r, json_extract(p.profile_json,'$.nick_override') o FROM league_member_identity i
  LEFT JOIN c.negotiation_profiles p ON p.name = i.chat_name WHERE i.league_id = 4`).all().map(x => [String(x.r), readOverride(x.o)]));
const pool = new Set([...ov].filter(([, o]) => o.active).map(([t]) => t));
const unreachable = new Set([...ov].filter(([, o]) => o.exclude).map(([t]) => t));
const e = plans.leagues.find(l => String(l.league) === '4');
const alts = e.alternatives?.value ?? [];
const first = alts.slice(0, 5).map(a => String(a.steps[0].partner));
const all = alts.slice(0, 5).flatMap(a => a.steps.map(s => String(s.partner)));
const v = validatePlans(plans);
console.log(JSON.stringify({ error: e.error ?? null, moves: alts.length, pool: [...pool], unreachable: [...unreachable],
  a_first_step_active_share: first.filter(t => pool.has(t)).length / first.length, first_step_partners: first,
  a_all_steps_active_share: all.filter(t => pool.has(t)).length / all.length, all_step_partners: all,
  unreachable_moves: alts.filter(a => a.steps.some(s => unreachable.has(String(s.partner)))).length,
  b_best_expected_title_odds: alts[0]?.expected?.value ?? null, b_best_p_complete: alts[0]?.p_complete?.value ?? null,
  b_best_delta_final: alts[0]?.delta_final?.value ?? null,
  p_yes_first_steps: alts.slice(0, 5).map(a => a.steps[0].p_yes?.value ?? null),
  validatePlans: v.ok ? 'ok' : v.errors.slice(0, 3) }, null, 1));
