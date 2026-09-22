/**
 * The Coach wire contract. Types only — no components, no rendering, no
 * fetching. The panel that uses these belongs to the UI work and is built
 * against the #73 design system; this file is the server's promise about what
 * arrives, kept next to the code that consumes it so the two cannot drift.
 *
 * Server side: server/routes/coach.js (POST /api/coach/ask) and
 * server/services/coach/{ask,verify,ledger}.js.
 *
 * The one idea worth carrying into the UI: every number in `answer` is
 * traceable. A claim's `cites` resolve into `ledger`, so a rendered sentence
 * can make each figure hoverable and show the row it came from, the query
 * that fetched it, and the formula if Coach worked it out. Nothing with
 * `verification.ok === false` ever carries a claim — the server returns a
 * refusal instead — so the panel never has to judge whether a sentence is
 * safe to show.
 */

/** A reference into the turn's ledger: `r1#0.target_share` or `d1`. */
export type Cite = string;

export interface CoachClaim {
  /** One sentence a person can act on. */
  text: string;
  /** The cells that support this sentence. Never empty on a shipped claim. */
  cites: Cite[];
}

export interface CoachAnswer {
  claims: CoachClaim[];
  /** What Coach could not answer, and why. A refusal is a valid answer, not an error. */
  refusals: string[];
  /** How old the hand-collected data behind the answer is, in plain words. */
  as_of: string | null;
}

/** How a table is kept current. `by_hand` is why an answer has to show its age. */
export type CollectionMode = 'auto' | 'by_hand' | 'derived' | 'seed';

export interface TableProvenance {
  collection: CollectionMode;
  freshness: string;
  grain: string;
}

/** One retrieval: a guarded SELECT, or a call into an existing service. */
export interface LedgerQuery {
  id: string;
  sql: string | null;
  params: unknown[];
  /** The tool that produced this, when it was a service rather than SQL. */
  tool: string | null;
  tables: string[];
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  /** True when a ceiling was hit. A shortened result is always declared. */
  truncated: boolean;
  provenance: Record<string, TableProvenance>;
}

/** One number Coach worked out, with the formula and the cells behind it. */
export interface LedgerDerived {
  id: string;
  op: 'sum' | 'difference' | 'product' | 'quotient' | 'mean' | 'min' | 'max' | 'percent_of';
  inputs: Cite[];
  label: string;
  value: number;
  formula: string;
}

export interface CoachLedger {
  queries: LedgerQuery[];
  derived: LedgerDerived[];
}

export type CoachViolationKind =
  | 'empty_answer' | 'uncited_claim' | 'bad_cite' | 'ungrounded_number' | 'missing_as_of';

export interface CoachViolation {
  kind: CoachViolationKind;
  detail: string;
  claim_index?: number;
  text?: string;
  /** The figure that could not be traced, for `ungrounded_number`. */
  number?: string;
  cite?: Cite;
  tables?: string[];
}

export interface CoachVerification {
  ok: boolean;
  violations: CoachViolation[];
  warnings: { kind: string; detail: string; claim_index?: number; text?: string }[];
  numbers_checked: number;
  /** Tables behind this answer that a person collects by hand. */
  hand_collected: string[];
  /** True when the first draft failed the check and was sent back. */
  retried: boolean;
}

/**
 * The thinking sequence, emitted as each thing happens. This is a real trace,
 * not a scripted animation: `rejected` only appears when Coach actually threw
 * away a draft, and `refused` only when a tool actually said no.
 */
export type CoachEvent =
  | { t: 'understood'; question: string }
  | { t: 'planning'; tools: string[] }
  | { t: 'query'; id: string | null; tool: string; status: 'running'; input: Record<string, unknown> }
  | { t: 'query'; id: string | null; tool: string; status: 'done'; row_count?: number;
      tables?: string[]; truncated?: boolean; ms: number }
  | { t: 'computing'; id: string; label: string; formula: string; value: number }
  | { t: 'refused'; tool: string; reason: string; ms: number }
  | { t: 'drafting' }
  | { t: 'checking'; numbers: number }
  | { t: 'rejected'; violations: CoachViolation[]; final: boolean }
  | { t: 'answer'; claims: number; refusals: number };

export interface CoachAskRequest {
  question: string;
  league_id?: number;
  /** What the page is showing. Context for the question, never evidence for an answer. */
  context?: {
    route?: string;
    section?: string | null;
    subview?: string | null;
    visible_summary?: Record<string, unknown>;
    event_context?: Record<string, unknown> | null;
  };
}

export interface CoachAskResponse {
  question: string;
  answer: CoachAnswer;
  ledger: CoachLedger;
  verification: CoachVerification;
  /** The same events the stream emits, for a client that did not stream. */
  plan: CoachEvent[];
  audit_id: number;
  cost_usd: number;
}

/** The final frame of the event stream, carrying everything the plain POST returns. */
export type CoachStreamEvent =
  | CoachEvent
  | ({ t: 'result' } & CoachAskResponse)
  | { t: 'error'; error: string; status: number };

/** Resolve a cite against a ledger. Returns undefined when it does not resolve. */
export function resolveCite(ledger: CoachLedger, cite: Cite): unknown {
  const derived = ledger.derived.find(d => d.id === cite);
  if (derived) return derived.value;
  const match = /^(r\d+)#(\d+)\.(.+)$/.exec(cite);
  if (!match) return undefined;
  const query = ledger.queries.find(q => q.id === match[1]);
  return query?.rows[Number(match[2])]?.[match[3]];
}
