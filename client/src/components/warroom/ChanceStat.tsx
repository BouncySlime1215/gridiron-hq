import type { ReactNode } from 'react';

/**
 * ChanceStat (docs/ui/CONSOLIDATION-MAP.md section 6): "chance he says yes", drawn the same way
 * everywhere it appears: the planner's hero card (Today, Trades → Next move), Go get's plan steps, the
 * finder's trade card (ManagerRead) and Trades → People. The served value (a point, or a low–high
 * band), a "guess" pill when it rests on an unvalidated model, and what it rests on (basis, n). It
 * never computes a chance; it only draws the one it is given.
 *   size 'big'  the hero's metric (label above, big number)
 *   size 'line' one line inside a card or a list row
 */
const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function ChanceStat({ value, low, high, guess = false, basis, n, why, size = 'line', label = 'Chance he says yes', big, testid }: {
  value?: number | null; low?: number | null; high?: number | null; guess?: boolean;
  basis?: string | null; n?: number | null; why?: string | null;
  size?: 'big' | 'line'; label?: string;
  /** size 'big': a pre-drawn number (the hero's count-up / unknown state) instead of `value`. */
  big?: ReactNode; testid?: string;
}) {
  const band = low != null && high != null && Math.abs(high - low) >= 0.005;
  const num = big ?? (value == null ? '—' : band ? `${pct(low!)}–${pct(high!)}` : pct(value));
  const rests = [basis, n != null ? `n=${n}` : null].filter(Boolean).join(' · ');
  const guessPill = guess ? <span className="wr-pill2 wr-pill2-amber chance-guess" title="Built on an unvalidated model: treat as a guess">guess</span> : null;
  if (size === 'big') {
    return (
      <div className="wr-metric chance-stat" data-testid={testid} data-chance={value ?? undefined}>
        <div className="wr-metric-l">{label}</div>
        <div className="wr-metric-v">{num}</div>
        {rests && <div className="wr-metric-s" title={why ?? undefined}>{rests}</div>}
        {guessPill && <div className="wr-metric-p">{guessPill}</div>}
      </div>
    );
  }
  return (
    <span className="chance-stat chance-line tabular-nums" data-testid={testid} title={why ?? undefined} data-chance={value ?? undefined}>
      <span className="chance-l">{label}</span> <b>{num}</b>
      {band && value != null && <span className="chance-rest"> · midpoint {pct(value)}</span>}
      {rests && <span className="chance-rest"> · {rests}</span>}
      {guessPill && <> {guessPill}</>}
    </span>
  );
}
