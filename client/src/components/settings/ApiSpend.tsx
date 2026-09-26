import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, useApi } from '../../api';
import { Button, Card, Chip, EmptyState, Section, Skeleton, Tabs } from '../ui/DesignSystem';

/**
 * SPEND-UI (SPEND-TRACKER-UI.md sections 1, 2): Settings -> AI & developer, first section, in the
 * order API spend > Daily budgets > API key. Every number and word is the server's display block
 * (server/services/ai-spend-display.js via GET /dev/spend); this screen computes nothing.
 *
 * CLAUDE.md 2b exception: this section may show dollars and model display names (Haiku 4.5,
 * Sonnet 5, Opus 5.5). It never shows raw model ids, feature keys or the key itself.
 */

type Level = 'ok' | 'warn' | 'over' | 'none';
interface Part { label: string; cost_usd: number; calls: number; share: number }
interface BudgetRow {
  key: string; anchor: string; label: string; budget_usd: number | null; spent_usd: number; is_default: boolean;
  share: number | null; level: Level; editable: boolean; off: boolean;
}
export interface SpendDisplay {
  empty: boolean;
  today: { spent_usd: number; budget_usd: number; all_sources_usd: number; calls: number; share: number | null; level: Level; line: string; resets: string; estimate: boolean };
  last_7: { days: { date: string; label: string; cost_usd: number; calls: number; height: number }[]; avg_usd: number; avg_height: number; avg_line: string };
  breakdown: { feature: Part[]; model: Part[]; source: Part[] | null };
  brief_line: string;
  anomaly: { line: string; tone: 'amber' | 'red' } | null;
  budgets: BudgetRow[];
  verified_note: string;
  credit_errors_today: number;
}
interface SpendResponse { spend: SpendDisplay; api_key: { configured: boolean } }

export const money = (n: number | null | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const LEVEL_TEXT: Record<Level, string> = { ok: 'Under budget', warn: 'Near the budget', over: 'Budget reached', none: 'No budget set' };
/** The content width at which the breakdown shows three cards instead of one with tabs (spec section 2). */
export const THREE_CARDS_MIN_PX = 900;

/** The section's own width (a ResizeObserver), so the breakdown follows the content area, not the window. */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect?.().width ?? 0);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setW(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export default function ApiSpend({ focusBudget }: { focusBudget?: string | null }) {
  const { data, loading, error, refetch } = useApi<SpendResponse>('/dev/spend');
  const [spend, setSpend] = useState<SpendDisplay | null>(null);
  useEffect(() => { if (data?.spend) setSpend(data.spend); }, [data]);
  if (loading && !spend) {
    return <div className="space-y-4" data-testid="spend-loading"><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;
  }
  if (error && !spend) {
    return <Card><p className="ds-note" role="alert">Couldn&apos;t load AI spend right now.</p><Button size="sm" className="mt-3" onClick={refetch}>Try again</Button></Card>;
  }
  if (!spend) return null;
  return (
    <div className="space-y-6" data-testid="ai-settings">
      <SpendSection spend={spend} />
      <BudgetsSection rows={spend.budgets} focus={focusBudget ?? null} onSaved={setSpend} />
      <KeySection configured={!!data?.api_key?.configured} onSaved={refetch} />
    </div>
  );
}

/* ------------------------------------------------------------------ API spend */

export function SpendSection({ spend }: { spend: SpendDisplay }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const t = spend.today;
  return (
    <Section title="API spend" description="What the app's AI calls cost, in New York days." className="spend">
      <div ref={ref} className="space-y-4" data-testid="spend-section">
        {spend.anomaly && (
          <Card tone={spend.anomaly.tone === 'red' ? 'bad' : 'warn'}>
            <p className="ds-h" role="status" data-testid="spend-anomaly">{spend.anomaly.line}</p>
          </Card>
        )}
        {spend.empty ? (
          <EmptyState icon="inbox" title="No AI calls yet" description="Spend shows here after the first call. Answers from your plan cost nothing." />
        ) : (
          <>
            <div className="spend-grid">
              <Card className="spend-today">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="ds-h">Today</h3>
                  {t.estimate && <Chip title="From token counts at list prices, not Anthropic's invoice">Estimate</Chip>}
                </div>
                <p className="spend-big" data-testid="spend-today-line">{t.line}</p>
                {t.share != null && (
                  <div className={`spend-meter spend-meter-${t.level}`} role="meter" aria-label="Today's spend against the daily budget"
                    aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(t.share, 1)} aria-valuetext={`${LEVEL_TEXT[t.level]}: ${t.line}`}
                    data-level={t.level} data-testid="spend-meter">
                    <span style={{ transform: `scaleX(${Math.min(t.share, 1)})` }} />
                  </div>
                )}
                <p className="ds-note mt-2">{LEVEL_TEXT[t.level]} · {t.calls} call{t.calls === 1 ? '' : 's'} · {t.resets}</p>
              </Card>
              <WeekBars week={spend.last_7} />
            </div>
            <Breakdown parts={spend.breakdown} wide={width >= THREE_CARDS_MIN_PX} />
          </>
        )}
        <p className="ds-note" data-testid="spend-brief-line">{`Morning brief: ${spend.brief_line}.`}</p>
        <p className="ds-note" data-testid="spend-verified-note">{spend.verified_note}</p>
      </div>
    </Section>
  );
}

/** Last 7 days: one bar per day (one series, the accent) and a dashed line at the average of the previous 7 full days (the same served value as the anomaly banner). */
function WeekBars({ week }: { week: SpendDisplay['last_7'] }) {
  return (
    <Card className="spend-week">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="ds-h">Last 7 days</h3>
        <span className="spend-avg-key ds-note" data-testid="spend-avg-key"><i aria-hidden />{week.avg_line}</span>
      </div>
      <div className="spend-bars" role="img" aria-label={`Daily AI spend for the last 7 days. ${week.avg_line}.`} data-testid="spend-bars">
        <div className="spend-avg" style={{ bottom: `${week.avg_height * 100}%` }} aria-hidden data-testid="spend-avg" />
        {week.days.map(d => (
          <div key={d.date} className="spend-bar" title={`${d.label} ${d.date}: ${money(d.cost_usd)}, ${d.calls} call${d.calls === 1 ? '' : 's'}`}>
            <span className="spend-bar-fill" style={{ transform: `scaleY(${d.height})` }} />
            <span className="spend-bar-l">{d.label}</span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Daily AI spend</caption>
        <tbody>{week.days.map(d => <tr key={d.date}><th scope="row">{d.date}</th><td>{money(d.cost_usd)}</td><td>{d.calls} calls</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

type PartKey = 'feature' | 'source' | 'model';
const PART_TITLE: Record<PartKey, string> = { feature: 'By feature', source: 'By source', model: 'By model' };

/** Today by feature, source and model: three cards when the content area is 900 px or wider, else one card with tabs. */
export function Breakdown({ parts, wide }: { parts: SpendDisplay['breakdown']; wide: boolean }) {
  const keys: PartKey[] = parts.source ? ['feature', 'source', 'model'] : ['feature', 'model'];
  const [tab, setTab] = useState<PartKey>('feature');
  if (wide) {
    return <div className={`spend-parts spend-parts-${keys.length}`} data-testid="spend-breakdown" data-layout="cards">
      {keys.map(k => <Card key={k}><h3 className="ds-h mb-2">{PART_TITLE[k]}</h3><PartList rows={parts[k] ?? []} /></Card>)}
    </div>;
  }
  return (
    <Card>
      <div data-testid="spend-breakdown" data-layout="tabs">
        <Tabs label="Today's spend by" value={tab} onChange={setTab} tabs={keys.map(k => ({ id: k, label: PART_TITLE[k] }))} />
        <div className="mt-3"><PartList rows={parts[tab] ?? []} /></div>
      </div>
    </Card>
  );
}

function PartList({ rows }: { rows: Part[] }) {
  if (!rows.length) return <p className="ds-note">No calls today.</p>;
  return (
    <ul className="spend-part-list">
      {rows.map(r => (
        <li key={r.label} className="spend-part">
          <span className="spend-part-t">{r.label}</span>
          <span className="spend-part-v">{money(r.cost_usd)}</span>
          <span className="spend-part-n">{r.calls} call{r.calls === 1 ? '' : 's'}</span>
          <span className="spend-part-bar" aria-hidden><span style={{ transform: `scaleX(${r.share})` }} /></span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ Daily budgets */

export function BudgetsSection({ rows, focus, onSaved }: { rows: BudgetRow[]; focus: string | null; onSaved: (s: SpendDisplay) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A league's pot links by its own key; when that pot has no row today, its feature's row stands in.
  const focusRow = (rows.find(r => r.key === focus || r.anchor === focus) ?? (focus ? rows.find(r => r.key === focus.split(':')[0]) : undefined))?.anchor ?? null;
  useEffect(() => {
    if (!focusRow || typeof document === 'undefined') return;
    document.getElementById?.(focusRow)?.scrollIntoView?.({ block: 'center' });
  }, [focusRow]);

  const save = async (row: BudgetRow, usd: number | null) => {
    setBusy(true); setMsg(null);
    try {
      const res = await api<{ spend: SpendDisplay }>(`/dev/budgets/${encodeURIComponent(row.key)}`, { method: 'PUT', body: JSON.stringify({ usd }) });
      onSaved(res.spend);
      setEditing(null);
      setMsg(usd == null ? `${row.label} is back to its default.` : `${row.label}: ${money(usd)} a day.`);
    } catch (e) {
      console.warn('Settings: the budget could not be saved', e);
      setMsg((e as { status?: number })?.status === 400 ? 'A daily budget is a dollar amount from 0 to 100.' : 'Couldn\'t save the budget. Try again in a moment.');
    } finally { setBusy(false); }
  };

  return (
    <Section title="Daily budgets" description="A feature stops calling the AI for the day when it reaches its budget. 0 turns it off.">
      <div className="ds-table-wrap">
        <table className="ds-table spend-budgets" data-testid="spend-budgets">
          <thead><tr><th>Feature</th><th className="spend-num">Today</th><th className="spend-num">Budget</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} id={r.anchor} data-testid="spend-budget-row" data-level={r.level} className={r.anchor === focusRow ? 'spend-row-focus' : undefined}>
                <td>{r.label}{r.level === 'over' && <> <Chip tone="bad">Reached</Chip></>}{r.level === 'warn' && <> <Chip tone="warn">Near</Chip></>}</td>
                <td className="text-right">{money(r.spent_usd)}</td>
                <td className="text-right">{editing === r.key ? (
                  <input className="input spend-input" inputMode="decimal" aria-label={`Daily budget for ${r.label}, dollars`} value={value}
                    onChange={e => setValue(e.target.value)} autoFocus />
                ) : r.off ? 'Off' : r.budget_usd == null ? 'None' : `${money(r.budget_usd)}${r.is_default ? ' (default)' : ''}`}</td>
                <td className="text-right">
                  {!r.editable ? <span className="ds-note">Shares its feature&apos;s budget</span>
                    : editing === r.key ? (
                      <span className="spend-actions">
                        <Button size="sm" variant="primary" disabled={busy || !value.trim() || !Number.isFinite(Number(value))} onClick={() => save(r, Number(value))}>Set</Button>
                        <Button size="sm" variant="quiet" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                      </span>
                    ) : (
                      <Button size="sm" onClick={() => { setEditing(r.key); setValue(r.budget_usd == null ? '' : String(r.budget_usd)); setMsg(null); }}
                        aria-label={`Edit the daily budget for ${r.label}`}>Edit</Button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="ds-note mt-2" role="status" data-testid="spend-budget-msg">{msg}</p>}
    </Section>
  );
}

/* ------------------------------------------------------------------ API key */

/** Connected / Replace key. The key is never shown, not even masked, and the field is a password input. */
export function KeySection({ configured, onSaved }: { configured: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('/dev/key', { method: 'PUT', body: JSON.stringify({ key }) });
      setKey(''); setOpen(false); setMsg('Key saved. AI features are on.');
      onSaved();
    } catch (e) {
      console.warn('Settings: the API key could not be saved', e);
      setMsg((e as { status?: number })?.status === 400 ? 'That does not look like an Anthropic key.' : 'Couldn\'t save the key. Try again in a moment.');
    } finally { setBusy(false); }
  };
  return (
    <Section title="API key">
      <Card>
        <div data-testid="spend-key" className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`spend-dot ${configured ? 'spend-dot-on' : ''}`} aria-hidden />
            <span className="ds-h" data-testid="spend-key-state">{configured ? 'Connected' : 'Not connected'}</span>
          </div>
          {!open && <Button size="sm" onClick={() => { setOpen(true); setMsg(null); }}>{configured ? 'Replace key' : 'Add key'}</Button>}
        </div>
        <p className="ds-note mt-1">Anthropic API key, stored on this Mac only. It is never shown here.</p>
        {open && (
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void save(); }}>
            <input type="password" autoComplete="off" spellCheck={false} className="input min-w-0 flex-1" aria-label="New Anthropic API key"
              placeholder="Paste the new key" value={key} onChange={e => setKey(e.target.value)} />
            <Button size="sm" variant="primary" type="submit" disabled={busy || !key.trim()}>Save</Button>
            <Button size="sm" variant="quiet" onClick={() => { setOpen(false); setKey(''); }}>Cancel</Button>
          </form>
        )}
        {msg && <p className="ds-note mt-2" role="status">{msg}</p>}
      </Card>
    </Section>
  );
}
