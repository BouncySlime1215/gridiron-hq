import { createContext, useContext, type ReactNode } from 'react';
import type { Field } from './types';
import { NOT_COMPUTED, se as fmtSe } from './format';

/** Source labels from the view (server SOURCES), shared by every tag on the page. */
export const SourcesContext = createContext<Record<string, { label: string; calibrated: boolean }>>({});

/** A small pill naming where a number came from; amber "guess" when its source is not calibrated. */
export function SourceTag({ id }: { id: string }) {
  const sources = useContext(SourcesContext);
  const label = sources[id]?.label ?? id;
  const guess = !sources[id]?.calibrated;
  return (
    <>
      <span className="wr-tag wr-src" title={`Source: ${label}`}>{label}</span>
      {guess && <span className="wr-tag wr-guess" title="Not calibrated yet: treat as a guess">guess</span>}
    </>
  );
}

/**
 * One value, inline. ok -> the formatted value (+ SE, "inside the noise" when it does not
 * clear 2 SE, guess tag); unknown -> grey "not computed yet"; failed -> red, no digits.
 */
export function Val<T>({ f, fmt, showSe, showReason, tags }: {
  f: Field<T> | undefined | null; fmt: (v: T) => string; showSe?: boolean; showReason?: boolean; tags?: boolean;
}) {
  if (!f || f.status === 'unknown' || (f.status === 'ok' && f.value === undefined)) {
    return (
      <span className="wr-unk" data-state="unknown" title={f?.reason}>
        {NOT_COMPUTED}{showReason && f?.reason ? `: ${f.reason}` : ''}
      </span>
    );
  }
  if (f.status === 'failed') {
    return (
      <span className="wr-fail" data-state="failed" title={f.reason}>
        hidden: failed its check{showReason && f.reason ? `. ${f.reason}` : ''}
      </span>
    );
  }
  const noise = f.clears_2se === false;
  return (
    <span className={noise ? 'wr-noise' : undefined} data-state="ok">
      {fmt(f.value as T)}
      {showSe && typeof f.se === 'number' && <span className="wr-muted"> {fmtSe(f.se)}</span>}
      {noise && <span className="wr-muted"> inside the noise</span>}
      {tags && <> <SourceTag id={f.source} /></>}
    </span>
  );
}

/** A whole section: its children only when ok, else a designed unknown / failed state. */
export function FieldBlock<T>({ f, label, children }: {
  f: Field<T> | undefined | null; label: string; children: (v: T) => ReactNode;
}) {
  if (f && f.status === 'ok' && f.value !== undefined) return <>{children(f.value)}</>;
  if (f && f.status === 'failed') {
    return (
      <div className="wr-state wr-state-failed" role="status" data-state="failed">
        {label} failed its check, so it is hidden. {f.reason}
      </div>
    );
  }
  return (
    <div className="wr-state" role="status" data-state="unknown">
      {f?.reason ?? `${label} ${NOT_COMPUTED}.`}
    </div>
  );
}
