/**
 * The War Room's one contract: the plans file's league entry (warroom-plans/1,
 * server/services/campaign/plans-schema.js), passed through by
 * server/services/war-room-view.js with the view's own meta on top. Coach (#230)
 * reads the same keys. Every number is a Field: `value` exists only when status is
 * 'ok'. The client formats; it never does arithmetic on a value (WAR-ROOM-UI.md 2.1).
 */
export type FieldStatus = 'ok' | 'unknown' | 'failed';

export interface Field<T> {
  status: FieldStatus;
  value?: T;
  reason?: string;
  source: string;
  se?: number;
  clears_2se?: boolean;
  as_of?: string;
  n?: number;
}
export type Num = Field<number>;

export interface PlayerRef { id: string; name: string }

export const REASONING_SLOTS = [
  ['case_for', 'Case for'],
  ['his_side', 'His side of the table'],
  ['devils_advocate', "Devil's advocate"],
  ['news_check', 'News check'],
  ['confidence', 'Confidence, explained'],
  ['counter', 'If he counters'],
] as const;
export type ReasoningSlot = typeof REASONING_SLOTS[number][0];
export type Reasoning = Record<ReasoningSlot, string> & { cites: string[]; check_first?: boolean };

export type ReplyKind = 'accept' | 'decline' | 'counter' | 'silence';
export interface Reply {
  do: string;
  when?: string;
  message?: string;
  odds_after?: Num;
  move_id?: string;
  counter_rules?: { accept_if: string; counter_with: string; walk_away_if: string };
}

/** One offer in a plan, with its playbook. */
export interface Step {
  partner: string;
  give: string[];
  get: string[];
  p_yes: Num;
  title_odds_delta: Num;
  title_after: Num;
  message: Field<string>;
  opening: Field<{ give: string[]; get: string[]; text?: string }>;
  walk_away: Field<{ text: string; max_give: string[] }>;
  send_when: Field<string>;
  reply_table: Field<Record<ReplyKind, Field<Reply>>>;
  reasoning?: Field<Reasoning>;
}

/** A plan: one deck card. `alternatives.value` is the deck, best first; its head is `next_move`. */
export interface Move {
  move_id: string;
  rank: number;
  target: string | null;
  target_owner: string | null;
  chained: boolean;
  steps: Step[];
  p_complete: Num;
  delta_final: Num;
  expected: Num;
  reasoning: Field<Reasoning>;
}

export interface Stop {
  id: string; order: number;
  kind: 'get' | 'sell' | 'flip' | 'claim' | 'cover_bye' | 'untouchable' | 'custom';
  label: string;
  status: 'next' | 'waiting' | 'done' | 'dropped' | 'blocked';
  added_by: 'plan' | 'nick' | 'coach';
  player_id?: string; week?: number; move_id?: string;
  p_yes?: Num; title_odds_delta?: Num;
}
export interface Itinerary { version: number; stops: Stop[]; stops_left: number; untouchables: string[]; conflicts: { text: string }[] }

export interface Target {
  player: string;
  owner: string;
  gain_if_landed: Num;
  p_reach: Num;
  mode_fit: Field<'fits' | 'needs_all_in' | 'too_risky_for_safe'>;
  why: Field<string>;
  approved: boolean;
  is_plan_target: boolean;
  reasoning?: Field<Reasoning>;
}

export interface Flip {
  player: string; buy_from: string; sell_to: string;
  spread: Num; price_a: Num; price_b: Num;
  legs: { give_a: string; get_b: string; p1: Num; p2: Num; p_both: Num; nick_after: Num } | null;
  legs_why_not?: string;
  reasoning?: Field<Reasoning>;
}

export interface CatchUpItem { text: string; gain: Num; steps: number; move_id?: string }
export interface SpeedPoint { arrive_by: number; cost: Num; net: Num; variance_note: string; offers_used: number; before_deadline: boolean }

export type CheckStatus = 'passing' | 'not_enough_data' | 'failing' | 'running' | 'not_run';
export interface BrainReport {
  overall: 'passing' | 'not_enough_data' | 'failing';
  checks: { id: string; name: string; bar: string; status: CheckStatus; result?: string; n?: number; as_of?: string }[];
  blocks: string[];
  fell_back_to?: 'balanced';
}
/** Not in warroom-plans/1 yet (FIX-03 adds it); the view writes it unknown until then. */
export interface NumberHealth { status: 'ok' | 'warn' | 'broken'; open: { check_id: string; text: string }[] }
/** This league's place in "needs you this week". */
export interface Attention { rank: number; of: number; reason: string }

export type RiskMode = 'safe' | 'balanced' | 'all_in';
export interface Destination {
  goal: Field<{ kind: 'title' | 'playoffs' | 'get_player' | 'points'; label: string; player_id?: string; points_per_week?: number }>;
  risk_mode: Field<{ mode: RiskMode; until_week?: number }>;
  tolerances: Field<Record<string, number>>;
  arrive_by: Num;
  eta_week: Num;
  title_now: Num;
  title_planned_now: Num;
  path: Field<{ week: number; planned: number; actual?: number }[]>;
  ground_lost: Num;
}

export interface Snapshot { id: string; as_of: string; schema?: string; producer?: string; producer_version?: string }

export interface WarRoomView {
  enabled: boolean;
  preview?: boolean;
  preview_reason?: string;
  banner?: string;
  league_id?: number;
  snapshot?: Snapshot | null;
  sources?: Record<string, { label: string; calibrated: boolean }>;
  // The league entry, as the contract writes it.
  league?: number;
  me?: string | null;
  names?: Record<string, string>;
  error?: string;
  attention?: Field<Attention>;
  destination?: Field<Destination>;
  feasibility?: Field<unknown>;
  finder_best_expected?: Num;
  next_move?: Field<Move>;
  alternatives?: Field<Move[]>;
  itinerary?: Field<Itinerary>;
  stop_tradeoffs?: Field<Record<string, unknown>>;
  flip_map?: Field<Flip[]>;
  targets?: Field<Target[]>;
  catch_up?: Field<CatchUpItem[]>;
  speed_curve?: Field<SpeedPoint[]>;
  brain_report?: Field<BrainReport>;
  number_health?: Field<NumberHealth>;
}

export type PanelId = 'next' | 'stops' | 'flip_map' | 'targets' | 'catch' | 'brain_report';

/** Player and team labels from the entry's `names` (ids only elsewhere). */
export function namer(names: Record<string, string> | undefined) {
  const one = (id: string): PlayerRef => ({ id, name: names?.[id] ?? `Player ${id}` });
  const text = (ids: string[] | undefined) => (ids ?? []).map(id => one(id).name).join(' + ');
  return { one, text };
}
export const teamLabel = (id: string | null | undefined) => (id == null ? '' : `Team ${id}`);
