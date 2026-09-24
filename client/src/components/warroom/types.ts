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

export type PanelId = 'next' | 'stops' | 'clones' | 'flip' | 'targets' | 'catch' | 'brain';

/* UI-ENG-4: the clone panel (server/services/warroom-clones.js). Labels only. */
export interface CloneBand { low: number; mid: number; high: number; n: number; basis: 'his_record' | 'population'; fitted: false }
export interface CloneReason { label: string; effect: number | null; source: string }
export interface CloneWant {
  player: { id: string; name: string; pos: string | null };
  age_days: number; strength: number; state: 'fresh' | 'fading'; you_have: boolean;
}
export interface CloneWord { label: 'credible' | 'mixed' | 'cheap_talk'; from: 'record' | 'profile'; n: number; held?: number; reversed?: number; confidence: string }
export interface CloneRow {
  team: string;
  label: string;
  standing: 'active' | 'normal' | 'deprioritised' | 'excluded';
  nick: string[];
  profile: Field<{ traits: { key: string; label: string; source: string }[]; as_of: string | null; messages_read: number | null }>;
  p_accept: Field<CloneBand> & { note?: string };
  reasons: Field<CloneReason[]>;
  wants: Field<CloneWant[]>;
  credibility: Field<CloneWord>;
}
export interface ClonesView {
  enabled: boolean;
  preview?: boolean;
  banner?: string;
  league_id?: number;
  as_of?: string;
  sources?: Record<string, { label: string; calibrated: boolean }>;
  clones?: Field<CloneRow[]>;
}
