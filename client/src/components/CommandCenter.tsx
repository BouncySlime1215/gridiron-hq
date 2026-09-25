import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api';
import { useLeague } from '../state/league';
import { Button, Card, Chip, Icon, Section, Skeleton, ErrorState, type IconName } from './ui/DesignSystem';

/**
 * This week, across every league (SK-01). Reads GET /api/command-center
 * (server/services/command-center.js#commandCenter), which computes nothing:
 * dead starters come from lineupDiff, the streaming swap from WV-01's
 * streamingBoard, injury alerts from WV-02's waiverBoard().injury_alerts and the
 * "no move yet" nudge from the collected transactions. A check that is not on
 * this build, failed, or has stale data is named under the list, never shown
 * as "nothing to do".
 *
 * Three lines per card: what / why (with its number) / what to do.
 */

type Tone = 'red' | 'amber' | 'green' | 'grey';
export interface CommandItem {
  league: { id: number; name: string };
  kind: 'dead_starter' | 'injury_alert' | 'stream' | 'no_move';
  what: string; why: string;
  action: { label: string; href: string };
  deadline: string | null; deadline_basis: string | null; deadline_guess: boolean;
  tone: Tone;
}
interface SourceState { state: string; message?: string; producer?: string; count?: number | null }
export interface CommandCenterPayload {
  generated_at: string;
  items: CommandItem[];
  leagues: { id: number; name: string; week: number | null; sources: Record<'dead_starters' | 'injury_alerts' | 'streams' | 'moves', SourceState> }[];
  empty_reason: 'no_leagues' | 'nothing_due' | null;
  /** Checks that ran in every league (server: command-center.js#clearChecks); only these may be stated as 0. */
  clear_checks?: ('dead_starters' | 'injury_alerts' | 'streams' | 'moves')[];
}

/** The card's tone as an icon in the matching status colour (no coloured border bars). */
const TONE_ICON: Record<Tone, { icon: IconName; cls: string }> = {
  red: { icon: 'stop', cls: 'text-[var(--c-red)] bg-[var(--c-red-tint)]' },
  amber: { icon: 'warn', cls: 'text-[var(--c-amber)] bg-[var(--c-amber-tint)]' },
  green: { icon: 'ok', cls: 'text-[var(--c-green)] bg-[var(--c-green-tint)]' },
  grey: { icon: 'clock', cls: 'text-[var(--c-muted)] bg-[var(--c-soft)]' },
};
/** Cards shown before "Show more". */
export const FIRST_CARDS = 4;
const CHECK_LABEL: Record<string, string> = {
  dead_starters: 'dead starters', injury_alerts: 'injury alerts', streams: 'defense streaming', moves: 'weekly moves',
};

const CLEAR_ZERO: Record<string, string> = {
  dead_starters: '0 dead starters', injury_alerts: '0 injury alerts',
  streams: '0 better defenses to stream', moves: '0 leagues without a move this week',
};

/** The "nothing needs you" sentence, built only from checks that ran in every league. */
export function clearSentence(p: CommandCenterPayload) {
  const n = p.leagues.length;
  const zeros = (p.clear_checks ?? []).map(k => CLEAR_ZERO[k]).filter(Boolean);
  const head = `Checked ${n} league${n === 1 ? '' : 's'}`;
  return zeros.length
    ? `${head}: ${zeros.join(', ')}.`
    : `${head}, but none of the checks could run in every league, so none is stated as clear.`;
}

function due(iso: string | null, basis: string | null) {
  if (!iso) return 'no deadline known';
  const d = new Date(iso);
  const when = d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return basis === 'kickoff' ? `before kickoff ${when}` : `by ${when}`;
}

function age(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

/** Checks that could not run, grouped by check, in plain words. */
export function missingChecks(p: CommandCenterPayload) {
  const out: { check: string; state: string; leagues: number; message?: string }[] = [];
  for (const k of Object.keys(CHECK_LABEL)) {
    const bad = p.leagues.map(l => l.sources[k as keyof typeof l.sources]).filter(s => s && s.state !== 'present');
    if (!bad.length) continue;
    out.push({ check: CHECK_LABEL[k], state: bad[0].state, leagues: bad.length, message: bad[0].message });
  }
  return out;
}

export function CommandCard({ item, onAct }: { item: CommandItem; onAct: (item: CommandItem) => void }) {
  const tone = TONE_ICON[item.tone] ?? TONE_ICON.grey;
  return <Card as="article" lift className="!p-4 flex gap-3" >
    <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${tone.cls}`}><Icon name={tone.icon} size={16} /></span>
    <div className="min-w-0 flex-1">
      <div className="font-semibold text-slate-900">{item.what}</div>
      <p className="mt-1 text-sm text-slate-600">{item.why}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Tonal, not filled: the next move on Today is the one primary action on the page. */}
        <Button variant="quiet" className="min-h-[40px]" onClick={() => onAct(item)}
          aria-label={`${item.action.label} in ${item.league.name}`}>{item.action.label}</Button>
        <span className="text-xs text-slate-500">
          {item.league.name} · {due(item.deadline, item.deadline_basis)}
          {item.deadline_guess && <span className="ml-1"><Chip tone="warn" title="ESPN does not say which time zone its waiver hour is in; Eastern is assumed.">guess</Chip></span>}
        </span>
      </div>
    </div>
  </Card>;
}

export function CommandCenterView({ data, onAct }: { data: CommandCenterPayload; onAct: (item: CommandItem) => void }) {
  const missing = missingChecks(data);
  const checked = data.leagues.length;
  const [all, setAll] = useState(false);
  const shown = all ? data.items : data.items.slice(0, FIRST_CARDS);
  return <div className="space-y-3">
    {data.empty_reason === 'no_leagues'
      ? <Card className="p-5 text-center">
          <div className="font-bold text-slate-800">No leagues connected yet</div>
          <p className="mt-1 text-sm text-slate-500">Connect a league and this list fills with what each one needs this week.</p>
        </Card>
      : data.items.length === 0
        ? <Card className="p-5">
            <div className="font-bold text-slate-800">{(data.clear_checks ?? []).length === Object.keys(CLEAR_ZERO).length ? 'Nothing needs you this week' : 'Nothing found in the checks that ran'}</div>
            <p className="mt-1 text-sm text-slate-500">{clearSentence(data)}{missing.length ? ' The rest could not run; see below.' : ''}</p>
          </Card>
        : <>
            <div className="grid gap-3 md:grid-cols-2 ds-stagger">
              {shown.map((it, i) => <CommandCard key={`${it.league.id}-${it.kind}-${i}`} item={it} onAct={onAct} />)}
            </div>
            {data.items.length > shown.length && (
              <Button className="w-full" onClick={() => setAll(true)}>Show {data.items.length - shown.length} more</Button>
            )}
          </>}
    {missing.length > 0 && <div role="note" className="ds-card ds-card-warn p-3 text-xs">
      <div className="font-semibold">Not checked, so not shown as clear:</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {missing.slice(0, 5).map(m => <li key={m.check}>{m.check} in {m.leagues} of {checked} league{checked === 1 ? '' : 's'}: {m.message ?? m.state.replace(/_/g, ' ')}</li>)}
      </ul>
    </div>}
    {data.generated_at && <div className="text-xs text-slate-400">Checked {age(data.generated_at)}</div>}
  </div>;
}

export default function CommandCenter() {
  const { data, loading, error, refetch } = useApi<CommandCenterPayload>('/command-center', { staleTime: 5 * 60_000 });
  const { setActiveId } = useLeague();
  const navigate = useNavigate();
  const act = (item: CommandItem) => { setActiveId(item.league.id); navigate(item.action.href); };
  return <Section title="This week, every league" description="Sorted by deadline. Each card says what, why, and the one thing to do." className="mb-6">
    {loading && !data
      ? <div className="space-y-3" aria-busy="true" aria-label="Loading this week's list">{[0, 1, 2].map(i => <Card key={i} className="space-y-2 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-9 w-32" /></Card>)}</div>
      : error && !data
        ? <ErrorState title="Could not load this week's list" message="The server did not answer. Your leagues are unchanged." retry={refetch} />
        : data ? <CommandCenterView data={data} onAct={act} /> : null}
  </Section>;
}
