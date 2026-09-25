import { useEffect, useRef } from 'react';

/**
 * WAR-ROOM-UI v2: a hero number that counts up from zero when its card appears. Display
 * only: every frame is the same formatter over an eased fraction of the served value, the
 * final frame is exactly fmt(to), and the first render (and reduced motion) is already the
 * final text. Frames write the text node directly, so React does not re-render per frame.
 */
export const COUNT_MS = 450;

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function CountUp({ to, fmt }: { to: number; fmt: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const final = fmt(to);
  useEffect(() => {
    const el = ref.current;
    const raf = typeof window !== 'undefined' ? window.requestAnimationFrame : undefined;
    if (!el || !raf || reduced() || !Number.isFinite(to) || to === 0) return;
    let id = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = t >= 1 ? final : fmt(to * eased);
      if (t < 1) id = raf(frame);
    };
    el.textContent = fmt(0);
    id = raf(frame);
    return () => { window.cancelAnimationFrame?.(id); if (el) el.textContent = final; };
    // fmt is a fresh arrow each render; the animation restarts only when the number does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);
  return <span ref={ref} data-state="ok">{final}</span>;
}
