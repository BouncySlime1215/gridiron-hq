import { useApi } from '../../api';
import { PageLoading, PageError } from '../PageState';

/**
 * "Does our projection beat ESPN's projection?" — the standing start/sit gate (plan item C12).
 *
 * Reads GET /api/gates/start-sit (server/services/gates/start-sit-gate.js), which the
 * weekly start_sit_gate job stores. The headline answers the plan's own question from the
 * plan-rule verdict (`plan_rule`: the projection the app served against ESPN's weekly
 * projection; Independent Auditor ruling (b), prereg addendum 2). Emerald appears ONLY when
 * that verdict is beats_dumb. The pre-registered season-average result (`average_check`)
 * sits below it as one plain line, "a weaker check": never a chip, never green, and a rose
 * warning if that floor ever fails.
 *
 * DIRECTION ONLY (standing rule 3): sizes and rates do not carry over to a live lineup, so
 * the panel says which way each result points and never by how much. The route still serves
 * the full evidence for the Auditor. Every failing week of every graded window and arm is
 * listed, never trimmed, under the rule it lost to, ESPN's first.
 *
 * "What was compared" says what each verdict grades, the headline's first: the projection the app
 * saved before kickoff (not the Start/Sit list's week_points) against ESPN's; then the weaker
 * check's, today's settings replayed against the season average, with the replay's limit.
 */

interface WeekRow { season: number; week: number }

type Direction = 'ours_ahead' | 'dumb_ahead' | 'even' | 'no_disagreements' | 'not_available';

interface Arm { status?: string; reason?: string; direction?: Direction; baseline?: string; failing_weeks?: WeekRow[] }

interface ServedWeek {
  week: number; captured_at: string | null; replay_champion: string | null;
  same_weights: boolean; served_before_k_fit: boolean | null;
}

interface GateWindow {
  status?: string; reason?: string; label?: string;
  season?: number; seasons?: number[]; weeks?: [number, number];
  direction?: Direction;
  failing_weeks?: WeekRow[];
  served?: { label?: string; weeks?: ServedWeek[]; vs_average?: Arm; vs_espn?: Arm };
}

/** The plan-rule verdict (prereg addendum 2 §5); only its words and direction are read here. */
interface PlanRule { verdict?: string; reason?: string | null; source?: string; weeks_graded?: number; direction?: Direction }

/** The pre-registered season-average rule, kept as a floor (prereg §8), with its own "ours" (the replay) and limit. */
interface AverageCheck { verdict?: string; rule?: string; policy?: string; replay_caveat?: string }

interface GateResult {
  status: string; reason?: string; stored_at?: string;
  verdict?: string; plan_rule?: PlanRule; average_check?: AverageCheck;
  /** What the top-level verdict compares: ours, the dumb rule, and what ours is not. */
  policy?: string; baseline?: string; limit?: string;
  universe?: string; scoring?: string;
  /** Only in a result stored before `limit` existed, where it (and `policy`) described the replay. */
  replay_caveat?: string;
  past?: GateWindow; forward?: GateWindow;
}

const SLATE = 'bg-slate-100 text-slate-700 ring-slate-200';

/**
 * The plan-rule chip and the line under it, one per state (prereg addendum 2 §7). Emerald only
 * for beats_dumb. not_shown's line is built from the result by planLine.
 */
const PLAN: Record<string, { label: string; chip: string; say: string }> = {
  beats_dumb: { label: 'Beats ESPN\'s projection', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    say: 'Over at least four weeks where they disagreed, our pick scored more than ESPN\'s, and it held up under the test set before the numbers.' },
  not_shown: { label: 'Not shown to beat ESPN\'s projection', chip: 'bg-amber-50 text-amber-900 ring-amber-200', say: '' },
  loses_to_dumb: { label: 'Loses to ESPN\'s projection', chip: 'bg-rose-50 text-rose-800 ring-rose-200',
    say: 'Measured at the same cutoff over at least four weeks, ESPN\'s pick scored more where they disagreed. Treat our start/sit calls as worse than ESPN\'s projection.' },
  instrument_fault: { label: 'Could not grade', chip: SLATE,
    say: 'The gate\'s own check failed (a perfect-foresight pick found no edge on these rows), so no verdict was drawn.' },
  not_run: { label: 'Not measured yet', chip: SLATE, say: 'The weekly gate job has not stored a result yet.' },
  // A result stored before addendum 2 has no plan_rule, and its top-level verdict was the
  // average's: it is never read as the plan rule's, so it is never painted green.
  before_plan_rule: { label: 'Not measured against ESPN\'s projection yet', chip: SLATE,
    say: 'This stored result was graded before the plan\'s rule was added; the next weekly run grades it.' },
};

/** Whose pick scored more against ESPN's projection, in words (prereg addendum 2 §7). */
const PICK: Record<Direction, string> = {
  ours_ahead: 'our pick scored more',
  dumb_ahead: 'ESPN\'s pick scored more',
  even: 'the two came out even',
  no_disagreements: 'the two never disagreed on a startable pair',
  not_available: 'no week has been graded against ESPN\'s projection yet',
};

/** Week counts in words: the panel shows no number but seasons and weeks (standing rule 3). */
const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen'];

const weeksLabel = (w?: [number, number]) => (w ? (w[0] === w[1] ? `week ${w[0]}` : `weeks ${w[0]}-${w[1]}`) : '');

/**
 * The not_shown line: the weeks measured and whose pick scored more; the at-lock caveat when
 * the at-lock source decided (ESPN's settled number carries later news, which favours ESPN);
 * then what to do until the rule passes.
 */
function planLine(plan: PlanRule, fwd: GateWindow): string {
  const weeks = plan.weeks_graded ?? 0;
  const direction = plan.direction ?? 'not_available';
  const parts: string[] = [];
  if (weeks > 0 && (direction === 'ours_ahead' || direction === 'dumb_ahead' || direction === 'even')) {
    const windowWeeks = fwd.weeks ? fwd.weeks[1] - fwd.weeks[0] + 1 : null;
    const where = fwd.season != null && windowWeeks === weeks ? ` (${fwd.season} ${weeksLabel(fwd.weeks)})` : ' this season';
    parts.push(`In the ${COUNT[weeks] ?? 'many'} week${weeks === 1 ? '' : 's'} measured${where}, ${PICK[direction]}.`);
    if (plan.source === 'espn_at_lock') {
      parts.push('ESPN\'s number was read at lineup lock, after news our projection did not have, which favours ESPN.');
    }
  } else if (direction === 'no_disagreements') {
    parts.push('So far the two never disagreed on a startable pair.');
  } else {
    parts.push('No week has been graded against ESPN\'s projection yet.');
  }
  parts.push('Until this passes, treat our start/sit calls as no better than ESPN\'s projection.');
  return parts.join(' ');
}

/**
 * The floor (average_check, H1 exactly as pre-registered): plain text while it passes, a rose
 * warning once it does not. Never a chip and never green (Auditor ruling (b)).
 */
const FLOOR: Record<string, { warn: boolean; say: (seasons: string, replayed: string) => string }> = {
  beats_dumb: { warn: false, say: (seasons, replayed) => `our pick scored more in ${seasons}${replayed}.` },
  beats_dumb_unconfirmed_forward: { warn: true,
    say: seasons => `our pick scored more in ${seasons}, but this season's weeks replayed do not confirm it yet.` },
  not_distinguishable: { warn: true, say: seasons => `our projection cannot be told apart from it in ${seasons}.` },
  loses_to_dumb: { warn: true, say: seasons => `the average's pick scored more in ${seasons}, clearly.` },
  no_disagreements: { warn: false, say: () => 'the two never disagreed on a startable pair.' },
  instrument_fault: { warn: false, say: () => 'these weeks could not be graded.' },
};
const FLOOR_LEAD = 'Weaker check, set before the numbers: against "start the higher season average", ';

/** One direction in words, naming whose pick it was. */
const DIRECTION: Record<Direction, (dumb: string) => string> = {
  ours_ahead: () => 'our pick scored more',
  dumb_ahead: dumb => `${dumb}'s pick scored more`,
  even: () => 'dead even',
  no_disagreements: () => 'they never disagreed',
  not_available: () => 'not available yet',
};
const say = (arm: Arm | GateWindow | undefined, dumb: string) => {
  if (!arm?.direction) return 'not available yet';
  if (arm.direction === 'not_available' && arm.reason) return `not available yet (${arm.reason})`;
  return DIRECTION[arm.direction](dumb);
};

const graded = (a?: Arm | GateWindow) => !!a?.direction && a.direction !== 'not_available';

/** The floor line from the average check, the past seasons and this season's replay; null before addendum 2. */
function floorLine(check: AverageCheck | undefined, past: GateWindow, fwd: GateWindow): { warn: boolean; text: string } | null {
  if (!check?.verdict) return null;
  const f = FLOOR[check.verdict];
  if (!f) return { warn: false, text: `${FLOOR_LEAD}${check.verdict}.` };
  const s = past.seasons ?? [];
  const seasons = s.length > 1 ? `${s[0]}-${s[s.length - 1]}` : s.length === 1 ? String(s[0]) : 'past seasons';
  const replayed = graded(fwd) && fwd.season != null ? ` and in ${fwd.season} ${weeksLabel(fwd.weeks)} replayed` : '';
  return { warn: f.warn, text: `${f.warn ? 'Warning. ' : ''}${FLOOR_LEAD}${f.say(seasons, replayed)}` };
}

interface Basis { rule?: string; ours?: string; limit?: string }

/**
 * "What was compared", per rule. The top-level texts describe the top-level verdict: the plan rule's
 * dumb rule (ESPN), ours (the projection saved before kickoff) and its limit (not week_points); the
 * average check carries its own (the season average, today's settings replayed, the replay's limit).
 * A result stored before `limit` existed had the replay's texts at the top level, and one stored
 * before the plan rule (no plan_rule) the season average too, so those show under the weaker check.
 */
function comparedBasis(data: GateResult): { plan: Basis; check: Basis } {
  const check = data.average_check;
  const current = data.limit != null;
  return {
    plan: { rule: data.plan_rule ? data.baseline : undefined, ours: current ? data.policy : undefined, limit: data.limit },
    check: {
      rule: check?.rule ?? (data.plan_rule ? undefined : data.baseline),
      ours: current ? check?.policy : data.policy,
      limit: current ? check?.replay_caveat : data.replay_caveat,
    },
  };
}

/** One failing-weeks group: the weeks a window or arm lost, and the rule it lost them to. */
interface LostGroup { arm: 'past' | 'replay' | 'served_vs_average' | 'served_vs_espn'; label: string; weeks: WeekRow[] }

/**
 * Every graded window and arm, with the weeks it lost (points per disagreement below 0), the
 * plan's rule first: this season as served against ESPN's projection, then the past seasons
 * and this season's replay against the average, then as served against the average. The past
 * window always; the others only once graded (a season not measured yet arrives as direction
 * 'not_available', so it gets no group).
 */
function lostGroups(past: GateWindow, fwd: GateWindow): LostGroup[] {
  const groups: LostGroup[] = [];
  const served = fwd.served;
  if (served?.vs_espn && graded(served.vs_espn)) {
    groups.push({ arm: 'served_vs_espn', label: 'This season as the app served it, against ESPN\'s projection (the plan\'s rule)',
      weeks: served.vs_espn.failing_weeks ?? [] });
  }
  groups.push({ arm: 'past', label: 'Past seasons, against "start the higher average" (the weaker check)', weeks: past.failing_weeks ?? [] });
  if (graded(fwd)) {
    groups.push({ arm: 'replay', label: 'This season, today\'s model replayed, against the average', weeks: fwd.failing_weeks ?? [] });
  }
  if (served?.vs_average && graded(served.vs_average)) {
    groups.push({ arm: 'served_vs_average', label: 'This season as the app served it, against the average',
      weeks: served.vs_average.failing_weeks ?? [] });
  }
  return groups;
}

export default function StartSitGate() {
  const { data, loading, error, refetch } = useApi<GateResult>('/gates/start-sit');
  return (
    <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '180ms' }}
      aria-labelledby="gate-heading">
      <h2 id="gate-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">
        Does our projection beat ESPN's projection?
      </h2>
      <p className="mt-0.5 text-xs leading-5 text-slate-500">The plan's dumb rule: start whoever ESPN projects higher.</p>
      <Body data={data} loading={loading} error={error} onRetry={refetch} />
    </section>
  );
}

function Body({ data, loading, error, onRetry }: {
  data: GateResult | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  if (loading && !data) return <PageLoading label="Reading the start/sit gate…" />;
  if (error && !data) return <div className="mt-3"><PageError message={error} onRetry={onRetry} /></div>;
  if (!data) return null;
  if (data.status !== 'measured') {
    return <p className="mt-2 text-sm leading-6 text-slate-600">{data.reason ?? PLAN.not_run.say}</p>;
  }

  const past = data.past ?? {};
  const fwd = data.forward ?? {};
  const served = fwd.served;
  const plan = data.plan_rule;
  const key = plan?.verdict ?? 'before_plan_rule';
  const v = PLAN[key] ?? { label: key, chip: SLATE, say: '' };
  const line = key === 'not_shown' && plan ? planLine(plan, fwd) : v.say;
  const floor = floorLine(data.average_check, past, fwd);
  const lost = lostGroups(past, fwd);
  const basis = comparedBasis(data);
  // Forward weeks the app served on different settings from today's replay, and why.
  const differs = (served?.weeks ?? []).filter(w => w.served_before_k_fit || !w.same_weights);

  return (
    <>
      <div className="mt-2">
        <span data-gate-chip={key}
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${v.chip}`}>
          {v.label}
        </span>
      </div>
      <p data-plan-line className="mt-1 text-xs leading-5 text-slate-600">{line}</p>

      {floor && (
        <p data-average-check={data.average_check?.verdict}
          className={`mt-2 text-xs leading-5 ${floor.warn ? 'text-rose-700' : 'text-slate-600'}`}>
          {floor.text}
        </p>
      )}

      {fwd.status ? (
        <p className="mt-2 text-xs leading-5 text-slate-600">This season: {fwd.reason ?? 'not available yet'}.</p>
      ) : (
        <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
          {served && (
            <p>What the app served this season, against the season average (the weaker check): {say(served.vs_average, 'the average')}.</p>
          )}
          {differs.map(w => (
            <p key={w.week} className="text-xs leading-5 text-slate-500">
              The week {w.week} projection was served on older settings
              ({[w.served_before_k_fit ? 'before the fitted volume numbers existed' : null,
                !w.same_weights ? 'different blend weights' : null].filter(Boolean).join('; ')}), so what the app
              served and today's replay are not the same projection.
            </p>
          ))}
          <p className="text-xs leading-5 text-slate-500">Few weeks so far: this season shows direction, not proof.</p>
        </div>
      )}

      <div className="mt-3">
        <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">
          Weeks our projection lost
        </div>
        <div className="mt-1.5 space-y-2">
          {lost.map(g => (
            <div key={g.arm} data-failing-group={g.arm}>
              <div className="text-xs text-slate-600">{g.label}</div>
              {g.weeks.length === 0 ? (
                <p className="mt-0.5 text-xs text-slate-500">None: our pick did not lose a graded week.</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {g.weeks.map(w => (
                    <span key={`${w.season}-${w.week}`} data-failing-week={`${w.season}-${w.week}`}
                      className="whitespace-nowrap rounded-md bg-rose-50 px-2 py-0.5 font-mono text-[11px] tabular-nums text-rose-800 ring-1 ring-rose-200">
                      {w.season} W{w.week}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <details className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-4 text-slate-500">
        <summary className="cursor-pointer font-semibold text-slate-600">What was compared</summary>
        {(basis.plan.rule || basis.plan.ours || basis.plan.limit) && (
          <div data-compared="plan_rule" className="mt-2 space-y-1.5">
            {basis.plan.rule && <p>{basis.plan.rule}</p>}
            <dl className="space-y-1.5">
              {basis.plan.ours && <div><dt className="inline font-semibold text-slate-600">Ours: </dt><dd className="inline">{basis.plan.ours}</dd></div>}
              {basis.plan.limit && <div><dt className="inline font-semibold text-slate-600">Limit: </dt><dd className="inline">{basis.plan.limit}</dd></div>}
            </dl>
          </div>
        )}
        <div data-compared="average_check" className="mt-2 space-y-1.5">
          {basis.check.rule && <p>{basis.check.rule}</p>}
          <dl className="space-y-1.5">
            {basis.check.ours && <div><dt className="inline font-semibold text-slate-600">Ours, in the weaker check: </dt><dd className="inline">{basis.check.ours}</dd></div>}
            {fwd.label && <div><dt className="inline font-semibold text-slate-600">This season, replayed: </dt><dd className="inline">{fwd.label}</dd></div>}
            {basis.check.limit && <div><dt className="inline font-semibold text-slate-600">Limit of the weaker check: </dt><dd className="inline">{basis.check.limit}</dd></div>}
          </dl>
        </div>
        <dl data-compared="both" className="mt-2 space-y-1.5">
          {served?.label && <div><dt className="inline font-semibold text-slate-600">This season, served: </dt><dd className="inline">{served.label}</dd></div>}
          <div><dt className="inline font-semibold text-slate-600">Which calls: </dt><dd className="inline">{data.universe}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Scoring: </dt><dd className="inline">{data.scoring}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Why no numbers: </dt>
            <dd className="inline">sizes measured on this league-wide pool of pairs do not carry over to your live lineups, so this panel shows only which way each result points.</dd></div>
          {data.stored_at && <div><dt className="inline font-semibold text-slate-600">Measured: </dt><dd className="inline">{data.stored_at} UTC</dd></div>}
        </dl>
      </details>
    </>
  );
}
