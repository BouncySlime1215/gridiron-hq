import { useMemo, useState } from 'react';
import { api } from '../../../api';
import { TeamLogo } from './TeamLogo';
import { WongProjectionPanel } from './WongProjection';
import { Panel, Stat, StatRow } from './shared';
import {
  american, bookLabel, dollars, formatLooseValue, humanizeKey, kickoff, line, pct, signedUnits
} from './format';
import type { WongRecord, WongSeason as Season, WongTicket } from './types';

/**
 * The season, tracked across weeks rather than shown a week at a time.
 *
 * The board answers "what can I take now"; this answers "is any of it
 * working". Every number here comes from settled tickets — nothing is
 * back-filled and nothing retrospective is counted toward the record.
 */
export function WongSeasonView({ season, unitSizeDollars, onChanged }: {
  season: Season; unitSizeDollars: number | null; onChanged: () => void;
}) {
  const tickets = season.tickets ?? [];
  const record = normalizeRecord(season.record);
  const open = tickets.filter(ticket => isOpen(ticket));
  const settled = tickets.filter(ticket => !isOpen(ticket));
  const roi = season.roi;

  return <div className="space-y-4">
    <Panel
      eyebrow={`Season ${season.season ?? new Date().getFullYear()}`}
      title="Season tracker"
      description="Every ticket you marked as taken, and what it did."
      footer="A ticket counts toward this record only once it is settled. Open tickets are exposure, not results."
    >
      <StatRow columns="sm:grid-cols-5">
        <Stat label="Record" value={recordText(record, season.record)}
          detail={`${settled.length} settled · ${open.length} open`} />
        <Stat label="Units staked" value={signedUnits(season.units_staked).replace('+', '')}
          detail={unitSizeDollars != null ? dollars((season.units_staked ?? 0) * unitSizeDollars) : 'set a unit size'} />
        <Stat label="Units won" value={signedUnits(season.units_won)}
          tone={toneOf(season.units_won)}
          detail={unitSizeDollars != null && season.units_won != null ? dollars(season.units_won * unitSizeDollars) : '—'} />
        <Stat label="ROI" value={pct(roi, 1)} tone={toneOf(roi)} detail="Return on everything staked" />
        <Stat label="Tickets taken" value={tickets.length}
          detail={`${tickets.filter(t => t.mode === 'placed').length} real · ${tickets.filter(t => t.mode !== 'placed').length} paper`} />
      </StatRow>
    </Panel>

    <PacePanel pace={season.pace} unitSizeDollars={unitSizeDollars} />

    <WongProjectionPanel projection={season.projection} unitSizeDollars={unitSizeDollars} />

    <TicketLedger tickets={tickets} unitSizeDollars={unitSizeDollars} onChanged={onChanged} />
  </div>;
}

/**
 * Pace, rendered from whatever keys the server sends.
 *
 * The contract pins the endpoint but not this object's fields, so it is drawn
 * generically instead of assuming a shape and silently dropping whatever does
 * not match. Key names decide the unit.
 */
function PacePanel({ pace, unitSizeDollars }: { pace: Record<string, unknown> | null | undefined; unitSizeDollars: number | null }) {
  const entries = useMemo(() => Object.entries(pace ?? {})
    .filter(([, value]) => value != null && typeof value !== 'object'), [pace]);
  if (!entries.length) return null;

  return <Panel eyebrow="Where the season is heading" title="Pace"
    description="How the season so far extrapolates over the weeks that are left.">
    <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map(([key, value]) => <Stat key={key} label={humanizeKey(key)}
        value={formatLooseValue(key, value)}
        detail={unitSizeDollars != null && /unit/.test(key) && typeof value === 'number'
          ? dollars(value * unitSizeDollars) : undefined} />)}
    </div>
  </Panel>;
}

function TicketLedger({ tickets, unitSizeDollars, onChanged }: {
  tickets: WongTicket[]; unitSizeDollars: number | null; onChanged: () => void;
}) {
  const ordered = useMemo(() => [...tickets].sort((a, b) => {
    const openDelta = Number(isOpen(b)) - Number(isOpen(a));
    if (openDelta) return openDelta;
    return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
  }), [tickets]);

  return <Panel title="Ticket ledger" description="Newest first, open tickets at the top.">
    {ordered.length === 0 ? (
      <div className="p-5 text-sm text-slate-500">
        No tickets yet this season. Take one from the board with “I took this bet” and it starts tracking here.
      </div>
    ) : <div className="divide-y divide-slate-100">
      {ordered.map(ticket => <TicketRow key={String(ticket.id)} ticket={ticket}
        unitSizeDollars={unitSizeDollars} onChanged={onChanged} />)}
    </div>}
  </Panel>;
}

function TicketRow({ ticket, unitSizeDollars, onChanged }: {
  ticket: WongTicket; unitSizeDollars: number | null; onChanged: () => void;
}) {
  const status = String(ticket.status ?? ticket.result ?? 'open').toLowerCase();
  const profit = ticket.profit_units ?? ticket.units_won ?? null;
  const statusTone = /won|win/.test(status) ? 'text-emerald-700'
    : /lost|loss/.test(status) ? 'text-rose-700'
    : /push|void|refund|reduced/.test(status) ? 'text-slate-600' : 'text-slate-400';

  return <div className="p-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${ticket.mode === 'placed'
        ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
        {ticket.mode === 'placed' ? 'real money' : 'paper'}
      </span>
      <span className="text-sm font-black text-slate-900">{bookLabel(ticket.book)}</span>
      <span className="text-xs font-bold tabular-nums text-slate-600">
        {american(ticket.american_price)} · {ticket.stake_units}u
        {unitSizeDollars != null ? ` · ${dollars(ticket.stake_units * unitSizeDollars)}` : ''}
      </span>
      {ticket.week != null && <span className="text-[11px] text-slate-400">Week {ticket.week}</span>}
      <span className="ml-auto flex items-center gap-2">
        {profit != null && <span className={`text-xs font-black tabular-nums ${toneClass(profit)}`}>{signedUnits(profit)}</span>}
        <span className={`text-xs font-black uppercase ${statusTone}`}>{status}</span>
      </span>
    </div>

    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {(ticket.legs ?? []).map((leg, index) => <div key={`${leg.event_id ?? index}:${leg.team}`}
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <TeamLogo team={leg.team} size={20} />
        <span className="truncate text-xs font-bold text-slate-800">{leg.team}</span>
        <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-slate-500">
          {line(leg.line ?? null)} <span className="font-bold text-emerald-700">→ {line(leg.teased_to ?? null)}</span>
        </span>
        {leg.result && <span className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">
          {leg.result}{leg.team_score != null ? ` ${leg.team_score}–${leg.opponent_score ?? '?'}` : ''}
        </span>}
      </div>)}
    </div>

    {(ticket.created_at || ticket.settled_at) && <div className="mt-2 text-[10px] text-slate-400">
      {ticket.created_at ? `Taken ${kickoff(ticket.created_at)}` : ''}
      {ticket.settled_at ? ` · settled ${kickoff(ticket.settled_at)}` : ''}
    </div>}

    {isOpen(ticket) && <SettleTicket ticket={ticket} onChanged={onChanged} />}
  </div>;
}

/**
 * Settlement.
 *
 * A teaser is graded from final scores — that is what decides each leg and
 * therefore the ticket — so the form asks for exactly that, in the same
 * `{ scores: [...] }` shape the existing teaser execution ledger already
 * posts (`server/services/nfl-teaser-execution.js`). If the service ends up
 * grading tickets on its own, the extra body is harmless.
 */
function SettleTicket({ ticket, onChanged }: { ticket: WongTicket; onChanged: () => void }) {
  const legs = ticket.legs ?? [];
  const [scores, setScores] = useState<Record<string, { team: string; opponent: string }>>(() =>
    Object.fromEntries(legs.map((leg, index) => [String(leg.event_id ?? index), { team: '', opponent: '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const keyOf = (leg: WongTicket['legs'][number], index: number) => String(leg.event_id ?? index);
  const update = (key: string, side: 'team' | 'opponent', value: string) =>
    setScores(current => ({ ...current, [key]: { ...current[key], [side]: value } }));
  const complete = legs.every((leg, index) => {
    const entry = scores[keyOf(leg, index)];
    return entry && entry.team !== '' && entry.opponent !== '';
  });

  const settle = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/betting/wong/tickets/${ticket.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({
          scores: legs.map((leg, index) => ({
            event_id: leg.event_id ?? null,
            team: leg.team,
            team_score: Number(scores[keyOf(leg, index)]?.team),
            opponent_score: Number(scores[keyOf(leg, index)]?.opponent)
          }))
        })
      });
      onChanged();
    } catch (reason: any) {
      setError(reason?.message ?? 'Could not settle this ticket.');
    } finally { setBusy(false); }
  };

  if (!open) return <button type="button" onClick={() => setOpen(true)}
    className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-slate-400">
    Settle this ticket
  </button>;

  return <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
    <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Final scores grade every leg</div>
    <div className="mt-2 flex flex-wrap items-end gap-3">
      {legs.map((leg, index) => {
        const key = keyOf(leg, index);
        return <div key={key}>
          <div className="mb-1 text-[10px] text-slate-500">{leg.team}{leg.opponent ? ` – ${leg.opponent}` : ''}</div>
          <div className="flex items-center gap-1">
            <input type="number" min="0" value={scores[key]?.team ?? ''} aria-label={`${leg.team} score`}
              onChange={event => update(key, 'team', event.target.value)}
              className="w-14 rounded border border-slate-300 px-2 py-1 text-xs tabular-nums" />
            <span className="text-slate-400">–</span>
            <input type="number" min="0" value={scores[key]?.opponent ?? ''} aria-label={`${leg.team} opponent score`}
              onChange={event => update(key, 'opponent', event.target.value)}
              className="w-14 rounded border border-slate-300 px-2 py-1 text-xs tabular-nums" />
          </div>
        </div>;
      })}
      <button type="button" onClick={settle} disabled={!complete || busy}
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50">
        {busy ? 'Settling…' : 'Settle'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs font-bold text-slate-500 underline">Cancel</button>
    </div>
    {error && <p className="mt-2 text-xs font-semibold text-rose-700">{error}</p>}
  </div>;
}

const isOpen = (ticket: WongTicket) => {
  const status = String(ticket.status ?? ticket.result ?? 'open').toLowerCase();
  return !status || status === 'open' || status === 'pending';
};

const toneOf = (value: number | null | undefined) =>
  typeof value !== 'number' || !Number.isFinite(value) ? 'neutral' : value > 0 ? 'good' : value < 0 ? 'bad' : 'neutral';

const toneClass = (value: number) => value > 0 ? 'text-emerald-700' : value < 0 ? 'text-rose-700' : 'text-slate-600';

function normalizeRecord(record: Season['record']): WongRecord | null {
  return record && typeof record === 'object' ? record : null;
}

function recordText(record: WongRecord | null, raw: Season['record']) {
  if (typeof raw === 'string') return raw;
  if (!record) return '—';
  const parts = [record.wins ?? 0, record.losses ?? 0];
  if (record.pushes) parts.push(record.pushes);
  return parts.join('–');
}
