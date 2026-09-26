import { useState } from 'react';
import { Avatar, Button, Card, Chip, type Tone } from '../ui/DesignSystem';

/**
 * NUMBERS-PEOPLE: one item's two reads and the verdict. Claude (numbers): Claude from the plan's
 * numbers alone. Jev (people): Claude's read fed to Jev, which leads with its own take from the
 * stored chat reads (ungraded). ONE component, used in two places, prop-driven and self-contained:
 *   variant="full"     Trades → Numbers & People: the item with photos, both lanes side by side
 *                      (stacked on a phone), the cited numbers, "Ask Coach about this".
 *   variant="compact"  inside a Coach answer about an item that has a read: the verdict, a stance
 *                      chip and a one-line why per lane; "Details" opens the cited numbers.
 * Everything shown arrives ready from the one producer (server services/numbers-people/view.js):
 * labels, formatted numbers, the verdict. Nothing is computed here.
 */
export type Stance = 'go' | 'wait' | 'avoid';
export type Verdict = 'agree' | 'differ' | 'same_but' | 'no_people_read';
export interface LaneRead {
  stance?: Stance; basis?: string; why?: string | null; why_withheld?: boolean;
  cites?: { label: string; value: string }[]; skipped?: string; label?: string;
}
export interface NPItem {
  key: string; item_type: 'move' | 'target' | 'partner'; item_id: string; title: string; subtitle: string | null;
  partner?: string | null; players: { id: string; name: string }[];
  numbers: LaneRead; people: LaneRead; verdict: Verdict; read_at?: string | null;
  history: { week: number | null; numbers: Stance | null; people: Stance | null; verdict: Verdict }[];
}

export const STANCE: Record<Stance, { label: string; tone: Tone }> = {
  go: { label: 'Go', tone: 'good' }, wait: { label: 'Wait', tone: 'warn' }, avoid: { label: 'Avoid', tone: 'bad' }
};
export const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  differ: { label: 'Differ', tone: 'warn' }, same_but: { label: 'Same call, different reasons', tone: 'accent' },
  agree: { label: 'Agree', tone: 'good' }, no_people_read: { label: 'No chat read', tone: 'neutral' }
};
const BASIS: Record<string, string> = {
  title_gain: 'odds gain', price: 'price', willingness: 'will he deal', roster_fit: 'roster fit', risk: 'risk', timing: 'timing'
};

const whyOf = (read: LaneRead, people?: boolean) => (read.skipped
  ? (people ? `No people read: ${read.skipped}.` : 'No read this run.')
  : read.why ?? (read.why_withheld ? 'Reason withheld: it stated a number the lane did not cite.' : ''));
/** The two lanes' names, as Nick calls them. */
export const LANES = { numbers: { name: 'Claude', sub: 'numbers' }, people: { name: 'Jev', sub: 'people' } } as const;

function Cites({ read }: { read: LaneRead }) {
  if (!read.cites?.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5">
      {read.cites.slice(0, 3).map(c => (
        <li key={`${c.label}:${c.value}`} className="ds-note flex min-w-0 gap-1"><span className="truncate">{c.label}</span><b className="shrink-0 tabular-nums">{c.value}</b></li>
      ))}
    </ul>
  );
}

function Lane({ read, people }: { read: LaneRead; people?: boolean }) {
  const lane = people ? LANES.people : LANES.numbers;
  return (
    <div className="min-w-0 rounded-[var(--r-tile)] bg-[var(--c-soft)] p-3" data-testid={`np-lane-${people ? 'people' : 'numbers'}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{lane.name}</span><span className="ds-note">{lane.sub}</span>
        {read.stance && <Chip tone={STANCE[read.stance].tone}>{STANCE[read.stance].label}</Chip>}
        {read.basis && BASIS[read.basis] && <span className="ds-note">on {BASIS[read.basis]}</span>}
      </div>
      {people && <div className="ds-note mb-1">{read.label ?? 'chat read (ungraded)'}</div>}
      <p className={read.skipped ? 'ds-note' : 'text-sm'}>{whyOf(read, people)}</p>
      <Cites read={read} />
    </div>
  );
}

/** Compact: one line per lane (name, stance chip, why), the verdict, details on demand. */
function Compact({ item }: { item: NPItem }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[item.verdict];
  const row = (read: LaneRead, people?: boolean) => (
    <div className="flex min-w-0 items-start gap-2" data-testid={`np-compact-${people ? 'people' : 'numbers'}`}>
      <span className="w-12 shrink-0 text-xs font-semibold leading-6" title={`${(people ? LANES.people : LANES.numbers).name} (${(people ? LANES.people : LANES.numbers).sub})`}>{(people ? LANES.people : LANES.numbers).name}</span>
      {read.stance ? <Chip tone={STANCE[read.stance].tone}>{STANCE[read.stance].label}</Chip> : <Chip>No read</Chip>}
      <span className={`min-w-0 flex-1 text-sm leading-6 ${open ? '' : 'truncate'}`} title={whyOf(read, people)}>{whyOf(read, people)}</span>
    </div>
  );
  return (
    <Card pad={false} className="p-3" as="section">
      <div data-testid="np-card-compact" data-verdict={item.verdict}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">Numbers &amp; People</span>
          <Chip tone={v.tone}>{v.label}</Chip>
        </div>
        <div className="space-y-1.5">
          {row(item.numbers)}
          {row(item.people, true)}
        </div>
        {open && (
          <div className="mt-2 space-y-2" data-testid="np-compact-detail">
            <div><div className="ds-note">Claude · numbers{item.numbers.basis && BASIS[item.numbers.basis] ? ` · on ${BASIS[item.numbers.basis]}` : ''}</div><Cites read={item.numbers} /></div>
            <div><div className="ds-note">Jev · people · {item.people.label ?? 'chat read (ungraded)'}{item.people.basis && BASIS[item.people.basis] ? ` · on ${BASIS[item.people.basis]}` : ''}</div><Cites read={item.people} /></div>
          </div>
        )}
        <div className="mt-1 flex justify-end">
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide details' : 'Details'}</Button>
        </div>
      </div>
    </Card>
  );
}

export default function NumbersPeopleCard({ item, variant = 'full', headshots = {}, onAsk }: {
  item: NPItem; variant?: 'full' | 'compact'; headshots?: Record<string, string>; onAsk?: (item: NPItem) => void;
}) {
  if (variant === 'compact') return <Compact item={item} />;
  const v = VERDICT[item.verdict];
  const pics = item.players.slice(0, 3);
  return (
    <Card tone={item.verdict === 'differ' ? 'warn' : undefined} className="min-w-0" as="article">
      <div data-testid="np-card" data-verdict={item.verdict}>
        <div className="mb-3 flex items-start gap-3">
          <div className="flex shrink-0 -space-x-2">
            {pics.length ? pics.map(p => <Avatar key={p.id} name={p.name} src={headshots[p.id] ?? null} size={36} />)
              : <Avatar name={item.title} size={36} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold" title={item.title}>{item.title}</div>
            {item.subtitle && <div className="ds-note truncate" title={item.subtitle}>{item.subtitle}</div>}
          </div>
          <Chip tone={v.tone}>{v.label}</Chip>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Lane read={item.numbers} />
          <Lane read={item.people} people />
        </div>
        {onAsk && (
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="quiet" icon="coach" onClick={() => onAsk(item)}>Ask Coach about this</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
