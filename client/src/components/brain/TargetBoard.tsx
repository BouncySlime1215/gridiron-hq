import type { BoardPlayerRead, BoardRead, TargetBoard as Board } from './types';

/**
 * TM-03: the target board for one league-mate — where his roster is weakest, who
 * he is down on, which of your players he rates, and how and when to approach him.
 *
 * Every line carries its sample size and its source, and anything resting on
 * fewer than five observations is marked THIN rather than shown as a finding.
 * Nothing here is new math: the server shapes stored reads
 * (server/services/target-board.js) and this only says them in plain words.
 */

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const pts = (v: number | null) => (v == null ? '—' : v.toFixed(1));

function Thin() {
  return (
    <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-800 ring-1 ring-amber-200">
      Thin
    </span>
  );
}

function Meta({ n, source, unit = '' }: { n: number; source: string | null; unit?: string }) {
  return <span className="text-[11px] tabular-nums text-slate-500">n={n}{unit ? ` ${unit}` : ''}{source ? ` · ${source}` : ''}</span>;
}

/** A labelled line whose value is either a read or the named reason there is none. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
      <span className="w-full text-[10px] font-black uppercase tracking-[.12em] text-slate-400 sm:w-40">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-[12px] leading-5 text-slate-800">{children}</span>
    </div>
  );
}

function absent(r: BoardRead) {
  if (r.state === 'no_corpus') return 'no league chat for him';
  if (r.state === 'withheld_under_5') return `withheld: ${r.n} decided offer${r.n === 1 ? '' : 's'}, needs 5`;
  return 'not measured yet';
}

/** A real share of his messages (night_share = AVG(hour 0-5)). */
function ChatShare({ r, words }: { r: BoardRead; words: string }) {
  if (r.value == null) return <span className="text-slate-500">{absent(r)}</span>;
  return (<><b className="tabular-nums">{pct(r.value)}</b><span>{words}</span>{r.thin && <Thin />}<Meta n={r.n} source={r.source} unit="msgs" /></>);
}

/**
 * A classifier probability averaged over his messages (p_open_to_trade etc. in
 * scripts/chat/extract_league_chat.py), NOT a share of messages. Worded as the
 * Coach variables name it (server/services/coach/people/variables.js), on 0-1.
 */
function ChatProb({ r, words }: { r: BoardRead; words?: string }) {
  if (r.value == null) return <span className="text-slate-500">{absent(r)}</span>;
  return (<>{words && <span>{words}</span>}<b className="tabular-nums">{r.value.toFixed(2)}</b>
    <span className="text-slate-600">avg probability 0-1</span>{r.thin && <Thin />}<Meta n={r.n} source={r.source} unit="msgs" /></>);
}

const VERDICT: Record<BoardPlayerRead['verdict'], string> = {
  buy_low: 'the buy: usage says the results are wrong',
  genuine_sour: 'sour, usage agrees',
  wants_him: 'talks him up',
};

function Players({ list, empty }: { list: BoardPlayerRead[]; empty: string }) {
  if (!list.length) return <span className="text-slate-500">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {list.slice(0, 5).map(p => (
        <span key={p.player} className="inline-flex items-baseline gap-1 rounded-lg bg-white px-2 py-0.5 ring-1 ring-slate-200">
          <b className="text-slate-900">{p.player}</b>
          <span className="text-[11px] text-slate-600">{VERDICT[p.verdict]}</span>
          <span className="text-[11px] tabular-nums text-slate-500">{p.sentiment.toFixed(2)}/4 · n={p.n} · {p.source}</span>
          {p.thin && <Thin />}
        </span>
      ))}
    </span>
  );
}

/**
 * A UTC hour in the viewer's time, on TODAY's date so daylight saving is the
 * one in force now (a fixed January date would be an hour early all autumn).
 */
const localHour = (h: number) => {
  const d = new Date();
  d.setUTCHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
};

export default function TargetBoard({ board, thinBelow = 5 }: { board: Board; thinBelow?: number }) {
  const hole = board.roster_hole;
  const tilt = board.tilt;
  const ah = board.active_hours;
  const noChat = board.player_reads_state === 'no_corpus';
  return (
    <div className="mt-2.5 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
      <div className="text-[11px] font-black uppercase tracking-[.14em] text-emerald-800">Target board</div>
      <p className="text-[11px] leading-5 text-slate-500">
        Each line shows how many observations it rests on and where it comes from; under {thinBelow} is marked thin.
      </p>
      <div className="mt-1 divide-y divide-emerald-100">
        <Line label="Weakest spot">
          {hole.read_state === 'present' ? (
            <>
              <b>{hole.position}</b>
              <span className="tabular-nums">starters at {hole.ratio?.toFixed(2)}× league average (VOR)</span>
              {hole.is_need
                ? <span className="tabular-nums text-rose-700">a need{hole.gap != null ? `, ${hole.gap} VOR pts short` : ''}</span>
                : <span className="text-slate-600">not a need</span>}
              {hole.thin && <Thin />}
              <Meta n={hole.n} source="trade finder needs" unit="teams" />
              {hole.needs.length > 1 && (
                <span className="w-full text-[11px] text-slate-500">also short at {hole.needs.slice(1).join(', ')}</span>
              )}
            </>
          ) : <span className="text-slate-500">not priced: {hole.reason}</span>}
        </Line>
        <Line label="Buy low: he's down on">
          <Players list={board.down_on} empty={noChat ? 'no league chat for him' : 'nobody on his roster he is clearly sour on'} />
        </Line>
        <Line label="Sell high: he rates yours">
          <Players list={board.rates_yours} empty={noChat ? 'no league chat for him' : 'none of your players he clearly talks up'} />
        </Line>
        <Line label="Open to trading">
          <ChatProb r={board.openness} words="how open he sounds to a deal" />
        </Line>
        <Line label="Calls players untouchable">
          <ChatProb r={board.untouchable} words="declaring a player untouchable" />
        </Line>
        <Line label="Tilt">
          {tilt.just_lost == null
            ? <span className="text-slate-500">no decided game yet</span>
            : <span>{tilt.just_lost ? 'Lost' : 'Won'} last week by {pts(Math.abs(tilt.last_week_margin.value ?? 0))}</span>}
          {tilt.just_lost != null && <Meta n={tilt.last_week_margin.n} source={tilt.last_week_margin.source} unit="game" />}
          <span className="flex w-full flex-wrap items-baseline gap-x-2">
            <ChatProb r={tilt.reacting_to_loss} words="how often he is reacting to a loss" />
          </span>
        </Line>
        <Line label="When he's active">
          {ah.busiest_hour_utc == null
            ? <span className="text-slate-500">busiest hour not known ({ah.actions_n} of {ah.min_actions} moves needed)</span>
            : <span>busiest around <b>{localHour(ah.busiest_hour_utc)}</b> your time</span>}
          {ah.thin && <Thin />}
          <Meta n={ah.actions_n} source={ah.source} unit="moves" />
          <span className="flex w-full flex-wrap items-baseline gap-x-2"><ChatShare r={ah.night_share} words="of his messages at night" /></span>
        </Line>
        <Line label="Accepts offers">
          {board.accept_rate.value == null
            ? <span className="text-slate-500">{absent(board.accept_rate)}</span>
            : <><b className="tabular-nums">{pct(board.accept_rate.value)}</b><span>of decided offers</span>
              {board.accept_rate.thin && <Thin />}</>}
          <Meta n={board.accept_rate.n} source={board.accept_rate.source} unit="offers" />
        </Line>
        <Line label="Lineup signals">
          {board.lineup_signals.read_state !== 'present'
            ? <span className="text-slate-500">not built on this server yet</span>
            : board.lineup_signals.signals.length
              ? board.lineup_signals.signals.slice(0, 5).map(s => (
                <span key={`${s.player}:${s.signal}:${s.week}`} className="inline-flex items-baseline gap-1">
                  <b>{s.player}</b><span>{s.signal.replace(/_/g, ' ')}</span>
                  {s.thin && <Thin />}<Meta n={s.n} source={s.source} />
                </span>))
              : <span className="text-slate-500">none for him</span>}
        </Line>
      </div>
    </div>
  );
}
