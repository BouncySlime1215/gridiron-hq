/**
 * BROKEN-F: which of the three player values a number is. Mirrors
 * server/services/player-values.js PLAYER_VALUE_FIELDS (test/broken-f-player-values.test.js
 * holds the two in step). The server only sends `value_kind` / `value_label` under
 * the preview switch; without them every page keeps its existing wording.
 */
export type PlayerValueKind = 'market_value' | 'preseason_vor' | 'clone_price';

export const PLAYER_VALUE_LABELS: Record<PlayerValueKind, { label: string; short: string }> = {
  market_value: { label: 'Market value (FantasyCalc)', short: 'Market' },
  preseason_vor: { label: 'Preseason VOR', short: 'Pre-VOR' },
  clone_price: { label: 'Clone price', short: 'Clone' },
};

type Labelled = { value_kind?: string | null; value_label?: string | null } | null | undefined;

/** The label for a response's or player's `value`: the server's own words when sent, else `fallback`. */
export function valueLabel(src: Labelled, fallback: string): string {
  if (src?.value_label) return src.value_label;
  const kind = src?.value_kind as PlayerValueKind | undefined;
  return (kind && PLAYER_VALUE_LABELS[kind]?.label) || fallback;
}

/** The short tag printed next to a bare number, or null when the server named nothing. */
export function valueShort(src: Labelled): string | null {
  const kind = src?.value_kind as PlayerValueKind | undefined;
  return (kind && PLAYER_VALUE_LABELS[kind]?.short) || null;
}
