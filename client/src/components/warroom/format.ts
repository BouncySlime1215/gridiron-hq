/**
 * Formatting only. Producer values arrive as fractions (0.38 = 38%, a title-odds change
 * of 0.018 = 1.8 points); these turn them into text and do nothing else.
 */
import type { Field } from './types';

export const NOT_COMPUTED = 'not computed yet';

/** 0.38 -> "38%". */
export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** A title-odds change 0.018 -> "+1.8 pts". */
export function pts(v: number): string {
  const s = (v * 100).toFixed(1);
  return `${v > 0 ? '+' : v < 0 ? '' : '±'}${s} pts`;
}

/** Standard error as "± 0.5". */
export function se(v: number): string {
  return `± ${(v * 100).toFixed(1)}`;
}

/** Plain number (prices). */
export function whole(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** The one-line text of any field: its formatted value, or why there is none. */
export function fieldText<T>(f: Field<T> | undefined | null, fmt: (v: T) => string): string {
  if (!f) return NOT_COMPUTED;
  if (f.status === 'ok' && f.value !== undefined) return fmt(f.value);
  if (f.status === 'failed') return 'hidden: failed its check';
  return NOT_COMPUTED;
}

export const isOk = <T,>(f: Field<T> | undefined | null): f is Field<T> & { value: T } =>
  !!f && f.status === 'ok' && f.value !== undefined;

/** A title-odds size with no sign (a cost or a gain) 0.006 -> "0.6 pts". */
export function size(v: number): string {
  return `${Math.abs(v * 100).toFixed(1)} pts`;
}
