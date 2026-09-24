/**
 * COACH-ROLEPLAY: the Coach tool around roleplay.js, and its only IO. It reads
 * league 4's section of the plans file (warroom-flag.js#warRoomPlansPath, the
 * same file the War Room view reads), the league's season, and the offers
 * Nick's team sent from trade_outcomes. Sync, because runCoachTool is.
 *
 * A missing plans file or league section is an answer ('unknown' with a
 * reason), not a fault: Coach says the role-play can't run yet. A file that
 * exists but cannot be read or parsed is 'failed' with the cause.
 *
 * No counterpart model is passed yet: COUNTERPART-01 (#254) builds it inside
 * the producer run and does not persist one per manager. Until it does, the
 * mix is the plan's P(responds) and P(yes) over the M6 prior, and the result
 * says so in its basis ("no counterpart model for him here").
 */
import fs from 'node:fs';
import { row } from '../../db/index.js';
import { outcomesFor } from '../trade-outcomes.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { roleplay, ROLEPLAY_LEAGUE_ID } from './roleplay.js';

/** One league's section of the plans file: { status: 'ok', plans, as_of } or a typed absence. */
export function readLeaguePlans(leagueId, file = warRoomPlansPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'unknown', reason: 'No plan has been run yet: the plans file does not exist.' };
    return { status: 'failed', reason: `The plans file could not be opened (${e.code ?? e.message}).` };
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    return { status: 'failed', reason: `The plans file is not valid JSON (${e.message}).` };
  }
  const entries = Array.isArray(doc?.leagues) ? doc.leagues : null;
  if (!entries) return { status: 'failed', reason: 'The plans file has no list of leagues in it.' };
  const plans = entries.find(e => String(e?.league) === String(leagueId));
  if (!plans) return { status: 'unknown', reason: `The plans file has no section for league ${leagueId}.` };
  if (plans.error) return { status: 'failed', reason: `The last plan run for league ${leagueId} failed: ${plans.error}` };
  return { status: 'ok', plans, as_of: doc.generated_at ?? null };
}

/** What goes into Coach's ledger: the simulation's scalars, labels and warnings, nothing else. */
function compact(r, asOf) {
  if (r.status !== 'ok') return { simulation: true, label: r.label, status: r.status, reason: r.reason ?? null };
  return {
    simulation: true, label: r.label, status: 'ok', team: r.team, plans_as_of: asOf,
    reply_mix: r.reply_mix, guess: r.guess, most_likely: r.most_likely, samples: r.samples, draws: r.draws,
    sampled_style: r.sampled.style, sampled_text: r.sampled.text, planned_answer: r.sampled.planned_answer,
    basis: r.basis.map(b => b.text), traits: r.traits.map(t => t.text),
    offers_7d: r.comes_across.offers_7d, this_would_be: r.comes_across.this_would_be,
    decline_streak: r.comes_across.decline_streak,
    warnings: r.comes_across.warnings.map(w => `${w.severity}: ${w.text}`),
    ...(r.preview ? { preview: true, preview_reason: r.preview_reason } : {})
  };
}

/**
 * Run the role-play for Coach. input: { team, text, give?, get? }.
 * @returns {{ value: object, tables: string[] }} the shape runCoachTool records
 * @throws {RoleplayInputError} a bad team or draft (runCoachTool turns it into a refusal)
 */
export function runRoleplayTool(input, { leagueId = ROLEPLAY_LEAGUE_ID, now = new Date(), file } = {}) {
  const read = readLeaguePlans(leagueId, file);
  if (read.status !== 'ok') return { value: { simulation: true, status: read.status, reason: read.reason }, tables: [] };
  const lg = row('SELECT season FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { value: { simulation: true, status: 'unknown', reason: `League ${leagueId} is not in this database.` }, tables: ['leagues'] };
  const r = roleplay({
    leagueId, plans: read.plans, team: input?.team, counterpart: null,
    draft: { text: input?.text ?? '', give: input?.give ?? [], get: input?.get ?? [] },
    history: outcomesFor(leagueId, lg.season), now: now.toISOString()
  });
  if (!r.enabled) return { value: { simulation: true, status: 'off', reason: 'Coach role-play is off (GRIDIRON_COACH_ROLEPLAY unset).' }, tables: [] };
  return { value: compact(r, read.as_of), tables: ['trade_outcomes', 'leagues'] };
}
