/**
 * THE GRID, WHEN THE QUESTION IS "COMPARE THESE".
 *
 * The fifth component in docs/design/design-system.md section 4. It exists
 * because the alternative is every page growing its own, which is what already
 * happened: the old components/StatTable.tsx was a rankings-only StatRow and
 * StatHeader pair with a hard-coded abbreviation map (TGT, RECY, RECTD),
 * `any`-typed rows and pre-system colours, imported by exactly one page. It is
 * replaced rather than kept. A table whose column names live inside itself is
 * the label-written-inline bug in grid form.
 *
 * FOUR RULES, each of which the old one broke:
 *
 *   1. COLUMNS ARE DECLARED BY GLOSSARY ID. A column is `{ id }`; the header
 *      text, unit, decimal places and plain sentence all follow from the entry.
 *      There is no `label` prop, for the same reason StatBlock has none.
 *   2. THE BASIS SITS IN THE HEADER, ONCE PER COLUMN. A chip in every cell of a
 *      twenty-row table is noise nobody reads, and no chip at all puts the
 *      table back where this redesign started. A column is usually one source,
 *      so the column is the honest place. A cell whose basis DIFFERS from its
 *      column's carries its own mark; a cell that matches carries nothing, so
 *      every mark on screen means something.
 *   3. TONE COMES FROM `better`, NEVER FROM THE BASIS. Only a quantity whose
 *      lexicon entry says `higher` or `lower` may colour its numbers. `neither`
 *      is never coloured — aDOT is the example: far downfield is not good or
 *      bad on its own. A basis never tints a number; that is the chip's job.
 *   4. A QUANTITY WE DO NOT STORE IS A STRUCK HEADER AND A REASON, NOT AN EMPTY
 *      COLUMN. A column of em dashes reads as "we have no data on this player".
 *      The truth is "we have this on nobody". Different sentences.
 *
 * ON THE LEXICON: Coach owns the normalised stat names
 * (server/services/coach/stat-names.js) and will publish docs/stat-lexicon.json.
 * Until that file is in this tree, `better` is supplied per column by the
 * caller and every column still takes its NAME from the glossary — no display
 * name is invented here. Columns whose quantity has no glossary entry yet are
 * listed in docs/tdd/stat-table.tdd.md so Coach can add the concept.
 */
import type { ReactNode } from 'react';
import BasisChip, { basisTier, type Basis } from './BasisChip';
import { formatValue, term, type TermId } from '../../lib/glossary';

/** Which direction is better, from the lexicon. `neither` means never coloured. */
export type Better = 'higher' | 'lower' | 'neither';

export interface StatColumn {
  /** The quantity. Everything visible about this column follows from it. */
  id: TermId;
  /** Where this column's numbers come from. Rendered once, in the header. */
  basis: Basis;
  /** The server's own reason for that basis, when it sent one. Never reworded. */
  basisNote?: string | null;
  /** From the lexicon. Omitted means `neither`, which is the safe default. */
  better?: Better;
  /** Show a sign on every value, for a column of changes. */
  signed?: boolean;
}

/**
 * A quantity that is not stored anywhere. Rendered as a struck header carrying
 * the reason, with no cells at all.
 *
 * The four in this state are named in the design system and must never appear
 * as numbers: yards per route run and route participation need a paid charting
 * feed, nothing stores touchdown rate, and red-zone share is being built.
 */
export interface NotTrackedColumn {
  notTracked: true;
  /** The name to show struck through. From the lexicon when it has an entry. */
  name: string;
  /** Why it is not there, in plain words. Shown under the header. */
  reason: string;
}

export interface StatRow {
  /** Stable key. */
  key: string;
  /** The first cell: whatever names this row. Sticks when the table scrolls. */
  head: ReactNode;
  /** Values by column id. A missing entry renders as an em dash, never as 0. */
  values: Partial<Record<TermId, number | null | undefined>>;
  /** Only where a cell's basis differs from its column's. */
  cellBasis?: Partial<Record<TermId, Basis>>;
  /** Opens the deep dive for this row and quantity. Omit and cells are inert. */
  onOpen?: (id: TermId) => void;
}

type Column = StatColumn | NotTrackedColumn;
const isTracked = (c: Column): c is StatColumn => !('notTracked' in c);

/** Colour a number only when its quantity has a direction and a sign. */
function toneFor(col: StatColumn, value: number | null | undefined) {
  const better = col.better ?? 'neither';
  if (better === 'neither' || value == null || !Number.isFinite(value) || value === 0) return 'neutral';
  const good = better === 'higher' ? value > 0 : value < 0;
  // Only a signed column has a meaningful zero point. An unsigned column of raw
  // values has no "above average" to colour against, and guessing one here
  // would be this component inventing a verdict.
  if (!col.signed) return 'neutral';
  return good ? 'good' : 'crit';
}

export default function StatTable({ columns, rows, caption }: {
  columns: Column[];
  rows: StatRow[];
  /** Read by screen readers and shown above the table. Says what is compared. */
  caption: string;
}) {
  return (
    <div className="stat-table-scroll">
      <table className="stat-table">
        <caption className="stat-table-caption">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="stat-table-head-cell stat-table-sticky" />
            {columns.map((col, i) => {
              if (!isTracked(col)) {
                return (
                  <th key={`nt-${i}`} scope="col" className="stat-table-head-cell" title={col.reason}>
                    <span className="stat-table-not-tracked">{col.name}</span>
                    <span className="stat-table-reason">Not tracked</span>
                  </th>
                );
              }
              const t = term(col.id);
              return (
                <th key={col.id} scope="col" className="stat-table-head-cell"
                  title={`${t.plain}${col.basisNote ? ` ${col.basisNote}` : ''}`}>
                  <span className="stat-table-name">{t.name}</span>
                  <BasisChip basis={col.basis} note={col.basisNote} className="stat-table-basis" />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <th scope="row" className="stat-table-row-head stat-table-sticky">{row.head}</th>
              {columns.map((col, i) => {
                // A not-tracked column has no cells. An empty cell here would be
                // the column of em dashes rule 4 exists to prevent.
                if (!isTracked(col)) return <td key={`nt-${i}`} className="stat-table-cell" aria-hidden="true" />;
                const value = row.values[col.id];
                const text = formatValue(col.id, value, { signed: col.signed });
                const differs = row.cellBasis?.[col.id];
                const tone = toneFor(col, value);
                const open = row.onOpen;
                const body = (
                  <>
                    <span className={`tabular tone-${tone}`}>{text}</span>
                    {differs && differs !== col.basis && (
                      // Only when it differs. A mark that appears on every cell
                      // is a mark nobody reads.
                      <span className="stat-table-cell-basis"
                        style={{ ['--chip' as string]: basisTier(differs)?.token }}
                        title={basisTier(differs)?.plain}
                        aria-label={basisTier(differs)?.label} />
                    )}
                  </>
                );
                return (
                  <td key={col.id} className="stat-table-cell">
                    {open ? (
                      <button type="button" className="stat-table-cell-button"
                        onClick={() => open(col.id)}
                        aria-label={`${term(col.id).name}, ${text}. Show where this came from.`}>
                        {body}
                      </button>
                    ) : body}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
