/**
 * Pure keyboard helpers for the design-system primitives (item 58, ACCESSIBILITY PASS).
 * No React and no DOM here, so test/a11y-check.test.js runs them directly.
 */

/** The WAI-ARIA tabs pattern: arrows move (and wrap), Home/End jump; null for any other key. */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (index + 1) % count;
    case 'ArrowLeft': case 'ArrowUp': return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/**
 * Tab inside an open dialog: at the last element Tab wraps to the first, at the first Shift+Tab
 * wraps to the last, and focus that is outside comes back to the first. null means "let the
 * browser move focus".
 */
export function trapTab<T>(focusable: T[], active: T, shift: boolean): T | null {
  if (!focusable.length) return null;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!focusable.includes(active)) return shift ? last : first;
  if (!shift && active === last) return first;
  if (shift && active === first) return last;
  return null;
}
