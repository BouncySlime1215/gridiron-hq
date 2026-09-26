/**
 * COACH-V2 drawer: Coach's answer as it happens. POST /api/coach/ask with
 * Accept: text/event-stream sends the thinking events as they occur and ends with a
 * `result` event carrying the same JSON the plain POST returns (routes/coach.js).
 *
 * Pure parts here (the stage each event means, the SSE parser) so they run in a node test;
 * the hook does the fetch.
 */

export type Stage = 'reading' | 'checking_league' | 'asking_jev' | 'comparing' | 'rechecking';

/** What Nick sees, one line that changes in place (COACH-V2 section 3). */
export function stageText(stage: Stage, who?: string | null): string {
  switch (stage) {
    case 'reading': return 'Reading your plan…';
    case 'checking_league': return 'Checking the league…';
    case 'asking_jev': return who ? `Asking Jev about ${who}…` : 'Asking Jev…';
    case 'comparing': return 'Comparing…';
    case 'rechecking': return 'Checking the numbers again…';
  }
}
export const STILL_WORKING = 'Still working, the numbers will show first.';
export const STILL_WORKING_MS = 8000;

/** The stage one server event moves the drawer to, or null when it does not change it. */
export function stageOf(event: { t?: string; final?: boolean } | null | undefined): Stage | null {
  switch (event?.t) {
    case 'understood': return 'reading';
    case 'routed': case 'preloaded': case 'planning': case 'query': case 'computing': return 'checking_league';
    case 'lane2_start': return 'asking_jev';
    case 'checking': case 'drafting': return 'comparing';
    case 'rejected': case 'reshaping': return 'rechecking';
    default: return null;
  }
}

/**
 * Split a text/event-stream buffer into complete `data:` payloads. Returns the parsed
 * events and the unfinished tail to keep for the next chunk. A payload that is not JSON
 * is an error, never skipped in silence.
 */
export function parseSse(buffer: string): { events: any[]; rest: string } {
  const events: any[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    events.push(JSON.parse(data));
  }
  return { events, rest };
}
