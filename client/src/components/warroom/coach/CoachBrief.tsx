import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../api';

/**
 * COACH-BRIEF-UI: the morning brief (or the weekly check-in) at the top of the Coach
 * dock, read from GET /api/coach/brief/:leagueId?kind=morning|weekly (COACH-BRIEF, #307).
 *
 * Every line drawn is a claim the route already grounded; each carries its cite(s), and a
 * cite shows the ledger row it stands on (hover: title; tap: the source line). Lines the
 * route typed unknown read "... not read: <reason>" and are marked as such. Dropped claims
 * are never drawn: at most their count, so Nick knows something was held back.
 *
 * The brief never blocks the page: it is asked for after first paint, a slow route shows
 * one small loading line, and a failed or timed-out route shows one small error line with
 * a retry. Flag off (GRIDIRON_COACH_BRIEF_ENABLED, or preview mode) -> nothing is drawn.
 */
type Kind = 'morning' | 'weekly';

interface Claim { section?: string; text: string; cites: string[] }
interface LedgerQuery { id: string; tool?: string | null; tables?: string[]; rows: Record<string, unknown>[] }
interface LedgerDerived { id: string; op?: string; value?: unknown; inputs?: string[]; label?: string }
interface Ledger { queries: LedgerQuery[]; derived: LedgerDerived[] }
interface Brief {
  status: 'ok' | 'off' | 'unknown' | 'failed';
  reason?: string;
  preview?: boolean;
  preview_reason?: string;
  claims?: Claim[];
  dropped?: unknown[];
  text?: string;
  ledger?: Ledger;
  plans_as_of?: string | null;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; brief: Brief };

export const BRIEF_TIMEOUT_MS = 8000;
const KINDS: { kind: Kind; label: string }[] = [{ kind: 'morning', label: 'Morning' }, { kind: 'weekly', label: 'Weekly' }];
const CITE = /^(r\d+)#(\d+)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const UNKNOWN = / not read: /;

const show = (v: unknown) => (v == null ? 'empty' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v));

/** A cite -> the ledger row it points at, as one readable line. Unresolvable says so. */
export function citeSource(ledger: Ledger | undefined, cite: string): string {
  const d = ledger?.derived?.find(x => x.id === cite);
  if (d) return `${cite}: ${show(d.value)} (${d.op ?? 'derived'}${d.inputs?.length ? ` of ${d.inputs.join(', ')}` : ''})`;
  const m = CITE.exec(cite);
  const q = m ? ledger?.queries?.find(x => x.id === m[1]) : undefined;
  const row = m && q ? q.rows?.[Number(m[2])] : undefined;
  if (!m || !q || !row || !Object.prototype.hasOwnProperty.call(row, m[3])) return `${cite}: not in the ledger sent with this brief`;
  const from = q.tool ?? q.tables?.[0] ?? 'query';
  return `${cite}: ${m[3]} = ${show(row[m[3]])} (${from}, row ${m[2]})`;
}

/** The heading each claim sits under, read from the route's own rendered text (no second copy of the headings). */
function headingsOf(brief: Brief): (string | null)[] {
  const claims = brief.claims ?? [];
  const out: (string | null)[] = claims.map(() => null);
  let heading: string | null = null;
  let j = 0;
  for (const raw of (brief.text ?? '').split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || j >= claims.length) continue;
    if (line === `- ${claims[j].text}`) { out[j++] = heading; continue; }
    if (line === claims[j].text) { out[j++] = null; heading = null; continue; }
    if (line.endsWith(':')) heading = line.slice(0, -1);
  }
  return out;
}

/** Run `fn` once the browser has painted (never inside the render that paints the deck). */
function afterPaint(fn: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const raf = typeof window !== 'undefined' ? window.requestAnimationFrame : undefined;
  if (raf) {
    const id = raf(() => { t = setTimeout(fn, 0); });
    return () => { window.cancelAnimationFrame?.(id); if (t) clearTimeout(t); };
  }
  t = setTimeout(fn, 0);
  return () => clearTimeout(t);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the brief took longer than ${Math.round(ms / 1000) || ms / 1000} s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function ClaimLine({ claim, heading, ledger, open, onCite }: {
  claim: Claim; heading: string | null; ledger?: Ledger; open: string | null; onCite: (cite: string) => void;
}) {
  const unknown = UNKNOWN.test(claim.text);
  return (
    <li className={`wr-brief-claim${unknown ? ' wr-brief-unknown' : ''}`} data-testid="coach-brief-claim"
      data-unknown={unknown ? 'true' : 'false'} data-section={claim.section ?? ''}>
      {heading && <span className="wr-brief-h">{heading}</span>}
      <span>{claim.text}</span>
      {claim.cites.map((cite, i) => (
        <button key={cite} type="button" className={`wr-cite${open === cite ? ' wr-on' : ''}`} data-cite={cite}
          title={citeSource(ledger, cite)} aria-expanded={open === cite} aria-label={`Source ${i + 1}: ${cite}`}
          onClick={() => onCite(cite)}>{i + 1}</button>
      ))}
      {open && claim.cites.includes(open) && (
        <div className="wr-brief-src" data-testid="coach-brief-source">{citeSource(ledger, open)}</div>
      )}
    </li>
  );
}

export default function CoachBrief({ leagueId, timeoutMs = BRIEF_TIMEOUT_MS }: { leagueId?: number | null; timeoutMs?: number }) {
  const [kind, setKind] = useState<Kind>('morning');
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<{ claim: number; cite: string } | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!leagueId) return;
    let live = true;
    setState({ phase: 'loading' });
    setOpen(null);
    const cancel = afterPaint(() => {
      withTimeout(api<Brief>(`/coach/brief/${leagueId}${kind === 'weekly' ? '?kind=weekly' : ''}`), timeoutMs)
        .then(brief => { if (live) setState({ phase: 'done', brief }); })
        .catch(e => { if (live) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) }); });
    });
    return () => { live = false; cancel(); };
  }, [leagueId, kind, attempt, timeoutMs]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  if (!leagueId) return null;
  if (state.phase === 'done' && state.brief.status === 'off') return null;

  const title = kind === 'weekly' ? 'Weekly check-in' : 'Morning brief';
  const brief = state.phase === 'done' ? state.brief : null;
  const claims = brief?.status === 'ok' ? brief.claims ?? [] : [];
  const headings = brief?.status === 'ok' ? headingsOf(brief) : [];
  const held = brief?.status === 'ok' ? brief.dropped?.length ?? 0 : 0;

  return (
    <section className="wr-brief" data-testid="coach-brief" aria-label={title}>
      <div className="wr-brief-top">
        <span className="wr-cap">{title}</span>
        <span className="wr-brief-kinds" role="group" aria-label="Brief kind">
          {KINDS.map(k => (
            <button key={k.kind} type="button" className={`wr-xp${kind === k.kind ? ' wr-on' : ''}`} aria-pressed={kind === k.kind}
              onClick={() => { setKind(k.kind); setHidden(false); }}>{k.label}</button>
          ))}
        </span>
        <button type="button" className="wr-link" onClick={() => setHidden(h => !h)} aria-expanded={!hidden}>{hidden ? 'Show' : 'Hide'}</button>
      </div>
      {!hidden && (
        <>
          {state.phase === 'loading' && <p className="wr-ch-s" data-testid="coach-brief-loading">Reading the {title.toLowerCase()}...</p>}
          {state.phase === 'error' && (
            <p className="wr-ch-s wr-brief-err" data-testid="coach-brief-error">
              Brief not read: {state.message}. <button type="button" className="wr-link" onClick={retry}>Retry</button>
            </p>
          )}
          {brief && brief.status !== 'ok' && (
            <p className="wr-ch-s" data-testid="coach-brief-unknown">Brief not read: {brief.reason ?? 'no reason given'}</p>
          )}
          {brief?.status === 'ok' && (
            <>
              {brief.preview && <p className="wr-ch-s">Preview: {brief.preview_reason ?? 'not confirmed yet'}</p>}
              <ul className="wr-brief-list">
                {claims.map((c, i) => (
                  <ClaimLine key={i} claim={c} heading={headings[i] !== headings[i - 1] ? headings[i] : null} ledger={brief.ledger}
                    open={open?.claim === i ? open.cite : null}
                    onCite={cite => setOpen(o => (o?.claim === i && o.cite === cite ? null : { claim: i, cite }))} />
                ))}
              </ul>
              {!claims.length && <p className="wr-ch-s">Nothing in this brief passed the grounding check.</p>}
              {held > 0 && <p className="wr-ch-s">{held} line{held > 1 ? 's' : ''} held back: failed the grounding check.</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
