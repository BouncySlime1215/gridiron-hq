/**
 * HIS-SIDE-WIRE (ONE-PLAN night 3): what a target's owner needs, shops and blocks, each with its n,
 * read from what the producer already holds. No new model and no new number of its own:
 *
 *   needs       the counterparty layer's roster read (res.partners[].needs)
 *   chat        the ONE-COUNTERPART model (people/counterpart.js#publicModel): what he shops, what he
 *               calls untouchable (with his follow-through on such claims: value and n), whom he asks about
 *   espn_block  ESPN's trade block (espn-trade-block.js, via the adapter): ON_THE_BLOCK players
 *   ledger      TRADE-MEMORY's season ledger (trade-memory.js#memorySummary, PR #379): the floor he paid
 *               for a player he bought this season, and the positions his trades took in and sent out
 *
 * The seller's floor is a market-value number Nick has not seen before and it is unmeasured, so the
 * field is served only with GRIDIRON_HIS_SIDE=1 (preview mode does not switch it on). Off, the view
 * writes the per-target read status to `_run.inputs.his_side` and nothing Nick sees changes.
 *
 * Pure: no DB, env or clock. Ids only; names come in through `nm` / `tl` at run time.
 */
export const HIS_SIDE_FLAG = 'GRIDIRON_HIS_SIDE';
export const hisSideOn = (env = {}) => (env ?? {})[HIS_SIDE_FLAG] === '1';

const SHOP = 'ON_THE_BLOCK';
const fmt = n => Math.round(n).toLocaleString('en-US');
const listOf = a => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/**
 * espn-trade-block.js#tradeBlocks result -> ON_THE_BLOCK players per roster, as planner ids.
 * idOfEspn(espnId) -> planner id or null; an unmapped id is counted, never guessed.
 * -> { status: 'ok', by_team: { [roster]: [id] }, unmapped } | { status: 'unknown', reason }
 */
export function tradeBlockRead({ blocks, error }, idOfEspn) {
  if (error) return { status: 'unknown', reason: error };
  const by_team = {};
  let unmapped = 0;
  for (const [team, players] of blocks) {
    by_team[team] = [];
    for (const [espn, status] of players) {
      if (status !== SHOP) continue;
      const id = idOfEspn(espn);
      if (id == null) { unmapped++; continue; }
      by_team[team].push(String(id));
    }
  }
  return { status: 'ok', by_team, unmapped };
}

const credOf = c => (c && Number.isFinite(c.value) && Number.isInteger(c.n) ? { value: c.value, n: c.n } : null);
const credText = c => (c?.n > 0 ? ` (kept ${c.kept ?? 0} of ${c.n} such claims)` : ' (none of his claims has resolved yet)');

/**
 * One target's his-side read.
 * player, owner: ids. partner: res.partners entry for the owner (or null). model: publicModel for the
 * owner (or null: counterpart off). block: the adapter's tradeBlockRead (or null: not read). memory:
 * TRADE-MEMORY's summary (or null). inNames(id): the entry's names has the id. nm(id), tl(team): labels.
 * -> { status: 'ok', value } | { status: 'unknown', reason, reads }
 */
export function hisSide({ player, owner, partner = null, model = null, block = null, memory = null, inNames, nm, tl }) {
  const p = String(player), team = String(owner);
  const keep = ids => [...new Set((ids ?? []).map(String))].filter(inNames);
  const needs = (partner?.needs_read ?? partner?.needs ?? []).map(String);
  const chatOk = model?.status === 'ok';
  const blockOk = block?.status === 'ok';
  const ledgerOk = memory?.status === 'on';
  const reads = {
    needs: needs.length ? 'ok' : 'none',
    chat: chatOk ? 'ok' : 'unknown',
    espn_block: blockOk ? 'ok' : block ? 'unknown' : 'unread',
    ledger: ledgerOk ? 'ok' : 'unread',
  };
  if (!Object.values(reads).includes('ok')) {
    return { status: 'unknown', reason: `Nothing is read about ${tl(team)}: no needs read, no chat read, no ESPN trade block, no trade ledger.`, reads };
  }

  const value = { reads, needs };
  const text = [needs.length ? `${tl(team)}'s roster read lists ${needs.join(', ')} as thin.` : `There is no read of ${tl(team)}'s needs.`];

  const untouchable = chatOk ? (model.untouchable ?? []).map(String) : [];
  const cred = chatOk ? model.credibility?.untouchable ?? null : null;
  value.target_protected = untouchable.includes(p);
  if (value.target_protected) text.push(`He calls ${nm(p)} untouchable in chat${credText(cred)}.`);

  let onBlock = [];
  if (blockOk) {
    onBlock = keep(block.by_team?.[team]);
    value.espn_block = { players: onBlock, n: onBlock.length };
    value.target_on_block = onBlock.includes(p);
    if (value.target_on_block) text.push(`${nm(p)} is on his ESPN trade block.`);
  }

  if (ledgerOk) {
    const f = (memory.floors ?? []).find(x => x.key === `${team}:${p}`);
    if (f && Number.isFinite(f.floor)) {
      value.floor = { value: f.floor, basis: String(f.basis ?? 'unknown') };
      text.push(`He paid ${fmt(f.floor)} for ${nm(p)} this season, so he sells only above that.`);
    }
    const c = memory.currency?.[team];
    if (c && (c.wants?.length || c.sells?.length)) {
      value.currency = { wants: (c.wants ?? []).map(String), sells: (c.sells ?? []).map(String) };
      const parts = [value.currency.wants.length ? `took in ${value.currency.wants.join(', ')}` : '',
        value.currency.sells.length ? `sent out ${value.currency.sells.join(', ')}` : ''].filter(Boolean);
      text.push(`His trades this season ${parts.join(' and ')}.`);
    }
  }

  if (chatOk) {
    const shops = keep(model.shopping);
    const protects = keep(untouchable);
    const wants = keep((model.wants ?? []).map(w => w.player));
    if (shops.length) value.shops = { players: shops, n: shops.length, source: 'chat' };
    if (protects.length) value.protects = { players: protects, n: protects.length, credibility: credOf(cred) };
    if (wants.length) value.wants = wants;
    const others = protects.filter(id => id !== p);
    const said = [shops.length ? `he is shopping ${listOf(shops.map(nm))}` : '',
      others.length ? `${shops.length ? '' : 'he '}calls ${listOf(others.map(nm))} untouchable${credText(cred)}` : ''].filter(Boolean);
    if (said.length) text.push(`In chat ${said.join(' and ')}.`);
    else if (!value.target_protected) text.push('In chat he names no one he is shopping or keeping.');
    if (wants.length) text.push(`He has asked about ${listOf(wants.map(nm))}.`);
  } else {
    text.push(`No chat read on ${tl(team)}.`);
  }

  if (blockOk) {
    const rest = onBlock.filter(id => id !== p);
    if (rest.length) text.push(`His ESPN trade block ${value.target_on_block ? 'also ' : ''}lists ${listOf(rest.map(nm))}.`);
    else if (!value.target_on_block) text.push('His ESPN trade block is empty.');
  }
  if (!ledgerOk) text.push('No trade ledger read this run.');

  value.text = text.join(' ');
  return { status: 'ok', value };
}

/**
 * CHAT-TRADE-INTEREST (shadow): people/chat-trade-interest.js#readChatTradeInterest -> per roster, the
 * planner ids he has shown he would give and wants (his own finalize drafts and trade-analyzer screens
 * in the league chat). idOfEspn(espnId) -> planner id or null; an unmapped id is counted, never guessed.
 * -> { status: 'ok', by_team: { [roster]: { wants, would_give, n } }, rows, unmapped } | { status, reason }
 */
export function chatInterestRead(read, idOfEspn) {
  if (!read || read.status !== 'ok') return { status: read?.status ?? 'unread', reason: read?.reason ?? 'not read' };
  const by_team = {};
  let unmapped = 0;
  const map = side => side.map(p => {
    const id = p.espn_id == null ? null : idOfEspn(p.espn_id);
    if (id == null) unmapped++;
    return id == null ? null : String(id);
  }).filter(x => x != null);
  for (const r of read.rows) {
    const t = (by_team[String(r.roster_id)] ??= { wants: [], would_give: [], n: 0 });
    t.n++;
    for (const id of map(r.wants)) if (!t.wants.includes(id)) t.wants.push(id);
    for (const id of map(r.would_give)) if (!t.would_give.includes(id)) t.would_give.push(id);
  }
  return { status: 'ok', by_team, rows: read.rows.length, unmapped };
}

/** One target against the owner's chat interest: has the owner shown he would give him, or wants him? Null: nothing read. */
export function chatInterestShadow(interest, owner, player) {
  if (interest?.status !== 'ok') return null;
  const t = interest.by_team?.[String(owner)];
  if (!t) return { owner_would_give: false, owner_wants: false, n: 0 };
  return { owner_would_give: t.would_give.includes(String(player)), owner_wants: t.wants.includes(String(player)), n: t.n };
}

/** The ESPN block read for the summary: a broken id map shows as an unmapped count, never as an empty block. */
const blockStatus = b => (!b ? { status: 'unread' } : b.status === 'ok' ? { status: 'ok', unmapped: b.unmapped ?? 0 }
  : { status: String(b.status), reason: String(b.reason ?? '') });

/**
 * `_run.inputs.his_side`: the per-target read status, ids only (the shadow measurement). block: the adapter's
 * read or null. interest: chatInterestRead or null; when given, `chat_interest` logs, per target, whether its
 * owner has shown in chat that he would give him or wants him (shadow: nothing served reads it).
 */
export function hisSideSummary(rows, on, block = null, interest = null) {
  const ci = interest == null ? {} : { chat_interest: interest.status !== 'ok'
    ? { status: String(interest.status), reason: String(interest.reason ?? '') }
    : { status: 'ok', rows: interest.rows, teams: Object.keys(interest.by_team).length, unmapped: interest.unmapped,
      targets: rows.map(r => ({ player: r.player, owner: r.owner, ...chatInterestShadow(interest, r.owner, r.player) })) } };
  return {
    ...ci,
    flag: on ? 'on' : 'shadow',
    espn_block: blockStatus(block),
    ok: rows.filter(r => r.hs.status === 'ok').length, of: rows.length,
    targets: rows.map(r => ({ player: r.player, owner: r.owner, status: r.hs.status, reads: r.hs.status === 'ok' ? r.hs.value.reads : r.hs.reads })),
  };
}

/** The producer's log line for one league's `_run.inputs.his_side` (the unmapped count reaches the run log, not only the file). */
export function hisSideLine(summary) {
  const b = summary.espn_block ?? { status: 'unread' };
  const block = b.status === 'ok' ? `ok, ${b.unmapped ?? 0} unmapped ids` : b.reason ? `${b.status} (${b.reason})` : b.status;
  return `his_side ${summary.flag}, ESPN trade block ${block}, ${summary.ok} of ${summary.of} targets read ok`;
}
