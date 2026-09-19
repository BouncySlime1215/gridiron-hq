import { useState } from 'react';

/**
 * A block of text the user is going to send to a real person, with the one
 * click that gets it onto the clipboard.
 *
 * The opener and the ask are the actual deliverable of the Trade Brain — they
 * are not analysis to read, they are a message to paste into a league chat — so
 * they are rendered as selectable text with a copy button rather than as prose
 * inside a paragraph. The clipboard API is unavailable over plain HTTP on a
 * phone through the tunnel, so a failure says so and the text stays selectable
 * instead of the button silently doing nothing.
 */
export default function CopyLine({ label, text, hint, tone = 'plain' }: {
  label: string; text: string; hint?: string; tone?: 'plain' | 'accent';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
    }
  };

  return (
    <div className={`rounded-xl border p-3 ${tone === 'accent'
      ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-[.12em] text-slate-500">{label}</span>
        <button type="button" className="btn-ghost ml-auto text-xs" onClick={copy}
          aria-label={`Copy ${label.toLowerCase()} to the clipboard`}>
          {state === 'copied' ? '✓ Copied' : '⧉ Copy'}
        </button>
      </div>
      <p className="mt-1.5 select-all whitespace-pre-wrap text-sm leading-6 text-slate-800">{text}</p>
      {hint && <p className="mt-1 text-[11px] leading-5 text-slate-500">{hint}</p>}
      {state === 'failed' && (
        <p role="status" className="mt-1 text-[11px] leading-5 text-rose-700">
          This browser would not give us the clipboard — the text above is selected in one click,
          so copy it by hand.
        </p>
      )}
    </div>
  );
}
