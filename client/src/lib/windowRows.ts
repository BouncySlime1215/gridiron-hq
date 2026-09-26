import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A tiny in-repo list window (no library): draw only the rows near the screen, with spacer rows above
 * and below at the height of the rows left out, so the page keeps its full height and scroll position.
 * Rows have one height per kind (a player row, a tier break), measured from the first drawn row of
 * each kind; the page itself scrolls (no inner scroll box).
 */
export interface WindowRange { start: number; end: number; padTop: number; padBottom: number }

/** Pure: the rows [start, end) that meet the view [viewTop, viewBottom] (px from the list top), plus `overscan` rows each side. */
export function windowRange(heights: number[], viewTop: number, viewBottom: number, overscan = 8): WindowRange {
  const n = heights.length;
  let y = 0, first = n, last = 0;
  const tops: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    const bottom = y + heights[i];
    if (bottom > viewTop && first === n) first = i;
    if (y < viewBottom) last = i + 1;
    y = bottom;
  }
  if (first === n) first = Math.max(0, n - 1);
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, Math.max(last, start) + overscan);
  const padTop = start < n ? tops[start] : y;
  const padBottom = end < n ? y - tops[end] : 0;
  return { start, end, padTop, padBottom };
}

/** Lists shorter than this draw every row (nothing to gain, and find-in-page keeps working). */
export const WINDOW_FROM = 40;
const SAMPLES = 12;

/**
 * The window for a list drawn in `ref` (a <tbody> or any block): recomputed on page scroll and resize,
 * once per frame. `kinds` names each row's kind; `guess` is the height to assume until one is measured.
 */
export function useWindowedRows(ref: RefObject<HTMLElement>, kinds: string[], guess: Record<string, number>, overscan = 8): WindowRange & { measure: (kind: string, el: HTMLElement | null) => void } {
  const [heights, setHeights] = useState(guess);
  const [view, setView] = useState<[number, number]>([0, typeof window === 'undefined' ? 1000 : window.innerHeight * 2]);
  const frame = useRef(0);
  useLayoutEffect(() => {
    const read = () => {
      frame.current = 0;
      const el = ref.current; if (!el) return;
      const top = el.getBoundingClientRect().top;
      setView(v => { const nv: [number, number] = [-top, window.innerHeight - top]; return v[0] === nv[0] && v[1] === nv[1] ? v : nv; });
    };
    const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(read); };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (frame.current) cancelAnimationFrame(frame.current); };
  }, [ref, kinds.length]);
  const on = kinds.length >= WINDOW_FROM;
  const range = on ? windowRange(kinds.map(k => heights[k] ?? 40), view[0], view[1], overscan) : { start: 0, end: kinds.length, padTop: 0, padBottom: 0 };
  // The mean of the first SAMPLES drawn rows of each kind (rows differ by a fraction of a pixel, and a
  // mean keeps the page's total height within a few px of the fully drawn list).
  const samples = useRef<Record<string, { sum: number; n: number }>>({});
  const measure = (kind: string, el: HTMLElement | null) => {
    if (!el) return;
    const s = (samples.current[kind] ??= { sum: 0, n: 0 });
    if (s.n >= SAMPLES) return;
    const h = el.getBoundingClientRect().height;
    if (!(h > 0)) return;
    s.sum += h; s.n += 1;
    const mean = s.sum / s.n;
    if (Math.abs(mean - (heights[kind] ?? 0)) > 0.05) setHeights(x => ({ ...x, [kind]: mean }));
  };
  useEffect(() => { samples.current = {}; }, [kinds.length]);
  return { ...range, measure };
}
