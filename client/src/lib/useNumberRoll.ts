/**
 * A NUMBER THAT MOVED SHOULD LOOK LIKE IT MOVED.
 *
 * The app cannot currently answer a question a manager asks constantly: *did
 * that number just change, or was it always this?* A cut is indistinguishable
 * from a re-render, so `.just-updated` flashes the row behind a number and the
 * digits themselves jump. The flash says "something here is new"; it does not
 * say which way it went or by how much.
 *
 * This counts. Over `--motion-reveal` the displayed value walks from the old one
 * to the new one, so the direction and the size of the move are visible without
 * anybody printing a delta.
 *
 * IT IS BOUNDED HARD, because an animated number is exactly the kind of thing
 * that becomes decoration:
 *
 *   - never on first paint. The page a manager opens is at rest. The first value
 *     is simply the value.
 *   - never under `prefers-reduced-motion`. The value sets. This is a settings
 *     read, not a nicety: the app already respects the preference globally and
 *     per-animation, and a number that keeps moving after everything else
 *     stopped is the worst offender.
 *   - never for a change smaller than the number's own display precision. A
 *     title chance that goes 14.2% -> 14.2% did not move on screen, and rolling
 *     it says something happened when nothing did.
 *   - never longer than the token. One duration, from the design system.
 *
 * It returns a NUMBER, not a string, so the caller still formats through the
 * glossary and a rolling value cannot render to a different precision than a
 * settled one.
 */
import { useEffect, useRef, useState } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

/** The duration in `--motion-reveal`, read once, with the token's value as the fallback. */
function revealMs(): number {
  if (typeof window === 'undefined') return 260;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-reveal').trim();
  const n = Number.parseFloat(raw);
  // A token that is missing or in an unexpected unit must not produce NaN and a
  // number that never settles. Fall back to the documented value.
  if (!Number.isFinite(n) || n <= 0) return 260;
  return raw.endsWith('ms') ? n : n * 1000;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function useNumberRoll(
  target: number | null | undefined,
  /** Decimal places this number renders at — the roll's own threshold. */
  precision = 1
): number | null | undefined {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const stop = () => { if (frame.current != null) cancelAnimationFrame(frame.current); frame.current = null; };
    const settle = () => { stop(); from.current = target; setShown(target); };

    const prev = from.current;
    // A value that arrived from nothing, or went to nothing, is not a move — it
    // is the number appearing or leaving, and there is nothing to count between.
    if (prev == null || target == null || !Number.isFinite(prev) || !Number.isFinite(target)) return settle();
    // Below the display precision, the screen would not change anyway.
    const step = Math.pow(10, -precision);
    if (Math.abs(target - prev) < step) return settle();
    if (typeof window === 'undefined' || window.matchMedia?.(REDUCED).matches) return settle();

    const ms = revealMs();
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setShown(prev + (target - prev) * easeOut(t));
      if (t < 1) { frame.current = requestAnimationFrame(tick); }
      else { from.current = target; frame.current = null; }
    };
    frame.current = requestAnimationFrame(tick);
    return stop;
  }, [target, precision]);

  return shown;
}
