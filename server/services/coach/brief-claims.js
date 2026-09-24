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
 * Teams are "Team <roster id>"; player names come from the plan's `names`
 * (players, never managers) or the ESPN roster row.
 */

const ok = f => f?.status === 'ok';
const val = f => (ok(f) ? f.value : undefined);
const pct = p => `${Math.round(p * 100)}%`;
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;
const human = s => String(s).replace(/_/g, ' ');

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
  const move = nm.value;
  const step = move.steps?.[0];
  if (!step) return out;
  const names = entry.names ?? {};
  const changed = entry._run?.changed;
  const row = {
    move_id: String(move.move_id), partner: String(step.partner), steps: move.steps.length,
    p_yes: val(step.p_yes) ?? null, guess: step.p_yes?.guess === true,
    delta: val(step.title_odds_delta) ?? null, title_after: val(step.title_after) ?? null,
    delta_final: val(move.delta_final) ?? null, p_complete: val(move.p_complete) ?? null, expected: val(move.expected) ?? null,
    send_when: val(step.send_when) ?? null, case_for: val(move.reasoning)?.case_for ?? val(step.reasoning)?.case_for ?? null,
    changed: changed?.changed === true, changed_reason: changed?.reason ?? null
  };
  const c = record(ledger, 'plan_read', [row]);
  const players = [...step.give.map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'give' })),
    ...step.get.map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'get' }))];
  const p = record(ledger, 'plan_players', players);
  const list = side => players.map((x, i) => ({ ...x, i })).filter(x => x.side === side);
  const deal = [...list('give'), ...list('get')].flatMap(x => [p(x.i, 'pid'), p(x.i, 'name')]);
  out.push({ section, cites: [c(0, 'partner'), ...deal],
    text: `Offer Team ${row.partner} ${list('give').map(x => x.name).join(' + ')} for ${list('get').map(x => x.name).join(' + ')}.` });
  if (row.steps > 1) out.push({ section, text: `It is the first of ${row.steps} steps.`, cites: [c(0, 'steps')] });
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
    .filter(t => t != null && t !== 'undefined').map(String))].map(t => `Team ${t}`);
  const labels = [...teams, ...players.map(x => x.name), `${row.steps} step(s)`, `${row.steps} steps`];
  const numeric = ['delta', 'p_yes', 'title_after', 'delta_final', 'p_complete', 'expected'].map(k => c(0, k));
  if (row.case_for) out.push({ section, strict: true, labels, text: `Why: ${row.case_for}`, cites: numeric });
  if (row.changed && row.changed_reason) {
    out.push({ section, strict: true, labels, text: `What changed: ${row.changed_reason}`, cites: [c(0, 'changed_reason'), ...numeric] });
  }
  if (row.send_when) out.push({ section, text: `When: ${row.send_when}`, cites: [c(0, 'send_when')] });
  return out;
}

/* ------------------------------------------------------------ overnight */

/**
 * Statements and credibility come only from their producers (PULSE-01, CRED-01);
 * brief-inputs.js returns both typed unknown until those are on main. Such a
 * section says it was not read, with the reason. An 'ok' section here would be
 * rows with no renderer yet, so it throws rather than vanish from the brief.
 */
function notRead(s, ledger, { section, tool, what }) {
  if (s.status === 'ok') throw new Error(`${what}: rows arrived but the brief has no renderer for them yet (wire the producer's rows here)`);
  const reason = s.reason ?? 'not read.';
  const c = record(ledger, tool, [{ reason }]);
  return [{ section, text: `${what} not read: ${reason}.`, cites: [c(0, 'reason')] }];
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

function brain(entry, ledger) {
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
    const n = record(ledger, 'plan_stops', [{ label: next.label }]);
    out.push({ section, text: `Next stop: ${next.label}.`, cites: [n(0, 'label')] });
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
    week: Number.isInteger(entry._run?.week) ? entry._run.week : null, next: next?.label ?? null };
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
function deal(ledger, entry, step, tool) {
  const names = entry.names ?? {};
  const players = [...(step.give ?? []).map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'give' })),
    ...(step.get ?? []).map(pid => ({ pid: String(pid), name: names[pid] ?? `player ${pid}`, side: 'get' }))];
  const t = record(ledger, `${tool}_partner`, [{ partner: String(step.partner) }]);
  const p = record(ledger, `${tool}_players`, players.length ? players : [{ pid: null, name: null, side: null }]);
  const side = s => players.filter(x => x.side === s).map(x => x.name).join(' + ');
  return { text: `Team ${step.partner} ${side('give')} for ${side('get')}`,
    cites: [t(0, 'partner'), ...players.flatMap((_, i) => [p(i, 'pid'), p(i, 'name')])] };
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
    basis: p.basis ?? null, edge: val(p.edge) ?? null, blocked: p.blocked === true, checked_out: p.checked_out === true }));
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
    const bits = [first.p_responds != null ? `${pct(first.p_responds)} chance he responds` : null,
      first.edge ? `the plan's edge with him is ${pts(first.edge)}` : null].filter(Boolean);
    out.push({ section, cites: [c(0, 'team'), ...(first.p_responds != null ? [c(0, 'p_responds')] : []),
      ...(first.basis ? [c(0, 'basis')] : []), ...(first.edge ? [c(0, 'edge')] : [])],
    text: `Message Team ${first.team} first${bits.length ? `: ${bits.join(', ')}` : ''}${first.basis ? `; basis: ${first.basis}` : ''}.` });
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
    const s = record(ledger, 'plan_partners_skipped', skipped.map(x => ({ team: x.team, why: x.basis ?? (x.blocked ? 'blocked' : 'checked out') })));
    out.push({ section, cites: skipped.flatMap((_, i) => [s(i, 'team'), s(i, 'why')]),
      text: `Skipped: ${skipped.map(x => `Team ${x.team} (${x.basis ?? (x.blocked ? 'blocked' : 'checked out')})`).join(', ')}.` });
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

/* ----------------------------------------------------------------- kinds */

export function claimsFor(kind, { entry, inputs, ledger }) {
  if (kind === 'morning') {
    return [...notRead(inputs.statements, ledger, { section: 'statements', tool: 'pulse_read', what: 'Statements' }),
      ...notRead(inputs.credibility, ledger, { section: 'credibility', tool: 'credibility_read', what: 'Follow-through' }),
      ...replies(inputs.replies, ledger), ...injuries(inputs.injuries, ledger),
      ...nextMove(entry, ledger, 'next_move'), ...brain(entry, ledger), ...footer(entry, ledger)];
  }
  if (kind === 'weekly') {
    return [...itinerary(entry, ledger), ...nextMove(entry, ledger, 'next_move').slice(0, 3), ...brain(entry, ledger).slice(0, 2),
      ...footer(entry, ledger)];
  }
  throw new Error(`unknown brief kind ${kind}`);
}
