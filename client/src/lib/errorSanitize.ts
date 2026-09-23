/**
 * UX-08b (plan item D23, UI rule 9): follow-up to UX-08's PageError/
 * logServerDetail fix (client/src/components/PageState.tsx, branch
 * claude/local-ux-08-lineup-error-no-leak, PR #167 — not yet merged, so
 * mirrored here rather than imported, and kept out of PageState.tsx since
 * that file is UX-08's, not this unit's, to edit).
 *
 * `alert()` popups and rendered `.error` strings across the app were putting
 * the server's raw error text (which has included file paths and table
 * names — see docs/tdd/2026-09-23-ux-08-lineup-error-no-leak.tdd.md) in
 * front of the user. Every one of those sites now goes through here: the
 * detail is logged for whoever is debugging, the user sees plain words.
 */

export function logServerDetail(where: string, detail: unknown): void {
  if (detail === null || detail === undefined || detail === '') return;
  // eslint-disable-next-line no-console
  console.error(`[${where}]`, detail);
}

/** For `alert(...)` call sites: same generic word choice, detail goes to the console instead. */
export function sanitizedAlert(where: string, prefix: string, detail: unknown): void {
  logServerDetail(where, detail);
  // eslint-disable-next-line no-alert
  alert(`${prefix}. Try again in a moment.`);
}

/** For sites that set a message into component state and render it. */
export function sanitizedMessage(where: string, prefix: string, detail: unknown): string {
  logServerDetail(where, detail);
  return `${prefix}. Try again in a moment.`;
}

/** For sites that render a `.error` field straight from a server payload. */
export const GENERIC_LOAD_ERROR = "Couldn't load this. Try again in a moment.";
