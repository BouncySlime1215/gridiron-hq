/**
 * COACH-BRIEF claim builders: plan fields and overnight rows -> draft claims.
 *
 * Each builder records the rows it reads in the turn's ledger (ledger.js) and
 * writes sentences that cite them: { section, text, cites, strict? }. Nothing
 * here decides whether a claim ships; brief.js runs every draft through
 * verify.js and drops what does not ground. Numbers are formatted from the
 * cell they cite (a probability as a whole percent, a title-odds change in
 * points to one decimal), which is the precision verify.js checks them at.
 *
 * Teams read by the plans entry's `teams` map (UI-POLISH-2: teamOf, 'Team <roster
 * id>' only when the map has no name); player names come from the plan's `names`
 * or the ESPN roster row.
 */

const ok = f => f?.status === 'ok';
const val = f => (ok(f) ? f.value : undefined);
const pct = p => `${Math.round(p * 100)}%`;
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;
const human = s => String(s).replace(/_/g, ' ');

/**
 * UI-POLISH-2: who a roster is, from the plans entry's `teams` Field, by the rule of
 * client types.ts#teamLabel (TEAM-NAMES): 'Manager (Team name)', else whichever is
 * known, else 'Team N'.
 */
export function teamOf(entry, id) {
  const map = ok(entry?.teams) && entry.teams.value && typeof entry.teams.value === 'object' ? entry.teams.value : {};
  const t = map[String(id)];
  const manager = typeof t?.manager === 'string' ? t.manager.trim() : '';
  const name = typeof t?.name === 'string' ? t.name.trim() : '';
  if (manager && name) return `${manager} (${name})`;
  return manager || name || `Team ${id}`;
}
/** Planner prose writes rosters as "Team N"; the brief says them by name when the map has one. */
export const namedTeams = (entry, text) => (text == null ? text : String(text).replace(/\bTeam (\d+)\b/g, (_, id) => teamOf(entry, id)));

/** Record rows under a tool name; returns cite(i, col). */
function record(ledger, tool, rows) {
  const e = ledger.record({ tool, tables: [tool], columns: Object.keys(rows[0] ?? {}), rows });
  return (i, col) => `${e.id}#${i}.${col}`;
}

const REPLY_PHRASE = {
  accept: 'accepted your offer', decline: 'declined your offer', counter: 'countered your offer',
  silence: 'let your offer expire without a reply'
};

/* ------------------------------------------------------------ next move */

export function nextMove(entry, ledger, section) {
  const out = [];
  if (entry.error) {
    const c = record(ledger, 'plan_read', [{ error: String(entry.error) }]);
    out.push({ section, text: `The last plan run failed: ${entry.error}`, cites: [c(0, 'error')] });
    return out;
  }
  const nm = entry.next_move;
  if (!ok(nm)) {
    const reason = nm?.reason ?? 'the plans file has no next move for this league.';
    const c = record(ledger, 'plan_read', [{ status: nm?.status ?? 'missing', reason }]);
    out.push({ section, text: `No next move: ${reason}`, cites: [c(0, 'reason')] });
    return out;
  }
  return moveClaims(entry, ledger, section, nm.value, { isNext: true });
}

/** The producer's template writes "all N step(s)"; Coach says "the step" or "all N steps". */
export const plainSteps = text => (typeof text === 'string'
  ? text.replace(/\ball 1 step\(s\) land\b/g, 'the step lands').replace(/\b1 step\(s\)/g, '1 step').replace(/step\(s\)/g, 'steps')
  : text);

/**
 * The claims for one served move (the next move, or an alternative in the deck),
 * told from step k: the offer, where it sits in the move, the title-odds change,
 * the chance he says yes, the planner's case and when to send. `isNext` adds
 * the "what changed" line, which the producer writes for the next move only.
 */
export function moveClaims(entry, ledger, section, move, { k = 0, isNext = false } = {}) {
  const out = [];
  const step = move?.steps?.[k];
  if (!step) return out;
  const names = entry.names ?? {};
  const changed = isNext ? entry._run?.changed : null;
  const row = {
    move_id: String(move.move_id), partner: String(step.partner), partner_label: teamOf(entry, step.partner), steps: move.steps.length,
    step: k + 1,
    p_yes: val(step.p_yes) ?? null, guess: step.p_yes?.guess === true,
    delta: val(step.title_odds_delta) ?? null, title_after: val(step.title_after) ?? null,
    delta_final: val(move.delta_final) ?? null, p_complete: val(move.p_complete) ?? null, expected: val(move.expected) ?? null,
    send_when: val(step.send_when) ?? null,
    case_for: plainSteps(namedTeams(entry, val(move.reasoning)?.case_for ?? val(step.reasoning)?.case_for ?? null)),
    changed: changed?.changed === true, changed_reason: namedTeams(entry, changed?.reason ?? null)
  };
  const c = record(ledger, 'plan_read', [row]);
  const players = [...step.give.map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'give' })),
    ...step.get.map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'get' }))];
  const p = record(ledger, 'plan_players', players);
  const list = side => players.map((x, i) => ({ ...x, i })).filter(x => x.side === side);
  const deal = [...list('give'), ...list('get')].flatMap(x => [p(x.i, 'pid'), p(x.i, 'name')]);
  out.push({ section, cites: [c(0, 'partner'), c(0, 'partner_label'), ...deal],
    text: `Offer ${row.partner_label} ${list('give').map(x => x.name).join(' + ')} for ${list('get').map(x => x.name).join(' + ')}.` });
  if (k > 0) out.push({ section, text: `It is step ${row.step} of ${row.steps}: the steps before it go first.`, cites: [c(0, 'step'), c(0, 'steps')] });
  else if (row.steps > 1) out.push({ section, text: `It is the first of ${row.steps} steps.`, cites: [c(0, 'steps')] });
  if (row.delta != null && row.title_after != null) {
    out.push({ section, text: `If he says yes, title odds move ${pts(row.delta)} to ${pct(row.title_after)}.`,
      cites: [c(0, 'delta'), c(0, 'title_after')] });
  }
  if (row.p_yes != null) {
    out.push({ section, cites: [c(0, 'p_yes')],
      text: `Chance he says yes: ${pct(row.p_yes)}${row.guess ? ', a guess until the yes-model is proven' : ''}.` });
  }
  // The planner's own prose, held to the numbers they stand on: strict, citing only
  // result cells. Team and player names are removed as labels, never matched as
  // numbers, so an id or a step count cannot ground a figure that happens to equal it.
  const teams = [...new Set([String(entry.me), row.partner, move.target_owner,
    ...(val(entry.alternatives) ?? []).flatMap(m => (m.steps ?? []).map(x => x.partner))]
    .filter(t => t != null && t !== 'undefined').map(String)), ...Object.keys(val(entry.teams) ?? {})]
    .flatMap(t => [`Team ${t}`, teamOf(entry, t)]);
  const labels = [...teams, ...players.map(x => x.name), `${row.steps} step(s)`, `${row.steps} steps`];
  const numeric = ['delta', 'p_yes', 'title_after', 'delta_final', 'p_complete', 'expected'].map(k2 => c(0, k2));
  if (row.case_for) out.push({ section, strict: true, labels, text: `Why: ${row.case_for}`, cites: numeric });
  if (row.changed && row.changed_reason) {
    out.push({ section, strict: true, labels, text: `What changed: ${row.changed_reason}`, cites: [c(0, 'changed_reason'), ...numeric] });
  }
  if (row.send_when) out.push({ section, text: `When: ${row.send_when}`, cites: [c(0, 'send_when')] });
  return out;
}

/* ------------------------------------------------------------ overnight */

/**
 * Statements and credibility come only from their producers (PULSE-01, CRED-01)
 * through brief-inputs.js. A section the producer has no row for says it was
 * not read, with the reason; an 'ok' section cites the producer's own rows,
 * recorded in the ledger under the producer's table.
 */
function notRead(s, ledger, { section, tool, what }) {
  const reason = s.reason ?? 'not read.';
  const c = record(ledger, tool, [{ reason }]);
  return [{ section, text: `${what} not read: ${reason}.`, cites: [c(0, 'reason')] }];
}

/** At most this many statement lines; the rest are counted in the summary line. */
export const MAX_STATEMENT_LINES = 6;
const times = w => `${w.toFixed(1)}x`;

/** What league-mates said in the window: PULSE-01's labelled statements, credible first, then newest. */
export function statements(s, ledger) {
  const section = 'statements';
  if (s.status !== 'ok') return notRead(s, ledger, { section, tool: 'pulse_read', what: 'Statements' });
  if (!s.rows.length) {
    const c = record(ledger, 'people_pulse_runs', [{ statements: 0, last_run: s.last_run }]);
    return [{ section, text: `No labelled statements from league-mates in this window (the chat pulse last ran ${s.last_run}).`,
      cites: [c(0, 'statements'), c(0, 'last_run')] }];
  }
  const rows = [...s.rows].sort((a, b) => Number(b.credible) - Number(a.credible) || Date.parse(b.as_of) - Date.parse(a.as_of));
  const c = record(ledger, 'people_pulse', rows.map(r => ({ id: r.id, roster_id: r.roster_id, type: r.type, phrase: r.phrase,
    credible: r.credible ? 1 : 0, weight: r.weight, bar: s.credible_lift, as_of: r.as_of, ago: `${r.ago} ago` })));
  const credible = ledger.derive({ op: 'sum', inputs: rows.map((_, i) => c(i, 'credible')), label: 'credible statements' });
  const head = record(ledger, 'people_pulse', [{ statements: rows.length, shown: Math.min(rows.length, MAX_STATEMENT_LINES) }]);
  const out = [{ section, cites: [head(0, 'statements'), credible.id],
    text: `League-mates made ${rows.length} labelled statement${rows.length === 1 ? '' : 's'} in this window; ${credible.value} credible.` }];
  rows.slice(0, MAX_STATEMENT_LINES).forEach((r, i) => {
    const cites = [c(i, 'roster_id'), c(i, 'phrase'), c(i, 'ago')];
    let why;
    if (r.weight == null) why = 'the pulse gives this kind of talk no weight yet';
    else if (r.credible) { why = `credible: it has followed through at ${times(r.weight)} the base rate`; cites.push(c(i, 'weight'), c(i, 'credible')); }
    else { why = `follow-through ${times(r.weight)} the base rate, under the ${times(s.credible_lift)} bar`; cites.push(c(i, 'weight'), c(i, 'bar')); }
    out.push({ section, cites, text: `Team ${r.roster_id}, ${r.ago} ago: ${r.phrase} (${why}).` });
  });
  if (rows.length > MAX_STATEMENT_LINES) {
    out.push({ section, text: `${rows.length - MAX_STATEMENT_LINES} more not listed here.`,
      cites: [ledger.derive({ op: 'difference', inputs: [head(0, 'statements'), head(0, 'shown')], label: 'statements not listed' }).id] });
  }
  return out;
}

const SAYS = {
  WANT_PLAYER: 'says he wants a player', SHOP: 'shops his own player', FRUSTRATED: 'vents about his own player',
  UNTOUCHABLE: 'calls his own player untouchable', HYPE_OWN: 'talks up his own player',
  HYPE_OTHER: "talks up another team's player", WANT_POS: 'says he needs a position'
};
const THEN = {
  acquired: 'he gets that player', left_roster: 'that player leaves his roster',
  acquired_or_proposed: 'he gets or bids for that player', next_acquisition_at_pos: 'his next pickup is at that position'
};
const STATUS = { proven: 'proven league-wide', manager_split: 'proven for him alone' };
/** At most this many credibility lines; the rest are counted in the head line. */
export const MAX_CREDIBILITY_LINES = 5;

/** Who is credible: CRED-01's rows whose weight clears PULSE-01's bar, strongest first. */
function credibility(s, ledger) {
  const section = 'credibility';
  if (s.status !== 'ok') return notRead(s, ledger, { section, tool: 'credibility_read', what: 'Follow-through' });
  const head = record(ledger, 'people_credibility', [{ as_of: s.as_of, credible: s.rows.length, bar: s.credible_lift,
    window_days: s.window_days }]);
  const headCites = [head(0, 'as_of'), head(0, 'credible'), head(0, 'bar'), head(0, 'window_days')];
  if (!s.rows.length) {
    return [{ section, cites: headCites,
      text: `Follow-through (run of ${s.as_of}): no manager's talk clears the ${times(s.credible_lift)} bar within ${s.window_days} days.` }];
  }
  const c = record(ledger, 'people_credibility', s.rows.map(r => ({ ...r })));
  const out = [{ section, cites: headCites,
    text: `Follow-through (run of ${s.as_of}): ${s.rows.length} manager-and-statement pair${s.rows.length === 1 ? '' : 's'} ` +
      `clear the ${times(s.credible_lift)} bar within ${s.window_days} days.` }];
  s.rows.slice(0, MAX_CREDIBILITY_LINES).forEach((r, i) => {
    out.push({ section, cites: [c(i, 'roster_id'), c(i, 'stmt_type'), c(i, 'window_days'), c(i, 'weight'), c(i, 'status'), c(i, 'n_statements')],
      text: `Team ${r.roster_id} is credible when he ${SAYS[r.stmt_type] ?? human(r.stmt_type).toLowerCase()}: ` +
        `within ${r.window_days} days ${THEN[r.outcome] ?? human(r.outcome)} at ${times(r.weight)} his base rate ` +
        `(${STATUS[r.status] ?? human(r.status)}; ${r.n_statements} statement${r.n_statements === 1 ? '' : 's'}).` });
  });
  return out;
}

function replies(s, ledger) {
  const section = 'replies';
  if (s.status !== 'ok') {
    const c = record(ledger, 'offer_log', [{ reason: s.reason }]);
    return [{ section, text: `Replies not read: ${s.reason}`, cites: [c(0, 'reason')] }];
  }
  const sum = record(ledger, 'offer_log', [{ rows: s.rows.length }]);
  if (!s.rows.length) return [{ section, text: 'No replies to your offers in this window.', cites: [sum(0, 'rows')] }];
  const c = record(ledger, 'offer_replies', s.rows.map(r => ({ team: r.team, reply: r.reply, decline_reason: r.decline_reason })));
  return s.rows.map((r, i) => {
    const why = r.decline_reason ? ` (his reason: ${human(r.decline_reason)})` : '';
    const who = r.team ? `Team ${r.team}` : 'A manager on a move no longer in the plan';
    return { section, text: `${who} ${REPLY_PHRASE[r.reply] ?? human(r.reply)}${why}.`,
      cites: [c(i, 'reply'), ...(r.team ? [c(i, 'team')] : []), ...(why ? [c(i, 'decline_reason')] : [])] };
  });
}

function injuries(s, ledger) {
  const section = 'injuries';
  if (s.status !== 'ok') {
    const c = record(ledger, 'injury_read', [{ reason: s.reason }]);
    return [{ section, text: `Injuries not read: ${s.reason}`, cites: [c(0, 'reason')] }];
  }
  const sum = record(ledger, 'injury_read', [{ rows: s.rows.length }]);
  if (!s.rows.length) {
    return [{ section, text: "No injury designation changed on your roster or the next move's players.", cites: [sum(0, 'rows')] }];
  }
  const c = record(ledger, 'injuries', s.rows.map(r => ({ name: r.name, status: r.status, mine: r.mine ? 1 : 0 })));
  return s.rows.map((r, i) => ({ section, cites: [c(i, 'name'), c(i, 'status')],
    text: `${r.name} (${r.mine ? 'your roster' : 'in the next move'}) is listed ${human(r.status)}.` }));
}

/* ---------------------------------------------------------------- brain */

export function brain(entry, ledger) {
  const section = 'brain';
  const out = [];
  const br = entry.brain_report;
  if (!ok(br)) {
    const reason = br?.reason ?? 'the plans file carries no brain report.';
    const c = record(ledger, 'brain_read', [{ reason }]);
    out.push({ section, text: `Brain check not read: ${reason}`, cites: [c(0, 'reason')] });
    out.push({ section, text: "The brain isn't proven here yet: read every chance and gain as a guess.", cites: [c(0, 'reason')] });
  } else {
    const r = br.value;
    const checks = r.checks.map(x => ({ id: x.id, status: x.status, pass: x.status === 'passing' ? 1 : 0 }));
    const head = record(ledger, 'brain_read', [{ overall: r.overall, checks: checks.length, fell_back_to: r.fell_back_to ?? null }]);
    out.push({ section, text: `Brain check overall: ${human(r.overall)}.`, cites: [head(0, 'overall')] });
    if (checks.length) {
      const c = record(ledger, 'brain_checks', checks);
      const passing = ledger.derive({ op: 'sum', inputs: checks.map((_, i) => c(i, 'pass')), label: 'checks passing' });
      out.push({ section, text: `${passing.value} of ${checks.length} checks pass.`, cites: [passing.id, head(0, 'checks')] });
    }
    const e1 = checks.find(x => x.id === 'E1');
    if (r.overall !== 'passing' || !e1 || e1.status !== 'passing') {
      out.push({ section, text: "The brain isn't proven here yet: read every chance and gain as a guess.", cites: [head(0, 'overall')] });
    }
    if (r.blocks?.length) {
      const b = record(ledger, 'brain_blocks', r.blocks.map(text => ({ text })));
      r.blocks.forEach((t, i) => out.push({ section, text: `Held back: ${t}`, cites: [b(i, 'text')] }));
    }
    if (r.fell_back_to) out.push({ section, text: `Running on ${human(r.fell_back_to)} mode until the checks pass.`, cites: [head(0, 'fell_back_to')] });
  }
  const nh = entry.number_health;
  if (ok(nh)) {
    const c = record(ledger, 'health_read', [{ overall: nh.value.overall, broken: nh.value.broken, warn: nh.value.warn }]);
    out.push({ section, text: `Number check: ${human(nh.value.overall)}, ${nh.value.broken} broken, ${nh.value.warn} warnings.`,
      cites: [c(0, 'overall'), c(0, 'broken'), c(0, 'warn')] });
  } else if (nh) {
    const reason = nh.reason ?? 'not computed.';
    const c = record(ledger, 'health_read', [{ reason }]);
    out.push({ section, text: `Number check not read: ${reason}`, cites: [c(0, 'reason')] });
  }
  return out;
}

/* ------------------------------------------------------------ itinerary */

const STOP_STATUSES = ['done', 'next', 'waiting', 'blocked', 'dropped'];

function itinerary(entry, ledger) {
  const section = 'itinerary';
  const out = [];
  const dest = val(entry.destination);
  const run = entry._run ?? {};
  if (dest) {
    const row = { goal: val(dest.goal)?.label ?? null, arrive_by: val(dest.arrive_by) ?? null, eta: val(dest.eta_week) ?? null,
      title_now: val(dest.title_now) ?? null, planned: val(dest.title_planned_now) ?? null, ground_lost: val(dest.ground_lost) ?? null };
    const c = record(ledger, 'plan_destination', [row]);
    if (row.goal) out.push({ section, text: `Goal: ${row.goal}.`, cites: [c(0, 'goal')] });
    if (row.arrive_by != null && row.eta != null) {
      out.push({ section, text: `Arrive by week ${row.arrive_by}; the plan gets there by week ${row.eta}.`, cites: [c(0, 'arrive_by'), c(0, 'eta')] });
    } else if (row.eta != null) out.push({ section, text: `The plan gets there by week ${row.eta}.`, cites: [c(0, 'eta')] });
    if (row.title_now != null && row.planned != null) {
      out.push({ section, text: `Title odds ${pct(row.title_now)} now against ${pct(row.planned)} planned for now.`,
        cites: [c(0, 'title_now'), c(0, 'planned')] });
    }
    if (row.ground_lost) out.push({ section, text: `Ground lost since the plan was set: ${pts(row.ground_lost)}.`, cites: [c(0, 'ground_lost')] });
  } else if (entry.destination) {
    const c = record(ledger, 'plan_destination', [{ reason: entry.destination.reason ?? 'not computed.' }]);
    out.push({ section, text: `Destination not read: ${entry.destination.reason ?? 'not computed.'}`, cites: [c(0, 'reason')] });
  }
  if (Number.isInteger(run.week) && Number.isInteger(run.deadline_week)) {
    const c = record(ledger, 'plan_run', [{ week: run.week, deadline_week: run.deadline_week }]);
    out.push({ section, text: `It is week ${run.week}; the trade deadline is week ${run.deadline_week}.`, cites: [c(0, 'week'), c(0, 'deadline_week')] });
  }
  const it = entry.itinerary;
  if (!ok(it)) {
    const reason = it?.reason ?? 'the plans file has no itinerary for this league.';
    const c = record(ledger, 'plan_itinerary', [{ reason }]);
    out.push({ section, text: `Itinerary not read: ${reason}`, cites: [c(0, 'reason')] });
    return out;
  }
  const stops = it.value.stops ?? [];
  const counts = { total: stops.length, ...Object.fromEntries(STOP_STATUSES.map(s => [s, stops.filter(x => x.status === s).length])),
    untouchables: (it.value.untouchables ?? []).length };
  const c = record(ledger, 'plan_itinerary', [counts]);
  out.push({ section, cites: ['total', 'done', 'waiting', 'blocked'].map(k => c(0, k)),
    text: `Stops: ${counts.done} of ${counts.total} done, ${counts.waiting} waiting, ${counts.blocked} blocked.` });
  const next = stops.find(x => x.status === 'next');
  if (next) {
    const n = record(ledger, 'plan_stops', [{ label: namedTeams(entry, next.label) }]);
    out.push({ section, text: `Next stop: ${namedTeams(entry, next.label)}.`, cites: [n(0, 'label')] });
  }
  if (it.value.conflicts?.length) {
    const k = record(ledger, 'plan_conflicts', it.value.conflicts.map(x => ({ text: x.text })));
    it.value.conflicts.forEach((x, i) => out.push({ section, text: `Conflict: ${x.text}`, cites: [k(i, 'text')] }));
  }
  if (counts.untouchables) {
    out.push({ section, text: `Untouchable players kept out of every deal: ${counts.untouchables}.`, cites: [c(0, 'untouchables')] });
  }
  const catchUp = val(entry.catch_up);
  if (run.behind === true && catchUp?.length) {
    const first = catchUp[0];
    const k = record(ledger, 'plan_catch_up', [{ text: first.text, gain: val(first.gain) ?? null }]);
    const gain = val(first.gain) != null ? ` (${pts(val(first.gain))})` : '';
    out.push({ section, text: `Behind plan. Cheapest way back: ${first.text}${gain}`, cites: [k(0, 'text'), ...(gain ? [k(0, 'gain')] : [])] });
  }
  return out;
}

/* --------------------------------------------------------------- footer */

/** Every Coach reply ends with: destination · where we are · next move (COACH-ANCHOR job 1). */
function footer(entry, ledger) {
  const dest = val(entry.destination);
  const next = (val(entry.itinerary)?.stops ?? []).find(x => x.status === 'next');
  const row = { goal: val(dest?.goal)?.label ?? null, title_now: val(dest?.title_now) ?? null,
    week: Number.isInteger(entry._run?.week) ? entry._run.week : null, next: namedTeams(entry, next?.label ?? null) };
  const c = record(ledger, 'plan_footer', [row]);
  const parts = [];
  const cites = [];
  if (row.goal) { parts.push(`Destination: ${row.goal}`); cites.push(c(0, 'goal')); }
  if (row.title_now != null) {
    parts.push(`where we are: title odds ${pct(row.title_now)}${row.week != null ? ` in week ${row.week}` : ''}`);
    cites.push(c(0, 'title_now'), ...(row.week != null ? [c(0, 'week')] : []));
  }
  if (row.next) { parts.push(`next move: ${row.next}`); cites.push(c(0, 'next')); }
  return parts.length ? [{ section: 'footer', text: parts.join(' · '), cites }] : [];
}

/* ------------------------------------------------ COACH-ANSWERS: starters */

/**
 * One trade step as a sentence fragment ("Team 3 P4 (WR) + P6 (RB) for P21 (WR)")
 * with the cites that ground it: the partner cell, and each player's id and name.
 */
export function deal(ledger, entry, step, tool) {
  const names = entry.names ?? {};
  const players = [...(step.give ?? []).map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'give' })),
    ...(step.get ?? []).map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'get' }))];
  const t = record(ledger, `${tool}_partner`, [{ partner: String(step.partner), partner_label: teamOf(entry, step.partner) }]);
  const p = record(ledger, `${tool}_players`, players.length ? players : [{ pid: null, name: null, side: null }]);
  const side = s => players.filter(x => x.side === s).map(x => x.name).join(' + ');
  return { text: `${teamOf(entry, step.partner)} ${side('give')} for ${side('get')}`,
    cites: [t(0, 'partner'), t(0, 'partner_label'), ...players.flatMap((_, i) => [p(i, 'pid'), p(i, 'name')])] };
}

/** "Step k of n toward <target>": where the next move sits on the way to the target. */
function stepOf(entry, ledger, section) {
  const move = val(entry.next_move);
  if (!move?.steps?.length) return [];
  const target = move.target == null ? null : String(move.target);
  const row = { k: 1, steps: move.steps.length, target, target_name: target ? (entry.names?.[target] ?? `player ${target}`) : null };
  const c = record(ledger, 'plan_step', [row]);
  return [{ section, text: `Step ${row.k} of ${row.steps}${target ? ` toward ${row.target_name}` : ''}.`,
    cites: [c(0, 'k'), c(0, 'steps'), ...(target ? [c(0, 'target'), c(0, 'target_name')] : [])] }];
}

/** Why nothing clears: the producer's reason and the nearest miss, or, when a move does clear, that move and the runner-up. */
function whyNothing(entry, ledger, section) {
  const out = [];
  if (entry.error) {
    const c = record(ledger, 'plan_read', [{ error: String(entry.error) }]);
    return [{ section, text: `The last plan run failed: ${entry.error}`, cites: [c(0, 'error')] }];
  }
  const nm = entry.next_move;
  const alts = (val(entry.alternatives) ?? []).filter(m => m?.steps?.length);
  if (ok(nm)) {
    const step = nm.value.steps?.[0];
    if (step) {
      const d = deal(ledger, entry, step, 'plan_next');
      const row = { delta: val(step.title_odds_delta) ?? null, clears: step.title_odds_delta?.clears_2se === true };
      const c = record(ledger, 'plan_clears', [row]);
      out.push({ section, cites: [...d.cites, c(0, 'delta'), c(0, 'clears')],
        text: `A move does clear: offer ${d.text}${row.delta != null ? `, title odds ${pts(row.delta)} if he says yes` : ''}` +
          `${row.clears ? ', past the noise bar' : ''}.` });
    }
    const runner = alts.find(m => m.move_id !== nm.value.move_id);
    if (runner) {
      const d = deal(ledger, entry, runner.steps[0], 'plan_runner_up');
      const delta = val(runner.steps[0].title_odds_delta) ?? null;
      const c = record(ledger, 'plan_runner_up', [{ delta }]);
      out.push({ section, cites: [...d.cites, ...(delta != null ? [c(0, 'delta')] : [])],
        text: `Next best: ${d.text}${delta != null ? `, ${pts(delta)}` : ''}.` });
    }
  } else {
    const reason = nm?.reason ?? 'the plans file has no next move for this league.';
    const c = record(ledger, 'plan_read', [{ status: nm?.status ?? 'missing', reason }]);
    out.push({ section, text: `Nothing clears: ${reason}`, cites: [c(0, 'reason')] });
    const modes = val(entry.risk_modes) ?? [];
    const active = modes.find(m => m.active);
    if (active && !ok(active.expected) && active.expected?.reason) {
      const a = record(ledger, 'plan_mode_active', [{ label: active.label, reason: active.expected.reason }]);
      out.push({ section, text: `In ${active.label} mode, your current one: ${active.expected.reason}`, cites: [a(0, 'label'), a(0, 'reason')] });
    }
    const alt = [...alts].sort((x, y) => (val(y.expected) ?? -1) - (val(x.expected) ?? -1))[0];
    const miss = [...modes].filter(m => !m.active && ok(m.expected) && m.first_step)
      .sort((x, y) => val(y.expected) - val(x.expected))[0];
    if (alt) {
      const d = deal(ledger, entry, alt.steps[0], 'plan_nearest');
      const m = record(ledger, 'plan_nearest', [{ expected: val(alt.expected) ?? null }]);
      out.push({ section, cites: [...d.cites, ...(val(alt.expected) != null ? [m(0, 'expected')] : [])],
        text: `Nearest miss: ${d.text}${val(alt.expected) != null ? `, expected ${pts(val(alt.expected))}` : ''}.` });
    } else if (miss) {
      const d = deal(ledger, entry, miss.first_step, 'plan_nearest');
      const row = { label: miss.label, expected: val(miss.expected), p_complete: val(miss.p_complete) ?? null, guess: miss.p_complete?.guess === true };
      const m = record(ledger, 'plan_nearest', [row]);
      out.push({ section, cites: [m(0, 'label'), ...d.cites, m(0, 'expected'), ...(row.p_complete != null ? [m(0, 'p_complete')] : [])],
        text: `Nearest miss: ${miss.label} mode, first step offer ${d.text}, expected ${pts(row.expected)}` +
          `${row.p_complete != null ? `, completes ${pct(row.p_complete)} of the time${row.guess ? ' (a guess)' : ''}` : ''}.` });
    }
  }
  const at = val(entry.attention);
  if (at?.reason) {
    const c = record(ledger, 'plan_attention', [{ rank: at.rank ?? null, of: at.of ?? null, reason: at.reason }]);
    out.push({ section, cites: [c(0, 'rank'), c(0, 'of'), c(0, 'reason')],
      text: at.rank != null && at.of != null ? `Across your leagues this one ranks ${at.rank} of ${at.of}: ${at.reason}.` : `Planner: ${at.reason}.` });
  }
  return out;
}

/** The all-in plan: first step, expected, if complete, chance to complete. */
function allIn(entry, ledger, section) {
  const rm = entry.risk_modes;
  if (!ok(rm)) {
    const reason = rm?.reason ?? 'the plans file has no risk modes for this league.';
    const c = record(ledger, 'plan_modes', [{ reason }]);
    return [{ section, text: `All-in plan not read: ${reason}`, cites: [c(0, 'reason')] }];
  }
  const mode = rm.value.find(m => m.mode === 'all_in');
  if (!mode) {
    const c = record(ledger, 'plan_modes', [{ modes: rm.value.length, reason: 'no all_in mode in the plans file' }]);
    return [{ section, text: 'All-in plan not read: no all_in mode in the plans file', cites: [c(0, 'reason')] }];
  }
  const out = [];
  const row = { label: mode.label ?? 'All in', active: mode.active === true, expected: val(mode.expected) ?? null,
    if_complete: val(mode.if_complete) ?? null, p_complete: val(mode.p_complete) ?? null, guess: mode.p_complete?.guess === true,
    reason: mode.expected?.reason ?? null };
  const c = record(ledger, 'plan_mode_all_in', [row]);
  if (row.expected == null) {
    out.push({ section, text: `All-in plan: ${row.reason ?? 'not computed.'}`, cites: [c(0, 'reason')] });
  } else {
    if (mode.first_step) {
      const d = deal(ledger, entry, mode.first_step, 'plan_all_in_step');
      out.push({ section, cites: [c(0, 'label'), ...d.cites], text: `All-in plan ("${row.label}") first step: offer ${d.text}.` });
    }
    out.push({ section, cites: [c(0, 'expected'), ...(row.if_complete != null ? [c(0, 'if_complete')] : [])],
      text: `Expected: ${pts(row.expected)} of title odds${row.if_complete != null ? `; ${pts(row.if_complete)} if it all lands` : ''}.` });
    if (row.p_complete != null) {
      out.push({ section, cites: [c(0, 'p_complete')],
        text: `Chance it completes: ${pct(row.p_complete)}${row.guess ? ', a guess until the yes-model is proven' : ''}.` });
    }
  }
  const active = rm.value.find(m => m.active);
  if (!row.active && active) {
    const a = record(ledger, 'plan_mode_active', [{ label: active.label, expected: val(active.expected) ?? null }]);
    const e = val(active.expected);
    out.push({ section, cites: [a(0, 'label'), ...(e != null ? [a(0, 'expected')] : [])],
      text: `You are on ${active.label} now${e != null ? `, expected ${pts(e)}` : ''}; switching modes opens a preview you confirm.` });
  }
  return out;
}

const ACTIVE_POOL = /^nick: active\b/i;

/** Who to message first: the planner's partners, reachable only, active pool first, planner order kept. */
function messageFirst(entry, ledger, section) {
  const pa = entry.partners;
  if (!ok(pa)) {
    const reason = pa?.reason ?? 'the plans file has no partner list for this league.';
    const c = record(ledger, 'plan_partners', [{ reason }]);
    return [{ section, text: `Partners not read: ${reason}`, cites: [c(0, 'reason')] }];
  }
  const all = pa.value.map(p => ({ team: String(p.team), p_responds: typeof p.p_responds === 'number' ? p.p_responds : null,
    basis: p.basis ?? null, edge: val(p.edge) ?? null, edge_unit: ok(p.edge) ? (p.edge.unit ?? null) : null, blocked: p.blocked === true, checked_out: p.checked_out === true }));
  const reachable = x => !x.blocked && !x.checked_out && !(x.p_responds === 0);
  const pool = all.filter(reachable);
  const ranked = [...pool.filter(x => ACTIVE_POOL.test(x.basis ?? '')), ...pool.filter(x => !ACTIVE_POOL.test(x.basis ?? ''))];
  const skipped = all.filter(x => !reachable(x));
  const out = [];
  if (!ranked.length) {
    const c = record(ledger, 'plan_partners', [{ reachable: 0, listed: all.length }]);
    out.push({ section, text: `No reachable partner: all ${all.length} listed are blocked or checked out.`, cites: [c(0, 'reachable'), c(0, 'listed')] });
  } else {
    const c = record(ledger, 'plan_partners', ranked);
    const first = ranked[0];
    // The edge is said in title-odds points only when the plan priced it in title odds (#390 review 2).
    const edge = first.edge_unit === 'title_odds' ? first.edge : null;
    const why = basisPhrase(first.basis);
    const bits = [first.p_responds != null ? `${pct(first.p_responds)} chance he responds` : null,
      edge ? `the plan's edge with him is ${pts(edge)} of title odds` : null].filter(Boolean);
    out.push({ section, cites: [c(0, 'team'), ...(first.p_responds != null ? [c(0, 'p_responds')] : []),
      ...(why ? [c(0, 'basis')] : []), ...(edge ? [c(0, 'edge'), c(0, 'edge_unit')] : [])],
    text: `Message Team ${first.team} first${bits.length ? `: ${bits.join(', ')}` : ''}${why ? `, ${why}` : ''}.` });
    const next = ranked.slice(1, 3);
    if (next.length) {
      out.push({ section, cites: next.map((_, i) => c(i + 1, 'team')), text: `Then ${next.map(x => `Team ${x.team}`).join(', then ')}.` });
    }
  }
  const step = val(entry.next_move)?.steps?.[0];
  if (step) {
    const n = record(ledger, 'plan_next_partner', [{ partner: String(step.partner) }]);
    out.push({ section, text: `The next move's offer goes to Team ${step.partner}.`, cites: [n(0, 'partner')] });
  }
  if (skipped.length) {
    const s = record(ledger, 'plan_partners_skipped', skipped.map(x => ({ team: x.team, why: basisPhrase(x.basis) ?? (x.blocked ? 'blocked' : 'checked out') })));
    out.push({ section, cites: skipped.flatMap((_, i) => [s(i, 'team'), s(i, 'why')]),
      text: `Skipped: ${skipped.map(x => `Team ${x.team} (${basisPhrase(x.basis) ?? (x.blocked ? 'blocked' : 'checked out')})`).join(', ')}.` });
  }
  return out;
}

/** COACH-ANSWERS: draft claims for one starter intent. brief.js#checkClaim grounds them. */
export function answerClaimsFor(intent, { entry, ledger }) {
  const section = intent;
  if (intent === 'next_move') {
    // No move clears: the producer's reason, then the nearest miss (why_nothing without its repeat of the reason).
    if (!entry.error && !ok(entry.next_move)) return [...nextMove(entry, ledger, section), ...whyNothing(entry, ledger, section).slice(1)];
    const draft = nextMove(entry, ledger, section).filter(c => !/^It is the first of \d+ steps\.$/.test(c.text));
    return [...draft.slice(0, 1), ...stepOf(entry, ledger, section), ...draft.slice(1)];
  }
  if (intent === 'why_nothing') return whyNothing(entry, ledger, section);
  if (intent === 'all_in') return allIn(entry, ledger, section);
  if (intent === 'message_first') return messageFirst(entry, ledger, section);
  throw new Error(`unknown starter intent ${intent}`);
}

/* ------------------------------------------- COACH-PARTNER: one partner */

/** The served moves in deck order: the next move first, then the alternatives it is not. */
export function servedMoves(entry) {
  const nm = ok(entry.next_move) ? entry.next_move.value : null;
  const alts = (val(entry.alternatives) ?? []).filter(m => m?.steps?.length);
  return [...(nm?.steps?.length ? [nm] : []), ...alts.filter(m => !nm || m.move_id !== nm.move_id)];
}

/** The deck the War Room swipes (client warroomCoach.ts#deckOf): the alternatives, else the next move alone. */
export function deckMoves(entry) {
  const alts = (val(entry.alternatives) ?? []).filter(m => m?.steps?.length);
  if (alts.length) return alts;
  return ok(entry.next_move) && entry.next_move.value?.steps?.length ? [entry.next_move.value] : [];
}

/** A served move's claims ordered like the next-move answer: offer, where it sits, then the rest. */
export function servedMoveClaims(entry, ledger, section, move, k) {
  const isNext = ok(entry.next_move) && entry.next_move.value?.move_id === move.move_id;
  const draft = moveClaims(entry, ledger, section, move, { k, isNext });
  const out = [...draft];
  const step = move.steps[k];
  const msg = val(step?.message);
  // A draft that does not name every player in the step, or names a player who is
  // not in it, is about some other deal: not shown.
  const core = pid => String((entry.names ?? {})[pid] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const says = (text, pid) => !!core(pid) && new RegExp(`(^|[^A-Za-z0-9])${core(pid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(text);
  const inStep = new Set([...(step?.give ?? []), ...(step?.get ?? [])].map(String));
  const fits = typeof msg === 'string' && [...inStep].every(pid => says(msg, pid))
    && !Object.keys(entry.names ?? {}).some(pid => !inStep.has(String(pid)) && says(msg, pid));
  if (fits && msg.trim()) {
    const m = record(ledger, 'plan_message', [{ move_id: String(move.move_id), message: msg }]);
    out.splice(1, 0, { section, text: `Draft to copy and send yourself: "${msg}"`, cites: [m(0, 'message')] });
  }
  if (move.steps.length > 1 && val(move.expected) != null) {
    const e = record(ledger, 'plan_move', [{ expected: val(move.expected), p_complete: val(move.p_complete) ?? null,
      guess: move.p_complete?.guess === true }]);
    const pc = val(move.p_complete);
    out.push({ section, cites: [e(0, 'expected'), ...(pc != null ? [e(0, 'p_complete')] : [])],
      text: `Whole move: expected ${pts(val(move.expected))} of title odds${pc != null ? `, completes ${pct(pc)} of the time${move.p_complete?.guess ? ' (a guess)' : ''}` : ''}.` });
  }
  return out;
}

const flipIds = (legs, key, lead) => (Array.isArray(legs[`${key}_ids`]) && legs[`${key}_ids`].some(x => x != null)
  ? legs[`${key}_ids`].filter(x => x != null).map(String) : [String(legs[lead])]);

/** The best flip leg with one roster: flip_map in the producer's order, legs priced only. */
function flipLegClaims(entry, ledger, section, roster, flip) {
  const names = entry.names ?? {};
  const legs = flip.legs;
  const buyLeg = String(flip.buy_from) === roster;
  const other = buyLeg ? String(flip.sell_to) : String(flip.buy_from);
  const nameOf = pid => names[pid] ?? `player ${pid}`;
  const give = flipIds(legs, 'give_a', 'give_a');
  const get = flipIds(legs, 'get_b', 'get_b');
  const players = [{ pid: String(flip.player), name: nameOf(flip.player), side: 'flip' },
    ...give.map(pid => ({ pid, name: nameOf(pid), side: 'give' })), ...get.map(pid => ({ pid, name: nameOf(pid), side: 'get' }))];
  const p = record(ledger, 'plan_flip_players', players);
  // flip_key: which flip this is (player:buy_from:sell_to), so the rules check can hold the lines about it.
  const t = record(ledger, 'plan_flip', [{ flip_key: `${flip.player}:${flip.buy_from}:${flip.sell_to}`,
    partner: roster, partner_label: teamOf(entry, roster), other, other_label: teamOf(entry, other),
    leg: buyLeg ? 1 : 2, legs: 2,
    p_his: val(buyLeg ? legs.p1 : legs.p2) ?? null, guess: (buyLeg ? legs.p1 : legs.p2)?.guess === true,
    p_both: val(legs.p_both) ?? null, nick_after: val(legs.nick_after) ?? null, clears: legs.nick_after?.clears_2se === true,
    spread: val(flip.spread) ?? null }]);
  const side = s2 => players.map((x, i) => ({ ...x, i })).filter(x => x.side === s2);
  const cite = xs => xs.flatMap(x => [p(x.i, 'pid'), p(x.i, 'name')]);
  const [f] = side('flip');
  const joined = xs => xs.map(x => x.name).join(' + ');
  const out = [];
  const lead = [t(0, 'partner'), t(0, 'partner_label'), t(0, 'other'), t(0, 'other_label'), ...cite([f]), ...cite(side('give')), ...cite(side('get'))];
  out.push({ section, cites: lead, text: buyLeg
    ? `Best flip leg with him: offer ${teamOf(entry, roster)} ${joined(side('give'))} for ${f.name}, then sell ${f.name} to ${teamOf(entry, other)} for ${joined(side('get'))}.`
    : `Best flip leg with him: buy ${f.name} from ${teamOf(entry, other)} for ${joined(side('give'))}, then offer ${teamOf(entry, roster)} ${f.name} for ${joined(side('get'))}.` });
  out.push({ section, cites: [t(0, 'leg'), t(0, 'legs')], text: `His is leg ${buyLeg ? 1 : 2} of 2; each leg is a separate offer.` });
  const pHis = buyLeg ? legs.p1 : legs.p2;
  if (val(pHis) != null) {
    out.push({ section, cites: [t(0, 'p_his')],
      text: `Chance he says yes to his leg: ${pct(val(pHis))}${pHis.guess ? ', a guess until the yes-model is proven' : ''}.` });
  }
  if (val(legs.p_both) != null) out.push({ section, cites: [t(0, 'p_both')], text: `Both legs land ${pct(val(legs.p_both))} of the time.` });
  if (val(legs.nick_after) != null) {
    out.push({ section, cites: [t(0, 'nick_after'), t(0, 'clears')],
      text: `If both land, your title odds change ${pts(val(legs.nick_after))}${legs.nick_after.clears_2se ? ', past the noise bar' : ', inside the noise'}.` });
  }
  const caseFor = plainSteps(namedTeams(entry, val(flip.reasoning)?.case_for ?? null));
  if (caseFor) {
    const labels = [roster, other, String(entry.me)].flatMap(x => [`Team ${x}`, teamOf(entry, x)]).concat(players.map(x => x.name));
    out.push({ section, strict: true, labels, text: `Why: ${caseFor}`, cites: [t(0, 'spread'), t(0, 'p_both'), t(0, 'nick_after')] });
  }
  return out;
}

/* The partners read carries engine labels ('activity read (receptiveness 1.30)');
 * Coach says the basis in plain words, or drops it. The chat labels are not
 * shown: Coach is not a second chat labeller (coach-brief.test.js pins that). */
const BASIS_PHRASE = [
  [/^activity read\b/, 'based on how active he has been lately'],
  [/^checked out\b/, 'he has gone quiet lately'],
  [/^no manager read\b/, 'there is no read on him yet, so this is a cautious guess'],
  [/^marked as never trading\b/, 'he is marked as never trading'],
  [/^Nick: unreachable\b/, 'you marked him as unreachable'],
  [/^Nick: not trading\b/, 'you marked him as not trading'],
  [/^Nick: active\b/, 'you marked him as active']
];
const basisPhrase = basis => (typeof basis === 'string' ? BASIS_PHRASE.find(([re]) => re.test(basis))?.[1] ?? null : null);
/**
 * The flip to pitch with one roster: only flips that raise Nick's title odds
 * if both legs land (flip_map is not filtered on the confirm dice), past the
 * noise bar first, then ones the catch-up list also names, then producer order.
 */
export function bestFlipWith(entry, roster) {
  const id = String(roster);
  const names = entry.names ?? {};
  const catchUp = (val(entry.catch_up) ?? []).filter(c => c?.kind === 'flip');
  const core = pid => String(names[pid] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const sides = f => [String(f.buy_from), String(f.sell_to)];
  const mentions = (text, t) => text.includes(`Team ${t}`) || text.includes(teamOf(entry, t));
  const inCatchUp = f => !!core(f.player) && catchUp.some(c => {
    const text = String(c.text ?? '');
    return text.includes(core(f.player)) && (sides(f).includes(String(c.partner)) || sides(f).every(t => mentions(text, t)));
  });
  return (val(entry.flip_map) ?? [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f?.legs && (String(f.buy_from) === id || String(f.sell_to) === id) && (val(f.legs.nick_after) ?? 0) > 0)
    .sort((a, b) => (b.f.legs.nick_after?.clears_2se === true) - (a.f.legs.nick_after?.clears_2se === true)
      || inCatchUp(b.f) - inCatchUp(a.f) || a.i - b.i)[0]?.f ?? null;
}

/** The partners read of one roster, and the honest "nothing clears with him". */
function partnerReadClaims(entry, ledger, section, roster) {
  const out = [];
  const label = teamOf(entry, roster);
  const h = record(ledger, 'plan_partner', [{ partner: roster, partner_label: label }]);
  out.push({ section, cites: [h(0, 'partner'), h(0, 'partner_label')],
    text: `No fair trade with ${label} clears your rules right now: no served plan or winning flip leg goes through him.` });
  const pa = ok(entry.partners) ? entry.partners.value.find(x => String(x.team) === roster) : null;
  if (!pa) {
    out.push({ section, cites: [h(0, 'partner_label')], text: `The plans file has no partner read for ${label}.` });
  } else {
    const names = entry.names ?? {};
    const wants = (pa.reason_chain ?? []).filter(r => r?.feature === 'wants_player' && r.player != null)
      .map(r => names[r.player] ?? `player ${r.player}`);
    const row = { p_responds: typeof pa.p_responds === 'number' ? pa.p_responds : null, basis: basisPhrase(pa.basis),
      holes: Array.isArray(pa.roster_holes) && pa.roster_holes.length ? pa.roster_holes.join(', ') : null,
      wants: wants.length ? wants.join(' + ') : null,
      offers_logged: typeof pa.offers_logged === 'number' ? pa.offers_logged : null,
      blocked: pa.blocked === true, checked_out: pa.checked_out === true };
    const c = record(ledger, 'plan_partners', [row]);
    if (row.blocked || row.checked_out) {
      out.push({ section, cites: [c(0, row.blocked ? 'blocked' : 'checked_out')],
        text: `The planner has him ${row.blocked ? 'blocked' : 'checked out'}, so it builds nothing with him.` });
    }
    if (row.p_responds != null) {
      out.push({ section, cites: [c(0, 'p_responds'), ...(row.basis ? [c(0, 'basis')] : [])],
        text: `${pct(row.p_responds)} chance he responds${row.basis ? `, ${row.basis}` : ''}.` });
    }
    if (row.holes) out.push({ section, cites: [c(0, 'holes')], text: `He needs ${row.holes}.` });
    if (row.wants) out.push({ section, cites: [c(0, 'wants')], text: `He wants a player you have: ${row.wants}.` });
    if (row.offers_logged) out.push({ section, cites: [c(0, 'offers_logged')], text: `Offers logged with him: ${row.offers_logged}.` });
  }
  const nm = entry.next_move;
  if (!entry.error && !ok(nm) && nm?.reason) {
    const r = record(ledger, 'plan_read', [{ status: nm.status ?? 'missing', reason: nm.reason }]);
    out.push({ section, cites: [r(0, 'reason')], text: `Closest miss this week (the whole league, not only him): ${nm.reason}` });
  }
  return out;
}

/**
 * COACH-PARTNER: a trade idea aimed at one roster, from served plans only (so
 * Nick's rules hold; nothing is invented): the best served move whose first
 * step goes to him, else one with any step through him, else the best priced
 * flip leg with him, else his partners read and "nothing clears with him".
 *
 * @returns {{claims: object[], source: string, move_id?: string}}
 */
export function partnerClaims(entry, ledger, roster) {
  const section = 'partner';
  const id = String(roster);
  if (entry.error) {
    const c = record(ledger, 'plan_read', [{ error: String(entry.error) }]);
    return { source: 'error', claims: [{ section, text: `The last plan run failed: ${entry.error}`, cites: [c(0, 'error')] }] };
  }
  const moves = servedMoves(entry);
  const first = moves.find(m => String(m.steps[0].partner) === id);
  if (first) return { source: 'plan_first_step', move_id: String(first.move_id), claims: servedMoveClaims(entry, ledger, section, first, 0) };
  const any = moves.find(m => m.steps.some(s2 => String(s2.partner) === id));
  if (any) {
    const k = any.steps.findIndex(s2 => String(s2.partner) === id);
    return { source: 'plan_any_step', move_id: String(any.move_id), claims: servedMoveClaims(entry, ledger, section, any, k) };
  }
  const flip = bestFlipWith(entry, id);
  if (flip) {
    const h = record(ledger, 'plan_partner', [{ partner: id, partner_label: teamOf(entry, id) }]);
    return { source: 'flip_leg', claims: [
      { section, cites: [h(0, 'partner'), h(0, 'partner_label')], text: `No served plan goes through ${teamOf(entry, id)}.` },
      ...flipLegClaims(entry, ledger, section, id, flip)] };
  }
  return { source: 'partner_read', claims: partnerReadClaims(entry, ledger, section, id) };
}

/** COACH-PARTNER: card i of the deck ("what else"), in full, or the end of the deck. */
export function alternativeClaims(entry, ledger, index) {
  const section = 'alternative';
  const deck = deckMoves(entry);
  const c = record(ledger, 'plan_deck', [{ card: index + 1, cards: deck.length }]);
  if (!deck.length) {
    const why = ok(entry.next_move) ? 'the plans file has no alternatives for this league.' : (entry.next_move?.reason ?? 'the plans file has no alternatives for this league.');
    const r = record(ledger, 'plan_read', [{ reason: why }]);
    return [{ section, cites: [r(0, 'reason')], text: `No alternatives in the deck: ${why}` }];
  }
  if (index >= deck.length) {
    return [{ section, cites: [c(0, 'cards')], text: `That was the last alternative in the deck (${deck.length} of ${deck.length}). Say "undo" to go back one.` }];
  }
  const move = deck[index];
  const claims = servedMoveClaims(entry, ledger, section, move, 0);
  claims.splice(1, 0, { section, cites: [c(0, 'card'), c(0, 'cards')], text: `Card ${index + 1} of ${deck.length} in the deck.` });
  if (val(move.expected) != null && move.steps.length === 1) {
    const e = record(ledger, 'plan_move', [{ expected: val(move.expected) }]);
    claims.push({ section, cites: [e(0, 'expected')], text: `Expected: ${pts(val(move.expected))} of title odds.` });
  }
  return claims;
}

/* ----------------------------------------------------------------- kinds */

export function claimsFor(kind, { entry, inputs, ledger }) {
  if (kind === 'morning') {
    return [...statements(inputs.statements, ledger), ...credibility(inputs.credibility, ledger),
      ...replies(inputs.replies, ledger), ...injuries(inputs.injuries, ledger),
      ...nextMove(entry, ledger, 'next_move'), ...brain(entry, ledger), ...footer(entry, ledger)];
  }
  if (kind === 'weekly') {
    return [...itinerary(entry, ledger), ...nextMove(entry, ledger, 'next_move').slice(0, 3), ...brain(entry, ledger).slice(0, 2),
      ...footer(entry, ledger)];
  }
  throw new Error(`unknown brief kind ${kind}`);
}
