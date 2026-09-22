import { useApi } from '../../api';
import { PageLoading, PageError } from '../PageState';

/**
 * "Does our projection beat the dumb rule?" — the standing start/sit gate (plan item C12).
 *
 * Reads GET /api/gates/start-sit (server/services/gates/start-sit-gate.js), which the
 * weekly start_sit_gate job stores. DIRECTION ONLY (standing rule 3): sizes and rates
 * measured on a replay do not carry over to a live lineup, so the panel says which way
 * each result points and never by how much. The route still serves the full evidence
 * for the Auditor; this component reads only the verdict, each window's `direction`,
 * the failing weeks' season and week, and the sentences of basis. Every failing week of
 * every graded window and arm is listed, never trimmed, under the rule it lost to.
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

interface GateResult {
  status: string; reason?: string; stored_at?: string;
  verdict?: string;
  policy?: string; baseline?: string; universe?: string; scoring?: string; replay_caveat?: string;
  past?: GateWindow; forward?: GateWindow;
}

const VERDICT: Record<string, { label: string; chip: string; say: string }> = {
  beats_dumb: { label: 'Beats "start the higher average"', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    say: 'Our projection picked the better player more often than "start the higher average", in past seasons and this one.' },
  beats_dumb_unconfirmed_forward: { label: 'Beat the average before, not yet this season', chip: 'bg-sky-50 text-sky-800 ring-sky-200',
    say: 'Our projection beat "start the higher average" in past seasons, but this season\'s weeks do not confirm it yet.' },
  not_distinguishable: { label: 'No proven edge', chip: 'bg-amber-50 text-amber-900 ring-amber-200',
    say: 'On these weeks our projection cannot be told apart from "start the higher average". Read its calls as no better than that rule.' },
  loses_to_dumb: { label: 'Loses to "start the higher average"', chip: 'bg-rose-50 text-rose-800 ring-rose-200',
    say: 'Where they disagreed, "start the higher average" picked the better player more often than our projection did.' },
  no_disagreements: { label: 'Never disagreed', chip: 'bg-slate-100 text-slate-700 ring-slate-200',
    say: 'Our projection and "start the higher average" made the same call on every startable pair, so there is nothing to grade.' },
  instrument_fault: { label: 'Could not grade', chip: 'bg-slate-100 text-slate-700 ring-slate-200',
    say: 'The gate\'s own check failed (a perfect-foresight pick found no edge on these rows), so no verdict was drawn.' },
  not_run: { label: 'Not measured yet', chip: 'bg-slate-100 text-slate-600 ring-slate-200',
    say: 'The weekly gate job has not stored a result yet.' },
};

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

/** The past window in words, from the pre-registered verdict and the direction of the pooled grade. */
function pastSentence(verdict: string | undefined, past: GateWindow): string {
  if (verdict === 'beats_dumb' || verdict === 'beats_dumb_unconfirmed_forward') {
    return 'where the two disagreed, our pick scored more, and it held up under the test set before the run.';
  }
  if (verdict === 'loses_to_dumb') return 'where the two disagreed, the average\'s pick scored more, clearly.';
  if (verdict === 'no_disagreements') return 'the two never disagreed.';
  if (verdict === 'instrument_fault') return 'these weeks could not be graded.';
  if (past.direction === 'ours_ahead') return 'our pick scored a little more, but not by enough to be sure.';
  if (past.direction === 'dumb_ahead') return 'the average\'s pick scored a little more, but not by enough to be sure.';
  return 'too close to call.';
}

/** One failing-weeks group: the weeks a window or arm lost, and the rule it lost them to. */
interface LostGroup { arm: 'past' | 'replay' | 'served_vs_average' | 'served_vs_espn'; label: string; weeks: WeekRow[] }

const graded = (a?: Arm | GateWindow) => !!a?.direction && a.direction !== 'not_available';

/**
 * Every graded window and arm, with the weeks it lost (points per disagreement below 0).
 * The past window always; this season's replay and served arms only once graded. The
 * served-vs-ESPN arm is the literal "start the highest projection": its losses are shown
 * beside the verdict's rule, not folded into it (prereg addendum 1 §3-4).
 */
function lostGroups(past: GateWindow, fwd: GateWindow): LostGroup[] {
  const groups: LostGroup[] = [
    { arm: 'past', label: 'Past seasons, against "start the higher average"', weeks: past.failing_weeks ?? [] },
  ];
  if (fwd.status) return groups;
  if (graded(fwd)) {
    groups.push({ arm: 'replay', label: 'This season, today\'s model replayed, against the average', weeks: fwd.failing_weeks ?? [] });
  }
  const served = fwd.served;
  if (served?.vs_average && graded(served.vs_average)) {
    groups.push({ arm: 'served_vs_average', label: 'This season as the app served it, against the average',
      weeks: served.vs_average.failing_weeks ?? [] });
  }
  if (served?.vs_espn && graded(served.vs_espn)) {
    groups.push({ arm: 'served_vs_espn', label: 'This season as the app served it, against ESPN\'s projection',
      weeks: served.vs_espn.failing_weeks ?? [] });
  }
  return groups;
}

const weeksLabel = (w?: [number, number]) => (w ? (w[0] === w[1] ? `week ${w[0]}` : `weeks ${w[0]}-${w[1]}`) : '');

export default function StartSitGate() {
  const { data, loading, error, refetch } = useApi<GateResult>('/gates/start-sit');
  return (
    <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '180ms' }}
      aria-labelledby="gate-heading">
      <h2 id="gate-heading" className="text-sm font-black uppercase tracking-wide text-slate-500">
        Does our projection beat the dumb rule?
      </h2>
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
    const v = VERDICT[data.status] ?? VERDICT.not_run;
    return <p className="mt-2 text-sm leading-6 text-slate-600">{data.reason ?? v.say}</p>;
  }

  const v = VERDICT[data.verdict ?? ''] ?? { label: data.verdict ?? '—', chip: 'bg-slate-100 text-slate-700 ring-slate-200', say: '' };
  const past = data.past ?? {};
  const fwd = data.forward ?? {};
  const served = fwd.served;
  const lost = lostGroups(past, fwd);
  const passed = data.verdict === 'beats_dumb';
  // Forward weeks the app served on different settings from today's replay, and why.
  const differs = (served?.weeks ?? []).filter(w => w.served_before_k_fit || !w.same_weights);

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${v.chip}`}>
          {v.label}
        </span>
        <span className="text-xs text-slate-500">{v.say}</span>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-700">
        <b className="text-slate-950">Past seasons</b> ({past.seasons?.join(' and ')}, {weeksLabel(past.weeks)}):{' '}
        {pastSentence(data.verdict, past)}
      </p>

      {fwd.status ? (
        <p className="mt-2 text-sm leading-6 text-slate-700">This season: {fwd.reason ?? 'not available yet'}.</p>
      ) : (
        <div className="mt-2 space-y-1 text-sm leading-6 text-slate-700">
          <p>
            <b className="text-slate-950">This season</b> ({fwd.season}, {weeksLabel(fwd.weeks)}), today's model replayed:{' '}
            {say(fwd, 'the average')}.
          </p>
          {served && (
            <p>
              What the app actually served that week: against the average, {say(served.vs_average, 'the average')};
              against ESPN's projection (the literal "start the highest projection"), {say(served.vs_espn, 'ESPN')}.
            </p>
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

      {!passed && (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          "No proven edge" is not the same as "no edge": these weeks may be too few to show a small one.
        </p>
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
        <dl className="mt-2 space-y-1.5">
          <div><dt className="inline font-semibold text-slate-600">Ours: </dt><dd className="inline">{data.policy}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Dumb rule: </dt><dd className="inline">{data.baseline}</dd></div>
          {served?.vs_espn?.baseline && (
            <div><dt className="inline font-semibold text-slate-600">Literal rule: </dt><dd className="inline">{served.vs_espn.baseline}</dd></div>
          )}
          {fwd.label && <div><dt className="inline font-semibold text-slate-600">This season, replayed: </dt><dd className="inline">{fwd.label}</dd></div>}
          {served?.label && <div><dt className="inline font-semibold text-slate-600">This season, served: </dt><dd className="inline">{served.label}</dd></div>}
          <div><dt className="inline font-semibold text-slate-600">Which calls: </dt><dd className="inline">{data.universe}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Scoring: </dt><dd className="inline">{data.scoring}</dd></div>
          <div><dt className="inline font-semibold text-slate-600">Why no numbers: </dt>
            <dd className="inline">sizes measured on a replay do not carry over to your live lineups, so this panel shows only which way each result points.</dd></div>
          {data.replay_caveat && <div><dt className="inline font-semibold text-slate-600">Limit: </dt><dd className="inline">{data.replay_caveat}</dd></div>}
          {data.stored_at && <div><dt className="inline font-semibold text-slate-600">Measured: </dt><dd className="inline">{data.stored_at} UTC</dd></div>}
        </dl>
      </details>
    </>
  );
}
