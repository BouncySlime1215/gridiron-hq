import type {
  Acceptance, Counterparty, ManagerPlayerRead, ManagerReadDeal,
  ReceptivenessFactor, Tactic, TacticAbsent,
} from './types';
import { hasManagerData, hasManagerRead } from './types';

/**
 * The other manager, on one deal: how receptive he is and what says so, how
 * likely he is to say yes as a band, what his negotiation profile records, and
 * the approach the engine suggests — next to the approaches it could not judge.
 *
 * The rule the whole panel follows is the one counterparty-pricing.js states:
 * "no data" and "the data reads neutral" are different answers and must never
 * arrive looking alike. So a factor with no sample is printed WITHOUT a number,
 * a tactic that did not fire is printed as "not enough data for X" rather than
 * dropped, and a league with no chat corpus — four of the five — gets one honest
 * line instead of a receptiveness read invented out of the 1.0 default.
 * Nothing to say at all → null, exactly like PlayerEvidence and RiskStrip.
 */

const pct = (v: number | null | undefined, d = 0) =>
  v == null ? '—' : `${(v * 100).toFixed(d)}%`;
const signed = (v: number | null | undefined, d = 3) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
const words = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What this source's `n` actually counts, so "4" is never a bare number. */
function sampleOf(f: ReceptivenessFactor): string {
  // No special case for a hand-set read: the layer now declares `n: null` for one,
  // so the generic no-sample path below says it, and a source that stops carrying
  // a sample cannot go on printing one because this list was not updated.
  const n = f.n;
  if (n == null || n === 0) return 'no sample behind it';
  if (f.source === 'chat_engagement') return `based on ${plural(n, 'chat message')}`;
  if (f.source === 'observed_accept_rate') return `based on ${plural(n, 'decided offer')}`;
  return `based on ${plural(n, 'observation')}`;
}

/** True when this factor was really measured — the gate on printing its number. */
const measured = (f: ReceptivenessFactor) => f.effect != null && (f.n ?? 0) > 0;

const RECEPTIVENESS_READ = (v: number) =>
  v >= 1.15 ? 'open to talking' : v >= 1.04 ? 'leans open'
    : v <= 0.85 ? 'hard to get talking' : v <= 0.96 ? 'leans closed' : 'middle of the league';

const BASIS_NOTE: Record<string, string> = {
  heuristic_anchored: 'anchored on his own accept rate',
  heuristic_unanchored: 'no decided offers with him yet, so it is unanchored',
  no_information: 'a declared starting point, not a measurement',
};

const TIER_NOTE: Record<string, string> = {
  hard: 'hand-set: hard to trade with — this overrides the read below',
  easy: 'hand-set: easy to trade with',
  fair: 'hand-set: an ordinary trade partner',
};

const NO_HOLD_NOTE: Record<string, string> = {
  yes: 'his no is final',
  usually: 'his no usually holds',
  rarely: 'his no rarely holds',
  unknown: 'the corpus does not say whether his no holds',
};

/** The hand-set tier, which is a person's override and not a measurement. */
function TierBadge({ tier }: { tier?: string | null }) {
  if (!tier || tier === 'fair') return null;
  return (
    <span
      title={TIER_NOTE[tier] ?? `hand-set tier: ${tier}`}
      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        tier === 'hard' ? 'border-amber-300 bg-amber-50 text-amber-800'
          : 'border-good bg-good-tint text-good'}`}>
      {tier === 'hard' ? 'hard to trade with' : `${tier} to trade with`}
    </span>
  );
}

/** P(accept) as a band. Never a point, and never without what it rests on. */
function Band({ a }: { a?: Acceptance | null }) {
  if (!a) return null;
  if (!a.band) {
    return (
      <span className="text-[11px] text-[var(--muted)]" title={a.why ?? undefined}>
        P(accept) not stated — {words(a.basis) || 'no basis'}
      </span>
    );
  }
  const note = BASIS_NOTE[a.basis ?? ''] ?? words(a.basis);
  return (
    <span className="text-[11px] tabular-nums text-[var(--muted)]"
      title={`${a.why ?? ''}${a.anchor?.why ? ` · ${a.anchor.why}` : ''}`}>
      P(accept) <b className="font-semibold text-[var(--ink)]">{pct(a.band.low)}–{pct(a.band.high)}</b>
      <span className="text-[var(--subtle)]"> · midpoint {pct(a.band.mid)} · {note}</span>
    </span>
  );
}

/** The receptiveness number taken apart into the sources that built it. */
function Factors({ factors }: { factors: ReceptivenessFactor[] }) {
  if (!factors.length) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {factors.map((f, i) => (
        <li key={`${f.source}-${i}`} className="text-[11px] leading-snug">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            {measured(f)
              ? <span className={`tabular-nums font-semibold ${f.effect! > 0 ? 'text-good' : f.effect! < 0 ? 'text-crit' : 'text-[var(--muted)]'}`}>
                {signed(f.effect)}
              </span>
              : <span className="text-[10px] uppercase tracking-wide text-[var(--subtle)]"
                title="read, but it never reduced to a number — reported rather than scored">
                not scored
              </span>}
            <span className="text-[var(--ink)]">{f.label}</span>
            <span className="text-[var(--subtle)]">· {sampleOf(f)}</span>
            {f.cap != null && (
              <span className="text-[var(--subtle)] tabular-nums" title="this source's hard cap">
                · cap {f.cap}
              </span>
            )}
          </div>
          {f.why && <div className="text-[var(--muted)]">{f.why}</div>}
        </li>
      ))}
    </ul>
  );
}

/** What he has said about the players in THIS deal — absent when he has not. */
function PlayerReads({ reads }: { reads: ManagerPlayerRead[] }) {
  if (!reads.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">On these players</div>
      <ul className="mt-1 space-y-1">
        {reads.map((r, i) => (
          <li key={`${r.player}-${i}`} className="text-[11px] leading-snug">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold text-[var(--ink)]">{r.player}</span>
              {r.owns === true && <span className="text-[10px] text-[var(--subtle)]">his</span>}
              {r.verdict && <span className="text-[var(--accent)]">{words(r.verdict)}</span>}
              {r.confidence && <span className="text-[var(--subtle)]">({r.confidence})</span>}
              {r.mentions != null && (
                <span className="text-[var(--subtle)] tabular-nums">· {plural(r.mentions, 'mention')}</span>
              )}
              {r.declared && (
                <span className={`text-[10px] font-semibold ${r.declared === 'held' ? 'text-crit' : 'text-amber-700'}`}
                  title={r.declared === 'held'
                    ? 'he has called him untouchable and his word has held'
                    : 'he has called him untouchable, but his refusals have not held — an opening price'}>
                  {r.declared === 'held' ? 'untouchable (held)' : 'untouchable (bluffed before)'}
                </span>
              )}
            </div>
            {r.why && <div className="text-[var(--muted)]">{r.why}</div>}
            {r.action && <div className="text-[var(--ink)]/70">→ {r.action}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The whole-corpus negotiation profile, with the corpus it was read from. */
function Negotiation({ cp }: { cp: Counterparty }) {
  const p = cp.negotiation;
  const asks = cp.asking_for_declared ?? [];
  if (!p && !asks.length && !cp.word_stance) return null;
  const calib = [
    p?.no_holds ? NO_HOLD_NOTE[p.no_holds] ?? `his no: ${p.no_holds}` : null,
    p?.praise_means ? `praise reads as ${p.praise_means}` : null,
    p?.inflation && p.inflation !== 'unknown' ? `${p.inflation} inflation` : null,
  ].filter(Boolean);

  return (
    <div className="mt-2 pt-2 border-t border-[var(--edge)]">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Negotiation profile</span>
        <span className="text-[10px] text-[var(--subtle)]">
          {(cp.negotiation_n ?? 0) > 0
            ? `read over ${plural(cp.negotiation_n!, 'message')}`
            : 'no message corpus behind it'}
          {p?.confidence && ` · ${p.confidence} confidence`}
        </span>
      </div>
      {p?.headline && <p className="mt-0.5 text-[11px] text-[var(--ink)]">{p.headline}</p>}
      {p?.how_to_approach && (
        <p className="text-[11px] text-[var(--muted)]"><span className="font-semibold">Approach </span>{p.how_to_approach}</p>
      )}
      {p?.best_bait && (
        <p className="text-[11px] text-[var(--muted)]"><span className="font-semibold">Bait </span>{p.best_bait}</p>
      )}
      {calib.length > 0 && <p className="text-[11px] text-[var(--subtle)]">{calib.join(' · ')}</p>}
      {!!(p?.what_moves_him?.length || p?.what_shuts_him_down?.length) && (
        <p className="text-[11px] text-[var(--muted)]">
          {p?.what_moves_him?.length ? <>moves him: {p.what_moves_him.join('; ')}</> : null}
          {p?.what_moves_him?.length && p?.what_shuts_him_down?.length ? ' · ' : null}
          {p?.what_shuts_him_down?.length ? <>shuts him down: {p.what_shuts_him_down.join('; ')}</> : null}
        </p>
      )}
      {asks.length > 0 && (
        <p className="text-[11px] text-amber-700" title={cp.word_stance_note ?? cp.word_note ?? undefined}>
          You are asking for {asks.join(' and ')}, which he has called untouchable — his word has not held
          often enough to take literally{cp.word_credibility != null
            ? ` (${pct(cp.word_credibility)} of his declarations have held)` : ''}. Expect a first no.
        </p>
      )}
    </div>
  );
}

/** The suggested approach, and — just as loudly — what could not be judged. */
function Tactics({ tactics, absent }: { tactics: Tactic[]; absent: TacticAbsent[] }) {
  if (!tactics.length && !absent.length) return null;
  const shownAbsent = absent.slice(0, 3);
  return (
    <div className="mt-2 pt-2 border-t border-[var(--edge)]">
      {tactics.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">How to play it</div>
          <ul className="mt-1 space-y-1">
            {tactics.slice(0, 3).map(t => (
              <li key={t.key} className="text-[11px] leading-snug">
                <span className="font-semibold text-[var(--ink)]">{t.label}</span>
                {(t.n ?? 0) > 0 && (
                  <span className="text-[var(--subtle)] tabular-nums"> · {plural(t.n!, 'observation')}</span>
                )}
                {t.why && <div className="text-[var(--muted)]">{t.why}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {shownAbsent.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {shownAbsent.map(a => (
            <li key={a.key} className="text-[11px] text-[var(--subtle)]">
              Not enough data for <span className="text-[var(--muted)]">{words(a.key)}</span> — {a.reason}
            </li>
          ))}
          {absent.length > shownAbsent.length && (
            <li className="text-[10px] text-[var(--subtle)]">
              and {absent.length - shownAbsent.length} more approach{absent.length - shownAbsent.length === 1 ? '' : 'es'} with nothing behind them
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function ManagerRead({ deal, compact = false }:
  { deal: ManagerReadDeal; compact?: boolean }) {
  if (!hasManagerRead(deal)) return null;
  const cp = deal.counterparty ?? null;
  const tier = deal.manager_tradeability ?? cp?.tier ?? null;

  // No chat corpus for this league: the engine ships a declared no-information
  // block (receptiveness 1, everything else null) and says so. One honest line,
  // and the hand-set tier if a person set one — never a read built from defaults.
  if (!hasManagerData(cp)) {
    return (
      <div className="mt-2 pt-2 border-t border-[var(--edge)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Manager read</span>
          <TierBadge tier={tier} />
        </div>
        <p className="mt-0.5 text-[11px] text-[var(--muted)]">
          No read on this manager yet — this league has no chat corpus, so the deal is priced on our
          numbers only. This is not "he looks neutral"; it is nothing measured either way.
        </p>
      </div>
    );
  }

  const factors = (cp!.receptiveness_factors ?? []).filter(f => f && f.label);
  const recept = cp!.receptiveness ?? null;

  return (
    <div className="mt-2 pt-2 border-t border-[var(--edge)]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Manager read</span>
        <TierBadge tier={tier} />
        {recept != null && (
          <span className="text-[11px] tabular-nums text-[var(--muted)]"
            title="Receptiveness: how likely this person is to engage with a trade at all, 0.7–1.3, where 1.0 is no information. It is not P(accept).">
            receptiveness <b className={`font-semibold ${recept > 1.03 ? 'text-good' : recept < 0.97 ? 'text-crit' : 'text-[var(--ink)]'}`}>
              {recept.toFixed(2)}
            </b>
            <span className="text-[var(--subtle)]"> · {RECEPTIVENESS_READ(recept)}</span>
          </span>
        )}
        {(cp!.chat_msgs ?? 0) > 0 && (
          <span className="text-[10px] text-[var(--subtle)] tabular-nums">
            from {plural(cp!.chat_msgs!, 'chat message')}
          </span>
        )}
        <span className="ml-auto"><Band a={deal.acceptance} /></span>
      </div>

      {!compact && (
        <>
          {factors.length > 0
            ? <Factors factors={factors} />
            : <p className="mt-1 text-[11px] text-[var(--subtle)]">
              Nothing named moved his receptiveness — it sits at the no-information default.
            </p>}
          <PlayerReads reads={cp!.player_reads ?? []} />
          <Negotiation cp={cp!} />
          <Tactics tactics={deal.tactics ?? []} absent={deal.tactics_absent ?? []} />
        </>
      )}
    </div>
  );
}
