import { useCallback, useRef } from 'react';

/**
 * WAR-ROOM-UI v2: the hero card's cursor-follow spotlight. Pointer moves are coalesced to
 * one write per animation frame, and the write is two CSS variables that only move a
 * transformed layer (warroom-v2.css .wr-spot-blob), so it never triggers layout. The CSS
 * shows it only on a fine pointer with motion allowed; touch and reduced motion get none.
 */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const frame = useRef(0);
  const last = useRef<{ x: number; y: number } | null>(null);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    last.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0;
      const p = last.current;
      if (!p || !ref.current) return;
      ref.current.style.setProperty('--mx', `${Math.round(p.x)}px`);
      ref.current.style.setProperty('--my', `${Math.round(p.y)}px`);
    });
  }, []);
  return { ref, handlers: { onPointerMove } };
}
