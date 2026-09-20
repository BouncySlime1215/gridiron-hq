/**
 * "CLICK INTO SOMETHING AND SEE HOW THAT DATA WAS FOUND."
 *
 * Five layers, one number, over the page rather than on a route. Each layer
 * answers the next question a manager would actually ask:
 *
 *   1. What is this?          the glossary sentence, in plain words
 *   2. What went into it?     the inputs, each with its own basis
 *   3. How was it worked out? the method, in a sentence, not a formula
 *   4. How well does it do?   what it was tested on, and what it failed
 *   5. Where does it live?    the raw field, the table, the file
 *
 * Layer 4 is the one that makes this worth building and the one that will be
 * tempting to drop. A drill-down that only explains is marketing. This app has
 * numbers that were tested and failed — matchups.js records a pre-registered
 * out-of-sample test where every defence-vs-position multiplier came out worse
 * than no adjustment, which is why every one of them is hard-coded to 1 — and a
 * page that shows the history without that sentence is worse than a page that
 * shows nothing.
 *
 * WHY A DRAWER AND NOT A ROUTE: Nick's own line is "a deep dive into the stats
 * but not new pages". A route loses the context the number was read in, and
 * coming back puts the manager at the top of a page instead of at the number
 * they were looking at. This closes back to exactly where it was, with the
 * originating block focused again.
 *
 * It is built on `Sheet` from DesignSystem.tsx rather than beside it. Sheet
 * already had Escape, a backdrop click and aria-modal and no consumer; the gaps
 * it had — no focus restore, no scroll lock, no deep link — are fixed there, so
 * this is one overlay in the app and not two.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './DesignSystem';
import BasisChip, { type Basis } from './BasisChip';
import { formatValue, term, type TermId } from '../../lib/glossary';

export interface DeepDiveInput {
  /** A glossary id when the input is itself a known quantity; a plain name otherwise. */
  id?: TermId;
  name?: string;
  value?: number | null;
  basis: Basis;
  note?: string | null;
}

export interface DeepDiveLayers {
  /** Layer 2. Each input carries its own basis — a measured number built from
   *  three assumed ones is not a measured number, and only this layer can say so. */
  inputs?: DeepDiveInput[];
  /** Layer 3. One or two sentences. No formula, no Greek. */
  method?: ReactNode;
  /** Layer 4. What it was tested on and how it did — INCLUDING when it failed.
   *  `null` means "never tested", which renders as that sentence and not as a gap. */
  tested?: ReactNode | null;
  /** Layer 5. The raw field is taken from the glossary; this adds the table or file. */
  source?: ReactNode;
}

const LAYER_TITLES = [
  'What this is',
  'What went into it',
  'How it was worked out',
  'How well it does',
  'Where it comes from'
] as const;

export default function DeepDive({ id, value, basis, basisNote = null, layers, open, onClose, returnFocusTo }: {
  id: TermId;
  value: number | null | undefined;
  basis: Basis;
  basisNote?: string | null;
  layers: DeepDiveLayers;
  open: boolean;
  onClose: () => void;
  /** The block that opened this. Focus goes back to it on close — a manager who
   *  closes a drawer should be where they were, not at the top of the document. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const t = term(id);
  const [shown, setShown] = useState(1);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open) { opener.current = document.activeElement; setShown(1); return; }
    // Closing. Prefer the ref the caller gave; fall back to whatever had focus
    // when this opened. Either way, never leave focus on a removed node, which
    // sends a keyboard or screen-reader user back to the top of the document.
    const back = returnFocusTo?.current ?? opener.current;
    if (back instanceof HTMLElement && document.contains(back)) back.focus();
  }, [open, returnFocusTo]);

  // Layer 4 is not optional the way the others are: `undefined` means the caller
  // forgot, `null` means the caller is saying it was never tested. Those are
  // different, and only the second one is allowed to be quiet.
  const tested = layers.tested === undefined
    ? null
    : layers.tested ?? 'This number has never been tested against a season it was not built on. Read it as the model’s opinion, not as a measurement.';

  const bodies: (ReactNode | null)[] = [
    <p key="1">{t.plain}</p>,
    layers.inputs?.length
      ? <ul key="2" className="deep-dive-inputs">
        {layers.inputs.map((input, i) => (
          <li key={i}>
            <span className="deep-dive-input-name">{input.id ? term(input.id).name : input.name}</span>
            <span className="tabular">{input.id ? formatValue(input.id, input.value) : input.value ?? ''}</span>
            <BasisChip basis={input.basis} note={input.note} />
          </li>
        ))}
      </ul>
      : null,
    layers.method ? <div key="3">{layers.method}</div> : null,
    <div key="4">{tested}</div>,
    <div key="5">
      {layers.source}
      <p className="deep-dive-raw">{t.raw}</p>
    </div>
  ];

  return (
    <Sheet open={open} title={t.name} onClose={onClose}>
      <div className="deep-dive-head">
        <span className="deep-dive-value tabular">{formatValue(id, value)}</span>
        <BasisChip basis={basis} note={basisNote} />
      </div>
      {LAYER_TITLES.map((title, i) => {
        if (bodies[i] == null) return null;
        // One layer at a time, in order. A wall of five open sections is a
        // document; the point of the drawer is that the manager chooses how far
        // down to go.
        if (i > shown - 1 && i !== shown) return null;
        const isNext = i === shown;
        return isNext ? (
          <button key={title} type="button" className="deep-dive-more" onClick={() => setShown(s => s + 1)}>
            {title}
          </button>
        ) : (
          <section key={title} className="deep-dive-layer">
            <h3>{title}</h3>
            {bodies[i]}
          </section>
        );
      })}
    </Sheet>
  );
}
