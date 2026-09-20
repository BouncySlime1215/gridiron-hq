/**
 * THE UNIT THAT GETS CLICKED.
 *
 * A number, its canonical name, where it came from, and at most one line of
 * "why". Every number a manager can ask a question about is one of these, and
 * the whole block is the hit target — not the digits, which on a phone are a
 * target about four millimetres wide.
 *
 * Three rules that are easy to break and are the reason this is a component
 * rather than a pattern people copy:
 *
 *   1. NO BORDER AND NO FILL. A stat block is not a card. Border, fill, radius
 *      and shadow each say "separate object", and spending them on every number
 *      flattens a page into a grid of equal things — which is precisely the look
 *      this redesign is getting away from. The existing `StatTile` in
 *      DesignSystem.tsx wraps every number in a `.card`; that is why it is not
 *      what this extends.
 *   2. THE LABEL COMES FROM THE GLOSSARY, never from the caller. A caller that
 *      can pass its own label is a caller that will, and then `floor` means two
 *      things again. The only text a caller controls is the one `note` line.
 *   3. THE BASIS CHIP IS NOT OPTIONAL. A stat block with no basis is a number
 *      with no provenance, which is the state this whole redesign exists to end.
 *      `basis` is a required prop; 'missing' is how you say you do not have one,
 *      and it renders as such rather than as nothing.
 *
 * Precision, unit and the em dash for a missing value all come from
 * `formatValue`, so two pages cannot print the same quantity to different
 * decimal places.
 */
import type { ReactNode } from 'react';
import BasisChip, { type Basis } from './BasisChip';
import { formatValue, term, type TermId } from '../../lib/glossary';

export default function StatBlock({
  id, value, basis, basisNote = null, n = null, note, size = 'stat',
  signed = false, onOpen, tone = 'neutral', children
}: {
  /** Which quantity this is. The label and the formatting follow from it. */
  id: TermId;
  /** The raw value as the server sent it. Fractions for percentages. */
  value: number | null | undefined;
  /** Where it came from. Required — see rule 3. */
  basis: Basis;
  /** The server's own reason, when it sent one. Never reworded here. */
  basisNote?: string | null;
  n?: number | null;
  /** One line of why, in the page's words. The only text a caller controls. */
  note?: ReactNode;
  /** `hero` for the one number a page exists to show. */
  size?: 'hero' | 'stat';
  signed?: boolean;
  /** Opens the deep dive. Omit it and the block is not interactive at all. */
  onOpen?: () => void;
  /** Colours the NUMBER only, and only where up and down genuinely mean better
   *  and worse. Never set from the basis — that is the chip's job, and a basis
   *  is not a verdict. */
  tone?: 'neutral' | 'good' | 'crit';
  children?: ReactNode;
}) {
  const t = term(id);
  const text = formatValue(id, value, { signed });
  const interactive = typeof onOpen === 'function';
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      {...(interactive
        ? { type: 'button' as const, onClick: onOpen,
            // The number alone is not a description of what opens.
            'aria-label': `${t.name}, ${text}. Show where this came from.` }
        : {})}
      className={`stat-block stat-block-${size}${interactive ? ' is-interactive' : ''}`}
    >
      <span className="stat-block-label">{t.name}</span>
      <span className={`stat-block-value tabular tone-${tone}`}>{text}</span>
      <BasisChip basis={basis} note={basisNote} n={n} className="stat-block-basis" />
      {note && <span className="stat-block-note">{note}</span>}
      {children}
    </Tag>
  );
}
