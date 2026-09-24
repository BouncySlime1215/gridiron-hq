/**
 * The War Room's one contract (server/services/war-room-view.js). Every number is a
 * Field: `value` exists only when status is 'ok'. The client formats; it never does
 * arithmetic on a value (WAR-ROOM-UI.md 2.1).
 */
export type FieldStatus = 'ok' | 'unknown' | 'failed';

export interface Field<T> {
  status: FieldStatus;
  value?: T;
  reason?: string;
  source: string;
  producer: string;
  producer_version: string;
  se?: number;
  clears_2se?: boolean;
  guess?: boolean;
  preview?: boolean;
}
export type Num = Field<number>;

export interface PlayerRef { id: string; name: string }

export interface Reply { kind: 'accept' | 'decline' | 'counter' | 'silence'; do: string; odds_after?: Num }

export const REASONING_SLOTS = [
  ['case_for', 'Case for'],
  ['his_side', 'His side of the table'],
  ['devils_advocate', "Devil's advocate"],
  ['news_check', 'News check'],
  ['confidence', 'Confidence, explained'],
  ['counter', 'If he counters'],
] as const;
export type ReasoningSlot = typeof REASONING_SLOTS[number][0];

export interface MoveCard {
  rank: number;
  origin: string;
  origin_label: string;
  step_index: number;
  of_steps: number;
  target: PlayerRef | null;
  target_owner: string | null;
  partner: string;
  partner_label: string;
  give: PlayerRef[];
  get: PlayerRef[];
  deal_line: string;
  p_yes: Num;
  odds_effect: { before: Num; after: Num; delta: Num };
  path_effect: { delta_final: Num; p_complete: Num; expected: Num; chained: boolean | null };
  vs_finder: { finder_expected: Num; this_expected: Num };
  message: Field<{ text: string }>;
  walk_away: Field<string>;
  send_when: Field<string>;
  why: Field<unknown>;
  replies: Record<'accept' | 'decline' | 'counter' | 'silence', Field<Reply>>;
  reasoning: Record<ReasoningSlot, Field<string>>;
}

export interface Stop {
  id: string; order: number;
  kind: 'get' | 'sell' | 'flip' | 'claim' | 'cover_bye' | 'custom';
  label: string;
  give: PlayerRef[]; get: PlayerRef[];
  status: 'next' | 'waiting' | 'done' | 'dropped' | 'blocked';
  added_by: 'plan' | 'nick' | 'coach';
  p_yes: Num; odds_after: Num;
}
export interface Itinerary { target: PlayerRef | null; stops: Stop[]; untouchables: string[]; conflicts: { text: string }[] }

export interface Target {
  player: PlayerRef;
  owner: Field<string>;
  gain_if_landed: Num;
  p_reach: Num;
  mode_fit: Field<string>;
  approved: boolean;
  is_plan_target: boolean;
}

export interface Flip {
  player: PlayerRef; buy_from: string; sell_to: string;
  spread: Num; price_a: Num; price_b: Num;
  legs: { give_a: PlayerRef; get_b: PlayerRef; p1: Num; p2: Num; p_both: Num; nick_after: Num } | null;
  legs_why_not: string | null;
}

export interface CatchUpItem { text: string; gain: Num; steps: number }
export interface SpeedPoint { arrive_by: number; net: Num; picked?: boolean }

export interface BrainCheck {
  overall: 'passing' | 'not_enough_data' | 'failing';
  checks: { id: string; status: 'passing' | 'not_enough_data' | 'failing' | 'running' | 'not_run'; result?: string }[];
  blocks: string[];
}
export interface NumberHealth { status: 'ok' | 'warn' | 'broken'; open: { check_id: string; text: string }[] }
export interface Attention { league_id: number; rank: number; text: string }

export interface Destination {
  goal: Field<{ label: string }>;
  risk_mode: Field<'safe' | 'balanced' | 'all_in'>;
  arrive_by: Num;
  eta_week: Num;
  title_now: Num;
  title_planned_now: Num;
  path: Field<{ week: number; planned: number; actual?: number }[]>;
  ground_lost: Num;
}

export interface WarRoomView {
  enabled: boolean;
  preview?: boolean;
  preview_reason?: string;
  banner?: string;
  league_id?: number;
  me?: string | null;
  snapshot?: { id: string; as_of: string } | null;
  names?: Record<string, string>;
  sources?: Record<string, { label: string; calibrated: boolean }>;
  attention?: Field<Attention[]>;
  destination?: Destination;
  next_move?: Field<{ cards: MoveCard[]; deck_note: string }>;
  itinerary?: Field<Itinerary>;
  suggestions?: Field<Target[]>;
  speed_curve?: Field<SpeedPoint[]>;
  catch_up?: Field<CatchUpItem[]>;
  flips?: Field<Flip[]>;
  brain_check?: Field<BrainCheck>;
  number_health?: Field<NumberHealth>;
}

export type PanelId = 'next' | 'stops' | 'flip' | 'self' | 'targets' | 'catch' | 'brain';

/** SELF-01b: GET /trades/:id/war-room/self (server/services/war-room-self.js). */
export interface SelfKind {
  kind: 'start_sit' | 'waiver' | 'trade' | 'next_move';
  label: string;
  follow: number;
  ignore: number;
  no_action: number;
  open: number;
}
export interface BiasFlag {
  category: string;
  bias: 'ignores' | 'overpays';
  label: string;
  /** Walk-forward record on his own later weeks: `hits` of `n` right, against `base_rate`. */
  forward: { n: number; hits: number; precision: number; base_rate: number };
}
export interface SelfView {
  enabled: boolean;
  league_id?: number;
  follow?: Field<{ kinds: SelfKind[] }>;
  flags?: Field<BiasFlag[]>;
  /** Candidate habits that did not pass the forward check: a count, never their names. */
  held?: number;
  note?: string;
}
