/**
 * WHERE A NUMBER CAME FROM, BESIDE THE NUMBER.
 *
 * Four separate answers to this question already ship, in four shapes, written
 * four times:
 *
 *   Lineup.tsx:180     a paragraph under the page when the basis is 'role',
 *                      and a different box when it is not
 *   OddsBasis.tsx      a block of sentences under the championship number
 *   News.tsx           a parenthetical on each card
 *   Settings           a freshness card
 *
 * They disagree about wording, about placement, and about whether the good case
 * is even mentioned. The one that matters is Lineup's: it says the fitted case
 * "quieter, since nothing is wrong, but present", and it is right — a reader who
 * only ever sees a basis line when something is degraded cannot tell a healthy
 * page from a page that forgot to check. So this chip renders in EVERY case,
 * including the best one.
 *
 * It renders a basis and decides nothing. The server decides what the basis is;
 * a component that inferred it from the number would be a second opinion, and
 * this repo already retired one of those (league-brain.js:185).
 *
 * PLACEMENT IS PART OF THE CONTRACT: beside the number, never in a footnote and
 * never only in a tooltip. The number is the thing that is wrong without it. A
 * hover sentence is an addition to the chip, not a replacement for it.
 */
import type { ReactNode } from 'react';

/**
 * The six tiers. Five are the server's own vocabulary; `missing` is the sixth
 * case, which is not a tier the server emits but the state where the field did
 * not arrive at all.
 *
 * `measured` and `fitted` are deliberately separate even though both are "real".
 * A rate counted from games this season and a number produced by a model fitted
 * on past seasons are different claims, and collapsing them is how a page ends
 * up saying "measured" about an estimate.
 */
export type Basis =
  | 'measured'   // counted from games actually played
  | 'fitted'     // a model fitted on history, with a fit id behind it
  | 'pooled'     // the fitted model's coarse layer — real, but not the validated one
  | 'assumed'    // a hand-set constant nobody fitted
  | 'none'       // nothing priced this at all
  | 'missing';   // the data is not loaded

/** The server's availability vocabulary, mapped onto the chip's. */
export const AVAILABILITY_BASIS: Record<string, Basis> = {
  role: 'fitted',
  pooled: 'pooled',
  constants: 'assumed',
  unfitted_position: 'none'
};

interface Tier { label: string; plain: string; token: string }

/**
 * One sentence per tier, in the words of someone who does not do statistics.
 * These are the hover text and they are the whole point: a coloured pill that
 * says "pooled" and explains nothing is decoration.
 */
const TIERS: Record<Basis, Tier> = {
  measured: {
    label: 'Measured',
    plain: 'Counted from games that have actually been played this season. This is not an estimate.',
    token: 'var(--basis-measured)'
  },
  fitted: {
    label: 'Fitted',
    plain: 'Worked out by a model that was trained on past seasons and then checked against a season it had never seen.',
    token: 'var(--basis-fitted)'
  },
  pooled: {
    label: 'Rough',
    plain: 'A coarser version of the model, used because the detailed one is not running. It is real, but it is known to be less accurate — treat it as a placeholder rather than a reason to change your lineup.',
    token: 'var(--basis-pooled)'
  },
  assumed: {
    label: 'Assumed',
    plain: 'A number we set by hand because nothing has been fitted for this yet. You can argue with it.',
    token: 'var(--basis-assumed)'
  },
  none: {
    label: 'Not modelled',
    plain: 'Nothing in the model prices this. The page is not hiding a number here — there is not one.',
    token: 'var(--basis-none)'
  },
  missing: {
    label: 'No data',
    plain: 'The data this needs is not loaded, so nothing can be shown. This is a gap on our side, not a fact about your team.',
    token: 'var(--basis-missing)'
  }
};

/** The tier record, for a page that wants the sentence without the pill. */
export function basisTier(basis: Basis) { return TIERS[basis]; }

export default function BasisChip({ basis, note, n, className = '' }: {
  basis: Basis;
  /** The server's own reason, when it sent one. Appended to the hover sentence, never reworded. */
  note?: string | null;
  /** How many observations are behind it, when that is meaningful. */
  n?: number | null;
  className?: string;
}) {
  const tier = TIERS[basis];
  // An unknown basis must not render as an empty pill with a colour. Better to
  // show nothing than to show a confident-looking chip for a tier we do not know.
  if (!tier) return null;
  const title = [tier.plain, note || null, n != null ? `Based on ${n} observation${n === 1 ? '' : 's'}.` : null]
    .filter(Boolean).join(' ');

  return (
    <span
      className={`basis-chip ${className}`.trim()}
      style={{ ['--chip' as string]: tier.token }}
      title={title}
      // The visible pill says one word; the sentence is the point. A `title`
      // alone reaches a mouse and nothing else — not a touch screen, and not
      // reliably a screen reader, which would announce "Fitted" and offer no way
      // to the explanation. So the label carries the whole sentence and the
      // visible text stays short. It is verbose in a table of twenty rows, and
      // that is the right trade: a chip nobody can read the meaning of is the
      // decoration this component exists instead of.
      aria-label={`${tier.label}. ${title}`}
      data-basis={basis}
    >
      <span className="basis-chip-label">{tier.label}</span>
      {n != null && <span className="basis-chip-n tabular">n={n}</span>}
    </span>
  );
}

/**
 * The chip with its sentence spelled out, for the one place per page that should
 * say it in full rather than on hover — a hover sentence does not exist on a
 * phone, and this app is read on a phone.
 */
export function BasisLine({ basis, note, children }: { basis: Basis; note?: string | null; children?: ReactNode }) {
  const tier = TIERS[basis];
  if (!tier) return null;
  return (
    <p className="basis-line" style={{ ['--chip' as string]: tier.token }} role="status">
      <BasisChip basis={basis} />
      <span>{children ?? tier.plain}{note ? ` ${note}` : ''}</span>
    </p>
  );
}
