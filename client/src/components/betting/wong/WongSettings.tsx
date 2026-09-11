import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { Panel, Stat, StatRow } from './shared';
import { bookLabel, dollars } from './format';
import type { WongSettings } from './types';

const KNOWN_BOOKS = ['draftkings', 'fanduel', 'pinnacle', 'betmgm', 'caesars', 'betrivers', 'espnbet', 'bovada'];

const REDUCED_PAYOUT_OPTIONS = [
  ['reduce_to_single', 'Drops to a single — the pushed leg is voided and the other leg pays alone'],
  ['push_refunds_stake', 'Whole ticket refunds — one push voids the ticket and returns the stake'],
  ['loses', 'The ticket loses — a push is graded as a miss']
] as const;

/**
 * Set the unit size once, for the season.
 *
 * A unit is only meaningful if it stops moving: change it mid-season and
 * every earlier row in the ledger silently starts meaning something else.
 * So this is one small form, saved deliberately, and it says as much.
 */
export function WongSettingsView({ settings, onSaved }: {
  settings: WongSettings; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<WongSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft(settings); setSaved(false); }, [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof WongSettings>(key: K, value: WongSettings[K]) => {
    setDraft(current => ({ ...current, [key]: value })); setSaved(false);
  };
  const toggleBook = (book: string) => {
    const books = draft.books ?? [];
    set('books', books.includes(book) ? books.filter(entry => entry !== book) : [...books, book]);
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api('/betting/wong/settings', { method: 'PUT', body: JSON.stringify(draft) });
      setSaved(true);
      onSaved();
    } catch (reason: any) {
      setError(reason?.message ?? 'Could not save these settings.');
    } finally { setBusy(false); }
  };

  const unit = Number(draft.unit_size_dollars) || 0;
  const bankrollUnits = Number(draft.bankroll_units) || 0;
  const maxTickets = Number(draft.max_tickets_per_week) || 0;
  const books = [...new Set([...KNOWN_BOOKS, ...(draft.books ?? [])])];

  return <div className="space-y-4">
    <Panel
      eyebrow="Set once, for the season"
      title="Staking"
      description="A unit only means something if it holds still. Changing it mid-season quietly rewrites what every earlier row in the ledger was worth."
      footer="Saved on the server, not in this browser — the phone and the laptop read the same unit size."
    >
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Unit size" hint="One unit, in dollars. Every stake and every result on this hub is a multiple of it.">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-400">$</span>
            <input type="number" min={1} step={1} value={draft.unit_size_dollars ?? ''}
              onChange={event => set('unit_size_dollars', Number(event.target.value))}
              className="w-32 rounded-md border border-slate-300 px-3 py-2 text-base font-black tabular-nums text-slate-900" />
          </div>
        </Field>
        <Field label="Bankroll" hint="How many units the season is allowed to risk in total.">
          <div className="flex items-center gap-2">
            <input type="number" min={1} step={1} value={draft.bankroll_units ?? ''}
              onChange={event => set('bankroll_units', Number(event.target.value))}
              className="w-32 rounded-md border border-slate-300 px-3 py-2 text-base font-black tabular-nums text-slate-900" />
            <span className="text-sm font-bold text-slate-400">units</span>
          </div>
        </Field>
        <Field label="Tickets per week" hint="The cap the recommended non-overlapping set is built against.">
          <input type="number" min={1} max={12} value={draft.max_tickets_per_week ?? ''}
            onChange={event => set('max_tickets_per_week', Number(event.target.value))}
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-base font-black tabular-nums text-slate-900" />
        </Field>
        <Field label="Push rule at your book" hint="How your book grades a ticket where one leg lands exactly on the teased number. Books genuinely differ, and it changes the maths.">
          <ReducedPayoutControl value={draft.reduced_payout} onChange={value => set('reduced_payout', value)} />
        </Field>
      </div>

      <StatRow columns="sm:grid-cols-3">
        <Stat label="One unit" value={dollars(unit)} detail="per single-unit ticket" />
        <Stat label="A full week" value={dollars(unit * maxTickets)} detail={`${maxTickets} tickets at 1u each`} />
        <Stat label="Bankroll" value={dollars(unit * bankrollUnits)} detail={`${bankrollUnits} units`} />
      </StatRow>
    </Panel>

    <Panel eyebrow="Which books to pull" title="Books"
      description="Only these are captured on refresh and compared on the board."
      footer="A book you cannot actually bet at is noise on the comparison — leave it off.">
      <div className="flex flex-wrap gap-2 p-4">
        {books.map(book => {
          const active = (draft.books ?? []).includes(book);
          return <button key={book} type="button" onClick={() => toggleBook(book)} aria-pressed={active}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${active
              ? 'border-emerald-600 bg-emerald-600 text-white'
              : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'}`}>
            {bookLabel(book)}
          </button>;
        })}
      </div>
    </Panel>

    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={save} disabled={!dirty || busy}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-50">
        {busy ? 'Saving…' : 'Save for the season'}
      </button>
      {dirty && <button type="button" onClick={() => setDraft(settings)} className="text-sm font-bold text-slate-500 underline">Discard changes</button>}
      {saved && !dirty && <span className="text-sm font-bold text-emerald-700">Saved.</span>}
      {error && <span className="text-sm font-semibold text-rose-700">{error}</span>}
    </div>
  </div>;
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <label className="block">
    <span className="text-xs font-black uppercase tracking-[.1em] text-slate-500">{label}</span>
    <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{hint}</span>
    <span className="mt-2 block">{children}</span>
  </label>;
}

/**
 * `reduced_payout` is typed loosely in the contract, so the control matches
 * whatever the server actually stores rather than forcing a shape on it.
 */
function ReducedPayoutControl({ value, onChange }: {
  value: WongSettings['reduced_payout']; onChange: (value: WongSettings['reduced_payout']) => void;
}) {
  if (typeof value === 'boolean') {
    return <label className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} className="h-4 w-4" />
      My book reduces the ticket to a single when a leg pushes
    </label>;
  }
  if (typeof value === 'number') {
    return <input type="number" step="0.01" value={value} onChange={event => onChange(Number(event.target.value))}
      className="w-40 rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums text-slate-900" />;
  }
  const current = typeof value === 'string' ? value : REDUCED_PAYOUT_OPTIONS[0][0];
  const known = REDUCED_PAYOUT_OPTIONS.some(([id]) => id === current);
  return <select value={current} onChange={event => onChange(event.target.value)}
    className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900">
    {!known && <option value={current}>{current}</option>}
    {REDUCED_PAYOUT_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </select>;
}
